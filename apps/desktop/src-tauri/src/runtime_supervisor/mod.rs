//! Starts and supervises the Node runtime sidecar (ADR-0002). The only module that spawns
//! the runtime.
//!
//! One supervision task owns the child process and drives the ADR-0002 lifecycle:
//!
//! - Starting: spawn, job object, `runtime.initialize` within 10 s, then Ready.
//! - Health pings every 5 s: two misses mark the runtime Degraded, five restart it.
//! - An exit the Host did not ask for is a crash: Restarting, with a 0.5, 1, 2 or 4 s wait
//!   ([`restart_policy`]), then Starting again. The fifth crash within two minutes ends in
//!   Failed.
//! - A handshake timeout, a protocol mismatch or a failed spawn cannot be fixed by retrying
//!   and go straight to Failed.
//! - From Failed, only the user's Restart (`runtime_restart`) starts it again.

#[cfg(windows)]
mod job_object_windows;
mod restart_policy;
#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::ipc::Channel;
use tokio::io::BufReader;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, watch};

use crate::logging;
use crate::rpc_relay::lines::{read_line_capped, Line};
use crate::rpc_relay::{allowlist, unavailable, Connection, MAX_MESSAGE_BYTES};
use restart_policy::{Decision, RestartPolicy};

/// Longest runtime stderr line kept; Node stack traces fit easily.
const MAX_STDERR_LINE_BYTES: usize = 64 * 1024;
/// How long a failed handshake waits to learn whether the process is exiting.
const EXIT_GRACE: Duration = Duration::from_millis(500);
const MODULE: &str = "runtime_supervisor";

