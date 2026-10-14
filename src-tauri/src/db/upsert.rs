//! インポートの競合モード (UPSERT) の SQL 生成 (#972)。
//!
//! インポートは従来 INSERT 専用だった。同じ CSV を繰り返し取り込む「マスター
//! データ同期」用途のため、ユーザが指定したキー列集合で競合を判定し、
//!
//! - `skip`   … 既存キーの行は何もしない (DO NOTHING 相当)
//! - `update` … 既存キーの行を取り込み値で更新する (DO UPDATE 相当)
//!
//! を選べるようにする。方言ごとの構文差はすべてこのモジュールの**純関数**に
//! 閉じ込め、各ドライバは「従来の INSERT 文 + ここで作った接尾辞」を実行する
//! だけにする (ドライバ側は接続・バインドのみ)。
//!
//! | 方言 | skip | update |
//! |---|---|---|
//! | MySQL | `ON DUPLICATE KEY UPDATE k = k` (no-op) | `ON DUPLICATE KEY UPDATE c = VALUES(c)` |
//! | PostgreSQL / SQLite | `ON CONFLICT (keys) DO NOTHING` | `ON CONFLICT (keys) DO UPDATE SET c = EXCLUDED.c` |
//!
//! MySQL の skip に `INSERT IGNORE` を使わないのは、IGNORE が重複キー以外の
//! エラー (型変換・NOT NULL 違反など) まで警告に格下げして黙って取り込んでしまい、
//! #687 の abort/skip の行エラー処理を素通りさせるため。

use std::borrow::Cow;
use std::collections::HashMap;

use serde::Deserialize;

use super::sync::quote_ident;
use super::DriverKind;
use crate::error::{AppError, Result};

/// 既存キーと衝突した行の扱い。既定 `Insert` は従来どおりの素の INSERT
/// (競合はエラー) で、フィールドを送らない古いリクエストとの後方互換を保つ。
#[derive(Debug, Clone, Copy, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConflictMode {
    /// 素の INSERT。キー重複は DB エラー (= #687 の abort/skip で処理)。
    #[default]
    Insert,
    /// 既存キーの行は変更せず読み飛ばす。
    Skip,
    /// 既存キーの行を取り込み値で更新する。
    Update,
}

/// インポート 1 回分の競合設定。`key_columns` は競合判定に使う列
/// (インポート対象列の部分集合)。`mode == Insert` のときは無視される。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportConflict {
    pub mode: ConflictMode,
    pub key_columns: Vec<String>,
}

impl ImportConflict {
    /// 従来の INSERT 専用設定 (サンドボックス取り込みなど競合を扱わない経路用)。
    pub fn insert_only() -> Self {
        Self::default()
    }

    pub fn is_upsert(&self) -> bool {
        self.mode != ConflictMode::Insert
    }

    /// 設定がインポート対象列と整合しているかを検証する。UPSERT モードでは
    /// キー列が 1 つ以上あり、重複がなく、すべてインポート対象列に含まれている
    /// 必要がある (取り込まない列をキーにしても比較する値が無い)。
    pub fn validate(&self, columns: &[String]) -> Result<()> {
        if !self.is_upsert() {
            return Ok(());
        }
        if self.key_columns.is_empty() {
            return Err(AppError::InvalidInput(
                "conflict mode requires at least one key column".into(),
            ));
        }
        for (i, key) in self.key_columns.iter().enumerate() {
            if self.key_columns[..i].contains(key) {
                return Err(AppError::InvalidInput(format!(
                    "duplicate key column: {key}"
                )));
            }
            if !columns.contains(key) {
                return Err(AppError::InvalidInput(format!(
                    "key column is not among the imported columns: {key}"
                )));
            }
        }
        Ok(())
    }

    /// キー列の `columns` 内の位置。`validate` 済みを前提とし、見つからない
    /// キーは単に無視する (パニックしない)。
    fn key_indices(&self, columns: &[String]) -> Vec<usize> {
        self.key_columns
            .iter()
            .filter_map(|k| columns.iter().position(|c| c == k))
            .collect()
    }

