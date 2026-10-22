//! `settings.json` as the Host sees it (DATA_AND_PERSISTENCE.md section 5). The Zod schema
//! in `packages/protocol/src/settings.ts` is the Workbench's view of the same file; both run
//! `fixtures/settings/cases.json`, and the defaults are compared with the generated
//! `packages/protocol/generated/settings.defaults.json`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub schema_version: u32,
    pub workspace: Workspace,
    pub appearance: Appearance,
    pub terminal: Terminal,
    pub providers: Providers,
    pub agent: Agent,
    pub privacy: Privacy,
    pub developer: Developer,
    /// Sections this version does not know (from a newer Jesutobits), kept as they are.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Workspace {
    pub default_folder: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Appearance {
    pub theme: String,
    pub follow_os_theme: bool,
    pub reduce_motion: bool,
    pub ui_scale: f64,
    pub editor_font_size: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Terminal {
    pub shell: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Providers {
    pub openrouter: OpenRouter,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OpenRouter {
    pub enabled: bool,
    /// Which stored key: `provider:openrouter:<profile>`. Never the key itself.
    pub profile: String,
    pub default_model: Option<String>,
    pub options: OpenRouterOptions,
}

/// OpenRouter's own request options, in OpenRouter's (snake_case) field names.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct OpenRouterOptions {
    pub provider: ProviderRouting,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProviderRouting {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<Vec<String>>,
    pub allow_fallbacks: bool,
    pub data_collection: DataCollection,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DataCollection {
    Allow,
    #[default]
    Deny,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Agent {
    pub default_policy_preset: PolicyPreset,
    pub limits: Limits,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PolicyPreset {
    Cautious,
    #[default]
    Balanced,
    Autonomous,
}

/// AGENT_HARNESS.md section 3.4.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Limits {
    pub steps_per_turn: u32,
    pub tool_calls_per_turn: u32,
    pub turn_minutes: u32,
    pub cost_per_turn_usd: f64,
    pub cost_per_session_usd: f64,
    pub fix_attempts: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Privacy {
    pub log_model_traffic: bool,
    pub provider_attribution_headers: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Developer {
    pub extension_developer_mode: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            workspace: Workspace::default(),
            appearance: Appearance::default(),
            terminal: Terminal::default(),
            providers: Providers::default(),
            agent: Agent::default(),
            privacy: Privacy::default(),
            developer: Developer::default(),
            extra: Map::new(),
        }
    }
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            theme: "builtin.jesutobits-themes/dark".to_owned(),
            follow_os_theme: true,
            reduce_motion: false,
            ui_scale: 1.0,
            editor_font_size: None,
        }
    }
}

impl Default for OpenRouter {
    fn default() -> Self {
        Self {
            enabled: true,
            profile: "default".to_owned(),
            default_model: None,
            options: OpenRouterOptions::default(),
        }
    }
}

impl Default for ProviderRouting {
    fn default() -> Self {
        Self {
            order: None,
            allow_fallbacks: true,
            data_collection: DataCollection::Deny,
        }
    }
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            steps_per_turn: 40,
            tool_calls_per_turn: 150,
            turn_minutes: 30,
            cost_per_turn_usd: 1.0,
            cost_per_session_usd: 5.0,
            fix_attempts: 3,
        }
    }
}

impl Default for Terminal {
    fn default() -> Self {
        Self {
            shell: "auto".to_owned(),
        }
    }
}

impl Settings {
    /// Parses and checks a settings document. `Err` is a plain-language reason.
    pub fn from_value(value: Value) -> Result<Self, String> {
        let settings: Settings =
            serde_json::from_value(value).map_err(|error| format!("invalid settings: {error}"))?;
        settings.validate()?;
        Ok(settings)
    }

    /// The ranges in packages/protocol/src/settings.ts.
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(format!(
                "settings schema version {} is not {SCHEMA_VERSION}",
                self.schema_version
            ));
        }
        if self.workspace.default_folder.as_deref() == Some("") {
            return Err("the workspace folder cannot be empty".to_owned());
        }
        if self.appearance.theme.is_empty() {
            return Err("the theme cannot be empty".to_owned());
        }
        if !(0.9..=1.5).contains(&self.appearance.ui_scale) {
            return Err("the UI scale must be between 90% and 150%".to_owned());
        }
        if let Some(size) = self.appearance.editor_font_size {
            if !(8..=32).contains(&size) {
                return Err("the editor font size must be between 8 and 32".to_owned());
            }
        }
        if self.terminal.shell.is_empty() {
            return Err("the terminal shell cannot be empty".to_owned());
        }
        self.validate_providers()?;
        self.validate_limits()
    }

    fn validate_providers(&self) -> Result<(), String> {
        let openrouter = &self.providers.openrouter;
        let profile_ok = (1..=32).contains(&openrouter.profile.len())
            && openrouter
                .profile
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if !profile_ok {
            return Err("the key profile may use only a-z, 0-9 and hyphens".to_owned());
        }
        if openrouter.default_model.as_deref() == Some("") {
            return Err("the default model cannot be empty".to_owned());
        }
        let options = &openrouter.options;
        let names_ok = |names: &Option<Vec<String>>, max: usize| {
            names
                .as_ref()
                .is_none_or(|names| names.len() <= max && names.iter().all(|n| !n.is_empty()))
        };
        if !names_ok(&options.provider.order, 20) || !names_ok(&options.models, 10) {
            return Err("the OpenRouter options list empty names or too many".to_owned());
        }
        Ok(())
    }

    /// The ranges in AgentSettingsSchema.
    fn validate_limits(&self) -> Result<(), String> {
        let limits = &self.agent.limits;
        let checks = [
            (
                "steps per turn",
                (1..=1000).contains(&limits.steps_per_turn),
            ),
            (
                "tool calls per turn",
                (1..=5000).contains(&limits.tool_calls_per_turn),
            ),
            ("minutes per turn", (1..=600).contains(&limits.turn_minutes)),
            (
                "cost per turn",
                (0.01..=1000.0).contains(&limits.cost_per_turn_usd),
            ),
            (
                "cost per session",
                (0.01..=10_000.0).contains(&limits.cost_per_session_usd),
            ),
            ("fix attempts", (1..=10).contains(&limits.fix_attempts)),
        ];
        match checks.iter().find(|(_, ok)| !ok) {
            Some((name, _)) => Err(format!("the agent limit for {name} is out of range")),
            None => Ok(()),
        }
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("settings always serialise")
    }
}

