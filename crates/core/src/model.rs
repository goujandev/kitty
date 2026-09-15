//! Models a harness says it can run.
//!
//! Always discovered, never hardcoded. Whatever the CLI reports for the user's
//! subscription is the truth, and it stays current without kitty shipping a
//! release (`MODEL-CATALOG.md`).

use serde::{Deserialize, Serialize};

use crate::HarnessId;

/// One model, as its CLI describes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// What kitty passes back to the CLI to select this model.
    ///
    /// Claude accepts aliases like `sonnet` alongside full names, and resolves
    /// them itself; storing what it gave us avoids guessing which form it
    /// wants later.
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    /// Reasoning effort levels this model accepts. Empty means it has none,
    /// which is a real answer: Haiku reports exactly that.
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
    /// The CLI's own default. Shown first, and used when nothing is chosen.
    pub is_default: bool,
}

/// Everything one harness can run, and when we asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    pub harness: HarnessId,
    pub models: Vec<ModelInfo>,
    /// Stamped so a CLI upgrade invalidates the cache rather than serving a
    /// list that predates the models it added.
    pub cli_version: String,
    pub fetched_at_ms: i64,
}

impl ModelCatalog {
    #[must_use]
    pub fn default_model(&self) -> Option<&ModelInfo> {
        self.models
            .iter()
            .find(|m| m.is_default)
            .or_else(|| self.models.first())
    }

    #[must_use]
    pub fn find(&self, id: &str) -> Option<&ModelInfo> {
        self.models.iter().find(|m| m.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::{ModelCatalog, ModelInfo};
    use crate::HarnessId;

    fn model(id: &str, is_default: bool) -> ModelInfo {
        ModelInfo {
            id: id.into(),
            display_name: id.into(),
            description: None,
            efforts: Vec::new(),
            default_effort: None,
            is_default,
        }
    }

    fn catalog(models: Vec<ModelInfo>) -> ModelCatalog {
        ModelCatalog {
            harness: HarnessId::Claude,
            models,
            cli_version: "2.1.270".into(),
            fetched_at_ms: 0,
        }
    }

    #[test]
    fn the_cli_default_wins_over_position() {
        let c = catalog(vec![model("first", false), model("second", true)]);
        assert_eq!(c.default_model().map(|m| m.id.as_str()), Some("second"));
    }

    #[test]
    fn without_a_flagged_default_the_first_model_is_used() {
        let c = catalog(vec![model("first", false), model("second", false)]);
        assert_eq!(c.default_model().map(|m| m.id.as_str()), Some("first"));
    }

    #[test]
    fn an_empty_catalog_has_no_default() {
        assert!(catalog(Vec::new()).default_model().is_none());
    }

    #[test]
    fn a_model_can_be_found_by_id() {
        let c = catalog(vec![model("sonnet", false)]);
        assert!(c.find("sonnet").is_some());
        assert!(c.find("nope").is_none());
    }
}