    /// 更新対象 (= キー以外) の列。
    fn non_key_columns<'a>(&self, columns: &'a [String]) -> Vec<&'a String> {
        columns
            .iter()
            .filter(|c| !self.key_columns.contains(c))
            .collect()
    }

    /// 1 文の中で同じキーが複数回現れる行を 1 行に畳む。
    ///
    /// PostgreSQL の `ON CONFLICT DO UPDATE` は、
    /// 1 文の中で同じ行を二度更新しようとするとエラーにする ("cannot affect row a
    /// second time")。1 行ずつ順に適用したときと同じ結果になるよう、
    /// `update` は**最後の行が勝ち**、`skip` は**最初の行が勝つ** (後続は既存
    /// キーとして読み飛ばされるため)。畳まれた行は元の出現位置の順を保つ。
    ///
    /// 重複が無ければ (大半のケース) 複製せず借用のまま返す。キーの比較は
    /// ファイル上のテキスト完全一致 (`NULL` 同士は同一視しない — SQL の一意性と同じ)。
    /// ただし `normalized_columns` に含まれるキー列は、DB 側で同値になる表記ゆれ
    /// (数値の `'1'` / `'01'` / `' 1'` / `'+1'`、UUID の大文字小文字・ハイフン・波括弧、
    /// boolean の `t` / `true` / `1` など) を同じキーとして扱えるよう [`KeyKind::normalize`]
    /// で正規化してから比較する (畳まないと "cannot affect row a second time")。
    pub fn collapse_duplicate_keys<'a>(
        &self,
        columns: &[String],
        rows: &'a [Vec<Option<String>>],
        normalized_columns: &[(String, KeyKind)],
    ) -> Cow<'a, [Vec<Option<String>>]> {
        if !self.is_upsert() || rows.len() < 2 {
            return Cow::Borrowed(rows);
        }
        let idx = self.key_indices(columns);
        if idx.is_empty() {
            return Cow::Borrowed(rows);
        }
        let kinds: Vec<Option<KeyKind>> = idx
            .iter()
            .map(|&ci| {
                let name = columns.get(ci)?;
                normalized_columns
                    .iter()
                    .find(|(n, _)| n == name)
                    .map(|(_, k)| *k)
            })
            .collect();
        // キー → 採用する行番号。
        let mut chosen: HashMap<Vec<Cow<str>>, usize> = HashMap::with_capacity(rows.len());
        let mut keep = vec![true; rows.len()];
        let mut any_dup = false;
        for (ri, row) in rows.iter().enumerate() {
            let mut key: Vec<Cow<str>> = Vec::with_capacity(idx.len());
            let mut has_null = false;
            for (k, &ci) in idx.iter().enumerate() {
                match row.get(ci).and_then(|c| c.as_deref()) {
                    Some(v) => match kinds[k] {
                        Some(kind) => key.push(kind.normalize(v)),
                        None => key.push(Cow::Borrowed(v)),
                    },
                    None => {
                        has_null = true;
                        break;
                    }
                }
            }
            if has_null {
                continue;
            }
            match chosen.get_mut(&key) {
                None => {
                    chosen.insert(key, ri);
                }
                Some(prev) => {
                    any_dup = true;
                    match self.mode {
                        ConflictMode::Update => {
                            keep[*prev] = false;
                            *prev = ri;
                        }
                        _ => keep[ri] = false,
                    }
                }
            }
        }
        if !any_dup {
            return Cow::Borrowed(rows);
        }
        Cow::Owned(
            rows.iter()
                .zip(keep)
                .filter(|(_, k)| *k)
                .map(|(r, _)| r.clone())
                .collect(),
        )
    }
}

/// キー比較の前に正規化する PostgreSQL 型の種別 (`collapse_duplicate_keys` 用)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyKind {
    /// 整数型・数値型 (`typcategory = 'N'`、money を除く)。
    Numeric,
    /// `uuid`。
    Uuid,
    /// `boolean`。
    Bool,
}

impl KeyKind {
    /// 同じ値になる表記を同じ文字列にそろえる。解釈できない値は元のまま返す。
    pub fn normalize(self, raw: &str) -> Cow<'_, str> {
        match self {
            KeyKind::Numeric => normalize_numeric_key(raw),
            KeyKind::Uuid => normalize_uuid_key(raw),
            KeyKind::Bool => normalize_bool_key(raw),
        }
    }
}

