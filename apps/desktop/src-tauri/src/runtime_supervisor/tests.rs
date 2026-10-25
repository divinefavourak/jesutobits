//! Lifecycle tests: the real supervisor drives `fixtures/bin/fake-runtime.mjs` (real
//! processes, real pipes, the job object on Windows) with shortened timings
//! (TESTING_STRATEGY.md section 5, "Runtime crash loop"). Needs `node` on PATH, or
//! `JESUTOBITS_NODE`.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::*;

const WAIT: Duration = Duration::from_secs(30);

fn fast_timings() -> Timings {
    Timings {
        handshake_timeout: Duration::from_secs(10),
        ping_interval: Duration::from_millis(100),
        ping_timeout: Duration::from_millis(300),
        backoff: [20, 40, 80, 160].map(Duration::from_millis).to_vec(),
        shutdown_exit_timeout: Duration::from_secs(3),
        ..Timings::default()
    }
}

struct Harness {
    supervisor: Supervisor,
    data_dir: PathBuf,
}

impl Harness {
    fn start(name: &str, args: &[&str], timings: Timings) -> Self {
        let data_dir = std::env::temp_dir().join(format!(
            "jesutobits-supervisor-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&data_dir);
        std::fs::create_dir_all(&data_dir).unwrap();
        let node = std::env::var_os("JESUTOBITS_NODE").unwrap_or_else(|| "node".into());
        let supervisor = Supervisor::with_timings(timings);
        supervisor.start(LaunchSpec {
            node: PathBuf::from(node),
            entry: Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../fixtures/bin/fake-runtime.mjs"),
            entry_args: args.iter().map(|a| (*a).to_owned()).collect(),
            data_dir: data_dir.clone(),
            use_job_object: true,
        });
        Self {
            supervisor,
            data_dir,
        }
    }

    fn history(&self) -> Vec<StatusUpdate> {
        self.supervisor.inner.history.lock().unwrap().clone()
    }

    /// Status sequence with repeats collapsed (Degraded can repeat with a new count).
    fn statuses(&self) -> Vec<RuntimeStatus> {
        let mut statuses: Vec<RuntimeStatus> = self.history().iter().map(|u| u.status).collect();
        statuses.dedup();
        statuses
    }

    fn current(&self) -> StatusUpdate {
        self.supervisor.inner.status.lock().unwrap().clone()
    }

    fn detail_of(&self, status: RuntimeStatus) -> String {
        self.history()
            .into_iter()
            .find(|u| u.status == status)
            .and_then(|u| u.detail)
            .unwrap_or_else(|| panic!("no {status:?} in {:?}", self.history()))
    }

    /// Starts counted by the fake runtime, across restarts.
    fn starts(&self) -> u32 {
        std::fs::read_to_string(self.data_dir.join("fake-runtime-starts"))
            .map(|text| text.trim().parse().unwrap())
            .unwrap_or(0)
    }

    async fn wait_until(&self, what: &str, done: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + WAIT;
        while !done(self) {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}; history: {:?}",
                self.history()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn wait_for(&self, status: RuntimeStatus) {
        self.wait_until(&format!("{status:?}"), |h| h.current().status == status)
            .await;
    }

    async fn finish(self) {
        self.supervisor.shutdown().await;
        assert!(
            !*self.supervisor.inner.running.borrow(),
            "the runtime is still running after shutdown"
        );
        let _ = std::fs::remove_dir_all(&self.data_dir);
    }
}

use RuntimeStatus::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_crash_loop_backs_off_then_fails_after_five_crashes() {
    let h = Harness::start(
        "crash-loop",
        &["--cooperative", "--crash-at-init", "99"],
        fast_timings(),
    );
    h.wait_for(Failed).await;

    assert_eq!(
        h.statuses(),
        [
            Starting, Restarting, Starting, Restarting, Starting, Restarting, Starting, Restarting,
            Starting, Failed
        ]
    );
    assert_eq!(h.starts(), 5);
    let restarting: Vec<String> = h
        .history()
        .into_iter()
        .filter(|u| u.status == Restarting)
        .map(|u| u.detail.unwrap())
        .collect();
    assert_eq!(
        restarting,
        [
            "The runtime exited during startup (exit code 3). Restarting in 0.02 s.",
            "The runtime exited during startup (exit code 3). Restarting in 0.04 s.",
            "The runtime exited during startup (exit code 3). Restarting in 0.08 s.",
            "The runtime exited during startup (exit code 3). Restarting in 0.16 s.",
        ]
    );
    assert!(
        h.detail_of(Failed)
            .contains("stopped 5 times within 2 minutes"),
        "{}",
        h.detail_of(Failed)
    );
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_user_can_restart_from_failed() {
    let h = Harness::start(
        "user-restart",
        &["--cooperative", "--crash-at-init", "5"],
        fast_timings(),
    );
    h.wait_for(Failed).await;
    assert_eq!(h.starts(), 5);

    h.supervisor.restart();
    h.wait_for(Ready).await;
    assert_eq!(h.starts(), 6);
    assert!(h.supervisor.connection().is_some());
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unexpected_exit_after_ready_restarts_the_runtime() {
    let h = Harness::start(
        "exit-after-ready",
        &["--cooperative", "--crash-after-ready", "1"],
        fast_timings(),
    );
    h.wait_until("a second Ready", |h| {
        h.statuses() == [Starting, Ready, Restarting, Starting, Ready]
    })
    .await;
    assert_eq!(
        h.detail_of(Restarting),
        "The runtime stopped unexpectedly (exit code 4). Restarting in 0.02 s."
    );
    assert_eq!(h.starts(), 2);
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unanswered_pings_degrade_then_restart() {
    let h = Harness::start(
        "ignore-pings",
        &["--cooperative", "--ignore-pings"],
        fast_timings(),
    );
    h.wait_until("Restarting", |h| h.statuses().contains(&Restarting))
        .await;
    let statuses = h.statuses();
    assert_eq!(&statuses[..4], [Starting, Ready, Degraded, Restarting]);
    assert_eq!(h.detail_of(Degraded), "2 health checks missed");
    assert!(
        h.detail_of(Restarting)
            .starts_with("The runtime stopped answering (5 health checks missed)"),
        "{}",
        h.detail_of(Restarting)
    );
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_handshake_timeout_fails_without_retrying() {
    let timings = Timings {
        handshake_timeout: Duration::from_millis(300),
        ..fast_timings()
    };
    let h = Harness::start("silent", &["--cooperative", "--silent"], timings);
    h.wait_for(Failed).await;
    assert_eq!(h.statuses(), [Starting, Failed]);
    assert!(h
        .detail_of(Failed)
        .starts_with("The runtime did not complete its handshake"));
    // No retry. Under load Node may not even reach the fake's first line within 300 ms, so
    // the start count can be 0; it must never grow.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(h.starts() <= 1, "started {} times", h.starts());
    assert_eq!(h.statuses(), [Starting, Failed]);
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_protocol_mismatch_fails_without_retrying() {
    let h = Harness::start(
        "protocol",
        &["--cooperative", "--protocol", "99.0.0"],
        fast_timings(),
    );
    h.wait_for(Failed).await;
    assert_eq!(h.statuses(), [Starting, Failed]);
    assert!(h
        .detail_of(Failed)
        .starts_with("Runtime protocol 99.0.0 is not compatible"));
    assert_eq!(h.starts(), 1);
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_during_backoff_returns_at_once_and_starts_nothing() {
    let timings = Timings {
        backoff: vec![Duration::from_secs(30)],
        ..fast_timings()
    };
    let h = Harness::start(
        "shutdown-backoff",
        &["--cooperative", "--crash-at-init", "99"],
        timings,
    );
    h.wait_for(Restarting).await;

    let started = Instant::now();
    h.supervisor.shutdown().await;
    assert!(started.elapsed() < Duration::from_secs(1));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(h.starts(), 1, "no start after shutdown");
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn graceful_shutdown_is_not_a_crash() {
    let h = Harness::start("graceful", &["--cooperative"], fast_timings());
    h.wait_for(Ready).await;

    let started = Instant::now();
    h.supervisor.shutdown().await;
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "took {:?}",
        started.elapsed()
    );
    assert!(!*h.supervisor.inner.running.borrow());
    assert!(!h.statuses().contains(&Restarting));
    assert!(!h.statuses().contains(&Failed));
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_is_ignored_unless_failed() {
    let h = Harness::start("restart-ignored", &["--cooperative"], fast_timings());
    h.wait_for(Ready).await;
    h.supervisor.restart();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(h.current().status, Ready);
    assert_eq!(h.starts(), 1);
    h.finish().await;
}

#[test]
fn durations_read_naturally() {
    assert_eq!(seconds(Duration::from_millis(500)), "0.5 s");
    assert_eq!(seconds(Duration::from_secs(4)), "4 s");
    assert_eq!(minutes(Duration::from_secs(120)), "2 minutes");
    assert_eq!(minutes(Duration::from_secs(60)), "1 minute");
}
