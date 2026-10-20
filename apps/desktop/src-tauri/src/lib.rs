//! Jesutobits Host (ARCHITECTURE.md section 5.1).

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
const MAX_LOG_MESSAGE_BYTES: usize = 16 * 1024;

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

/// The Workbench logs through the Host (ARCHITECTURE.md section 10). Log files and
/// redaction arrive in Phase 1; until then lines go to the Host's stderr.
#[tauri::command]
fn workbench_log(level: String, message: String) {
    let level = match level.as_str() {
        "error" | "warn" | "info" | "debug" => level,
        _ => "info".to_owned(),
    };
    let mut end = message.len().min(MAX_LOG_MESSAGE_BYTES);
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    eprintln!("[workbench:{level}] {}", &message[..end]);
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
