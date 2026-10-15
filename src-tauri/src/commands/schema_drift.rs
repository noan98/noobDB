//! スキーマドリフト・タイムライン (#736 / #1260) の IPC コマンド。
//!
//! 取得 (`columns_for_database` / `indexes_for_database` の 2 クエリ)・正規化・
//! フィンガープリント・保存・前世代との差分計算を Rust 内で完結させ、フロントへは
//! 要約だけを返す。設計の詳細は `crate::schema_drift` のモジュール doc。
//! メタデータの読み取りのみで、クエリ履歴には記録されず、読み取り専用セッションでも
//! そのまま動く。

use serde::Serialize;
use tauri::State;

use crate::db::sync::{generate_sync_sql, SyncPlan};
use crate::error::{AppError, Result};
use crate::schema_drift::store::{self, LegacyGeneration};
use crate::schema_drift::{
    capture_payload, diff_indexes, schema_diff_between, summarize_payloads, DriftSummary,
    GenerationMeta, IndexDriftStatus, SnapshotPayload,
};
use crate::state::{AppState, Session};

/// `schema_drift_capture` の結果。
#[derive(Debug, Serialize)]
pub struct SchemaDriftCapture {
    /// 新しい世代が追加されたか (直前世代と同一内容なら false)。
    pub added: bool,
    /// 実際に取得した対象の名前。PostgreSQL ではプロファイルの DB 名が既定スキーマ
    /// (`current_schema()`) に解決される (#1537)。MySQL / SQLite は要求した名前のまま。
    pub database: String,
    /// 追加後の世代一覧 (新しい順)。`added` が false のときは空 (一覧は変わっていない)。
    pub generations: Vec<GenerationMeta>,
    /// 直前世代からの変化サマリ。初回取得・どちらかの世代が省略済み・追加なしのときは `None`。
    /// 変化が無ければ `tables` が空のサマリになる。
    pub summary: Option<DriftSummary>,
}

async fn session_of(state: &AppState, session_id: &str) -> Result<std::sync::Arc<Session>> {
    state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))
}

fn parse_id(id: &str) -> Result<i64> {
    id.parse::<i64>()
        .map_err(|_| AppError::InvalidInput(format!("invalid schema drift generation id '{id}'")))
}

/// 世代に紐づける実行 SQL の最大文字数。長大なスクリプトでタイムラインを重くしない。
const MAX_TRIGGER_SQL_CHARS: usize = 2000;

/// 世代に紐づける SQL を整える (純関数)。前後の空白を落とし、空なら `None`、長すぎるときは
/// 先頭 `MAX_TRIGGER_SQL_CHARS` 文字で切って `…` を付ける。
pub(crate) fn normalize_trigger_sql(sql: Option<&str>) -> Option<String> {
    let sql = sql?.trim();
    if sql.is_empty() {
        return None;
    }
    if sql.chars().count() <= MAX_TRIGGER_SQL_CHARS {
        return Some(sql.to_string());
    }
    let mut cut: String = sql.chars().take(MAX_TRIGGER_SQL_CHARS).collect();
    cut.push('…');
    Some(cut)
}

/// `database` の現在のスキーマを取得して世代として記録し、前世代からの変化サマリを返す。
///
/// `trigger_sql` は DDL の成功をきっかけにした自動取得のときに、そのとき実行した SQL
/// (#1537)。世代に紐づけて保存し、タイムラインで「どの文でスキーマが変わったか」を辿れる
/// ようにする。履歴を残さない接続 (`skip_history`) では SQL を保存しない。
#[tauri::command]
pub async fn schema_drift_capture(
    session_id: String,
    profile_id: String,
    database: String,
    trigger_sql: Option<String>,
    state: State<'_, AppState>,
) -> Result<SchemaDriftCapture> {
    let session = session_of(&state, &session_id).await?;
    let payload = capture_payload(&session.conn, &database).await?;
    let trigger_sql = if session.skip_history {
        None
    } else {
        normalize_trigger_sql(trigger_sql.as_deref())
    };
    let outcome = store::record(&profile_id, &payload, trigger_sql.as_deref()).await?;
    if !outcome.added {
        return Ok(SchemaDriftCapture {
            added: false,
            database: payload.database,
            generations: Vec::new(),
            summary: None,
        });
    }
    // 新世代がサイズ超過で省略された場合でも、比較には手元の `payload` を使える。
    let summary = outcome
        .prev
        .as_ref()
        .and_then(|p| p.payload.as_ref())
        // 対象 (DB / スキーマ) が前世代と違うと全テーブルが増減したように見えるので比べない
        // (PostgreSQL で DB 名のまま空を取っていた旧世代との境目など)。
        .and_then(|prev| summarize_if_same_target(prev, &payload));
    Ok(SchemaDriftCapture {
        added: true,
        database: payload.database,
        generations: store::list(&profile_id).await?,
        summary,
    })
}

