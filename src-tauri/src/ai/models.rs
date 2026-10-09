//! モデル / タスク種別 / エフォートの定義と解決 (#690)。
//!
//! フロント `src/ai/aiModels.ts` と二重定義になっている (`aiParity.test.ts` が
//! ソースを読んで集合の一致を固定する)。モデル ID を IPC の呼び出し側が直接渡す
//! 経路は作らず、「タスク種別 + 設定スナップショット」からバックエンドで解決する。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// 選択できるモデル (固定の 4 つ)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AiModel {
    #[serde(rename = "claude-opus-5-5")]
    Opus55,
    #[serde(rename = "claude-sonnet-5-5")]
    Sonnet55,
    #[serde(rename = "claude-haiku-5-5")]
    Haiku55,
    #[serde(rename = "claude-fable-5-1")]
    Fable51,
}

impl AiModel {
    #[cfg(test)]
    pub const ALL: [AiModel; 4] = [
        AiModel::Opus55,
        AiModel::Sonnet55,
        AiModel::Haiku55,
        AiModel::Fable51,
    ];

    /// API に送るモデル ID。
    pub fn id(self) -> &'static str {
        match self {
            AiModel::Opus55 => "claude-opus-5-5",
            AiModel::Sonnet55 => "claude-sonnet-5-5",
            AiModel::Haiku55 => "claude-haiku-5-5",
            AiModel::Fable51 => "claude-fable-5-1",
        }
    }
}

/// `output_config.effort` の段階。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiEffort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl AiEffort {
    #[cfg(test)]
    pub const ALL: [AiEffort; 5] = [
        AiEffort::Low,
        AiEffort::Medium,
        AiEffort::High,
        AiEffort::Xhigh,
        AiEffort::Max,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            AiEffort::Low => "low",
            AiEffort::Medium => "medium",
            AiEffort::High => "high",
            AiEffort::Xhigh => "xhigh",
            AiEffort::Max => "max",
        }
    }
}

/// AI 機能のタスク種別。後続 Issue がここへ追加する (追加時は `recommended_*` の表と
/// フロント `AI_TASK_DEFS` も一緒に更新する)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiTaskKind {
    ConnectionTest,
    Generic,
    /// DB エラーの AI 解説と修正提案 (#692)。
    ErrorExplain,
    /// 自然言語から SQL 生成。
    Nl2sql,
    /// 実行計画の解釈。
    ExplainInterpret,
    /// 危険クエリの影響分析。
    ImpactAnalysis,
    /// SQL の解説。
    SqlExplain,
    /// SQL の最適化リライト。
    SqlRewrite,
    /// スキーマドキュメント生成。
    SchemaDoc,
    /// 同期 SQL のリスク要約。
    SyncRisk,
    /// テストデータ生成。
    TestData,
    /// 履歴の自然言語検索。
    HistorySearch,
}

impl AiTaskKind {
    #[cfg(test)]
    pub const ALL: [AiTaskKind; 12] = [
        AiTaskKind::ConnectionTest,
        AiTaskKind::Generic,
        AiTaskKind::ErrorExplain,
        AiTaskKind::Nl2sql,
        AiTaskKind::ExplainInterpret,
        AiTaskKind::ImpactAnalysis,
        AiTaskKind::SqlExplain,
        AiTaskKind::SqlRewrite,
        AiTaskKind::SchemaDoc,
        AiTaskKind::SyncRisk,
        AiTaskKind::TestData,
        AiTaskKind::HistorySearch,
    ];

    /// このタスク種別の推奨モデル (設定で上書きされない場合の目安。UI の「(推奨)」表示用)。
    // 推奨モデルの表の単一ソース。UI の「(推奨)」表示はフロント `AI_TASK_DEFS` が持ち、
    // `aiParity.test.ts` / 下のテストで一致を固定するため、本体からは呼ばれない。
    #[allow(dead_code)]
    pub fn recommended_model(self) -> AiModel {
        match self {
            AiTaskKind::ConnectionTest => AiModel::Opus55,
            AiTaskKind::Generic => AiModel::Opus55,
            AiTaskKind::ErrorExplain => AiModel::Opus55,
            AiTaskKind::Nl2sql => AiModel::Opus55,
            AiTaskKind::ExplainInterpret => AiModel::Opus55,
            AiTaskKind::ImpactAnalysis => AiModel::Opus55,
            AiTaskKind::SqlExplain => AiModel::Opus55,
            AiTaskKind::SqlRewrite => AiModel::Opus55,
            AiTaskKind::SchemaDoc => AiModel::Opus55,
            AiTaskKind::SyncRisk => AiModel::Opus55,
            AiTaskKind::TestData => AiModel::Opus55,
            AiTaskKind::HistorySearch => AiModel::Opus55,
        }
    }

    /// このタスク種別の推奨エフォート。`taskEfforts[kind]` が `null` のときに使う。
    pub fn recommended_effort(self) -> AiEffort {
        match self {
            AiTaskKind::ConnectionTest => AiEffort::Low,
            AiTaskKind::Generic => AiEffort::Medium,
            AiTaskKind::ErrorExplain => AiEffort::Low,
            AiTaskKind::Nl2sql => AiEffort::High,
            AiTaskKind::ExplainInterpret => AiEffort::High,
            AiTaskKind::ImpactAnalysis => AiEffort::High,
            AiTaskKind::SqlExplain => AiEffort::Medium,
            AiTaskKind::SqlRewrite => AiEffort::High,
            AiTaskKind::SchemaDoc => AiEffort::Medium,
            AiTaskKind::SyncRisk => AiEffort::High,
            AiTaskKind::TestData => AiEffort::Medium,
            AiTaskKind::HistorySearch => AiEffort::Low,
        }
    }
}

