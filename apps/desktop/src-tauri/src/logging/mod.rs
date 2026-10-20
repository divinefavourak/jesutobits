//! Host log files (ARCHITECTURE.md section 10, NFR-014).
//!
//! The Host is the single writer of three JSON-lines files in the app log dir:
//! `host.jsonl` (its own lines), `workbench.jsonl` (lines the Workbench sends through
//! `workbench_log`) and `runtime.jsonl` (the runtime's stderr). Each rotates at 10 MB and
//! keeps 10 files. Every line passes through the [`Redactor`] first.
//!
//! Before [`init`] runs, or if the log dir cannot be opened, lines go to stderr only. Debug
//! builds also echo every line to stderr for `pnpm dev`.

mod redact;
mod rotating_file;
mod timestamp;

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde_json::{Map, Value};

pub use redact::Redactor;
use rotating_file::RotatingFile;

const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const FILES_KEPT: usize = 10;
/// Longest `msg` written; longer messages are cut at a character boundary.
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Error,
    Warn,
    Info,
    Debug,
    /// Only through `JESUTOBITS_HOST_LOG=trace` (ARCHITECTURE.md section 10).
    Trace,
}

impl Level {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "error" => Some(Self::Error),
            "warn" => Some(Self::Warn),
            "info" => Some(Self::Info),
            "debug" => Some(Self::Debug),
            "trace" => Some(Self::Trace),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warn => "warn",
            Self::Info => "info",
            Self::Debug => "debug",
            Self::Trace => "trace",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Component {
    Host,
    Workbench,
    Runtime,
}

impl Component {
    fn as_str(self) -> &'static str {
        match self {
            Self::Host => "host",
            Self::Workbench => "workbench",
            Self::Runtime => "runtime",
        }
    }
}

struct Sinks {
    host: Mutex<RotatingFile>,
    workbench: Mutex<RotatingFile>,
    runtime: Mutex<RotatingFile>,
}

pub struct Logger {
    /// Applies to the Host's own lines; the Workbench and runtime filter their own.
    level: Level,
    redactor: Redactor,
    sinks: Option<Sinks>,
    echo: bool,
}

static LOGGER: OnceLock<Logger> = OnceLock::new();

/// Opens the log files in `dir`. The level comes from `JESUTOBITS_HOST_LOG` (default `info`).
/// A second call is ignored.
pub fn init(dir: &Path) {
    let level = std::env::var("JESUTOBITS_HOST_LOG")
        .ok()
        .and_then(|text| Level::parse(&text))
        .unwrap_or(Level::Info);
    let logger = match Logger::open(dir, level, cfg!(debug_assertions)) {
        Ok(logger) => logger,
        Err(error) => {
            eprintln!(
                "[host] could not open log files in {}: {error}; logging to stderr only",
                dir.display()
            );
            Logger::stderr_only(level)
        }
    };
    if LOGGER.set(logger).is_ok() {
        info("logging", format!("log files in {}", dir.display()));
    }
}

fn logger() -> &'static Logger {
    LOGGER.get_or_init(|| Logger::stderr_only(Level::Info))
}

/// The redactor every log line passes through; the secret store registers values here.
#[allow(dead_code)] // The secret store (Phase 2) is the first caller.
pub fn redactor() -> &'static Redactor {
    &logger().redactor
}

pub fn error(module: &str, msg: impl AsRef<str>) {
    logger().host(Level::Error, module, msg.as_ref(), Map::new());
}

pub fn warn(module: &str, msg: impl AsRef<str>) {
    logger().host(Level::Warn, module, msg.as_ref(), Map::new());
}

pub fn info(module: &str, msg: impl AsRef<str>) {
    logger().host(Level::Info, module, msg.as_ref(), Map::new());
}

#[allow(dead_code)] // Used by later Host modules; kept with its siblings.
pub fn debug(module: &str, msg: impl AsRef<str>) {
    logger().host(Level::Debug, module, msg.as_ref(), Map::new());
}

/// A Host line with extra structured fields, for example durations or exit codes.
pub fn with_fields(level: Level, module: &str, msg: impl AsRef<str>, fields: Map<String, Value>) {
    logger().host(level, module, msg.as_ref(), fields);
}

/// A line from the Workbench (`workbench_log`). Unknown levels are logged as `info`, and
/// `trace` is refused because it is reserved for environment variables.
pub fn workbench(level: &str, msg: &str) {
    let level = match Level::parse(level) {
        Some(Level::Trace) | None => Level::Info,
        Some(level) => level,
    };
    logger().write(Component::Workbench, level, "workbench", msg, Map::new());
}