/// Environment the runtime inherits (ADR-0011 allowlist plus Jesutobits' own dev settings).
/// Everything else, including NODE_OPTIONS, is dropped.
const ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "HOME",
    "USERPROFILE",
    "TEMP",
    "TMP",
    "LANG",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "APPDATA",
    "LOCALAPPDATA",
    "JESUTOBITS_RUNTIME_LOG",
    "JESUTOBITS_PROVIDER",
    "JESUTOBITS_CASSETTE",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeStatus {
    Starting,
    Ready,
    Degraded,
    Restarting,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StatusUpdate {
    pub status: RuntimeStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Where the runtime lives and how to start it.
pub struct LaunchSpec {
    pub node: PathBuf,
    pub entry: PathBuf,
    /// Extra arguments after the entry; tests use them to pick fake-runtime behaviour.
    pub entry_args: Vec<String>,
    pub data_dir: PathBuf,
    /// Debug builds may disable the job object to show what it prevents (Spike S1).
    pub use_job_object: bool,
}

/// Every lifecycle duration and limit. Production uses ADR-0002's values; tests shrink them.
#[derive(Clone, Debug)]
pub struct Timings {
    pub handshake_timeout: Duration,
    pub ping_interval: Duration,
    pub ping_timeout: Duration,
    pub missed_pings_degraded: u32,
    pub missed_pings_restart: u32,
    pub backoff: Vec<Duration>,
    pub crash_window: Duration,
    pub crashes_until_failed: usize,
    pub shutdown_reply_timeout: Duration,
    pub shutdown_exit_timeout: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Self {
            handshake_timeout: Duration::from_secs(10),
            ping_interval: Duration::from_secs(5),
            ping_timeout: Duration::from_secs(2),
            missed_pings_degraded: 2,
            missed_pings_restart: 5,
            backoff: [500, 1000, 2000, 4000].map(Duration::from_millis).to_vec(),
            crash_window: Duration::from_secs(120),
            crashes_until_failed: 5,
            shutdown_reply_timeout: Duration::from_secs(2),
            shutdown_exit_timeout: Duration::from_secs(5),
        }
    }
}

/// Requests from other tasks to the supervision task.
#[derive(Debug)]
enum Request {
    /// Kill the running process (shutdown after the graceful wait).
    Kill,
    /// Start again from Failed; ignored in every other state.
    Restart,
}

#[derive(Default)]
struct Subscribers {
    events: Option<Channel<Value>>,
    status: Option<Channel<StatusUpdate>>,
}

struct Inner {
    timings: Timings,
    connection: Mutex<Option<Arc<Connection>>>,
    status: Mutex<StatusUpdate>,
    subscribers: Mutex<Subscribers>,
    requests: mpsc::UnboundedSender<Request>,
    /// Taken by the supervision task when it starts.
    request_rx: Mutex<Option<mpsc::UnboundedReceiver<Request>>>,
    /// True while a runtime process exists. `shutdown` waits for false.
    running: watch::Sender<bool>,
    shutting_down: watch::Sender<bool>,
    #[cfg(windows)]
    job: Mutex<Option<job_object_windows::JobObject>>,
    /// Every status change in order, so tests can assert sequences.
    #[cfg(test)]
    history: Mutex<Vec<StatusUpdate>>,
}

pub struct Supervisor {
    inner: Arc<Inner>,
}

/// How one run of the runtime ended.
enum Ended {
    /// The Host asked it to stop.
    ShutDown,
    /// It exited or stopped answering: restart with backoff.
    Crashed(String),
    /// Retrying cannot help: go to Failed.
    Fatal(String),
}

impl Supervisor {
    pub fn new() -> Self {
        Self::with_timings(Timings::default())
    }

    pub fn with_timings(timings: Timings) -> Self {
        let (requests, request_rx) = mpsc::unbounded_channel();
        let initial = StatusUpdate {
            status: RuntimeStatus::Starting,
            detail: None,
        };
        Self {
            inner: Arc::new(Inner {
                timings,
                connection: Mutex::new(None),
                #[cfg(test)]
                history: Mutex::new(vec![initial.clone()]),
                status: Mutex::new(initial),
                subscribers: Mutex::new(Subscribers::default()),
                requests,
                request_rx: Mutex::new(Some(request_rx)),
                running: watch::channel(false).0,
                shutting_down: watch::channel(false).0,
                #[cfg(windows)]
                job: Mutex::new(None),
            }),
        }
    }

    /// Starts the supervision task. Call once.
    pub fn start(&self, spec: LaunchSpec) {
        let requests = self
            .inner
            .request_rx
            .lock()
            .unwrap()
            .take()
            .expect("Supervisor::start is called once");
        tauri::async_runtime::spawn(supervise(self.inner.clone(), spec, requests));
    }

    /// The live connection, once the handshake has succeeded.
    pub fn connection(&self) -> Option<Arc<Connection>> {
        self.inner.connection.lock().unwrap().clone()
    }

    /// Replaces the Workbench's channels (a reload subscribes again) and sends the current status.
    pub fn subscribe(&self, events: Channel<Value>, status: Channel<StatusUpdate>) {
        let current = self.inner.status.lock().unwrap().clone();
        let _ = status.send(current);
        let mut subscribers = self.inner.subscribers.lock().unwrap();
        subscribers.events = Some(events);
        subscribers.status = Some(status);
    }

    /// The user's "Restart runtime" (ADR-0002: Failed -> Starting). Ignored unless Failed.
    pub fn restart(&self) {
        let _ = self.inner.requests.send(Request::Restart);
    }

    /// Graceful stop (ADR-0002): ask, wait up to 5 s, then kill. The job object is the
    /// backstop for anything the runtime left behind. Also ends any restart backoff.
    pub async fn shutdown(&self) {
        self.inner.shutting_down.send_replace(true);
        let mut running = self.inner.running.subscribe();
        if !*running.borrow() {
            return;
        }
        logging::info(MODULE, "shutting down the runtime");
        let timings = &self.inner.timings;
        if let Some(connection) = self.connection() {
            if let Err(error) = host_call(
                &connection,
                "runtime.shutdown",
                json!({}),
                timings.shutdown_reply_timeout,
            )
            .await
            {
                logging::warn(MODULE, format!("runtime.shutdown failed: {error}"));
            }
        }
        if tokio::time::timeout(
            timings.shutdown_exit_timeout,
            running.wait_for(|running| !*running),
        )
        .await
        .is_err()
        {
            logging::warn(
                MODULE,
                format!(
                    "runtime did not exit within {}; killing it",
                    seconds(timings.shutdown_exit_timeout)
                ),
            );
            let _ = self.inner.requests.send(Request::Kill);
            let _ = tokio::time::timeout(Duration::from_secs(2), running.wait_for(|r| !*r)).await;
        }
    }
}

impl Default for Supervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl Inner {
    fn set_status(&self, status: RuntimeStatus, detail: Option<String>) {
        let update = StatusUpdate { status, detail };
        {
            let mut current = self.status.lock().unwrap();
            if *current == update {
                return;
            }
            *current = update.clone();
        }
        #[cfg(test)]
        self.history.lock().unwrap().push(update.clone());
        if let Some(channel) = &self.subscribers.lock().unwrap().status {
            let _ = channel.send(update);
        }
    }

    fn forward_event(&self, event: Value) {
        // Without a subscriber the event is dropped here; the runtime's ring buffer and
        // `events.replay` cover the gap (ADR-0003).
        if let Some(channel) = &self.subscribers.lock().unwrap().events {
            let _ = channel.send(event);
        }
    }

    fn is_shutting_down(&self) -> bool {
        *self.shutting_down.borrow()
    }

    /// Resolves once shutdown has been requested.
    async fn shutdown_requested(&self) {
        let mut flag = self.shutting_down.subscribe();
        let _ = flag.wait_for(|requested| *requested).await;
    }
}

/// The supervision task: runs the runtime, restarts it after crashes, parks in Failed.
async fn supervise(
    inner: Arc<Inner>,
    spec: LaunchSpec,
    mut requests: mpsc::UnboundedReceiver<Request>,
) {
    let timings = &inner.timings;
    let mut policy = RestartPolicy::new(
        timings.backoff.clone(),
        timings.crash_window,
        timings.crashes_until_failed,
    );
    loop {
        if inner.is_shutting_down() {
            return;
        }
        let failure = match run_once(&inner, &spec, &mut requests).await {
            Ended::ShutDown => return,
            Ended::Fatal(detail) => detail,
            Ended::Crashed(detail) => match policy.on_crash(Instant::now()) {
                Decision::RestartAfter(delay) => {
                    logging::warn(MODULE, format!("{detail}; restarting in {}", seconds(delay)));
                    inner.set_status(
                        RuntimeStatus::Restarting,
                        Some(format!("{detail}. Restarting in {}.", seconds(delay))),
                    );
                    tokio::select! {
                        _ = tokio::time::sleep(delay) => continue,
                        _ = inner.shutdown_requested() => return,
                    }
                }
                Decision::GiveUp(crashes) => format!(
                    "{detail}. It stopped {crashes} times within {}, so it was not restarted again.",
                    minutes(timings.crash_window)
                ),
            },
        };
        logging::error(MODULE, format!("runtime failed: {failure}"));
        inner.set_status(RuntimeStatus::Failed, Some(failure));
        if !wait_for_restart(&inner, &mut requests).await {
            return;
        }
        logging::info(MODULE, "restart requested by the user");
        policy.reset();
    }
}

/// Parks in Failed until the user restarts (true) or the app shuts down (false).
async fn wait_for_restart(inner: &Inner, requests: &mut mpsc::UnboundedReceiver<Request>) -> bool {
    // Requests sent before Failed (for example a Restart click during Restarting) are stale.
    while requests.try_recv().is_ok() {}
    loop {
        tokio::select! {
            request = requests.recv() => match request {
                Some(Request::Restart) => return true,
                Some(Request::Kill) => {}
                None => return false,
            },
            _ = inner.shutdown_requested() => return false,
        }
    }
}

fn runtime_env() -> Vec<(String, String)> {
    std::env::vars()
        .filter(|(name, _)| {
            ENV_ALLOWLIST.iter().any(|allowed| {
                // Windows environment names are case-insensitive ("Path").
                if cfg!(windows) {
                    allowed.eq_ignore_ascii_case(name)
                } else {
                    *allowed == name
                }
            })
        })
        .collect()
}

/// Starts the runtime once and supervises it until it exits, stops answering or is shut
/// down.
async fn run_once(
    inner: &Arc<Inner>,
    spec: &LaunchSpec,
    requests: &mut mpsc::UnboundedReceiver<Request>,
) -> Ended {
    let timings = &inner.timings;
    inner.set_status(RuntimeStatus::Starting, None);
    let started = Instant::now();

    let mut command = Command::new(&spec.node);
    command
        .arg("--disable-warning=ExperimentalWarning")
        .arg(&spec.entry)
        .args(&spec.entry_args)
        .arg("--stdio")
        .arg("--data-dir")
        .arg(&spec.data_dir)
        .env_clear()
        .envs(runtime_env())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Ended::Fatal(format!("Could not start {}: {error}", spec.node.display()))
        }
    };
    inner.running.send_replace(true);

    // Assign before `initialize`: the runtime starts no children until it is initialised.
    if let Err(detail) = guard_process_tree(inner, spec, &child) {
        kill_and_reap(inner, &mut child).await;
        return Ended::Fatal(detail);
    }

    let stdin = child.stdin.take().expect("stdin is piped");
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");

    let events = inner.clone();
    let connection = Arc::new(Connection::new(
        Box::new(stdin),
        Box::new(move |event| events.forward_event(event)),
    ));
    pump_stdout(connection.clone(), stdout);
    pump_stderr(stderr);

    // The handshake races the process's exit and a shutdown request.
    let params = json!({
        "protocolVersion": allowlist::PROTOCOL_VERSION,
        "client": { "name": "jesutobits-host", "version": env!("CARGO_PKG_VERSION") },
    });
    let handshake = tokio::select! {
        result = host_call(&connection, "runtime.initialize", params, timings.handshake_timeout) => result,
        status = child.wait() => {
            let code = observe_exit(inner, status);
            return Ended::Crashed(format!("The runtime exited during startup (exit code {code})"));
        }
        _ = inner.shutdown_requested() => {
            kill_and_reap(inner, &mut child).await;
            return Ended::ShutDown;
        }
    };
    let result = match handshake {
        Ok(result) => result,
        Err(error) => {
            // A process that is exiting fails the call first; tell the two cases apart.
            if let Ok(status) = tokio::time::timeout(EXIT_GRACE, child.wait()).await {
                let code = observe_exit(inner, status);
                return Ended::Crashed(format!(
                    "The runtime exited during startup (exit code {code})"
                ));
            }
            kill_and_reap(inner, &mut child).await;
            return Ended::Fatal(format!(
                "The runtime did not complete its handshake: {}",
                error["message"].as_str().unwrap_or("unknown error")
            ));
        }
    };
    let runtime_protocol = result["protocolVersion"].as_str().unwrap_or_default();
    if major(runtime_protocol) != major(allowlist::PROTOCOL_VERSION) {
        kill_and_reap(inner, &mut child).await;
        return Ended::Fatal(format!(
            "Runtime protocol {runtime_protocol} is not compatible with Host protocol {}",
            allowlist::PROTOCOL_VERSION
        ));
    }

    let ms = started.elapsed().as_millis() as u64;
    let node_version = result["nodeVersion"].as_str().unwrap_or("?");
    let mut fields = Map::new();
    fields.insert("ms".into(), ms.into());
    fields.insert("nodeVersion".into(), node_version.into());
    fields.insert("protocolVersion".into(), runtime_protocol.into());
    logging::with_fields(
        logging::Level::Info,
        MODULE,
        format!("runtime ready in {ms} ms (node {node_version}, protocol {runtime_protocol})"),
        fields,
    );
    *inner.connection.lock().unwrap() = Some(connection.clone());
    inner.set_status(RuntimeStatus::Ready, None);

    // Supervise until the process exits or stops answering.
    let mut pings = tokio::time::interval(timings.ping_interval);
    pings.tick().await; // The first tick fires immediately; the handshake just succeeded.
    let mut missed = 0;
    loop {
        tokio::select! {
            status = child.wait() => {
                let code = observe_exit(inner, status);
                return if inner.is_shutting_down() {
                    Ended::ShutDown
                } else {
                    Ended::Crashed(format!("The runtime stopped unexpectedly (exit code {code})"))
                };
            }
            Some(request) = requests.recv() => {
                if let Request::Kill = request {
                    let _ = child.start_kill();
                }
            }
            _ = pings.tick() => {
                if inner.is_shutting_down() {
                    continue;
                }
                match host_call(&connection, "runtime.ping", json!({}), timings.ping_timeout).await {
                    Ok(_) => {
                        missed = 0;
                        inner.set_status(RuntimeStatus::Ready, None);
                    }
                    Err(_) => {
                        missed += 1;
                        if missed >= timings.missed_pings_restart {
                            kill_and_reap(inner, &mut child).await;
                            return Ended::Crashed(format!(
                                "The runtime stopped answering ({missed} health checks missed)"
                            ));
                        }
                        if missed >= timings.missed_pings_degraded {
                            inner.set_status(
                                RuntimeStatus::Degraded,
                                Some(format!("{missed} health checks missed")),
                            );
                        }
                    }
                }
            }
        }
    }
}

