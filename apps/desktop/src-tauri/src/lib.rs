//! Jesutobits Host (ARCHITECTURE.md section 5.1).

mod dialogs;
mod host_methods;
mod logging;
mod rpc_relay;
mod runtime_supervisor;
mod secret_store;
mod settings_store;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{Manager, RunEvent, State};

use rpc_relay::{allowlist, rpc_error, Connection, CODE_METHOD_NOT_ALLOWED, METHOD_NOT_FOUND};
use runtime_supervisor::{LaunchSpec, StatusUpdate, Supervisor};
use secret_store::SecretStore;
use settings_store::{commands as settings, SettingsStore};

/// When the Host started, for startup timing (NFR-001).
static HOST_STARTED: OnceLock<Instant> = OnceLock::new();

/// How long a Workbench call may wait for the runtime. Long work streams events instead.
const WORKBENCH_CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// `runtime.configure` only stores the settings; it answers at once.
const CONFIGURE_TIMEOUT: Duration = Duration::from_secs(5);

/// Relays a Workbench call to the runtime if the method is on the allowlist (ADR-0003).
/// `Err` is a JSON-RPC error object whose `data` is a JesutobitsError.
#[tauri::command]
async fn rpc_call(
    method: String,
    params: Option<Value>,
    supervisor: State<'_, Supervisor>,
) -> Result<Value, Value> {
    if !allowlist::is_workbench_method(&method) {
        let message = format!("{method} is not callable from the Workbench");
        return Err(rpc_error(
            METHOD_NOT_FOUND,
            CODE_METHOD_NOT_ALLOWED,
            &message,
            false,
        ));
    }
    let connection = supervisor
        .connection()
        .ok_or_else(runtime_supervisor::not_ready)?;
    connection
        .call(
            &method,
            params.unwrap_or_else(|| json!({})),
            WORKBENCH_CALL_TIMEOUT,
        )
        .await
}

/// Streams runtime events and status changes to the Workbench.
#[tauri::command]
fn runtime_subscribe(
    on_event: Channel<Value>,
    on_status: Channel<StatusUpdate>,
    supervisor: State<'_, Supervisor>,
) {
    supervisor.subscribe(on_event, on_status);
}

/// The user's "Restart runtime" from the Failed state (ADR-0002). Ignored in other states.
#[tauri::command]
fn runtime_restart(supervisor: State<'_, Supervisor>) {
    supervisor.restart();
}

/// The Workbench logs through the Host into `workbench.jsonl` (ARCHITECTURE.md section 10).
#[tauri::command]
fn workbench_log(level: String, message: String) {
    logging::workbench(&level, &message);
}

/// The Workbench rendered its first screen. Logs the time since the Host started, which is
/// NFR-001's cold start, and the webview's own share (`sinceNavigationMs`).
#[tauri::command]
fn workbench_ready(since_navigation_ms: f64) {
    static LOADS: AtomicU32 = AtomicU32::new(0);
    let load = LOADS.fetch_add(1, Ordering::Relaxed) + 1;
    let since_start = HOST_STARTED
        .get()
        .map_or(0, |started| started.elapsed().as_millis() as u64);
    let since_navigation = since_navigation_ms.max(0.0).round() as u64;
    let mut fields = serde_json::Map::new();
    fields.insert("load".into(), load.into());
    fields.insert("sinceHostStartMs".into(), since_start.into());
    fields.insert("sinceNavigationMs".into(), since_navigation.into());
    let msg = if load == 1 {
        format!(
            "workbench interactive {since_start} ms after Host start ({since_navigation} ms in the webview)"
        )
    } else {
        format!("workbench reloaded and interactive after {since_navigation} ms (load {load})")
    };
    logging::with_fields(logging::Level::Info, "startup", msg, fields);
}

/// `JESUTOBITS_CONFIG_DIR` overrides the app config dir (settings.json, ui-state.json).
fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, tauri::Error> {
    match std::env::var_os("JESUTOBITS_CONFIG_DIR") {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => app.path().app_config_dir(),
    }
}

/// `JESUTOBITS_LOG_DIR` overrides the app log dir, like `JESUTOBITS_DATA_DIR` for data.
fn log_dir(app: &tauri::AppHandle) -> Result<PathBuf, tauri::Error> {
    match std::env::var_os("JESUTOBITS_LOG_DIR") {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => app.path().app_log_dir(),
    }
}

/// `runtime.configure`'s params: the settings sections the runtime acts on, and Jesutobits'
/// own folders that agent tools must never touch.
fn runtime_config(app: &tauri::AppHandle, settings: &Value) -> Value {
    let dirs: Vec<String> = [config_dir(app), log_dir(app)]
        .into_iter()
        .filter_map(Result::ok)
        .map(|dir| dir.to_string_lossy().into_owned())
        .collect();
    json!({
        "settings": {
            "providers": settings["providers"],
            "agent": settings["agent"],
            "privacy": settings["privacy"],
        },
        "appDirs": dirs,
    })
}