/// Merges `patch` into `target`: objects merge key by key, anything else replaces.
pub fn merge(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(target), Value::Object(patch)) => {
            for (key, value) in patch {
                match target.get_mut(key) {
                    Some(existing) if existing.is_object() && value.is_object() => {
                        merge(existing, value)
                    }
                    _ => {
                        target.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (target, patch) => *target = patch.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(path: &str) -> Value {
        let full = format!("{}/../../../{path}", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(full).unwrap()).unwrap()
    }

    #[test]
    fn shared_cases() {
        let cases = fixture("fixtures/settings/cases.json");
        for case in cases["valid"].as_array().unwrap() {
            assert!(
                Settings::from_value(case["settings"].clone()).is_ok(),
                "should accept: {}",
                case["name"]
            );
        }
        for case in cases["invalid"].as_array().unwrap() {
            assert!(
                Settings::from_value(case["settings"].clone()).is_err(),
                "should reject: {}",
                case["name"]
            );
        }
    }

    /// Same fields and values as the Zod defaults, at every level.
    #[test]
    fn defaults_match_the_protocol() {
        let mut generated = fixture("packages/protocol/generated/settings.defaults.json");
        generated.as_object_mut().unwrap().remove("$comment");
        assert_same(&Settings::default().to_value(), &generated, "settings");
    }

    fn assert_same(rust: &Value, zod: &Value, at: &str) {
        match (rust, zod) {
            (Value::Object(a), Value::Object(b)) => {
                let mut keys_a: Vec<_> = a.keys().collect();
                let mut keys_b: Vec<_> = b.keys().collect();
                keys_a.sort();
                keys_b.sort();
                assert_eq!(keys_a, keys_b, "fields differ at {at}");
                for key in a.keys() {
                    assert_same(&a[key], &b[key], &format!("{at}.{key}"));
                }
            }
            // serde writes 1.0 where Zod's default is 1.
            (Value::Number(a), Value::Number(b)) => {
                assert_eq!(a.as_f64(), b.as_f64(), "value differs at {at}")
            }
            _ => assert_eq!(rust, zod, "value differs at {at}"),
        }
    }

    #[test]
    fn keeps_sections_from_newer_versions() {
        let settings = Settings::from_value(json!({ "companion": { "enabled": true } })).unwrap();
        assert_eq!(settings.to_value()["companion"], json!({ "enabled": true }));
    }

    #[test]
    fn merges_patches_deeply() {
        let mut value = Settings::default().to_value();
        merge(
            &mut value,
            &json!({ "appearance": { "uiScale": 1.25 }, "workspace": { "defaultFolder": "C:\\p" } }),
        );
        let settings = Settings::from_value(value).unwrap();
        assert_eq!(settings.appearance.ui_scale, 1.25);
        assert_eq!(settings.appearance.theme, "builtin.jesutobits-themes/dark");
        assert_eq!(settings.workspace.default_folder.as_deref(), Some("C:\\p"));
    }
}
