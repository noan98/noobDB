//! 取り込みマッピングテンプレートの IPC (#1623)。保存先と上限は `import_templates::store`。

use crate::error::Result;
use crate::import_templates::store;
use crate::import_templates::ImportTemplate;

/// `profile_id` の接続・`database` の、`table` 用 (省略時は全テーブル分) の保存済みテンプレート。
#[tauri::command]
pub async fn list_import_templates(
    profile_id: String,
    database: Option<String>,
    table: Option<String>,
) -> Result<Vec<ImportTemplate>> {
    store::list(&profile_id, database.as_deref(), table.as_deref())
}

/// テンプレートを保存する。同じ (接続, データベース, テーブル) は置き換わる。
#[tauri::command]
pub async fn save_import_template(template: ImportTemplate) -> Result<ImportTemplate> {
    let now = chrono::Utc::now().timestamp_millis();
    store::save(template, now)
}

/// テンプレートを ID で削除する。
#[tauri::command]
pub async fn delete_import_template(id: String) -> Result<()> {
    store::delete(&id)
}
