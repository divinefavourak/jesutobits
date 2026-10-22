//! Provider keys in the OS credential store (SECURITY.md section 3, ADR-0008).
//!
//! The Workbench may set, delete and ask whether a secret exists, but has no command to read
//! one back. Only the runtime reads them, through the `host.secrets.get` reverse call, when it
//! is about to call the provider. Every value the Host handles is registered with the log
//! redactor, so it is masked if it ever reaches a log line.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::State;

use crate::logging;
use crate::rpc_relay::{rpc_error, APPLICATION_ERROR};

const MODULE: &str = "secret_store";
const INVALID_PARAMS: i64 = -32602;
pub const CODE_INVALID_PARAMS: &str = "rpc.invalid_params";
pub const CODE_UNAVAILABLE: &str = "storage.secrets_unavailable";
/// Longer values are not API keys; refusing them keeps the credential store tidy.
const MAX_VALUE_CHARS: usize = 4096;

/// Where secret values are kept. The OS store in the app; memory in tests.
pub trait Backend: Send + Sync {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String>;
    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String>;
    /// Deleting a secret that does not exist succeeds.
    fn delete(&self, service: &str, account: &str) -> Result<(), String>;
}

/// Windows Credential Manager, the macOS Keychain, or the Linux kernel keyring.
struct OsBackend;

impl Backend for OsBackend {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(service, account).map_err(|error| error.to_string())?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(service, account).map_err(|error| error.to_string())?;
        entry.set_password(value).map_err(|error| error.to_string())
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(service, account).map_err(|error| error.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

/// Keeps secrets only for the life of the process.
#[derive(Default)]
pub struct MemoryBackend {
    values: Mutex<HashMap<(String, String), String>>,
}

impl Backend for MemoryBackend {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        let key = (service.to_owned(), account.to_owned());
        Ok(self.values.lock().unwrap().get(&key).cloned())
    }

    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        let key = (service.to_owned(), account.to_owned());
        self.values.lock().unwrap().insert(key, value.to_owned());
        Ok(())
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        let key = (service.to_owned(), account.to_owned());
        self.values.lock().unwrap().remove(&key);
        Ok(())
    }
}

/// A refused request; `code` is a JesutobitsError code from packages/protocol.
#[derive(Debug, PartialEq)]
pub struct SecretError {
    pub code: &'static str,
    pub message: String,
}

impl SecretError {
    fn to_rpc(&self) -> Value {
        let code = if self.code == CODE_INVALID_PARAMS {
            INVALID_PARAMS
        } else {
            APPLICATION_ERROR
        };
        rpc_error(code, self.code, &self.message, false)
    }
}

fn invalid(message: &str) -> SecretError {
    SecretError {
        code: CODE_INVALID_PARAMS,
        message: message.to_owned(),
    }
}

fn unavailable(what: &str, reason: &str) -> SecretError {
    // The reason comes from the OS and never contains the value.
    logging::warn(MODULE, format!("could not {what}: {reason}"));
    SecretError {
        code: CODE_UNAVAILABLE,
        message: format!("The OS credential store could not {what}: {reason}"),
    }
}

/// `provider:<id>:<profile>` (ARCHITECTURE.md section 5.1), lower-case letters, digits and
/// hyphens. The reference is the credential store's account name.
pub fn check_ref(reference: &str) -> Result<(), SecretError> {
    let parts: Vec<&str> = reference.split(':').collect();
    let part_ok = |part: &str| {
        (1..=32).contains(&part.len())
            && part
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    };
    if parts.len() == 3 && parts[0] == "provider" && part_ok(parts[1]) && part_ok(parts[2]) {
        Ok(())
    } else {
        Err(invalid(
            "A secret reference looks like provider:<id>:<profile>",
        ))
    }
}

fn check_value(value: &str) -> Result<(), SecretError> {
    if value.trim().is_empty() {
        return Err(invalid("The secret is empty"));
    }
    if value.chars().count() > MAX_VALUE_CHARS {
        return Err(invalid("The secret is too long"));
    }
    if value.chars().any(char::is_control) {
        return Err(invalid(
            "The secret contains line breaks or control characters",
        ));
    }
    Ok(())
}

pub struct SecretStore {
    /// The credential store's service name: the app's bundle identifier.
    service: String,
    backend: Box<dyn Backend>,
}

impl SecretStore {
    pub fn new(service: &str, backend: Box<dyn Backend>) -> Self {
        Self {
            service: service.to_owned(),
            backend,
        }
    }

    /// The OS store, or memory when a debug build sets `JESUTOBITS_SECRET_STORE=memory`, so
    /// desktop tests never touch the user's credentials.
    pub fn for_app(identifier: &str) -> Self {
        if cfg!(debug_assertions)
            && std::env::var("JESUTOBITS_SECRET_STORE").as_deref() == Ok("memory")
        {
            logging::info(
                MODULE,
                "keeping secrets in memory (JESUTOBITS_SECRET_STORE)",
            );
            return Self::new(identifier, Box::new(MemoryBackend::default()));
        }
        Self::new(identifier, Box::new(OsBackend))
    }

    pub fn set(&self, reference: &str, value: &str) -> Result<(), SecretError> {
        check_ref(reference)?;
        // Leading and trailing spaces are paste accidents, never part of a key.
        let value = value.trim();
        check_value(value)?;
        logging::redactor().register(reference, value);
        self.backend
            .set(&self.service, reference, value)
            .map_err(|reason| unavailable("save the secret", &reason))?;
        logging::info(MODULE, format!("saved {reference}"));
        Ok(())
    }