/// One line of the runtime's stderr. A JSON object with a valid `level` and a string `msg`
/// is kept as structured fields; anything else (for example Node's own crash output) is
/// logged as a `warn` line from module `stderr`.
pub fn runtime_stderr(line: &str) {
    logger().runtime_line(line);
}

impl Logger {
    fn open(dir: &Path, level: Level, echo: bool) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let sink = |stem| RotatingFile::open(dir, stem, MAX_FILE_BYTES, FILES_KEPT).map(Mutex::new);
        Ok(Self {
            level,
            redactor: Redactor::default(),
            sinks: Some(Sinks {
                host: sink("host")?,
                workbench: sink("workbench")?,
                runtime: sink("runtime")?,
            }),
            echo,
        })
    }

    fn stderr_only(level: Level) -> Self {
        Self {
            level,
            redactor: Redactor::default(),
            sinks: None,
            echo: true,
        }
    }

    fn host(&self, level: Level, module: &str, msg: &str, fields: Map<String, Value>) {
        if level <= self.level {
            self.write(Component::Host, level, module, msg, fields);
        }
    }

    fn runtime_line(&self, line: &str) {
        let structured = match serde_json::from_str::<Value>(line) {
            Ok(Value::Object(mut object)) => {
                let level = object
                    .get("level")
                    .and_then(Value::as_str)
                    .and_then(Level::parse);
                let msg = object.get("msg").and_then(Value::as_str).map(str::to_owned);
                match (level, msg) {
                    (Some(level), Some(msg)) => {
                        let module = match object.remove("module") {
                            Some(Value::String(module)) => module,
                            _ => "runtime".to_owned(),
                        };
                        // The Host owns these fields; the rest are the runtime's.
                        for key in ["ts", "level", "component", "msg"] {
                            object.remove(key);
                        }
                        Some((level, module, msg, object))
                    }
                    _ => None,
                }
            }
            _ => None,
        };
        match structured {
            Some((level, module, msg, fields)) => {
                self.write(Component::Runtime, level, &module, &msg, fields)
            }
            None => self.write(Component::Runtime, Level::Warn, "stderr", line, Map::new()),
        }
    }

    fn write(
        &self,
        component: Component,
        level: Level,
        module: &str,
        msg: &str,
        fields: Map<String, Value>,
    ) {
        let line = self.format(component, level, module, msg, fields);
        if self.echo {
            eprintln!(
                "[{}:{}] {module}: {}",
                component.as_str(),
                level.as_str(),
                self.redactor.redact(msg)
            );
        }
        let Some(sinks) = &self.sinks else { return };
        let sink = match component {
            Component::Host => &sinks.host,
            Component::Workbench => &sinks.workbench,
            Component::Runtime => &sinks.runtime,
        };
        if let Err(error) = sink.lock().unwrap().write_line(&line) {
            eprintln!("[host] could not write a log line: {error}");
        }
    }

    /// Builds one JSON line with every string value redacted, including nested extra
    /// fields. Redacting before serialisation also catches secrets that JSON would escape.
    fn format(
        &self,
        component: Component,
        level: Level,
        module: &str,
        msg: &str,
        fields: Map<String, Value>,
    ) -> String {
        let mut object = Map::new();
        object.insert("ts".into(), timestamp::now_rfc3339().into());
        object.insert("level".into(), level.as_str().into());
        object.insert("component".into(), component.as_str().into());
        object.insert("module".into(), module.into());
        // Redact before cutting, so a secret across the cut cannot leave a partial value.
        let msg = truncate(&self.redactor.redact(msg), MAX_MESSAGE_BYTES);
        object.insert("msg".into(), msg.into());
        for (key, value) in fields {
            object.entry(key).or_insert(value);
        }
        let mut value = Value::Object(object);
        self.redact_strings(&mut value);
        value.to_string()
    }

    fn redact_strings(&self, value: &mut Value) {
        match value {
            Value::String(text) => *text = self.redactor.redact(text),
            Value::Array(items) => items.iter_mut().for_each(|v| self.redact_strings(v)),
            Value::Object(map) => map.values_mut().for_each(|v| self.redact_strings(v)),
            _ => {}
        }
    }
}

fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated]", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_logger(name: &str, level: Level) -> (Logger, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "jesutobits-logger-test-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        (Logger::open(&dir, level, false).unwrap(), dir)
    }

    fn read(dir: &Path, stem: &str) -> Vec<Value> {
        std::fs::read_to_string(dir.join(format!("{stem}.jsonl")))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn writes_the_documented_fields() {
        let (logger, dir) = temp_logger("fields", Level::Info);
        let mut fields = Map::new();
        fields.insert("ms".into(), json!(183));
        logger.host(Level::Info, "runtime_supervisor", "runtime ready", fields);

        let lines = read(&dir, "host");
        assert_eq!(lines.len(), 1);
        let line = &lines[0];
        assert_eq!(line["level"], "info");
        assert_eq!(line["component"], "host");
        assert_eq!(line["module"], "runtime_supervisor");
        assert_eq!(line["msg"], "runtime ready");
        assert_eq!(line["ms"], 183);
        assert!(line["ts"].as_str().unwrap().ends_with('Z'));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn filters_host_lines_below_the_level() {
        let (logger, dir) = temp_logger("level", Level::Warn);
        logger.host(Level::Info, "m", "hidden", Map::new());
        logger.host(Level::Error, "m", "shown", Map::new());
        let lines = read(&dir, "host");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["msg"], "shown");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn redacts_messages_and_extra_fields() {
        let (logger, dir) = temp_logger("redact", Level::Info);
        logger
            .redactor
            .register("provider:test", "canary-0123456789");
        let mut fields = Map::new();
        fields.insert("header".into(), json!("Bearer canary-0123456789"));
        logger.host(
            Level::Info,
            "m",
            "key canary-0123456789 and sk-or-v1-0123456789abcdef0123",
            fields,
        );
        let raw = std::fs::read_to_string(dir.join("host.jsonl")).unwrap();
        assert!(!raw.contains("canary-0123456789"));
        assert!(!raw.contains("sk-or-v1"));
        let line = &read(&dir, "host")[0];
        assert_eq!(
            line["msg"],
            "key [REDACTED:provider:test] and [REDACTED:token]"
        );
        assert_eq!(line["header"], "Bearer [REDACTED:provider:test]");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn redacts_secrets_that_json_would_escape() {
        let (logger, dir) = temp_logger("escape", Level::Info);
        logger.redactor.register("k", r#"quote"and\slash"#);
        let mut fields = Map::new();
        fields.insert("nested".into(), json!({ "list": [r#"quote"and\slash"#] }));
        logger.host(Level::Info, "m", r#"x quote"and\slash y"#, fields);
        let line = &read(&dir, "host")[0];
        assert_eq!(line["msg"], "x [REDACTED:k] y");
        assert_eq!(line["nested"]["list"][0], "[REDACTED:k]");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn extra_fields_cannot_overwrite_the_documented_ones() {
        let (logger, dir) = temp_logger("override", Level::Info);
        let mut fields = Map::new();
        fields.insert("component".into(), json!("workbench"));
        logger.host(Level::Info, "m", "x", fields);
        assert_eq!(read(&dir, "host")[0]["component"], "host");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn truncates_long_messages_at_a_character_boundary() {
        let text = "é".repeat(MAX_MESSAGE_BYTES); // two bytes each
        let cut = truncate(&text, MAX_MESSAGE_BYTES - 1);
        assert!(cut.ends_with("…[truncated]"));
        assert!(cut.len() <= MAX_MESSAGE_BYTES - 1 + "…[truncated]".len());
    }

    #[test]
    fn workbench_lines_go_to_their_own_file() {
        let (logger, dir) = temp_logger("workbench", Level::Error);
        // The Host's level does not filter Workbench lines.
        logger.write(
            Component::Workbench,
            Level::Info,
            "workbench",
            "hi",
            Map::new(),
        );
        let lines = read(&dir, "workbench");
        assert_eq!(lines[0]["component"], "workbench");
        assert_eq!(lines[0]["msg"], "hi");
        assert!(read(&dir, "host").is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn keeps_structured_runtime_lines_and_wraps_the_rest() {
        let (logger, dir) = temp_logger("runtime", Level::Info);
        logger.runtime_line(
            r#"{"ts":"forged","level":"debug","component":"host","module":"rpc","msg":"handled","turnId":"trn_1"}"#,
        );
        logger.runtime_line("TypeError: boom");
        logger.runtime_line(r#"{"level":"loud","msg":"bad level"}"#);

        let lines = read(&dir, "runtime");
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["level"], "debug");
        assert_eq!(lines[0]["component"], "runtime");
        assert_eq!(lines[0]["module"], "rpc");
        assert_eq!(lines[0]["turnId"], "trn_1");
        assert_ne!(lines[0]["ts"], "forged");
        assert_eq!(lines[1]["module"], "stderr");
        assert_eq!(lines[1]["level"], "warn");
        assert_eq!(lines[1]["msg"], "TypeError: boom");
        assert_eq!(lines[2]["module"], "stderr");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