/// UUID を小文字・ハイフン無し 32 桁にそろえる (PostgreSQL は大文字小文字・波括弧・
/// ハイフンの有無を許す)。32 桁の 16 進にならなければ元のまま。
fn normalize_uuid_key(raw: &str) -> Cow<'_, str> {
    let t = raw.trim();
    let t = t
        .strip_prefix('{')
        .and_then(|x| x.strip_suffix('}'))
        .unwrap_or(t);
    let compact: String = t.chars().filter(|c| *c != '-').collect();
    if compact.len() == 32 && compact.bytes().all(|b| b.is_ascii_hexdigit()) {
        Cow::Owned(compact.to_ascii_lowercase())
    } else {
        Cow::Borrowed(raw)
    }
}

/// boolean の入力表記 (`t`/`true`/`yes`/`on`/`y`/`1` と `f`/`false`/`no`/`off`/`n`/`0`、
/// 大文字小文字・前後空白無視) を `t` / `f` にそろえる。それ以外は元のまま。
fn normalize_bool_key(raw: &str) -> Cow<'_, str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "t" | "true" | "yes" | "y" | "on" | "1" => Cow::Borrowed("t"),
        "f" | "false" | "no" | "n" | "off" | "0" => Cow::Borrowed("f"),
        _ => Cow::Borrowed(raw),
    }
}

/// 整数型・数値型のキー列の比較用に、数値テキストを正規形へ直す。前後の空白・
/// 先頭の `+`・先頭の 0・小数部末尾の 0 を落とし、`-0` は `0` にする
/// (`'1'` / `'01'` / `' 1'` / `'1.0'` が同じキーになる)。f64 を通さず文字列のまま
/// 処理するので 64bit 整数・高精度 NUMERIC も丸まらない。`1e3` や `NaN` など
/// 単純な 10 進表記でない値は元のテキストのまま返す。
pub fn normalize_numeric_key(raw: &str) -> Cow<'_, str> {
    let t = raw.trim();
    let (neg, body) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let (int_part, frac_part) = match body.split_once('.') {
        Some((i, f)) => (i, f),
        None => (body, ""),
    };
    let digits_ok = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if (int_part.is_empty() && frac_part.is_empty())
        || !digits_ok(int_part)
        || !digits_ok(frac_part)
    {
        return Cow::Borrowed(raw);
    }
    let int_trim = int_part.trim_start_matches('0');
    let frac_trim = frac_part.trim_end_matches('0');
    let int_norm = if int_trim.is_empty() { "0" } else { int_trim };
    let is_zero = int_norm == "0" && frac_trim.is_empty();
    let mut out = String::with_capacity(t.len());
    if neg && !is_zero {
        out.push('-');
    }
    out.push_str(int_norm);
    if !frac_trim.is_empty() {
        out.push('.');
        out.push_str(frac_trim);
    }
    Cow::Owned(out)
}

/// テーブルの一意キー (PRIMARY / UNIQUE インデックス) 1 本分。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UniqueKey {
    pub name: String,
    pub columns: Vec<String>,
}

/// MySQL の UPSERT を実行してよいか、テーブルの一意キーから事前に検証する。
///
/// `ON DUPLICATE KEY UPDATE` は**PRIMARY を含むすべての一意キー**の衝突で発火し、
/// ユーザが選んだキー列は構文に現れない。そのため選択キー以外の一意キーが 1 つでも
/// あると、そのキーの衝突で意図しない行が黙って更新 (または読み飛ばし) される。
/// 実行前に次のどちらかなら拒否する。
///
/// - 選んだキー列の集合と完全に一致する一意キーが無い (その列では衝突判定されない)
/// - 選択キー以外の一意キーがある。ただし「インポートしない列を含み、その列が省略時に
///   衝突しない (`omitted_safe`: AUTO_INCREMENT、または既定値 NULL の NULL 許容列)」
///   一意キーは、今回の行では衝突し得ないので許容する。
///
/// `uniques` が空 (一意キー無し) の場合も、選択キーに一致するものが無いので拒否になる。
pub fn check_mysql_unique_keys(
    uniques: &[UniqueKey],
    omitted_safe: &[String],
    imported: &[String],
    key_columns: &[String],
) -> Result<()> {
    let same_set = |a: &[String], b: &[String]| {
        a.len() == b.len() && a.iter().all(|c| b.contains(c)) && b.iter().all(|c| a.contains(c))
    };
    if !uniques.iter().any(|u| same_set(&u.columns, key_columns)) {
        return Err(AppError::InvalidInput(format!(
            "MySQL upsert requires the key columns ({}) to exactly match a PRIMARY or UNIQUE key of the table",
            key_columns.join(", ")
        )));
    }
    for u in uniques {
        // 選択キーと同じ列集合の一意キーは (重複して定義されていても) すべて読み飛ばす。
        if same_set(&u.columns, key_columns) {
            continue;
        }
        let cannot_collide = u
            .columns
            .iter()
            .any(|c| !imported.contains(c) && omitted_safe.contains(c));
        if !cannot_collide {
            return Err(AppError::InvalidInput(format!(
                "MySQL upsert would also fire on another unique key ({}: {}), which can overwrite or skip unrelated rows; use a table with a single unique key matching the selected key columns",
                u.name,
                u.columns.join(", ")
            )));
        }
    }
    Ok(())
}