/// Puts the runtime and everything it starts under a kill-on-close job object (Windows).
fn guard_process_tree(inner: &Inner, spec: &LaunchSpec, child: &Child) -> Result<(), String> {
    if !spec.use_job_object {
        logging::warn(
            MODULE,
            "job object disabled (JESUTOBITS_DISABLE_JOB_OBJECT)",
        );
        return Ok(());
    }
    #[cfg(windows)]
    {
        let job = job_object_windows::JobObject::new_kill_on_close()
            .map_err(|error| format!("Could not create a job object: {error}"))?;
        let handle = child
            .raw_handle()
            .ok_or("The runtime exited before it could be assigned to a job object")?;
        job.assign(handle)
            .map_err(|error| format!("Could not assign the job object: {error}"))?;
        // Replacing the previous run's job closes it, which ends anything that run left.
        *inner.job.lock().unwrap() = Some(job);
    }
    // ADR-0011's process-group cleanup (process_group_unix.rs) is not built yet.
    #[cfg(not(windows))]
    {
        let _ = (inner, child);
        logging::warn(
            MODULE,
            "no process-tree guard on this platform yet; the runtime's stdin-EOF shutdown is the only cleanup",
        );
    }
    Ok(())
}

fn pump_stdout(connection: Arc<Connection>, stdout: tokio::process::ChildStdout) {
    tauri::async_runtime::spawn(async move {
        let mut stdout = BufReader::new(stdout);
        let mut line = Vec::new();
        loop {
            match read_line_capped(&mut stdout, &mut line, MAX_MESSAGE_BYTES).await {
                Ok(Line::Complete) => connection.handle_line(&line).await,
                Ok(Line::Oversize) => logging::warn(
                    MODULE,
                    format!("dropped a runtime message over {MAX_MESSAGE_BYTES} bytes"),
                ),
                Ok(Line::Eof) | Err(_) => break,
            }
        }
        connection.close();
    });
}

