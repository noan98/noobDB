//! 重複レコードのマージ (#2303) の純粋層 — 型・条件式・SQL 生成・判定。I/O は持たない。
//!
//! マージは「残す行 (survivor) に子テーブルの参照を付け替え → 重複行 (loser) を DELETE →
//! 残す行の列値を選んだ行の値で整える」を 1 トランザクションで行う。この順にする理由:
//!
//! 1. 子の付け替えが先 — 重複行を先に消すと `ON DELETE CASCADE` が子行まで消し、`RESTRICT` は失敗する。
//! 2. 重複行の DELETE が次 — 残す行へ重複行の UNIQUE な値 (メールアドレスなど) を持ち込む UPDATE が、
//!    まだ存在する重複行と衝突しないようにする。
//! 3. 残す行の UPDATE が最後。
//!
//! 実際に DB を読み書きする側は `commands::row_merge`。ここは「読んだ行から何を組み立てるか」だけを持つので、
//! 3 ドライバ共通の SQL 生成を DB 無しでテストできる。リテラルは `data_diff::sql_literal` /
//! `subset::key_literal` (方言別エスケープの単一実装) に任せる。

use serde::{Deserialize, Serialize};

use super::subset::key_literal;
use super::sync::quote_ident;
use super::types::{IndexInfo, TableColumnInfo, Value};
use super::DriverKind;

/// マージに選べる行数 (残す行 + 重複行) の上限。条件式の `OR` が深くなりすぎない範囲に収める
/// (SQLite の式の深さ上限 1000 に対して十分小さい)。
pub const MAX_MERGE_ROWS: usize = 50;
/// 衝突を列挙して扱う件数の上限 (衝突キーのグループ数)。これを超えたら止める。
pub const MAX_CONFLICT_GROUPS: usize = 200;
/// 1 文の `OR` に並べる行条件の数。
pub const COND_CHUNK: usize = 100;

/// 子側の UNIQUE / PK が付け替えで重なるときの扱い。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    /// 中止 (既定)。何も書かずに衝突を報告する。
    #[default]
    Abort,
    /// 重なる子行 (残す行の側に同じキーが既にある、または重複行どうしで重なる行) を削除する。
    DeleteColliding,
    /// 重なる子行だけ付け替えを飛ばす (重複行を消すときの `ON DELETE` に任せる)。
    SkipRepoint,
}

/// 残す行の列値を、どの行から採るか。`from_row` は `[残す行, 重複行 1, 重複行 2, …]` の添字。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowMergePick {
    pub column: String,
    pub from_row: usize,
}

/// マージの指定 (プレビューも実行も同じ形)。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowMergeRequest {
    /// 行を特定するキー列 (主キー、無ければ NOT NULL の UNIQUE キー)。
    pub key_columns: Vec<String>,
    /// 残す行のキー値 (`key_columns` と同順)。
    pub survivor: Vec<Value>,
    /// 消す行のキー値。
    pub losers: Vec<Vec<Value>>,
    /// 列ごとの採用元。省略 (`None`) なら提案値 (残す行、NULL なら他の行で補う)。
    /// 指定した列以外は残す行の値のまま。
    #[serde(default)]
    pub picks: Option<Vec<RowMergePick>>,
    #[serde(default)]
    pub conflict_policy: ConflictPolicy,
    /// プレビューで見せた計画。実行の直前に立て直した計画と食い違えば、何も書かずに `changed` を返す。
    /// プレビューには使わない。
    #[serde(default)]
    pub expected: Option<RowMergeExpected>,
}

/// プレビューで利用者に見せた計画 (実行時の照合用)。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowMergeExpected {
    /// 実行する文 (順番どおり)。
    pub statements: Vec<String>,
    /// 子の外部キーごとの (付け替え + 飛ばす + 削除) 行数。`children` と同じ順。
    pub child_rows: Vec<u64>,
}