/// PostgreSQL / SQLite の `ON CONFLICT (キー列)` が使える表か、一意キーから事前に検証する
/// (#1612)。選んだキー列の集合と完全に一致する PRIMARY / UNIQUE が無いと、最初のチャンクで
/// DB の生エラー (`there is no unique or exclusion constraint matching the ON CONFLICT
/// specification` など) になり取り込みが途中で失敗するため、実行前に分かりやすく拒否する。
/// MySQL と違い他の一意キーは `ON CONFLICT` の判定に影響しないので、一致の有無だけ見る。
pub fn check_conflict_target_unique(
    driver: DriverKind,
    uniques: &[UniqueKey],
    key_columns: &[String],
) -> Result<()> {
    // SQLite の列名は大文字小文字を区別しない (PostgreSQL は区別する)。
    let fold = driver == DriverKind::Sqlite;
    let eq = |a: &String, b: &String| {
        if fold {
            a.eq_ignore_ascii_case(b)
        } else {
            a == b
        }
    };
    let same_set = |a: &[String], b: &[String]| {
        a.len() == b.len()
            && a.iter().all(|c| b.iter().any(|d| eq(c, d)))
            && b.iter().all(|c| a.iter().any(|d| eq(c, d)))
    };
    if uniques.iter().any(|u| same_set(&u.columns, key_columns)) {
        return Ok(());
    }
    let name = match driver {
        DriverKind::Postgres => "PostgreSQL",
        DriverKind::Sqlite => "SQLite",
        DriverKind::Mysql => "MySQL",
    };
    Err(AppError::InvalidInput(format!(
        "{name} upsert requires the key columns ({}) to exactly match a PRIMARY or UNIQUE key of the table",
        key_columns.join(", ")
    )))
}

/// 取り込まない列が、省略時 (= 既定値が入るとき) に一意キーの衝突を起こさないか。
/// 安全なのは AUTO_INCREMENT、または NULL 許容で既定値が NULL の列 (NULL は衝突しない。
/// MariaDB は既定値を文字列 `'NULL'` で返す)。生成列 (`STORED` / `VIRTUAL` /
/// `PERSISTENT GENERATED`) は式の結果が入って衝突し得るので安全とみなさない。
/// `DEFAULT_GENERATED` (式の既定値) は生成列ではない。
pub fn omitted_column_is_safe(extra: &str, nullable: bool, default: Option<&str>) -> bool {
    let up = extra.to_ascii_uppercase();
    if [
        "STORED GENERATED",
        "VIRTUAL GENERATED",
        "PERSISTENT GENERATED",
    ]
    .iter()
    .any(|m| up.contains(m))
    {
        return false;
    }
    up.contains("AUTO_INCREMENT") || (nullable && matches!(default, None | Some("NULL")))
}