/// プロファイルの世代一覧 (新しい順。保持上限はストア側のローテーション)。セッション不要。
#[tauri::command]
pub async fn schema_drift_list(profile_id: String) -> Result<Vec<GenerationMeta>> {
    store::list(&profile_id).await
}

/// 世代にラベルを付ける・外す (`label` が null / 空で外す, #1621)。セッション不要。
/// ラベル付きの世代はローテーションで消えない。世代が無ければ false。
#[tauri::command]
pub async fn schema_drift_set_label(
    profile_id: String,
    id: String,
    label: Option<String>,
) -> Result<bool> {
    store::set_label(&profile_id, parse_id(&id)?, label.as_deref()).await
}

/// 同じプロファイルの 2 世代 (`from_id` = 比較元、`to_id` = 比較先) の変化サマリ。
/// どちらかの世代が (サイズ超過で) 省略されている、存在しない、または対象 (DB / スキーマ)
/// が異なるときは `None` (対象が違うと全テーブルが増減したように見えるため。PostgreSQL で
/// 実 DB 名のまま空を取っていた旧世代との比較など, #1537)。
#[tauri::command]
pub async fn schema_drift_compare(
    profile_id: String,
    from_id: String,
    to_id: String,
) -> Result<Option<DriftSummary>> {
    let (from, to) = (parse_id(&from_id)?, parse_id(&to_id)?);
    let a = store::load(&profile_id, from).await?;
    let b = store::load(&profile_id, to).await?;
    match (a.and_then(|g| g.payload), b.and_then(|g| g.payload)) {
        (Some(a), Some(b)) => Ok(summarize_if_same_target(&a, &b)),
        _ => Ok(None),
    }
}

/// `schema_drift_revert_sql` の結果 (#1621)。
#[derive(Debug, Clone, Serialize)]
pub struct RevertSql {
    /// 現在の世代 (`to`) を戻したい世代 (`from`) の形へ戻す DDL と警告。
    pub plan: SyncPlan,
    /// `allow_destructive` が false のために出力しなかった破壊的な文 (DROP) の数。
    pub omitted_destructive: usize,
    /// 戻す対象のデータベース / スキーマ。
    pub database: String,
}

/// 巻き戻し DDL の本体 (純粋)。`from` を source、`to` を target として差分を取り、
/// 既存の `generate_sync_sql` で target を source に揃える DDL にする。インデックスの
/// 差分は同期 DDL が扱わないため、警告に列挙して手での対応を促す。
pub(crate) fn revert_plan(
    from: &SnapshotPayload,
    to: &SnapshotPayload,
    allow_destructive: bool,
) -> Result<RevertSql> {
    if from.driver != to.driver || from.database != to.database {
        return Err(AppError::InvalidInput(
            "generations target different databases or schemas".into(),
        ));
    }
    let diff = schema_diff_between(from, to);
    // 破壊的な文の数を数えるため、いったん全部生成してから許可されないものを外す。
    let mut plan = generate_sync_sql(&diff, true);
    let destructive = plan.statements.iter().filter(|s| s.destructive).count();
    let omitted_destructive = if allow_destructive {
        0
    } else {
        plan.statements.retain(|s| !s.destructive);
        destructive
    };
    for entry in diff_indexes(from, to) {
        let what = match entry.status {
            IndexDriftStatus::Added => "追加",
            IndexDriftStatus::Removed => "削除",
            IndexDriftStatus::Changed => "変更",
        };
        plan.warnings.push(format!(
            "表 {} のインデックス {} が{}されています。巻き戻し DDL にはインデックスの変更を含みません (手動で戻してください)",
            entry.table, entry.index_name, what
        ));
    }
    Ok(RevertSql {
        plan,
        omitted_destructive,
        database: to.database.clone(),
    })
}