/// マージを実行できない理由。UI が翻訳して表示する。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MergeBlocker {
    /// キー列が表の主キーでも UNIQUE キーでもない (行を一意に特定できない)。
    NoKey,
    #[serde(rename_all = "camelCase")]
    TooManyRows { max: usize },
    /// 同じ行を重複して選んでいる (残す行が重複行にも入っているなど)。
    DuplicateSelection,
    /// 選んだ行が DB に無い (他で削除された)。
    #[serde(rename_all = "camelCase")]
    RowNotFound { index: usize },
    /// 表のエンジンがトランザクションを持たない (MySQL の MyISAM など)。
    #[serde(rename_all = "camelCase")]
    UnsupportedEngine { engine: String },
    /// 残す行の参照先の列が NULL で、子を付け替えられない。
    #[serde(rename_all = "camelCase")]
    NullReference { table: String, column: String },
    /// 自己参照の列が、マージで消える行 (または残す行自身) を指してしまう。
    #[serde(rename_all = "camelCase")]
    SelfReference { table: String, column: String },
    /// 付け替えで子側の UNIQUE / PK が重なる (扱いが「中止」のとき)。
    #[serde(rename_all = "camelCase")]
    UniqueConflict {
        table: String,
        index: String,
        groups: u64,
    },
    /// 衝突が多すぎて列挙しきれない。
    #[serde(rename_all = "camelCase")]
    TooManyConflicts { table: String, index: String },
    /// 付け替えを飛ばした子行が、重複行の DELETE で失敗する (`ON DELETE` が連鎖でも NULL 化でもない)。
    #[serde(rename_all = "camelCase")]
    SkipUnsafe { table: String },
    /// 採用元を選べない列 (キー列・他の表から参照されている列・生成列) を別の行から採ろうとしている。
    #[serde(rename_all = "camelCase")]
    LockedPick { column: String },
    /// 採用元の指定が不正 (存在しない列・範囲外の行)。
    #[serde(rename_all = "camelCase")]
    InvalidPick { column: String },
    /// 子テーブルの外部キーの参照先の列を決められない。
    #[serde(rename_all = "camelCase")]
    UnresolvedForeignKey { table: String, constraint: String },
    /// 子テーブルの列メタデータを取得できない。
    #[serde(rename_all = "camelCase")]
    ChildUnreadable { table: String },
    /// 別のデータベースの子テーブルが `ON DELETE CASCADE / SET NULL / SET DEFAULT` で参照している (MySQL)。
    /// 辿れないので、重複行の DELETE で黙って消える / NULL になるのを防ぐために止める。
    #[serde(rename_all = "camelCase")]
    CrossDatabaseCascade { schema: String, table: String },
    /// 削除する子行 (衝突で消す行・付け替えを飛ばして連鎖で消える行) を、さらに別の表が
    /// `ON DELETE CASCADE / SET NULL / SET DEFAULT` で参照している。孫の行が黙って消え、Undo にも残らない。
    #[serde(rename_all = "camelCase")]
    DeletedChildReferenced { table: String, referencing: String },
    /// 外部キー検査が無効 (SQLite の `PRAGMA foreign_keys = OFF`) なので、付け替えを飛ばすと
    /// 重複行の DELETE で連鎖が働かず孤児行が残る。
    #[serde(rename_all = "camelCase")]
    SkipWithoutForeignKeys { table: String },
}

/// マージは実行できるが注意が要ること。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MergeWarning {
    /// 別のデータベースの子テーブルは辿れない (MySQL)。参照が残っていれば DELETE が失敗して全体がロールバックされる。
    #[serde(rename_all = "camelCase")]
    CrossDatabaseChild { table: String },
    /// 部分インデックス・式インデックスなど、衝突を事前に検出できない一意制約。DB が拒否すれば全体をロールバックする。
    #[serde(rename_all = "camelCase")]
    UncheckedIndex { table: String, index: String },
}

/// Undo (フライトレコーダー記録) を残せない理由。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UndoDecline {
    /// 子テーブルに主キー (UNIQUE キー) が無く、行を特定して元に戻せない。
    #[serde(rename_all = "camelCase")]
    ChildWithoutKey { table: String },
    /// 記録する行数が上限を超える。
    #[serde(rename_all = "camelCase")]
    TooManyRows { limit: u64 },
    /// 別スキーマの子テーブルがある (1 つの記録バッチは 1 スキーマに限られる)。
    #[serde(rename_all = "camelCase")]
    CrossSchemaChild { table: String },
}

/// 子テーブル側の外部キー 1 本 (複合キーは列を並べて 1 本)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildEdge {
    /// 子テーブルのデータベース / スキーマ。親と同じなら親の値。
    pub child_db: String,
    pub child: String,
    pub constraint: String,
    pub child_cols: Vec<String>,
    /// 参照先 (親) の列。`child_cols` と同順。
    pub parent_cols: Vec<String>,
    pub on_delete: Option<String>,
}