async fn configure(connection: Arc<Connection>, params: Value) {
    if let Err(error) = connection
        .call("runtime.configure", params, CONFIGURE_TIMEOUT)
        .await
    {
        logging::warn(
            "runtime",
            format!(
                "the runtime did not take the settings: {}",
                error["message"].as_str().unwrap_or("unknown error")
            ),
        );
    }
}

fn launch_spec(
    app: &tauri::AppHandle,
    secrets: Arc<SecretStore>,
) -> Result<LaunchSpec, Box<dyn std::error::Error>> {
    // Tauri copies sidecars next to the executable, without the target-triple suffix.
    let exe_dir = std::env::current_exe()?
        .parent()
        .ok_or("executable has no parent directory")?
        .to_path_buf();
    let node = exe_dir.join(if cfg!(windows) {
        "jesutobits-node.exe"
    } else {
        "jesutobits-node"
    });

    let mut entry = app.path().resource_dir()?.join("runtime").join("main.mjs");
    let mut use_job_object = true;
    // Debug-only overrides for Spike S1 and desktop tests; release builds ignore them.
    if cfg!(debug_assertions) {
        if let Some(path) = std::env::var_os("JESUTOBITS_RUNTIME_ENTRY") {
            entry = PathBuf::from(path);
        }
        use_job_object = std::env::var("JESUTOBITS_DISABLE_JOB_OBJECT").as_deref() != Ok("1");
    }

    // The database and checkpoints are large and machine-specific, so they go in the local
    // (not roaming) data dir: %LOCALAPPDATA%\<identifier> (DATA_AND_PERSISTENCE.md section 2).
    let data_dir = match std::env::var_os("JESUTOBITS_DATA_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => app.path().app_local_data_dir()?,
    };
    std::fs::create_dir_all(&data_dir)?;

    let handle = app.clone();
    Ok(LaunchSpec {
        node,
        entry,
        entry_args: Vec::new(),
        data_dir,
        use_job_object,
        reverse_handler: Some(host_methods::reverse_handler(secrets)),
        on_ready: Some(Arc::new(move |connection| {
            let settings = handle.state::<SettingsStore>().settings();
            let params = runtime_config(&handle, &settings);
            Box::pin(configure(connection, params))
        })),
    })
}

pub fn run() {
    HOST_STARTED.get_or_init(Instant::now);
    let app = tauri::Builder::default()
        .setup(|app| {
            logging::init(&log_dir(app.handle())?);
            app.manage(SettingsStore::load(&config_dir(app.handle())?));
            let secrets = Arc::new(SecretStore::for_app(&app.config().identifier));
            app.manage(secrets.clone());
            let supervisor = Supervisor::new();
            supervisor.start(launch_spec(app.handle(), secrets)?);
            app.manage(supervisor);
            let handle = app.handle().clone();
            app.state::<SettingsStore>().on_change(move |settings| {
                if let Some(connection) = handle.state::<Supervisor>().connection() {
                    let params = runtime_config(&handle, settings);
                    tauri::async_runtime::spawn(configure(connection, params));
                }
            });
            if let Some(window) = app.get_webview_window("main") {
                settings_store::window::restore_and_track(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rpc_call,
            runtime_subscribe,
            runtime_restart,
            workbench_log,
            workbench_ready,
            settings::settings_get,
            settings::settings_update,
            settings::settings_subscribe,
            settings::ui_state_get,
            settings::ui_state_update,
            settings::host_notices,
            dialogs::dialog_pick_folder,
            secret_store::secrets_set,
            secret_store::secrets_delete,
            secret_store::secrets_exists
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the Jesutobits Host");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let supervisor = handle.state::<Supervisor>();
            tauri::async_runtime::block_on(supervisor.shutdown());
        }
    });
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    /// Spike S3 found that Tauri injects its IPC into the preview iframe; only capability URL
    /// scoping refuses the frame's calls. So no capability may ever grant a remote URL, which
    /// would hand the untrusted preview the Workbench's commands (ADR-0010).
    #[test]
    fn capabilities_never_grant_remote_urls() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities");
        let mut checked = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            // JSON only, so this test sees every capability file.
            assert_eq!(
                path.extension().and_then(|e| e.to_str()),
                Some("json"),
                "{} is not JSON; this test cannot check it",
                path.display()
            );
            let capability: Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            assert!(
                capability.get("remote").is_none(),
                "{} grants IPC to remote URLs",
                path.display()
            );
            checked += 1;
        }
        assert!(checked > 0, "no capability files found");

        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        for capability in conf["app"]["security"]["capabilities"]
            .as_array()
            .into_iter()
            .flatten()
        {
            assert!(
                capability.get("remote").is_none(),
                "tauri.conf.json defines a capability with remote URLs"
            );
        }
    }
}
