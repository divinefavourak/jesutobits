fn main() {
    // Declaring the app's commands makes each one a capability permission, so the main
    // window can call only what capabilities/main.json grants (NFR-008).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "rpc_call",
            "runtime_subscribe",
            "runtime_restart",
            "workbench_log",
            "workbench_ready",
        ]),
    ))
    .expect("failed to run tauri-build");
}