fn pump_stderr(stderr: tokio::process::ChildStderr) {
    tauri::async_runtime::spawn(async move {
        // The runtime's stderr becomes runtime.jsonl; the Host is that file's only writer.
        let mut stderr = BufReader::new(stderr);
        let mut line = Vec::new();
        loop {
            match read_line_capped(&mut stderr, &mut line, MAX_STDERR_LINE_BYTES).await {
                Ok(Line::Complete) => logging::runtime_stderr(&String::from_utf8_lossy(&line)),
                Ok(Line::Oversize) => logging::warn(
                    MODULE,
                    format!("dropped a runtime stderr line over {MAX_STDERR_LINE_BYTES} bytes"),
                ),
                Ok(Line::Eof) | Err(_) => break,
            }
        }
    });
}

/// Records an exit: drops the connection, logs, then clears `running`. Returns the exit
/// code as text ("none" when the process was ended by a signal or killed).
fn observe_exit(inner: &Inner, status: std::io::Result<std::process::ExitStatus>) -> String {
    inner.connection.lock().unwrap().take();
    let code = status.ok().and_then(|s| s.code());
    let code_text = code.map_or_else(|| "none".to_owned(), |c| c.to_string());
    let mut fields = Map::new();
    fields.insert("exitCode".into(), code.into());
    // Log before signalling: `shutdown` returns on the signal and the app then exits.
    logging::with_fields(
        logging::Level::Info,
        MODULE,
        format!("runtime exited with code {code_text}"),
        fields,
    );
    inner.running.send_replace(false);
    code_text
}

