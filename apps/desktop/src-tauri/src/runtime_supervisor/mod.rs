//! Starts and supervises the Node runtime sidecar (ADR-0002). The only module that spawns
//! the runtime.
//!
//! Lifecycle: Starting -> (spawn, job object, `runtime.initialize` within 10 s) -> Ready.
//! Health pings every 5 s mark the runtime Degraded after two misses. Automatic restart
//! with backoff (ADR-0002's Restarting state) arrives in Phase 1; until then an exit or a
//! failed handshake ends in Failed.

#[cfg(windows)]
mod job_object_windows;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::ipc::Channel;
use tokio::io::BufReader;
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, watch};

use crate::logging;
use crate::rpc_relay::lines::{read_line_capped, Line};
use crate::rpc_relay::{allowlist, unavailable, Connection, MAX_MESSAGE_BYTES};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const PING_INTERVAL: Duration = Duration::from_secs(5);
const PING_TIMEOUT: Duration = Duration::from_secs(2);
const MISSED_PINGS_DEGRADED: u32 = 2;
const SHUTDOWN_REPLY_TIMEOUT: Duration = Duration::from_secs(2);
const SHUTDOWN_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
/// Longest runtime stderr line kept; Node stack traces fit easily.
const MAX_STDERR_LINE_BYTES: usize = 64 * 1024;
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
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct StatusUpdate {
    pub status: RuntimeStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Where the runtime lives and how to start it.
pub struct LaunchSpec {
    pub node: PathBuf,
    pub entry: PathBuf,
    pub data_dir: PathBuf,
    /// Debug builds may disable the job object to show what it prevents (Spike S1).
    pub use_job_object: bool,
}

#[derive(Default)]
struct Subscribers {
    events: Option<Channel<Value>>,
    status: Option<Channel<StatusUpdate>>,
}

struct Inner {
    connection: Mutex<Option<Arc<Connection>>>,
    status: Mutex<StatusUpdate>,
    subscribers: Mutex<Subscribers>,
    kill: Mutex<Option<oneshot::Sender<()>>>,
    exited: watch::Sender<bool>,
    shutting_down: AtomicBool,
    #[cfg(windows)]
    job: Mutex<Option<job_object_windows::JobObject>>,
}

pub struct Supervisor {
    inner: Arc<Inner>,
}

impl Supervisor {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                connection: Mutex::new(None),
                status: Mutex::new(StatusUpdate {
                    status: RuntimeStatus::Starting,
                    detail: None,
                }),
                subscribers: Mutex::new(Subscribers::default()),
                kill: Mutex::new(None),
                exited: watch::channel(false).0,
                shutting_down: AtomicBool::new(false),
                #[cfg(windows)]
                job: Mutex::new(None),
            }),
        }
    }

    pub fn start(&self, spec: LaunchSpec) {
        let inner = self.inner.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(detail) = launch(inner.clone(), spec).await {
                logging::error(MODULE, format!("runtime failed to start: {detail}"));
                inner.set_status(RuntimeStatus::Failed, Some(detail));
                inner.kill();
            }
        });
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

    /// Graceful stop (ADR-0002): ask, wait up to 5 s, then kill. The job object is the
    /// backstop for anything the runtime left behind.
    pub async fn shutdown(&self) {
        self.inner.shutting_down.store(true, Ordering::SeqCst);
        let mut exited = self.inner.exited.subscribe();
        if *exited.borrow() {
            return;
        }
        logging::info(MODULE, "shutting down the runtime");
        if let Some(connection) = self.connection() {
            if let Err(error) = host_call(
                &connection,
                "runtime.shutdown",
                json!({}),
                SHUTDOWN_REPLY_TIMEOUT,
            )
            .await
            {
                logging::warn(MODULE, format!("runtime.shutdown failed: {error}"));
            }
        }
        if tokio::time::timeout(SHUTDOWN_EXIT_TIMEOUT, exited.wait_for(|done| *done))
            .await
            .is_err()
        {
            logging::warn(MODULE, "runtime did not exit within 5 s; killing it");
            self.inner.kill();
            let _ =
                tokio::time::timeout(Duration::from_secs(2), exited.wait_for(|done| *done)).await;
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
            if current.status == update.status && current.detail == update.detail {
                return;
            }
            *current = update.clone();
        }
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

    fn kill(&self) {
        if let Some(kill) = self.kill.lock().unwrap().take() {
            let _ = kill.send(());
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

async fn launch(inner: Arc<Inner>, spec: LaunchSpec) -> Result<(), String> {
    inner.set_status(RuntimeStatus::Starting, None);
    let started = Instant::now();

    let mut command = Command::new(&spec.node);
    command
        .arg("--disable-warning=ExperimentalWarning")
        .arg(&spec.entry)
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

    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start {}: {error}", spec.node.display()))?;

    // Assign before `initialize`: the runtime starts no children until it is initialised.
    if spec.use_job_object {
        #[cfg(windows)]
        {
            let job = job_object_windows::JobObject::new_kill_on_close()
                .map_err(|error| format!("could not create job object: {error}"))?;
            let handle = child
                .raw_handle()
                .ok_or("runtime exited before job assignment")?;
            job.assign(handle)
                .map_err(|error| format!("could not assign job object: {error}"))?;
            *inner.job.lock().unwrap() = Some(job);
        }
        // ADR-0011's process-group cleanup (process_group_unix.rs) is not built yet.
        #[cfg(not(windows))]
        logging::warn(
            MODULE,
            "no process-tree guard on this platform yet; the runtime's stdin-EOF shutdown is the only cleanup",
        );
    } else {
        logging::warn(
            MODULE,
            "job object disabled (JESUTOBITS_DISABLE_JOB_OBJECT)",
        );
    }

    let stdin = child.stdin.take().expect("stdin is piped");
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");

    let events = inner.clone();
    let connection = Arc::new(Connection::new(
        Box::new(stdin),
        Box::new(move |event| events.forward_event(event)),
    ));

    let reader = connection.clone();
    tauri::async_runtime::spawn(async move {
        let mut stdout = BufReader::new(stdout);
        let mut line = Vec::new();
        loop {
            match read_line_capped(&mut stdout, &mut line, MAX_MESSAGE_BYTES).await {
                Ok(Line::Complete) => reader.handle_line(&line).await,
                Ok(Line::Oversize) => logging::warn(
                    MODULE,
                    format!("dropped a runtime message over {MAX_MESSAGE_BYTES} bytes"),
                ),
                Ok(Line::Eof) | Err(_) => break,
            }
        }
        reader.close();
    });

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

    watch_exit(inner.clone(), child);

    let params = json!({
        "protocolVersion": allowlist::PROTOCOL_VERSION,
        "client": { "name": "jesutobits-host", "version": env!("CARGO_PKG_VERSION") },
    });
    let result = host_call(&connection, "runtime.initialize", params, HANDSHAKE_TIMEOUT)
        .await
        .map_err(|error| {
            format!(
                "handshake failed: {}",
                error["message"].as_str().unwrap_or("unknown error")
            )
        })?;
    let runtime_protocol = result["protocolVersion"].as_str().unwrap_or_default();
    if major(runtime_protocol) != major(allowlist::PROTOCOL_VERSION) {
        return Err(format!(
            "runtime protocol {runtime_protocol} is not compatible with Host protocol {}",
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
    tauri::async_runtime::spawn(health_pings(inner, connection));
    Ok(())
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

/// Owns the child: reports its exit, or kills it on request.
fn watch_exit(inner: Arc<Inner>, mut child: Child) {
    let (kill_tx, kill_rx) = oneshot::channel();
    *inner.kill.lock().unwrap() = Some(kill_tx);
    tauri::async_runtime::spawn(async move {
        let status = tokio::select! {
            status = child.wait() => status,
            _ = kill_rx => {
                let _ = child.start_kill();
                child.wait().await
            }
        };
        inner.connection.lock().unwrap().take();
        let code = status.ok().and_then(|s| s.code());
        // No code means the process was ended by a signal or killed.
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
        inner.exited.send_replace(true);
        if !inner.shutting_down.load(Ordering::SeqCst) {
            inner.set_status(
                RuntimeStatus::Failed,
                Some(format!(
                    "The runtime exited unexpectedly (code {code_text})"
                )),
            );
        }
    });
}

async fn health_pings(inner: Arc<Inner>, connection: Arc<Connection>) {
    let mut missed = 0;
    let mut interval = tokio::time::interval(PING_INTERVAL);
    interval.tick().await; // The first tick fires immediately; the handshake just succeeded.
    loop {
        interval.tick().await;
        if inner.shutting_down.load(Ordering::SeqCst) || *inner.exited.borrow() {
            return;
        }
        match host_call(&connection, "runtime.ping", json!({}), PING_TIMEOUT).await {
            Ok(_) => {
                missed = 0;
                inner.set_status(RuntimeStatus::Ready, None);
            }
            Err(_) => {
                missed += 1;
                if missed >= MISSED_PINGS_DEGRADED {
                    inner.set_status(
                        RuntimeStatus::Degraded,
                        Some(format!("{missed} health pings missed")),
                    );
                }
            }
        }
    }
}

/// Error for Workbench calls made while no runtime connection is live.
pub fn not_ready() -> Value {
    unavailable("The runtime is not ready")
}