/// 2 世代の差分を打ち消す DDL を生成する (#1621)。`from` = 戻したい世代、`to` = 現在側の世代で、
/// `to` の状態から `from` の状態へ戻す DDL を返す。DROP を含む文は `destructive` とし、
/// `allow_destructive` が false の間は出力しない (件数だけ `omitted_destructive` で返す)。
/// 世代の対象 (DB / スキーマ) が違う、またはどちらかのペイロードが省略されているときは拒否する。
/// 生成のみで実行はしない (適用は利用者が内容を確認してエディタから行う)。
#[tauri::command]
pub async fn schema_drift_revert_sql(
    profile_id: String,
    from_id: String,
    to_id: String,
    allow_destructive: bool,
) -> Result<RevertSql> {
    let (from, to) = (parse_id(&from_id)?, parse_id(&to_id)?);
    let a = store::load(&profile_id, from).await?;
    let b = store::load(&profile_id, to).await?;
    match (a.and_then(|g| g.payload), b.and_then(|g| g.payload)) {
        (Some(a), Some(b)) => revert_plan(&a, &b, allow_destructive),
        _ => Err(AppError::InvalidInput(
            "generation not found or its snapshot was omitted".into(),
        )),
    }
}

/// 2 つのペイロードの対象 (DB / スキーマ) が同じときだけ差分サマリを作る。
pub(crate) fn summarize_if_same_target(
    prev: &SnapshotPayload,
    next: &SnapshotPayload,
) -> Option<DriftSummary> {
    (prev.database == next.database).then(|| summarize_payloads(prev, next))
}