/// フロントの設定ストア (`ai.*`) から IPC 呼び出しごとに渡される設定スナップショット。
/// Rust 側に設定ストアは持たない。送信範囲 (`sendScope` / `allowRowData`) はプロンプトを
/// 組み立てるフロント側の責務なので、ここには含めない。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsSnapshot {
    pub enabled: bool,
    pub default_model: AiModel,
    /// `null` = 既定に従う。キーが無いタスク種別も同じ扱い。
    #[serde(default)]
    pub task_models: HashMap<AiTaskKind, Option<AiModel>>,
    /// `null` = 推奨エフォート。キーが無いタスク種別も同じ扱い。
    #[serde(default)]
    pub task_efforts: HashMap<AiTaskKind, Option<AiEffort>>,
}

/// `taskModels[kind] ?? defaultModel`。
pub fn resolve_model(kind: AiTaskKind, settings: &AiSettingsSnapshot) -> AiModel {
    settings
        .task_models
        .get(&kind)
        .copied()
        .flatten()
        .unwrap_or(settings.default_model)
}

/// `taskEfforts[kind] ?? 推奨エフォート`。
pub fn resolve_effort(kind: AiTaskKind, settings: &AiSettingsSnapshot) -> AiEffort {
    settings
        .task_efforts
        .get(&kind)
        .copied()
        .flatten()
        .unwrap_or_else(|| kind.recommended_effort())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> AiSettingsSnapshot {
        AiSettingsSnapshot {
            enabled: true,
            default_model: AiModel::Opus55,
            task_models: HashMap::new(),
            task_efforts: HashMap::new(),
        }
    }

    #[test]
    fn model_falls_back_to_default_when_unset_or_null() {
        let mut s = snapshot();
        assert_eq!(resolve_model(AiTaskKind::Generic, &s), AiModel::Opus55);
        s.task_models.insert(AiTaskKind::Generic, None);
        assert_eq!(resolve_model(AiTaskKind::Generic, &s), AiModel::Opus55);
        s.default_model = AiModel::Sonnet55;
        assert_eq!(resolve_model(AiTaskKind::Generic, &s), AiModel::Sonnet55);
    }

    #[test]
    fn task_model_overrides_default_only_for_that_task() {
        let mut s = snapshot();
        s.task_models
            .insert(AiTaskKind::ConnectionTest, Some(AiModel::Haiku55));
        assert_eq!(
            resolve_model(AiTaskKind::ConnectionTest, &s),
            AiModel::Haiku55
        );
        assert_eq!(resolve_model(AiTaskKind::Generic, &s), AiModel::Opus55);
    }

    #[test]
    fn effort_falls_back_to_recommended_per_task() {
        let mut s = snapshot();
        assert_eq!(
            resolve_effort(AiTaskKind::ConnectionTest, &s),
            AiEffort::Low
        );
        assert_eq!(resolve_effort(AiTaskKind::Generic, &s), AiEffort::Medium);
        s.task_efforts.insert(AiTaskKind::Generic, None);
        assert_eq!(resolve_effort(AiTaskKind::Generic, &s), AiEffort::Medium);
        s.task_efforts
            .insert(AiTaskKind::Generic, Some(AiEffort::Max));
        assert_eq!(resolve_effort(AiTaskKind::Generic, &s), AiEffort::Max);
        assert_eq!(
            resolve_effort(AiTaskKind::ConnectionTest, &s),
            AiEffort::Low
        );
    }

    #[test]
    fn recommended_model_is_opus_for_current_tasks() {
        for k in AiTaskKind::ALL {
            assert_eq!(k.recommended_model(), AiModel::Opus55);
        }
    }

    #[test]
    fn snapshot_deserializes_from_frontend_json() {
        let s: AiSettingsSnapshot = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "defaultModel": "claude-sonnet-5-5",
            "taskModels": { "connectionTest": "claude-haiku-5-5", "generic": null },
            "taskEfforts": { "connectionTest": null, "generic": "xhigh" }
        }))
        .unwrap();
        assert_eq!(
            resolve_model(AiTaskKind::ConnectionTest, &s),
            AiModel::Haiku55
        );
        assert_eq!(resolve_model(AiTaskKind::Generic, &s), AiModel::Sonnet55);
        assert_eq!(resolve_effort(AiTaskKind::Generic, &s), AiEffort::Xhigh);
    }

    #[test]
    fn unknown_model_id_is_rejected() {
        let r: Result<AiSettingsSnapshot, _> = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "defaultModel": "claude-unknown"
        }));
        assert!(r.is_err());
    }

    #[test]
    fn model_ids_match_serde_names() {
        for m in AiModel::ALL {
            assert_eq!(serde_json::to_value(m).unwrap(), m.id());
        }
        for e in AiEffort::ALL {
            assert_eq!(serde_json::to_value(e).unwrap(), e.as_str());
        }
    }
}
