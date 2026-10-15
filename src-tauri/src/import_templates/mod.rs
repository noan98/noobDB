//! 取り込みのマッピングテンプレート (#1623)。接続 (プロファイル) × データベース × テーブル
//! 単位で、列マッピング・区切り文字・NULL トークン・文字コード・キー列などを保存し、次回
//! 同じテーブルへ取り込むときに候補として提示する。**秘密情報は含まない** (ファイルのパスも
//! 持たない)。保存先は data_dir の `import_templates.json` (非秘密の JSON ストア)。

pub mod store;

use serde::{Deserialize, Serialize};

/// テンプレートの 1 列ぶんの対応。ヘッダーがあるファイルでは `header` (ファイル側の列名) で
/// 次回のファイルの列位置を引き直し、見つからなければ `csv_index` に頼る。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateColumn {
    /// 取り込み先のテーブル列名。
    pub column: String,
    /// ファイル側の列名 (ヘッダー行があったとき)。
    #[serde(default)]
    pub header: Option<String>,
    /// 保存時のファイル側の列位置 (0 始まり)。
    pub csv_index: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTemplate {
    /// `profile_id` / `database` / `table` から決まる安定キー (保存時に計算する)。
    #[serde(default)]
    pub id: String,
    pub profile_id: String,
    #[serde(default)]
    pub database: Option<String>,
    pub table: String,
    /// `csv` / `json` / `ndjson` / `xlsx`。
    pub format: String,
    pub delimiter: String,
    pub quote: String,
    pub has_header: bool,
    #[serde(default)]
    pub null_token: Option<String>,
    pub encoding: String,
    #[serde(default)]
    pub sheet: Option<String>,
    /// `insert` / `skip` / `update`。
    #[serde(default)]
    pub conflict_mode: Option<String>,
    /// `abort` / `skip`。
    #[serde(default)]
    pub error_mode: Option<String>,
    #[serde(default)]
    pub key_columns: Vec<String>,
    pub mapping: Vec<TemplateColumn>,
    /// 保存時刻 (UNIX ミリ秒)。古いものから間引く基準。
    #[serde(default)]
    pub updated_at_ms: i64,
}

impl ImportTemplate {
    /// 同じ (接続, データベース, テーブル) には 1 件だけ持つので、その組から ID を作る。
    pub fn key_for(profile_id: &str, database: Option<&str>, table: &str) -> String {
        format!("{profile_id}\u{1f}{}\u{1f}{table}", database.unwrap_or(""))
    }
}