/// MySQL / PostgreSQL / SQLite の `INSERT … VALUES (…)` の**後ろに付ける**
/// 競合句 (先頭に空白を含む)。`Insert` モードは空文字。
pub fn conflict_clause(
    driver: DriverKind,
    columns: &[String],
    conflict: &ImportConflict,
) -> String {
    if !conflict.is_upsert() {
        return String::new();
    }
    let q = |c: &str| quote_ident(driver, c);
    let updates = conflict.non_key_columns(columns);
    let do_update = conflict.mode == ConflictMode::Update && !updates.is_empty();
    match driver {
        DriverKind::Mysql => {
            // ON DUPLICATE KEY はテーブルの全一意キーで判定する (キー列の指定は
            // 構文に現れない)。キー列はここでは「更新しない列」を決めるのに使う。
            // `VALUES(col)` は 8.0.20 で非推奨だが MariaDB 互換のため行エイリアス
            // (`AS new`) ではなくこちらを使う。
            let set = if do_update {
                updates
                    .iter()
                    .map(|c| format!("{0} = VALUES({0})", q(c)))
                    .collect::<Vec<_>>()
                    .join(", ")
            } else {
                // 何も変えない代入で「既存行は読み飛ばす」を表す。
                let k = conflict
                    .key_columns
                    .first()
                    .map(String::as_str)
                    .or_else(|| columns.first().map(String::as_str))
                    .unwrap_or_default();
                format!("{0} = {0}", q(k))
            };
            format!(" ON DUPLICATE KEY UPDATE {set}")
        }
        DriverKind::Postgres | DriverKind::Sqlite => {
            let keys = conflict
                .key_columns
                .iter()
                .map(|k| q(k))
                .collect::<Vec<_>>()
                .join(", ");
            if do_update {
                let set = updates
                    .iter()
                    .map(|c| format!("{0} = EXCLUDED.{0}", q(c)))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(" ON CONFLICT ({keys}) DO UPDATE SET {set}")
            } else {
                format!(" ON CONFLICT ({keys}) DO NOTHING")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn conflict(mode: ConflictMode, keys: &[&str]) -> ImportConflict {
        ImportConflict {
            mode,
            key_columns: cols(keys),
        }
    }

    fn row(cells: &[Option<&str>]) -> Vec<Option<String>> {
        cells.iter().map(|c| c.map(str::to_string)).collect()
    }

    #[test]
    fn conflict_target_requires_exact_unique_match() {
        let u = vec![
            UniqueKey {
                name: "pk".into(),
                columns: cols(&["a", "b"]),
            },
            UniqueKey {
                name: "email".into(),
                columns: cols(&["email"]),
            },
        ];
        let ok = |k: &[&str]| check_conflict_target_unique(DriverKind::Postgres, &u, &cols(k));
        assert!(ok(&["b", "a"]).is_ok());
        assert!(ok(&["email"]).is_ok());
        // 部分集合・上位集合・無関係な列は拒否 (メッセージにキー列が入る)。
        assert!(ok(&["a"]).is_err());
        assert!(ok(&["a", "b", "email"]).is_err());
        let msg = ok(&["name"])
            .err()
            .map(|e| e.to_string())
            .unwrap_or_default();
        assert!(msg.contains("PostgreSQL") && msg.contains("name"), "{msg}");
        assert!(check_conflict_target_unique(DriverKind::Sqlite, &[], &cols(&["a"])).is_err());
        // SQLite だけ列名の大文字小文字を無視する。
        let lower = vec![UniqueKey {
            name: "pk".into(),
            columns: cols(&["id"]),
        }];
        assert!(check_conflict_target_unique(DriverKind::Sqlite, &lower, &cols(&["ID"])).is_ok());
        assert!(
            check_conflict_target_unique(DriverKind::Postgres, &lower, &cols(&["ID"])).is_err()
        );
    }

    #[test]
    fn insert_mode_has_no_clause_for_any_driver() {
        let c = cols(&["id", "name"]);
        for d in [DriverKind::Mysql, DriverKind::Postgres, DriverKind::Sqlite] {
            assert_eq!(conflict_clause(d, &c, &ImportConflict::insert_only()), "");
        }
    }

    #[test]
    fn mysql_update_uses_on_duplicate_key_update_values() {
        let c = cols(&["id", "name", "age"]);
        assert_eq!(
            conflict_clause(
                DriverKind::Mysql,
                &c,
                &conflict(ConflictMode::Update, &["id"])
            ),
            " ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `age` = VALUES(`age`)"
        );
    }

    #[test]
    fn mysql_skip_is_a_no_op_assignment_not_insert_ignore() {
        let c = cols(&["id", "name"]);
        assert_eq!(
            conflict_clause(
                DriverKind::Mysql,
                &c,
                &conflict(ConflictMode::Skip, &["id"])
            ),
            " ON DUPLICATE KEY UPDATE `id` = `id`"
        );
    }

    #[test]
    fn mysql_update_with_only_key_columns_degrades_to_skip() {
        let c = cols(&["a", "b"]);
        assert_eq!(
            conflict_clause(
                DriverKind::Mysql,
                &c,
                &conflict(ConflictMode::Update, &["a", "b"])
            ),
            " ON DUPLICATE KEY UPDATE `a` = `a`"
        );
    }

    #[test]
    fn postgres_sqlite_use_on_conflict() {
        let c = cols(&["id", "name"]);
        for d in [DriverKind::Postgres, DriverKind::Sqlite] {
            assert_eq!(
                conflict_clause(d, &c, &conflict(ConflictMode::Update, &["id"])),
                " ON CONFLICT (\"id\") DO UPDATE SET \"name\" = EXCLUDED.\"name\""
            );
            assert_eq!(
                conflict_clause(d, &c, &conflict(ConflictMode::Skip, &["id"])),
                " ON CONFLICT (\"id\") DO NOTHING"
            );
        }
    }

    #[test]
    fn on_conflict_composite_key_and_quoting() {
        let c = cols(&["a\"x", "b", "v"]);
        assert_eq!(
            conflict_clause(
                DriverKind::Postgres,
                &c,
                &conflict(ConflictMode::Update, &["a\"x", "b"])
            ),
            " ON CONFLICT (\"a\"\"x\", \"b\") DO UPDATE SET \"v\" = EXCLUDED.\"v\""
        );
    }

    #[test]
    fn on_conflict_update_with_only_keys_is_do_nothing() {
        let c = cols(&["id"]);
        assert_eq!(
            conflict_clause(
                DriverKind::Sqlite,
                &c,
                &conflict(ConflictMode::Update, &["id"])
            ),
            " ON CONFLICT (\"id\") DO NOTHING"
        );
    }

    #[test]
    fn validate_rules() {
        let c = cols(&["id", "name"]);
        assert!(ImportConflict::insert_only().validate(&c).is_ok());
        assert!(conflict(ConflictMode::Update, &["id"]).validate(&c).is_ok());
        assert!(conflict(ConflictMode::Update, &[]).validate(&c).is_err());
        assert!(conflict(ConflictMode::Skip, &["missing"])
            .validate(&c)
            .is_err());
        assert!(conflict(ConflictMode::Skip, &["id", "id"])
            .validate(&c)
            .is_err());
        // Insert モードではキー列の内容を問わない (無視される)。
        assert!(conflict(ConflictMode::Insert, &["missing"])
            .validate(&c)
            .is_ok());
    }

    #[test]
    fn collapse_update_keeps_last_occurrence_skip_keeps_first() {
        let c = cols(&["id", "v"]);
        let rows = vec![
            row(&[Some("1"), Some("a")]),
            row(&[Some("2"), Some("b")]),
            row(&[Some("1"), Some("c")]),
        ];
        let up = conflict(ConflictMode::Update, &["id"]).collapse_duplicate_keys(&c, &rows, &[]);
        assert_eq!(
            up.as_ref(),
            &[row(&[Some("2"), Some("b")]), row(&[Some("1"), Some("c")])]
        );
        let sk = conflict(ConflictMode::Skip, &["id"]).collapse_duplicate_keys(&c, &rows, &[]);
        assert_eq!(
            sk.as_ref(),
            &[row(&[Some("1"), Some("a")]), row(&[Some("2"), Some("b")])]
        );
    }

    #[test]
    fn collapse_borrows_when_no_duplicates_or_insert_mode_and_ignores_null_keys() {
        let c = cols(&["id", "v"]);
        let rows = vec![row(&[None, Some("a")]), row(&[None, Some("b")])];
        assert!(matches!(
            conflict(ConflictMode::Update, &["id"]).collapse_duplicate_keys(&c, &rows, &[]),
            Cow::Borrowed(_)
        ));
        let dup = vec![row(&[Some("1"), Some("a")]), row(&[Some("1"), Some("b")])];
        assert!(matches!(
            ImportConflict::insert_only().collapse_duplicate_keys(&c, &dup, &[]),
            Cow::Borrowed(_)
        ));
    }

    #[test]
    fn collapse_composite_key() {
        let c = cols(&["a", "b", "v"]);
        let rows = vec![
            row(&[Some("1"), Some("x"), Some("p")]),
            row(&[Some("1"), Some("y"), Some("q")]),
            row(&[Some("1"), Some("x"), Some("r")]),
        ];
        let out =
            conflict(ConflictMode::Update, &["a", "b"]).collapse_duplicate_keys(&c, &rows, &[]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1], row(&[Some("1"), Some("x"), Some("r")]));
    }

    fn uk(name: &str, c: &[&str]) -> UniqueKey {
        UniqueKey {
            name: name.into(),
            columns: cols(c),
        }
    }

    #[test]
    fn mysql_check_accepts_exact_single_unique_key() {
        let u = vec![uk("PRIMARY", &["id"])];
        assert!(check_mysql_unique_keys(&u, &[], &cols(&["id", "v"]), &cols(&["id"])).is_ok());
    }

    #[test]
    fn mysql_check_rejects_when_no_unique_key_matches_selection() {
        let u = vec![uk("PRIMARY", &["id"]), uk("email", &["email"])];
        let r = check_mysql_unique_keys(&u, &[], &cols(&["id", "name"]), &cols(&["name"]));
        assert!(r.is_err());
        // 一意キーが無いテーブルも拒否。
        assert!(check_mysql_unique_keys(&[], &[], &cols(&["a"]), &cols(&["a"])).is_err());
    }

    #[test]
    fn mysql_check_rejects_other_unique_key_that_can_collide() {
        // key=email を選んでも id (PK) の衝突で別行が上書きされ得る。
        let u = vec![uk("PRIMARY", &["id"]), uk("email", &["email"])];
        let r =
            check_mysql_unique_keys(&u, &[], &cols(&["id", "email", "name"]), &cols(&["email"]));
        assert!(r.is_err());
        // 選択キーが複合の一部でも (部分集合は別の一意キー扱い)。
        let u = vec![uk("a", &["a"]), uk("ab", &["a", "b"])];
        assert!(check_mysql_unique_keys(&u, &[], &cols(&["a", "b"]), &cols(&["a", "b"])).is_err());
    }

    #[test]
    fn mysql_check_allows_omitted_auto_increment_pk() {
        let u = vec![uk("PRIMARY", &["id"]), uk("email", &["email"])];
        // id を取り込まず AUTO_INCREMENT (omitted_safe) なら PK は衝突しない。
        assert!(check_mysql_unique_keys(
            &u,
            &cols(&["id"]),
            &cols(&["email", "name"]),
            &cols(&["email"])
        )
        .is_ok());
        // id を取り込む場合は omitted_safe でも許容しない。
        assert!(check_mysql_unique_keys(
            &u,
            &cols(&["id"]),
            &cols(&["id", "email"]),
            &cols(&["email"])
        )
        .is_err());
    }

    #[test]
    fn mysql_check_key_order_does_not_matter() {
        let u = vec![uk("ab", &["a", "b"])];
        assert!(check_mysql_unique_keys(&u, &[], &cols(&["a", "b"]), &cols(&["b", "a"])).is_ok());
    }

    #[test]
    fn normalize_numeric_key_cases() {
        for (raw, want) in [
            ("1", "1"),
            ("01", "1"),
            (" 1 ", "1"),
            ("+1", "1"),
            ("-0", "0"),
            ("000", "0"),
            ("1.0", "1"),
            ("1.50", "1.5"),
            ("-007.10", "-7.1"),
            (".5", "0.5"),
            ("9223372036854775807", "9223372036854775807"),
            ("9223372036854775808", "9223372036854775808"),
            ("012345678901234567890", "12345678901234567890"),
        ] {
            assert_eq!(normalize_numeric_key(raw), want, "raw={raw:?}");
        }
        // 数値として解釈できないものは元のまま。
        for raw in ["abc", "1e3", "NaN", "", "-", "1.2.3", "0x10", "1 2"] {
            assert_eq!(normalize_numeric_key(raw), raw, "raw={raw:?}");
        }
    }

    #[test]
    fn collapse_normalizes_numeric_key_columns_only() {
        let c = cols(&["id", "v"]);
        let rows = vec![
            row(&[Some("1"), Some("a")]),
            row(&[Some("01"), Some("b")]),
            row(&[Some(" 1"), Some("c")]),
        ];
        let num = [("id".to_string(), KeyKind::Numeric)];
        let up = conflict(ConflictMode::Update, &["id"]).collapse_duplicate_keys(&c, &rows, &num);
        assert_eq!(up.as_ref(), &[row(&[Some(" 1"), Some("c")])]);
        let sk = conflict(ConflictMode::Skip, &["id"]).collapse_duplicate_keys(&c, &rows, &num);
        assert_eq!(sk.as_ref(), &[row(&[Some("1"), Some("a")])]);
        // 数値列でなければ従来どおりテキスト完全一致 (畳まない)。
        let none = conflict(ConflictMode::Update, &["id"]).collapse_duplicate_keys(&c, &rows, &[]);
        assert!(matches!(none, Cow::Borrowed(_)));
    }

    #[test]
    fn collapse_normalizes_uuid_and_bool_keys() {
        let c = cols(&["id", "v"]);
        let rows = vec![
            row(&[Some("A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11"), Some("a")]),
            row(&[Some("{a0eebc999c0b4ef8bb6d6bb9bd380a11}"), Some("b")]),
        ];
        let kinds = [("id".to_string(), KeyKind::Uuid)];
        let up = conflict(ConflictMode::Update, &["id"]).collapse_duplicate_keys(&c, &rows, &kinds);
        assert_eq!(up.len(), 1);
        assert_eq!(up[0][1].as_deref(), Some("b"));
        // 型情報が無ければ従来どおり畳まない。
        let none = conflict(ConflictMode::Update, &["id"]).collapse_duplicate_keys(&c, &rows, &[]);
        assert!(matches!(none, Cow::Borrowed(_)));
        // 32 桁の 16 進にならない値は元のまま (別キー)。
        assert_eq!(KeyKind::Uuid.normalize("not-a-uuid"), "not-a-uuid");
        assert_eq!(KeyKind::Bool.normalize("TRUE"), "t");
        assert_eq!(KeyKind::Bool.normalize(" 0 "), "f");
        assert_eq!(KeyKind::Bool.normalize("maybe"), "maybe");
    }

    #[test]
    fn collapse_numeric_keeps_64bit_precision() {
        let c = cols(&["id"]);
        let rows = vec![
            row(&[Some("9007199254740993")]),
            row(&[Some("9007199254740992")]),
        ];
        let out = conflict(ConflictMode::Update, &["id"]).collapse_duplicate_keys(
            &c,
            &rows,
            &[("id".to_string(), KeyKind::Numeric)],
        );
        assert!(matches!(out, Cow::Borrowed(_)));
    }

    #[test]
    fn omitted_column_safety_rules() {
        assert!(omitted_column_is_safe("auto_increment", false, None));
        assert!(omitted_column_is_safe("", true, None));
        // MariaDB は既定値 NULL を文字列で返す。
        assert!(omitted_column_is_safe("", true, Some("NULL")));
        assert!(!omitted_column_is_safe("", false, None));
        assert!(!omitted_column_is_safe("", true, Some("0")));
        assert!(!omitted_column_is_safe("", true, Some("'NULL'")));
        // 式の既定値は生成列ではない。
        assert!(omitted_column_is_safe("DEFAULT_GENERATED", true, None));
        for g in [
            "STORED GENERATED",
            "VIRTUAL GENERATED",
            "PERSISTENT GENERATED",
        ] {
            assert!(!omitted_column_is_safe(g, true, None), "{g}");
        }
    }

    #[test]
    fn mysql_check_rejects_unique_key_containing_generated_column() {
        // 生成列 (omitted_safe に入らない) を含む一意キーは、取り込まなくても衝突し得る。
        let u = vec![uk("email", &["email"]), uk("g", &["gen"])];
        assert!(check_mysql_unique_keys(&u, &[], &cols(&["email"]), &cols(&["email"])).is_err());
    }

    #[test]
    fn mysql_check_skips_every_unique_key_equal_to_selection() {
        let u = vec![uk("a1", &["a"]), uk("a2", &["a"])];
        assert!(check_mysql_unique_keys(&u, &[], &cols(&["a"]), &cols(&["a"])).is_ok());
    }
}