/// 旧 localStorage の世代 (新しい順) をストアへ一度だけ取り込む。既にこのプロファイルの
/// 世代があるときは何もしない。読めない世代は捨てる。取り込んだ件数を返す。
#[tauri::command]
pub async fn schema_drift_import_legacy(
    profile_id: String,
    generations: Vec<serde_json::Value>,
) -> Result<usize> {
    // 旧ストアの JSON は古いバージョンが書いたものを含みうるので、世代ごとに読み、
    // 読めないもの (必須フィールド欠落など) だけを捨てて残りを取り込む。
    let generations: Vec<LegacyGeneration> = generations
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();
    store::import_legacy(&profile_id, generations).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::DriverKind;

    fn payload(database: &str) -> SnapshotPayload {
        SnapshotPayload {
            driver: DriverKind::Postgres,
            database: database.to_string(),
            tables: Vec::new(),
        }
    }

    fn col(name: &str, ty: &str, key: &str) -> crate::db::types::TableColumnInfo {
        crate::db::types::TableColumnInfo {
            name: name.into(),
            data_type: ty.into(),
            nullable: key.is_empty(),
            key: key.into(),
            default: None,
            extra: String::new(),
            referenced_table: None,
            referenced_column: None,
            comment: None,
        }
    }

    fn table(
        name: &str,
        cols: Vec<crate::db::types::TableColumnInfo>,
    ) -> crate::schema_drift::SnapshotTable {
        crate::schema_drift::SnapshotTable {
            name: name.into(),
            columns: cols,
            indexes: Vec::new(),
        }
    }

    fn mysql_payload(tables: Vec<crate::schema_drift::SnapshotTable>) -> SnapshotPayload {
        SnapshotPayload {
            driver: DriverKind::Mysql,
            database: "app".into(),
            tables,
        }
    }

    /// #1621: 古い世代へ戻す DDL。追加された列は DROP COLUMN (破壊的)、
    /// 削除された列は ADD COLUMN になり、破壊的な文は許可があるときだけ出る。
    #[test]
    fn revert_plan_reverses_the_change_and_gates_destructive_statements() {
        let old = mysql_payload(vec![table(
            "users",
            vec![col("id", "int", "PRI"), col("legacy", "varchar(10)", "")],
        )]);
        // 新世代: legacy 列が消え、email 列とテーブル audit が増えた。
        let new = mysql_payload(vec![
            table(
                "users",
                vec![col("id", "int", "PRI"), col("email", "varchar(50)", "")],
            ),
            table("audit", vec![col("id", "int", "PRI")]),
        ]);
        let safe = revert_plan(&old, &new, false).unwrap();
        assert_eq!(safe.database, "app");
        assert!(safe.plan.statements.iter().all(|s| !s.destructive));
        assert!(safe
            .plan
            .statements
            .iter()
            .any(|s| s.sql.contains("ADD COLUMN") && s.sql.contains("legacy")));
        // DROP COLUMN email と DROP TABLE audit が省かれた。
        assert_eq!(safe.omitted_destructive, 2);

        let full = revert_plan(&old, &new, true).unwrap();
        assert_eq!(full.omitted_destructive, 0);
        let drops: Vec<&str> = full
            .plan
            .statements
            .iter()
            .filter(|s| s.destructive)
            .map(|s| s.sql.as_str())
            .collect();
        assert_eq!(drops.len(), 2);
        assert!(drops
            .iter()
            .any(|s| s.contains("DROP COLUMN") && s.contains("email")));
        assert!(drops
            .iter()
            .any(|s| s.contains("DROP TABLE") && s.contains("audit")));
    }

    #[test]
    fn revert_plan_rejects_different_targets_and_reports_index_changes() {
        let a = mysql_payload(vec![table("users", vec![col("id", "int", "PRI")])]);
        let mut other = a.clone();
        other.database = "other".into();
        assert!(revert_plan(&a, &other, false).is_err());
        let mut pg = a.clone();
        pg.driver = DriverKind::Postgres;
        assert!(revert_plan(&a, &pg, false).is_err());

        // インデックスだけが違う場合は DDL が空で、警告に出る。
        let mut with_index = a.clone();
        with_index.tables[0]
            .indexes
            .push(crate::db::types::IndexInfo {
                name: "idx_id".into(),
                columns: vec!["id".into()],
                unique: false,
                primary: false,
                method: Some("BTREE".into()),
                ..Default::default()
            });
        let plan = revert_plan(&a, &with_index, true).unwrap();
        assert!(plan.plan.statements.is_empty());
        assert!(plan.plan.warnings.iter().any(|w| w.contains("idx_id")));
        // 同一世代なら空。
        let same = revert_plan(&a, &a, true).unwrap();
        assert!(same.plan.statements.is_empty() && same.plan.warnings.is_empty());
    }

    #[test]
    fn summaries_are_only_made_for_the_same_target() {
        assert!(summarize_if_same_target(&payload("public"), &payload("public")).is_some());
        // 実 DB 名で空を取っていた旧世代と、既定スキーマの新世代は比べない。
        assert!(summarize_if_same_target(&payload("testdb"), &payload("public")).is_none());
    }

    #[test]
    fn normalize_trigger_sql_trims_and_drops_empty() {
        assert_eq!(normalize_trigger_sql(None), None);
        assert_eq!(normalize_trigger_sql(Some("  \n ")), None);
        assert_eq!(
            normalize_trigger_sql(Some("  ALTER TABLE t ADD c INT;\n")).as_deref(),
            Some("ALTER TABLE t ADD c INT;")
        );
    }

    #[test]
    fn normalize_trigger_sql_truncates_on_char_boundary() {
        let long = "あ".repeat(MAX_TRIGGER_SQL_CHARS + 10);
        let out = normalize_trigger_sql(Some(&long)).unwrap();
        assert_eq!(out.chars().count(), MAX_TRIGGER_SQL_CHARS + 1);
        assert!(out.ends_with('…'));
        let exact = "x".repeat(MAX_TRIGGER_SQL_CHARS);
        assert_eq!(normalize_trigger_sql(Some(&exact)).unwrap(), exact);
    }
}
