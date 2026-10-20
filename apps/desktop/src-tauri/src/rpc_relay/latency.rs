//! Spike S1 measurement: what the Host relay adds per message (NFR-006), without the webview.
//!
//! Drives the real runtime bundle through [`Connection`] the way the supervisor does, and
//! reports round-trip percentiles. Compare with `scripts/spikes/s1-stdio-latency.mjs` (no
//! Host) to get the relay's share. Ignored by default:
//!
//!   pnpm build:runtime
//!   cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml relay_latency -- --ignored --nocapture

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use tokio::io::BufReader;
use tokio::process::Command;

use super::lines::{read_line_capped, Line};
use super::{allowlist, Connection, MAX_MESSAGE_BYTES};

fn percentile(sorted: &[f64], p: f64) -> f64 {
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "measurement; run explicitly with --ignored --nocapture"]
async fn relay_latency() {
    let bundle = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/runtime/dist/bundle/runtime.mjs"
    );
    let node = std::env::var("JESUTOBITS_NODE").unwrap_or_else(|_| "node".to_owned());
    let mut child = Command::new(node)
        .arg(bundle)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn the runtime bundle (run `pnpm build:runtime`)");

    let connection = Arc::new(Connection::new(
        Box::new(child.stdin.take().unwrap()),
        Box::new(|_| {}),
    ));
    let reader = connection.clone();
    let stdout = child.stdout.take().unwrap();
    tokio::spawn(async move {
        let mut stdout = BufReader::new(stdout);
        let mut line = Vec::new();
        while let Ok(Line::Complete) =
            read_line_capped(&mut stdout, &mut line, MAX_MESSAGE_BYTES).await
        {
            reader.handle_line(&line).await;
        }
    });

    let timeout = Duration::from_secs(5);
    let params = json!({ "protocolVersion": allowlist::PROTOCOL_VERSION, "client": { "name": "latency", "version": "0" } });
    connection
        .call("runtime.initialize", params, timeout)
        .await
        .expect("handshake");

    for bytes in [16usize, 1024, 65_536] {
        let echo = "x".repeat(bytes);
        let params = json!({ "echo": echo });
        for _ in 0..50 {
            connection
                .call("runtime.ping", params.clone(), timeout)
                .await
                .unwrap();
        }
        let mut samples: Vec<f64> = Vec::with_capacity(1000);
        for _ in 0..1000 {
            let start = Instant::now();
            let reply = connection
                .call("runtime.ping", params.clone(), timeout)
                .await
                .unwrap();
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(reply["echo"].as_str().map(str::len), Some(bytes));
        }
        samples.sort_by(f64::total_cmp);
        println!(
            "[bench] host-relay {{\"bytes\":{bytes},\"p50\":{:.3},\"p95\":{:.3},\"p99\":{:.3},\"max\":{:.3}}}",
            percentile(&samples, 50.0),
            percentile(&samples, 95.0),
            percentile(&samples, 99.0),
            samples[samples.len() - 1],
        );
    }
}