    pub fn delete(&self, reference: &str) -> Result<(), SecretError> {
        check_ref(reference)?;
        self.backend
            .delete(&self.service, reference)
            .map_err(|reason| unavailable("delete the secret", &reason))?;
        logging::info(MODULE, format!("deleted {reference}"));
        Ok(())
    }

    pub fn exists(&self, reference: &str) -> Result<bool, SecretError> {
        Ok(self.get(reference)?.is_some())
    }

    /// For the runtime only (`host.secrets.get`); never exposed to the Workbench.
    pub fn get(&self, reference: &str) -> Result<Option<String>, SecretError> {
        check_ref(reference)?;
        let value = self
            .backend
            .get(&self.service, reference)
            .map_err(|reason| unavailable("read the secret", &reason))?;
        if let Some(value) = &value {
            logging::redactor().register(reference, value);
        }
        Ok(value)
    }
}

/// `host.secrets.get` (ADR-0003): `{ value }`, null when nothing is stored.
pub fn answer_get(store: &SecretStore, params: &Value) -> Result<Value, Value> {
    let Some(reference) = params["ref"].as_str() else {
        return Err(invalid("host.secrets.get needs a ref").to_rpc());
    };
    store
        .get(reference)
        .map(|value| json!({ "value": value }))
        .map_err(|error| error.to_rpc())
}

// Workbench commands (SECURITY.md section 8): write-only. Credential-store calls can block
// for a moment, so they run off the main thread.

#[tauri::command(async)]
pub fn secrets_set(
    secret_ref: String,
    value: String,
    store: State<'_, Arc<SecretStore>>,
) -> Result<(), Value> {
    store
        .set(&secret_ref, &value)
        .map_err(|error| error.to_rpc())
}

#[tauri::command(async)]
pub fn secrets_delete(secret_ref: String, store: State<'_, Arc<SecretStore>>) -> Result<(), Value> {
    store.delete(&secret_ref).map_err(|error| error.to_rpc())
}

#[tauri::command(async)]
pub fn secrets_exists(
    secret_ref: String,
    store: State<'_, Arc<SecretStore>>,
) -> Result<bool, Value> {
    store.exists(&secret_ref).map_err(|error| error.to_rpc())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> SecretStore {
        SecretStore::new("dev.jesutobits.test", Box::new(MemoryBackend::default()))
    }

    const REF: &str = "provider:openrouter:default";

    #[test]
    fn round_trips_and_deletes() {
        let store = store();
        assert_eq!(store.exists(REF), Ok(false));
        store.set(REF, "  sk-or-v1-abcdefghijklmnop  ").unwrap();
        assert_eq!(
            store.get(REF).unwrap().as_deref(),
            Some("sk-or-v1-abcdefghijklmnop")
        );
        assert_eq!(store.exists(REF), Ok(true));
        store.delete(REF).unwrap();
        store.delete(REF).unwrap();
        assert_eq!(store.get(REF), Ok(None));
    }

    #[test]
    fn checks_references() {
        for good in [REF, "provider:a:b", "provider:open-router:work-2"] {
            assert_eq!(check_ref(good), Ok(()), "{good}");
        }
        for bad in [
            "",
            "provider:openrouter",
            "provider:OpenRouter:default",
            "provider:openrouter:default:x",
            "secret:openrouter:default",
            "provider::default",
            "provider:open router:default",
            "provider:../x:default",
        ] {
            assert_eq!(
                check_ref(bad).unwrap_err().code,
                CODE_INVALID_PARAMS,
                "{bad}"
            );
        }
    }

    #[test]
    fn refuses_empty_long_and_multiline_values() {
        let store = store();
        for bad in [
            "",
            "   ",
            "sk-or\nsecond-line",
            &"x".repeat(MAX_VALUE_CHARS + 1),
        ] {
            assert_eq!(store.set(REF, bad).unwrap_err().code, CODE_INVALID_PARAMS);
        }
        assert_eq!(store.get(REF), Ok(None));
    }

    #[test]
    fn registers_values_for_redaction() {
        let store = store();
        store.set(REF, "sk-or-v1-redact-me-please").unwrap();
        let line = logging::redactor().redact("key is sk-or-v1-redact-me-please");
        assert!(!line.contains("redact-me-please"), "{line}");
    }

    #[test]
    fn answers_the_reverse_call() {
        let store = store();
        assert_eq!(
            answer_get(&store, &json!({ "ref": REF })),
            Ok(json!({ "value": null }))
        );
        store.set(REF, "sk-or-v1-abcdefghijklmnop").unwrap();
        assert_eq!(
            answer_get(&store, &json!({ "ref": REF })),
            Ok(json!({ "value": "sk-or-v1-abcdefghijklmnop" }))
        );
        let error = answer_get(&store, &json!({})).unwrap_err();
        assert_eq!(error["data"]["code"], CODE_INVALID_PARAMS);
        let error = answer_get(&store, &json!({ "ref": "nope" })).unwrap_err();
        assert_eq!(error["code"], INVALID_PARAMS);
    }

    /// The real OS store. Run with `cargo test -- --ignored keychain` (nightly desktop suite).
    #[test]
    #[ignore = "touches the OS credential store"]
    fn keychain_round_trip() {
        let store = SecretStore::new("dev.jesutobits.app.test", Box::new(OsBackend));
        let reference = "provider:jesutobits-test:keychain";
        store
            .set(reference, "sk-or-v1-keychain-round-trip")
            .unwrap();
        assert_eq!(
            store.get(reference).unwrap().as_deref(),
            Some("sk-or-v1-keychain-round-trip")
        );
        store.delete(reference).unwrap();
        assert_eq!(store.get(reference), Ok(None));
    }
}