async fn kill_and_reap(inner: &Inner, child: &mut Child) {
    let _ = child.start_kill();
    let status = child.wait().await;
    observe_exit(inner, status);
}

/// Calls a method the Host itself sends. Every such method is declared in packages/protocol
/// with the `host` caller, so the generated list stays the single source of truth.
async fn host_call(
    connection: &Connection,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, Value> {
    debug_assert!(
        allowlist::HOST_METHODS.contains(&method),
        "{method} is not declared as a host method in packages/protocol"
    );
    connection.call(method, params, timeout).await
}

fn major(version: &str) -> Option<&str> {
    version.split('.').next().filter(|part| !part.is_empty())
}

/// "0.5 s", "4 s".
fn seconds(duration: Duration) -> String {
    let secs = duration.as_secs_f64();
    if secs.fract() == 0.0 {
        format!("{secs:.0} s")
    } else {
        format!("{secs} s")
    }
}

/// "2 minutes", or seconds for windows under a minute (tests).
fn minutes(duration: Duration) -> String {
    match duration.as_secs() {
        60 => "1 minute".to_owned(),
        s if s >= 60 && s % 60 == 0 => format!("{} minutes", s / 60),
        _ => seconds(duration),
    }
}

/// Error for Workbench calls made while no runtime connection is live.
pub fn not_ready() -> Value {
    unavailable("The runtime is not ready")
}
