//! Masks secrets before anything reaches a log file (SECURITY.md section 6.1).
//!
//! Two layers: exact values of known secrets (registered by the secret store, Phase 2),
//! replaced with `[REDACTED:<ref>]`, then common token shapes as defence in depth. The token
//! patterns are shared with the runtime's masker through `fixtures/redaction/cases.json`.

use std::sync::{OnceLock, RwLock};

use regex::Regex;

/// Shorter values would mask ordinary text everywhere they occur.
const MIN_SECRET_LEN: usize = 8;

fn patterns() -> &'static [(Regex, &'static str)] {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            // A block without its END line is masked to the end of the text.
            (
                r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)",
                "[REDACTED:private-key]",
            ),
            (r"\bsk-[A-Za-z0-9_-]{16,}", "[REDACTED:token]"),
            (r"\bgh[pousr]_[A-Za-z0-9]{20,}", "[REDACTED:token]"),
            (r"\bgithub_pat_[A-Za-z0-9_]{20,}", "[REDACTED:token]"),
            (r"\bAKIA[0-9A-Z]{16}\b", "[REDACTED:token]"),
            (r"\bxox[abprs]-[A-Za-z0-9-]{10,}", "[REDACTED:token]"),
            (
                r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
                "[REDACTED:token]",
            ),
        ]
        .into_iter()
        .map(|(pattern, replacement)| (Regex::new(pattern).expect("valid pattern"), replacement))
        .collect()
    })
}

#[derive(Default)]
pub struct Redactor {
    /// `(reference, value)`, longest value first so a secret containing another is masked whole.
    secrets: RwLock<Vec<(String, String)>>,
}

impl Redactor {
    /// Remembers a secret's value so every later line masks it. Returns false, and
    /// remembers nothing, for values too short to mask safely.
    #[allow(dead_code)] // The secret store (Phase 2) is the first caller.
    pub fn register(&self, reference: &str, value: &str) -> bool {
        if value.len() < MIN_SECRET_LEN {
            return false;
        }
        let mut secrets = self.secrets.write().unwrap();
        secrets.retain(|(r, _)| r != reference);
        secrets.push((reference.to_owned(), value.to_owned()));
        secrets.sort_by_key(|(_, v)| std::cmp::Reverse(v.len()));
        true
    }

    pub fn redact(&self, text: &str) -> String {
        let mut text = text.to_owned();
        for (reference, value) in self.secrets.read().unwrap().iter() {
            if text.contains(value.as_str()) {
                text = text.replace(value.as_str(), &format!("[REDACTED:{reference}]"));
            }
        }
        for (pattern, replacement) in patterns() {
            if let std::borrow::Cow::Owned(replaced) = pattern.replace_all(&text, *replacement) {
                text = replaced;
            }
        }
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn shared_pattern_cases() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../fixtures/redaction/cases.json"
        );
        let cases: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let redactor = Redactor::default();
        let cases = cases["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            assert_eq!(
                redactor.redact(case["input"].as_str().unwrap()),
                case["expected"].as_str().unwrap(),
                "case: {}",
                case["name"]
            );
        }
    }

    #[test]
    fn masks_registered_secrets_by_reference() {
        let redactor = Redactor::default();
        assert!(redactor.register("provider:openrouter:default", "canary-value-123"));
        assert_eq!(
            redactor.redact("sent canary-value-123 twice: canary-value-123"),
            "sent [REDACTED:provider:openrouter:default] twice: [REDACTED:provider:openrouter:default]"
        );
    }

    #[test]
    fn masks_the_longer_secret_whole() {
        let redactor = Redactor::default();
        redactor.register("short", "abcdefgh");
        redactor.register("long", "abcdefgh-and-more");
        assert_eq!(redactor.redact("abcdefgh-and-more"), "[REDACTED:long]");
    }

    #[test]
    fn re_registering_a_reference_replaces_its_value() {
        let redactor = Redactor::default();
        redactor.register("k", "old-value-1");
        redactor.register("k", "new-value-2");
        assert_eq!(redactor.redact("old-value-1"), "old-value-1");
        assert_eq!(redactor.redact("new-value-2"), "[REDACTED:k]");
    }

    #[test]
    fn refuses_values_too_short_to_mask() {
        let redactor = Redactor::default();
        assert!(!redactor.register("k", "abc"));
        assert_eq!(redactor.redact("abc"), "abc");
    }
}