/// 値を比べるための正規化した文字列。型の違い (`Int(5)` と `String("5")`) を吸収する。
pub fn norm_sig(v: &Value) -> String {
    match v {
        Value::Null => "\u{0}NULL".to_string(),
        Value::Bool(b) => (if *b { "1" } else { "0" }).to_string(),
        Value::Int(i) => i.to_string(),
        Value::UInt(u) => u.to_string(),
        Value::Float(f) => f.to_string(),
        Value::String(s) => s.clone(),
        Value::Bytes(h) => h.to_ascii_lowercase(),
    }
}

/// 値の並びの正規化したシグネチャ (区切りで連結)。
pub fn sig(vals: &[Value]) -> String {
    vals.iter().map(norm_sig).collect::<Vec<_>>().join("\u{1f}")
}

/// `col = lit AND col2 IS NULL …`。型は `types` (列と同順) でリテラルの書き方を決める。
pub fn eq_cond(driver: DriverKind, cols: &[String], types: &[String], vals: &[Value]) -> String {
    cols.iter()
        .zip(vals)
        .enumerate()
        .map(|(i, (c, v))| match v {
            Value::Null => format!("{} IS NULL", quote_ident(driver, c)),
            _ => format!(
                "{} = {}",
                quote_ident(driver, c),
                key_literal(driver, types.get(i).map_or("", String::as_str), v)
            ),
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// 条件式を `(a) OR (b) …` で繋ぐ。空なら `None`。
pub fn or_conds(conds: &[String]) -> Option<String> {
    if conds.is_empty() {
        return None;
    }
    Some(
        conds
            .iter()
            .map(|c| format!("({c})"))
            .collect::<Vec<_>>()
            .join(" OR "),
    )
}

/// 親の行 (全列) から `cols` の値を取り出す。
pub fn pick_values(columns: &[String], row: &[Value], cols: &[String]) -> Option<Vec<Value>> {
    cols.iter()
        .map(|c| {
            columns
                .iter()
                .position(|n| n.eq_ignore_ascii_case(c))
                .and_then(|i| row.get(i).cloned())
        })
        .collect()
}

/// 子テーブルで「重複行を参照している行」の条件。参照先の値のどれかが NULL の重複行は何も参照されない
/// (`MATCH SIMPLE`) ので除く。1 行も無ければ `None`。
pub fn loser_match_cond(
    driver: DriverKind,
    edge: &ChildEdge,
    child_types: &[String],
    loser_ref_values: &[Vec<Value>],
) -> Option<String> {
    let conds: Vec<String> = loser_ref_values
        .iter()
        .filter(|v| v.iter().all(|x| !matches!(x, Value::Null)))
        .map(|v| eq_cond(driver, &edge.child_cols, child_types, v))
        .collect();
    or_conds(&conds)
}

/// 子の付け替え `UPDATE child SET fk = 残す行の値 WHERE (重複行を参照) [AND NOT (除外する行)]`。
pub fn repoint_sql(
    driver: DriverKind,
    child_ref: &str,
    edge: &ChildEdge,
    child_types: &[String],
    survivor_ref: &[Value],
    loser_match: &str,
    exclude: &[String],
) -> String {
    let set = edge
        .child_cols
        .iter()
        .zip(survivor_ref)
        .enumerate()
        .map(|(i, (c, v))| {
            format!(
                "{} = {}",
                quote_ident(driver, c),
                key_literal(driver, child_types.get(i).map_or("", String::as_str), v)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let mut sql = format!("UPDATE {child_ref} SET {set} WHERE ({loser_match})");
    if let Some(ex) = or_conds(exclude) {
        sql.push_str(&format!(" AND NOT ({ex})"));
    }
    sql
}

/// 行条件の一覧から `DELETE FROM t WHERE (…) OR (…)` をチャンクに分けて作る。各文と、その文が消す行数を返す。
pub fn delete_where_sql(table_ref: &str, conds: &[String]) -> Vec<(String, u64)> {
    conds
        .chunks(COND_CHUNK)
        .filter_map(|chunk| {
            let w = or_conds(chunk)?;
            Some((
                format!("DELETE FROM {table_ref} WHERE {w}"),
                chunk.len() as u64,
            ))
        })
        .collect()
}

/// 残す行を採用元の値で整える `UPDATE parent SET col = v, … WHERE key`。変える列が無ければ `None`。
pub fn survivor_update_sql(
    driver: DriverKind,
    table_ref: &str,
    sets: &[(String, String, Value)],
    key_cond: &str,
) -> Option<String> {
    if sets.is_empty() {
        return None;
    }
    let set = sets
        .iter()
        .map(|(c, ty, v)| {
            format!(
                "{} = {}",
                quote_ident(driver, c),
                key_literal(driver, ty, v)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!("UPDATE {table_ref} SET {set} WHERE {key_cond}"))
}

/// 列ごとの採用元の提案 (`[残す行, 重複行…]` の添字)。残す行が NULL (または空文字) で、他の行に値があれば
/// その最初の行から補う。それ以外は残す行。`locked` の列は常に残す行。
pub fn suggest_picks(rows: &[Vec<Value>], locked: &[bool]) -> Vec<usize> {
    let width = rows.first().map_or(0, Vec::len);
    (0..width)
        .map(|c| {
            if locked.get(c).copied().unwrap_or(false) {
                return 0;
            }
            let empty = |v: &Value| match v {
                Value::Null => true,
                Value::String(s) => s.is_empty(),
                _ => false,
            };
            if !rows.first().and_then(|r| r.get(c)).is_some_and(empty) {
                return 0;
            }
            rows.iter()
                .enumerate()
                .skip(1)
                .find(|(_, r)| r.get(c).is_some_and(|v| !empty(v)))
                .map_or(0, |(i, _)| i)
        })
        .collect()
}

/// 付け替えで重なる子行 (1 グループ) の、残す・消す・飛ばす行の振り分け。
///
/// `members` は同じ衝突キーを持つ子行で、`(重複行の添字 (残す行側は None), 行を特定する値)`。
/// 残す行側に既にある行があればそれを残し、無ければ重複行の順で最初の行を残す。残りが「重なる行」。
pub fn classify_collision_group<T: Clone>(members: &[(Option<usize>, T)]) -> Vec<T> {
    let keep = members.iter().position(|(l, _)| l.is_none()).or_else(|| {
        members
            .iter()
            .enumerate()
            .min_by_key(|(_, (l, _))| l.unwrap_or(usize::MAX))
            .map(|(i, _)| i)
    });
    members
        .iter()
        .enumerate()
        .filter(|(i, _)| Some(*i) != keep)
        .map(|(_, (_, t))| t.clone())
        .collect()
}

/// 子側の一意キーの衝突を数える SQL。付け替え後に同じキーになる行のグループ (`n > 1`) を返す。
///
/// 付け替え後は `child_cols` が残す行の値に揃うので、一意キー `ucols` のうち外部キーの列は定数になる。
/// 残りの列 (`others`) でグルーピングし、`重複行を参照する行 + 残す行を参照する行` の中で 2 行以上に
/// なるグループが衝突。NULL を含むキーは UNIQUE と同じく互いに別物として除く。
/// 戻りの列は `others` と最後に `n`。`others` が空 (一意キーが外部キーの列だけ) のときは `n` のみ。
pub fn collision_groups_sql(
    driver: DriverKind,
    child_ref: &str,
    others: &[String],
    scope_cond: &str,
    limit: usize,
) -> String {
    let cols = others
        .iter()
        .map(|c| quote_ident(driver, c))
        .collect::<Vec<_>>();
    let not_null = cols
        .iter()
        .map(|c| format!("{c} IS NOT NULL"))
        .collect::<Vec<_>>()
        .join(" AND ");
    let mut inner = if cols.is_empty() {
        "SELECT COUNT(*) AS n".to_string()
    } else {
        format!("SELECT {}, COUNT(*) AS n", cols.join(", "))
    };
    inner.push_str(&format!(" FROM {child_ref} WHERE ({scope_cond})"));
    if !not_null.is_empty() {
        inner.push_str(&format!(" AND {not_null}"));
    }
    if !cols.is_empty() {
        inner.push_str(&format!(" GROUP BY {}", cols.join(", ")));
    }
    format!("SELECT * FROM ({inner}) AS merge_groups WHERE n > 1 LIMIT {limit}")
}

/// 衝突グループ 1 つの子行 (外部キー列 + `others`) を読む SQL。
pub fn collision_members_sql(
    driver: DriverKind,
    child_ref: &str,
    select_cols: &[String],
    scope_cond: &str,
    group_cond: Option<&str>,
) -> String {
    let cols = select_cols
        .iter()
        .map(|c| quote_ident(driver, c))
        .collect::<Vec<_>>()
        .join(", ");
    let mut sql = format!("SELECT {cols} FROM {child_ref} WHERE ({scope_cond})");
    if let Some(g) = group_cond {
        sql.push_str(&format!(" AND ({g})"));
    }
    sql
}

/// 参照動作が「重複行を消すとき子行を残す」(= 付け替えを飛ばしても DELETE が通る) か。
pub fn delete_survives_skip(on_delete: Option<&str>) -> bool {
    matches!(
        on_delete.map(str::to_ascii_uppercase).as_deref(),
        Some("CASCADE" | "SET NULL" | "SET DEFAULT")
    )
}

/// 「付け替えを飛ばす」を止める理由。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipBlock {
    /// `ON DELETE` が連鎖でも NULL 化でもなく、飛ばした行が重複行の DELETE を妨げる。
    Unsafe,
    /// 外部キー検査が無効 (SQLite の `PRAGMA foreign_keys = OFF`) で、DELETE の連鎖が働かず孤児行が残る。
    NoForeignKeys,
}

/// 付け替えを飛ばす行 (`skipped`) があるとき、その扱いを止めるべきか。
pub fn skip_blocker(
    on_delete: Option<&str>,
    fk_enforced: Option<bool>,
    skipped: u64,
) -> Option<SkipBlock> {
    if skipped == 0 {
        None
    } else if !delete_survives_skip(on_delete) {
        Some(SkipBlock::Unsafe)
    } else if fk_enforced == Some(false) {
        Some(SkipBlock::NoForeignKeys)
    } else {
        None
    }
}

/// `Value` を件数として読む (`COUNT(*)` の戻り)。
pub fn value_to_u64(v: &Value) -> u64 {
    match v {
        Value::Int(i) => u64::try_from(*i).unwrap_or(0),
        Value::UInt(u) => *u,
        Value::String(s) => s.trim().parse().unwrap_or(0),
        Value::Float(f) if *f >= 0.0 => *f as u64,
        _ => 0,
    }
}

/// 行を一意に特定できるキー列 (主キー、無ければ全列 NOT NULL で部分・式でない UNIQUE キー)。
/// `PRI` の列が主キー。順序は主キーのインデックスがあればそれに従う。
pub fn row_key_of(cols: &[TableColumnInfo], idxs: &[IndexInfo]) -> Option<Vec<String>> {
    let pri: Vec<String> = cols
        .iter()
        .filter(|c| c.key.eq_ignore_ascii_case("PRI"))
        .map(|c| c.name.clone())
        .collect();
    if !pri.is_empty() {
        if let Some(p) = idxs.iter().find(|i| i.primary) {
            let ordered = index_key_columns(p);
            if ordered.len() == pri.len() {
                return Some(ordered);
            }
        }
        return Some(pri);
    }
    idxs.iter()
        .filter(|i| i.unique && usable_unique_index(i))
        .map(index_key_columns)
        .find(|k| {
            !k.is_empty()
                && k.iter().all(|c| {
                    cols.iter()
                        .find(|x| x.name.eq_ignore_ascii_case(c))
                        .is_some_and(|x| !x.nullable)
                })
        })
}

/// `key_columns` が表の行キー (主キー、または NOT NULL の UNIQUE キー) と集合として一致するか。
pub fn is_row_key(cols: &[TableColumnInfo], idxs: &[IndexInfo], key_columns: &[String]) -> bool {
    if key_columns.is_empty() {
        return false;
    }
    let want: std::collections::BTreeSet<String> =
        key_columns.iter().map(|c| c.to_ascii_lowercase()).collect();
    let set = |v: &[String]| -> std::collections::BTreeSet<String> {
        v.iter().map(|c| c.to_ascii_lowercase()).collect()
    };
    let pri: Vec<String> = cols
        .iter()
        .filter(|c| c.key.eq_ignore_ascii_case("PRI"))
        .map(|c| c.name.clone())
        .collect();
    if !pri.is_empty() {
        return set(&pri) == want;
    }
    idxs.iter().any(|i| {
        i.unique
            && usable_unique_index(i)
            && set(&index_key_columns(i)) == want
            && key_columns.iter().all(|c| {
                cols.iter()
                    .find(|x| x.name.eq_ignore_ascii_case(c))
                    .is_some_and(|x| !x.nullable)
            })
    })
}

/// 部分・式・`NULLS NOT DISTINCT`・無効でない、列だけの一意インデックスか。
pub fn usable_unique_index(i: &IndexInfo) -> bool {
    i.predicate.is_none() && i.first_expression_at.is_none() && !i.nulls_not_distinct && !i.invalid
}

/// インデックスのキー列 (PostgreSQL の `INCLUDE` 列を除く)。
pub fn index_key_columns(i: &IndexInfo) -> Vec<String> {
    let n = i.key_column_count.unwrap_or(i.columns.len());
    i.columns.iter().take(n).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(x: &str) -> String {
        x.to_string()
    }
    fn edge(cols: &[&str], pcols: &[&str]) -> ChildEdge {
        ChildEdge {
            child_db: s("db"),
            child: s("orders"),
            constraint: s("fk"),
            child_cols: cols.iter().map(|c| s(c)).collect(),
            parent_cols: pcols.iter().map(|c| s(c)).collect(),
            on_delete: None,
        }
    }

    #[test]
    fn norm_sig_ignores_numeric_representation() {
        assert_eq!(norm_sig(&Value::Int(5)), norm_sig(&Value::String(s("5"))));
        assert_eq!(norm_sig(&Value::UInt(5)), norm_sig(&Value::Int(5)));
        assert_ne!(norm_sig(&Value::Null), norm_sig(&Value::String(s(""))));
        assert_eq!(
            sig(&[Value::Int(1), Value::Null]),
            sig(&[Value::UInt(1), Value::Null])
        );
    }

    #[test]
    fn eq_cond_uses_is_null_and_typed_literals_per_driver() {
        let cols = vec![s("a"), s("b"), s("c")];
        let types = vec![s("bigint"), s("text"), s("int")];
        let vals = vec![
            Value::String(s("9007199254740993")),
            Value::String(s("it's")),
            Value::Null,
        ];
        assert_eq!(
            eq_cond(DriverKind::Postgres, &cols, &types, &vals),
            "\"a\" = 9007199254740993 AND \"b\" = 'it''s' AND \"c\" IS NULL"
        );
        assert_eq!(
            eq_cond(DriverKind::Mysql, &cols, &types, &vals),
            "`a` = 9007199254740993 AND `b` = 'it''s' AND `c` IS NULL"
        );
    }

    #[test]
    fn repoint_sql_composite_with_excludes() {
        let e = edge(&["region", "sub"], &["code", "sub"]);
        let types = vec![s("int"), s("int")];
        let m = loser_match_cond(
            DriverKind::Sqlite,
            &e,
            &types,
            &[
                vec![Value::Int(1), Value::Int(2)],
                vec![Value::Int(1), Value::Null],
                vec![Value::Int(3), Value::Int(4)],
            ],
        )
        .expect("match");
        // NULL を含む重複行の参照先は何も参照されないので条件に入らない。
        assert_eq!(
            m,
            "(\"region\" = 1 AND \"sub\" = 2) OR (\"region\" = 3 AND \"sub\" = 4)"
        );
        let sql = repoint_sql(
            DriverKind::Sqlite,
            "\"orders\"",
            &e,
            &types,
            &[Value::Int(9), Value::Int(9)],
            &m,
            &[s("\"id\" = 5")],
        );
        assert_eq!(
            sql,
            "UPDATE \"orders\" SET \"region\" = 9, \"sub\" = 9 WHERE ((\"region\" = 1 AND \"sub\" = 2) OR (\"region\" = 3 AND \"sub\" = 4)) AND NOT ((\"id\" = 5))"
        );
    }

    #[test]
    fn delete_where_sql_chunks() {
        let conds: Vec<String> = (0..250).map(|i| format!("id = {i}")).collect();
        let out = delete_where_sql("t", &conds);
        assert_eq!(out.len(), 3);
        assert_eq!(out.iter().map(|(_, n)| *n).sum::<u64>(), 250);
        assert!(out[0]
            .0
            .starts_with("DELETE FROM t WHERE (id = 0) OR (id = 1)"));
        assert!(delete_where_sql("t", &[]).is_empty());
    }

    #[test]
    fn suggest_picks_fills_null_from_the_first_row_that_has_a_value() {
        let rows = vec![
            vec![Value::Int(1), Value::Null, Value::String(s("keep"))],
            vec![
                Value::Int(2),
                Value::String(s("x")),
                Value::String(s("other")),
            ],
            vec![Value::Int(3), Value::String(s("y")), Value::Null],
        ];
        assert_eq!(suggest_picks(&rows, &[true, false, false]), vec![0, 1, 0]);
        // 全部 NULL なら残す行のまま。
        let nulls = vec![vec![Value::Null], vec![Value::Null]];
        assert_eq!(suggest_picks(&nulls, &[false]), vec![0]);
        // ロックされた列は補わない。
        assert_eq!(suggest_picks(&rows, &[false, true, false]), vec![0, 0, 0]);
    }

    #[test]
    fn collision_group_keeps_survivor_side_row_else_first_loser() {
        // 残す行側に既にある行があれば、それを残して重複行側を全部落とす。
        let g = [(Some(1), "l1"), (None, "s"), (Some(2), "l2")];
        assert_eq!(classify_collision_group(&g), vec!["l1", "l2"]);
        // 残す行側が無ければ、最初の重複行 (添字が小さい方) を残す。
        let g = [(Some(2), "l2"), (Some(1), "l1")];
        assert_eq!(classify_collision_group(&g), vec!["l2"]);
    }

    #[test]
    fn collision_sql_shapes() {
        let sql = collision_groups_sql(
            DriverKind::Mysql,
            "`d`.`cc`",
            &[s("coupon_id")],
            "`customer_id` = 1 OR `customer_id` = 2",
            201,
        );
        assert_eq!(
            sql,
            "SELECT * FROM (SELECT `coupon_id`, COUNT(*) AS n FROM `d`.`cc` WHERE (`customer_id` = 1 OR `customer_id` = 2) AND `coupon_id` IS NOT NULL GROUP BY `coupon_id`) AS merge_groups WHERE n > 1 LIMIT 201"
        );
        // 一意キーが外部キーの列だけのとき (1 対 1) は GROUP BY が無い。
        let sql = collision_groups_sql(DriverKind::Sqlite, "t", &[], "a = 1", 5);
        assert_eq!(
            sql,
            "SELECT * FROM (SELECT COUNT(*) AS n FROM t WHERE (a = 1)) AS merge_groups WHERE n > 1 LIMIT 5"
        );
    }

    #[test]
    fn skip_blocker_covers_unsafe_actions_and_disabled_foreign_keys() {
        assert_eq!(skip_blocker(Some("CASCADE"), Some(true), 0), None);
        assert_eq!(skip_blocker(Some("CASCADE"), None, 2), None);
        assert_eq!(skip_blocker(None, Some(true), 1), Some(SkipBlock::Unsafe));
        // 外部キー検査が無効なら、連鎖の子でも孤児行ができるので止める。
        assert_eq!(
            skip_blocker(Some("SET NULL"), Some(false), 1),
            Some(SkipBlock::NoForeignKeys)
        );
        assert_eq!(skip_blocker(Some("SET NULL"), Some(false), 0), None);
    }

    #[test]
    fn skip_is_safe_only_for_cascade_or_null_actions() {
        assert!(delete_survives_skip(Some("cascade")));
        assert!(delete_survives_skip(Some("SET NULL")));
        assert!(!delete_survives_skip(Some("RESTRICT")));
        assert!(!delete_survives_skip(None));
    }

    #[test]
    fn survivor_update_sql_renders_literals() {
        let sets = vec![(s("email"), s("text"), Value::String(s("a@x")))];
        assert_eq!(
            survivor_update_sql(DriverKind::Postgres, "\"s\".\"t\"", &sets, "\"id\" = 1")
                .as_deref(),
            Some("UPDATE \"s\".\"t\" SET \"email\" = 'a@x' WHERE \"id\" = 1")
        );
        assert!(survivor_update_sql(DriverKind::Postgres, "t", &[], "x").is_none());
    }

    #[test]
    fn value_to_u64_reads_counts() {
        assert_eq!(value_to_u64(&Value::Int(3)), 3);
        assert_eq!(value_to_u64(&Value::UInt(4)), 4);
        assert_eq!(value_to_u64(&Value::String(s("5"))), 5);
        assert_eq!(value_to_u64(&Value::Null), 0);
    }
}
