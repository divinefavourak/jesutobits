//! Jesutobits Host (ARCHITECTURE.md section 5.1).

mod logging;
mod rpc_relay;
mod runtime_supervisor;

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{Manager, RunEvent, State};

use rpc_relay::{allowlist, rpc_error, CODE_METHOD_NOT_ALLOWED, METHOD_NOT_FOUND};
use runtime_supervisor::{LaunchSpec, StatusUpdate, Supervisor};

/// How long a Workbench call may wait for the runtime. Long work streams events instead.
const WORKBENCH_CALL_TIMEOUT: Duration = Duration::from_secs(60);

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

/// The Workbench logs through the Host into `workbench.jsonl` (ARCHITECTURE.md section 10).
#[tauri::command]
fn workbench_log(level: String, message: String) {
    logging::workbench(&level, &message);
}

/// `JESUTOBITS_LOG_DIR` overrides the app log dir, like `JESUTOBITS_DATA_DIR` for data.
fn log_dir(app: &tauri::AppHandle) -> Result<PathBuf, tauri::Error> {
    match std::env::var_os("JESUTOBITS_LOG_DIR") {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => app.path().app_log_dir(),
    }
}

fn launch_spec(app: &tauri::AppHandle) -> Result<LaunchSpec, Box<dyn std::error::Error>> {
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

    let data_dir = match std::env::var_os("JESUTOBITS_DATA_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => app.path().app_data_dir()?,
    };
    std::fs::create_dir_all(&data_dir)?;

    Ok(LaunchSpec {
        node,
        entry,
        data_dir,
        use_job_object,
    })
}

pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            logging::init(&log_dir(app.handle())?);
            let supervisor = Supervisor::new();
            supervisor.start(launch_spec(app.handle())?);
            app.manage(supervisor);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rpc_call,
            runtime_subscribe,
            workbench_log
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
