//! 非テーブルオブジェクト (ビュー / マテビュー / ルーチン / トリガー / シーケンス) の
//! スキーマ比較 (#1879)。
//!
//! `db::diff` がテーブルと列を比べるのに対し、こちらは「定義 DDL の本文」を比べる純粋層。
//! コマンド層 (`commands::diff`) が両側のオブジェクト一覧と定義本文を集めて
//! [`compute_object_diff`] に渡し、同期 SQL の生成は `db::sync::generate_sync_sql` が
//! [`create_object_sql`] / [`replace_object_sql`] / [`drop_object_sql`] を使って行う。
//! DB には触れないので単体テストできる。

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use super::diff::DiffStatus;
use super::where_used::supports_kind;
use super::DriverKind;

/// 比較対象のオブジェクト種別 (表示・作成順の基準)。作成は関数 → プロシージャ → ビュー →
/// マテビュー → トリガーの順 (後ろの種別が前の種別を参照しうる)。シーケンスは表の既定値から
/// 参照されるので、同期では表より先に作る。
pub const OBJECT_KINDS: [&str; 6] = [
    "sequence",
    "function",
    "procedure",
    "view",
    "materialized_view",
    "trigger",
];

/// このドライバがその種別を持ち、定義を比較できるか。`where_used::supports_kind` に
/// シーケンス (PostgreSQL のみ) を足したもの。
pub fn supports_object_kind(driver: DriverKind, kind: &str) -> bool {
    if kind == "sequence" {
        return driver == DriverKind::Postgres;
    }
    supports_kind(driver, kind)
}

/// このドライバが持たない (比較対象外の) 種別。UI が「対象外」と理由付きで表示する。
pub fn unsupported_object_kinds(driver: DriverKind) -> Vec<String> {
    OBJECT_KINDS
        .iter()
        .filter(|k| !supports_object_kind(driver, k))
        .map(|k| k.to_string())
        .collect()
}

/// 片側から集めた 1 オブジェクト。`definition` はドライバが返した本文そのまま (PostgreSQL の
/// ビューだけ、コマンド層が `CREATE VIEW ... AS` で包んで完全な文にしたもの)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectDefinition {
    pub kind: String,
    pub name: String,
    /// PostgreSQL の関数 / プロシージャの引数並び (`pg_get_function_identity_arguments`)。
    /// オーバーロードの区別と `DROP FUNCTION` に使う。それ以外は `None`。
    pub signature: Option<String>,
    pub definition: String,
}

/// 1 オブジェクトの比較結果。`Same` のものは定義を載せない (ペイロードを小さくする)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObjectDiff {
    pub kind: String,
    pub name: String,
    /// PostgreSQL の関数 / プロシージャの引数並び。オーバーロードの識別に使う。
    #[serde(default)]
    pub signature: Option<String>,
    /// トリガーの対象テーブル (定義から読めたとき)。PostgreSQL ではトリガー名が表ごとに
    /// 一意なので、(名前, 対象表) で対応づける。
    #[serde(default)]
    pub table: Option<String>,
    pub status: DiffStatus,
    /// source 側の定義 (`SourceOnly` / `Different` のとき)。DEFINER とスキーマ修飾を
    /// 取り除いた、target にそのまま適用できる形。
    #[serde(default)]
    pub source_definition: Option<String>,
    /// target 側の定義 (`TargetOnly` / `Different` のとき)。比較の見比べ用。
    #[serde(default)]
    pub target_definition: Option<String>,
}

/// オブジェクト比較の結果一式。`SchemaDiff::objects`。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObjectComparison {
    /// 比較したか。取得に失敗したときは false で、差分がないように見せない。
    #[serde(default)]
    pub compared: bool,
    #[serde(default)]
    pub items: Vec<ObjectDiff>,
    /// このドライバに存在しない種別 (SQLite のルーチンなど)。UI が「対象外」と表示する。
    #[serde(default)]
    pub unsupported_kinds: Vec<String>,
}

struct Prepared {
    kind: String,
    name: String,
    signature: Option<String>,
    table: Option<String>,
    /// 同期にそのまま使える本文 (DEFINER・スキーマ修飾を除去済み)。
    portable: String,
    /// 比較用 (空白を畳んだもの)。
    normalized: String,
    /// 対応づけのキー。PostgreSQL の関数は引数並び、トリガーは対象表を含める。
    identity: String,
}

fn prepare(driver: DriverKind, db: &str, def: &ObjectDefinition) -> Prepared {
    let portable = portable_definition(driver, db, &def.definition);
    let normalized = normalize_definition(&portable);
    let table = if def.kind == "trigger" {
        trigger_table(&portable)
    } else {
        None
    };
    let identity = match (driver, def.kind.as_str()) {
        (DriverKind::Postgres, "function" | "procedure") => {
            collapse_whitespace(def.signature.as_deref().unwrap_or_default())
        }
        (DriverKind::Postgres, "trigger") => table.clone().unwrap_or_default(),
        _ => String::new(),
    };
    Prepared {
        kind: def.kind.clone(),
        name: def.name.clone(),
        signature: def.signature.clone(),
        table,
        portable,
        normalized,
        identity,
    }
}

fn kind_rank(kind: &str) -> usize {
    OBJECT_KINDS
        .iter()
        .position(|k| *k == kind)
        .unwrap_or(OBJECT_KINDS.len())
}

/// `source` と `target` のオブジェクトを (種別, 名前, 識別子) で対応づけて比べる。
/// `source_db` / `target_db` は、定義本文に入るスキーマ修飾 (`db.` / `` `db`. ``) を
/// 取り除くために使う (別名のスキーマ同士でも同じ定義として比べるため)。
/// 結果は種別 → 名前の順。
pub fn compute_object_diff(
    driver: DriverKind,
    source_db: &str,
    target_db: &str,
    source: &[ObjectDefinition],
    target: &[ObjectDefinition],
) -> Vec<ObjectDiff> {
    type Key = (usize, String, String, String);
    let key = |p: &Prepared| -> Key {
        (
            kind_rank(&p.kind),
            p.name.clone(),
            p.identity.clone(),
            p.kind.clone(),
        )
    };
    let mut src: BTreeMap<Key, Prepared> = BTreeMap::new();
    for d in source {
        let p = prepare(driver, source_db, d);
        src.insert(key(&p), p);
    }
    let mut tgt: BTreeMap<Key, Prepared> = BTreeMap::new();
    for d in target {
        let p = prepare(driver, target_db, d);
        tgt.insert(key(&p), p);
    }

    let mut keys: Vec<Key> = src.keys().chain(tgt.keys()).cloned().collect();
    keys.sort();
    keys.dedup();

    keys.into_iter()
        .filter_map(|k| {
            let (s, t) = (src.get(&k), tgt.get(&k));
            let base = |p: &Prepared, status: DiffStatus| ObjectDiff {
                kind: p.kind.clone(),
                name: p.name.clone(),
                signature: p.signature.clone(),
                table: p.table.clone(),
                status,
                source_definition: None,
                target_definition: None,
            };
            match (s, t) {
                (Some(s), None) => Some(ObjectDiff {
                    source_definition: Some(s.portable.clone()),
                    ..base(s, DiffStatus::SourceOnly)
                }),
                (None, Some(t)) => Some(ObjectDiff {
                    target_definition: Some(t.portable.clone()),
                    ..base(t, DiffStatus::TargetOnly)
                }),
                (Some(s), Some(t)) if s.normalized == t.normalized => {
                    Some(base(s, DiffStatus::Same))
                }
                (Some(s), Some(t)) => Some(ObjectDiff {
                    source_definition: Some(s.portable.clone()),
                    target_definition: Some(t.portable.clone()),
                    ..base(s, DiffStatus::Different)
                }),
                (None, None) => None,
            }
        })
        .collect()
}

// ── 本文の整形 ─────────────────────────────────────────────

fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 比較用の正規化: 空白の連続を 1 つに畳み、末尾の `;` を除く。
fn normalize_definition(s: &str) -> String {
    collapse_whitespace(s)
        .trim_end_matches(';')
        .trim_end()
        .to_string()
}

fn is_ident_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// target にそのまま適用できる本文にする: 前後の空白と末尾の `;` を除き、MySQL の
/// `DEFINER=...` (適用先に無いアカウントだと失敗する) と、自スキーマの修飾を取り除く。
fn portable_definition(driver: DriverKind, db: &str, raw: &str) -> String {
    let mut s = raw.trim().trim_end_matches(';').trim_end().to_string();
    if driver == DriverKind::Mysql {
        s = strip_mysql_definer(&s);
    }
    strip_schema_qualifier(driver, db, &s)
}

/// MySQL の `DEFINER=`user`@`host`` を (後続の空白ごと) 取り除く。
fn strip_mysql_definer(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    let Some(start) = lower.find("definer=") else {
        return s.to_string();
    };
    let bytes = s.as_bytes();
    let mut i = start + "definer=".len();
    // user 部
    i = skip_account_part(bytes, i, |c| c == b'@');
    if bytes.get(i) == Some(&b'@') {
        i += 1;
        // host 部
        i = skip_account_part(bytes, i, |c| c.is_ascii_whitespace());
    }
    while bytes.get(i).is_some_and(|c| c.is_ascii_whitespace()) {
        i += 1;
    }
    format!("{}{}", &s[..start], &s[i..])
}

fn skip_account_part(bytes: &[u8], mut i: usize, stop: impl Fn(u8) -> bool) -> usize {
    match bytes.get(i) {
        Some(b'`') | Some(b'\'') | Some(b'"') => {
            let quote = bytes[i];
            i += 1;
            while i < bytes.len() {
                if bytes[i] == quote {
                    // 引用符の二重化 (`` ` ``` ` ``) は中身の引用符
                    if bytes.get(i + 1) == Some(&quote) {
                        i += 2;
                        continue;
                    }
                    return i + 1;
                }
                i += 1;
            }
            i
        }
        _ => {
            while i < bytes.len() && !stop(bytes[i]) {
                i += 1;
            }
            i
        }
    }
}

/// 自スキーマの修飾 (`` `db`. `` / `"db".` / `db.`) を取り除く。SQLite は修飾が付かない
/// (`main.` を書くのは稀) ので何もしない。直前が `.` や識別子文字のものは別物なので残す。
fn strip_schema_qualifier(driver: DriverKind, db: &str, s: &str) -> String {
    if db.is_empty() {
        return s.to_string();
    }
    let mut patterns: Vec<String> = Vec::new();
    match driver {
        DriverKind::Mysql => patterns.push(format!("`{}`.", db.replace('`', "``"))),
        DriverKind::Postgres => {
            patterns.push(format!("\"{}\".", db.replace('"', "\"\"")));
            patterns.push(format!("{db}."));
        }
        DriverKind::Sqlite => return s.to_string(),
    }
    let mut out = s.to_string();
    for pat in &patterns {
        out = remove_prefix_qualifier(&out, pat);
    }
    out
}

fn remove_prefix_qualifier(s: &str, pat: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    let mut prev: Option<char> = None;
    while let Some(pos) = rest.find(pat) {
        let before = &rest[..pos];
        let p = before.chars().next_back().or(prev);
        // `other.db.t` や `xdb.t` の途中は取り除かない。
        let boundary_ok =
            !matches!(p, Some(c) if c == '.' || is_ident_char(c) || c == '"' || c == '`');
        out.push_str(before);
        if boundary_ok {
            // 修飾を落とす。
        } else {
            out.push_str(pat);
        }
        prev = pat.chars().next_back();
        rest = &rest[pos + pat.len()..];
    }
    out.push_str(rest);
    out
}

/// トリガー定義の `... ON <table> ...` から対象表を読む。
fn trigger_table(def: &str) -> Option<String> {
    let mut tokens = def.split_whitespace();
    // `TRIGGER` の後ろの最初の `ON`
    tokens
        .by_ref()
        .find(|t| t.eq_ignore_ascii_case("TRIGGER"))?;
    tokens.by_ref().find(|t| t.eq_ignore_ascii_case("ON"))?;
    let raw = tokens.next()?;
    let name = raw.trim_end_matches([';', ',']).trim_matches(['`', '"']);
    // `schema.table` 形は表名側だけ残す。
    let name = name.rsplit('.').next().unwrap_or(name);
    let name = name.trim_matches(['`', '"']);
    (!name.is_empty()).then(|| name.to_string())
}

// ── 同期 SQL ───────────────────────────────────────────────

fn quote(driver: DriverKind, name: &str) -> String {
    super::sync::quote_ident(driver, name)
}

fn drop_keyword(kind: &str) -> &'static str {
    match kind {
        "view" => "VIEW",
        "materialized_view" => "MATERIALIZED VIEW",
        "function" => "FUNCTION",
        "procedure" => "PROCEDURE",
        "trigger" => "TRIGGER",
        _ => "SEQUENCE",
    }
}

/// `DROP ...` 文 (末尾の `;` なし)。
pub fn drop_object_sql(driver: DriverKind, d: &ObjectDiff) -> String {
    let kw = drop_keyword(&d.kind);
    let name = quote(driver, &d.name);
    match (driver, d.kind.as_str()) {
        (DriverKind::Postgres, "function" | "procedure") => {
            format!(
                "DROP {kw} {name}({})",
                d.signature.as_deref().unwrap_or_default()
            )
        }
        (DriverKind::Postgres, "trigger") => match &d.table {
            Some(t) => format!("DROP TRIGGER {name} ON {}", quote(driver, t)),
            None => format!("DROP TRIGGER {name}"),
        },
        _ => format!("DROP {kw} {name}"),
    }
}

/// `CREATE ...` 文。`definition` は [`ObjectDiff::source_definition`]。
pub fn create_object_sql(definition: &str) -> String {
    definition
        .trim()
        .trim_end_matches(';')
        .trim_end()
        .to_string()
}

/// 先頭の `CREATE` を `CREATE OR REPLACE` にする (既に OR REPLACE ならそのまま)。
fn with_or_replace(definition: &str) -> String {
    let d = definition.trim_start();
    let lower = d.to_ascii_lowercase();
    if !lower.starts_with("create") || lower.starts_with("create or replace") {
        return d.to_string();
    }
    format!("CREATE OR REPLACE{}", &d["create".len()..])
}

/// PostgreSQL の DO ブロックで複数文を 1 文にまとめる。ブロック内で使うドル引用の
/// タグは本文に現れないものを選ぶ。
fn pg_do_block(parts: &[String]) -> String {
    let mut tag = String::from("$noobdb$");
    let mut n = 0;
    while parts.iter().any(|p| p.contains(&tag)) {
        n += 1;
        tag = format!("$noobdb{n}$");
    }
    let body = parts
        .iter()
        .map(|p| format!("  {};", p.trim().trim_end_matches(';')))
        .collect::<Vec<_>>()
        .join("\n");
    format!("DO {tag}\nBEGIN\n{body}\nEND\n{tag}")
}

/// 定義が変わったオブジェクトを target で置き換える SQL。1 つの `SyncStatement` に載せるので
/// 複数文になるときは `;` で区切る (MySQL / SQLite)。PostgreSQL は拡張プロトコルが複数文を
/// 受けないため、DO ブロックで 1 文にする。
pub fn replace_object_sql(driver: DriverKind, d: &ObjectDiff, definition: &str) -> String {
    let create = create_object_sql(definition);
    let drop = drop_object_sql(driver, d);
    match (driver, d.kind.as_str()) {
        // 値を持つシーケンスは DROP せず ALTER (採番の現在値を保つ)。
        (DriverKind::Postgres, "sequence") => match create.strip_prefix("CREATE SEQUENCE") {
            Some(rest) => format!("ALTER SEQUENCE{rest}"),
            None => create,
        },
        (DriverKind::Postgres, "function" | "procedure") => with_or_replace(&create),
        (DriverKind::Postgres, _) => pg_do_block(&[drop, create]),
        (DriverKind::Mysql, "view") => with_or_replace(&create),
        (DriverKind::Mysql, _) | (DriverKind::Sqlite, _) => format!("{drop};\n{create}"),
    }
}

/// 作成・置換の依存順。ビュー同士など、別のオブジェクトの名前を本文に含むものを後ろへ回す
/// (循環や名前の偶然の一致があっても、元の順序を保って必ず全件を返す)。
pub fn order_for_create<'a>(items: &[&'a ObjectDiff]) -> Vec<&'a ObjectDiff> {
    let mut sorted: Vec<&ObjectDiff> = items.to_vec();
    sorted.sort_by(|a, b| {
        kind_rank(&a.kind)
            .cmp(&kind_rank(&b.kind))
            .then_with(|| a.name.cmp(&b.name))
    });
    let mentions = |a: &ObjectDiff, b: &ObjectDiff| -> bool {
        // a の本文が b の名前を含むか (b を先に作る必要がある)
        a.kind == b.kind
            && a.name != b.name
            && a.source_definition
                .as_deref()
                .is_some_and(|d| contains_word(d, &b.name))
    };
    let mut out: Vec<&ObjectDiff> = Vec::with_capacity(sorted.len());
    let mut placed: HashSet<usize> = HashSet::new();
    while out.len() < sorted.len() {
        let mut progressed = false;
        for (i, a) in sorted.iter().enumerate() {
            if placed.contains(&i) {
                continue;
            }
            let blocked = sorted
                .iter()
                .enumerate()
                .any(|(j, b)| !placed.contains(&j) && j != i && mentions(a, b));
            if !blocked {
                placed.insert(i);
                out.push(a);
                progressed = true;
            }
        }
        if !progressed {
            // 循環: 残りは元の順で出す。
            for (i, a) in sorted.iter().enumerate() {
                if placed.insert(i) {
                    out.push(a);
                }
            }
        }
    }
    out
}

/// 識別子として単語境界で `word` を含むか (大小無視)。
fn contains_word(haystack: &str, word: &str) -> bool {
    if word.is_empty() {
        return false;
    }
    let h = haystack.to_lowercase();
    let w = word.to_lowercase();
    let mut from = 0;
    while let Some(pos) = h[from..].find(&w) {
        let start = from + pos;
        let end = start + w.len();
        let before_ok = h[..start]
            .chars()
            .next_back()
            .map_or(true, |c| !is_ident_char(c));
        let after_ok = h[end..].chars().next().map_or(true, |c| !is_ident_char(c));
        if before_ok && after_ok {
            return true;
        }
        from = end;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(kind: &str, name: &str, definition: &str) -> ObjectDefinition {
        ObjectDefinition {
            kind: kind.into(),
            name: name.into(),
            signature: None,
            definition: definition.into(),
        }
    }

    fn diffs(
        driver: DriverKind,
        s_db: &str,
        t_db: &str,
        s: &[ObjectDefinition],
        t: &[ObjectDefinition],
    ) -> Vec<ObjectDiff> {
        compute_object_diff(driver, s_db, t_db, s, t)
    }

    #[test]
    fn classifies_added_removed_changed_and_same() {
        let s = [
            def("view", "a", "CREATE VIEW a AS SELECT 1"),
            def("view", "b", "CREATE VIEW b AS SELECT 2"),
            def("view", "c", "CREATE VIEW c AS SELECT 3"),
        ];
        let t = [
            def("view", "b", "CREATE VIEW b AS SELECT 2"),
            def("view", "c", "CREATE VIEW c AS SELECT 99"),
            def("view", "d", "CREATE VIEW d AS SELECT 4"),
        ];
        let d = diffs(DriverKind::Sqlite, "main", "main", &s, &t);
        let by = |n: &str| d.iter().find(|x| x.name == n).map(|x| x.status);
        assert_eq!(by("a"), Some(DiffStatus::SourceOnly));
        assert_eq!(by("b"), Some(DiffStatus::Same));
        assert_eq!(by("c"), Some(DiffStatus::Different));
        assert_eq!(by("d"), Some(DiffStatus::TargetOnly));
        // Same は定義を載せない。
        let b = d.iter().find(|x| x.name == "b").unwrap();
        assert!(b.source_definition.is_none() && b.target_definition.is_none());
    }

    #[test]
    fn whitespace_and_trailing_semicolon_do_not_matter() {
        let s = [def("view", "v", "CREATE VIEW v AS\n  SELECT 1\n  FROM t;")];
        let t = [def("view", "v", "CREATE VIEW v AS SELECT 1 FROM t")];
        let d = diffs(DriverKind::Sqlite, "main", "main", &s, &t);
        assert_eq!(d[0].status, DiffStatus::Same);
    }

    #[test]
    fn mysql_definer_and_database_qualifier_are_ignored() {
        let s = [def(
            "view",
            "v",
            "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v` AS select `stg`.`t`.`id` AS `id` from `stg`.`t`",
        )];
        let t = [def(
            "view",
            "v",
            "CREATE ALGORITHM=UNDEFINED DEFINER=`app`@`10.0.0.1` SQL SECURITY DEFINER VIEW `v` AS select `prod`.`t`.`id` AS `id` from `prod`.`t`",
        )];
        let d = diffs(DriverKind::Mysql, "stg", "prod", &s, &t);
        assert_eq!(d[0].status, DiffStatus::Same);
    }

    #[test]
    fn mysql_portable_definition_drops_definer_and_qualifier() {
        let s = [def(
            "procedure",
            "p",
            "CREATE DEFINER=`root`@`localhost` PROCEDURE `p`()\nBEGIN\n  SELECT * FROM `stg`.`t`;\nEND",
        )];
        let d = diffs(DriverKind::Mysql, "stg", "prod", &s, &[]);
        let sql = d[0].source_definition.as_deref().unwrap();
        assert!(!sql.contains("DEFINER"), "{sql}");
        assert!(!sql.contains("`stg`"), "{sql}");
        assert!(sql.starts_with("CREATE PROCEDURE `p`()"), "{sql}");
    }

    #[test]
    fn qualifier_strip_keeps_longer_names() {
        // `xstg.` や `other.stg.` は自スキーマの修飾ではない。
        let out = strip_schema_qualifier(
            DriverKind::Postgres,
            "stg",
            "SELECT xstg.a, other.stg.b, stg.c FROM stg.t",
        );
        assert_eq!(out, "SELECT xstg.a, other.stg.b, c FROM t");
        let q = strip_schema_qualifier(
            DriverKind::Postgres,
            "My Schema",
            "FROM \"My Schema\".t JOIN \"x\".\"My Schema\".u",
        );
        assert_eq!(q, "FROM t JOIN \"x\".\"My Schema\".u");
    }

    #[test]
    fn postgres_overloads_are_distinct_objects() {
        let mk = |sig: &str, body: &str| ObjectDefinition {
            kind: "function".into(),
            name: "f".into(),
            signature: Some(sig.into()),
            definition: format!(
                "CREATE OR REPLACE FUNCTION public.f({sig}) RETURNS int AS $$ {body} $$"
            ),
        };
        let s = [mk("a integer", "SELECT 1"), mk("a text", "SELECT 2")];
        let t = [mk("a integer", "SELECT 1"), mk("a text", "SELECT 3")];
        let d = diffs(DriverKind::Postgres, "public", "public", &s, &t);
        assert_eq!(d.len(), 2);
        let int = d
            .iter()
            .find(|x| x.signature.as_deref() == Some("a integer"))
            .unwrap();
        let text = d
            .iter()
            .find(|x| x.signature.as_deref() == Some("a text"))
            .unwrap();
        assert_eq!(int.status, DiffStatus::Same);
        assert_eq!(text.status, DiffStatus::Different);
    }

    #[test]
    fn postgres_triggers_match_by_name_and_table() {
        let s = [
            def(
                "trigger",
                "audit",
                "CREATE TRIGGER audit AFTER INSERT ON public.a FOR EACH ROW EXECUTE FUNCTION f()",
            ),
            def(
                "trigger",
                "audit",
                "CREATE TRIGGER audit AFTER INSERT ON public.b FOR EACH ROW EXECUTE FUNCTION f()",
            ),
        ];
        let t = [def(
            "trigger",
            "audit",
            "CREATE TRIGGER audit AFTER INSERT ON public.a FOR EACH ROW EXECUTE FUNCTION f()",
        )];
        let d = diffs(DriverKind::Postgres, "public", "public", &s, &t);
        assert_eq!(d.len(), 2);
        assert_eq!(
            d.iter()
                .find(|x| x.table.as_deref() == Some("a"))
                .unwrap()
                .status,
            DiffStatus::Same
        );
        assert_eq!(
            d.iter()
                .find(|x| x.table.as_deref() == Some("b"))
                .unwrap()
                .status,
            DiffStatus::SourceOnly
        );
    }

    #[test]
    fn trigger_table_is_read_from_the_definition() {
        assert_eq!(
            trigger_table(
                "CREATE DEFINER=x TRIGGER `t` BEFORE UPDATE ON `orders` FOR EACH ROW SET NEW.a = 1"
            )
            .as_deref(),
            Some("orders")
        );
        assert_eq!(
            trigger_table(
                "CREATE TRIGGER t AFTER UPDATE OF a, b ON \"x\".\"Orders\" BEGIN SELECT 1; END"
            )
            .as_deref(),
            Some("Orders")
        );
        assert_eq!(trigger_table("CREATE VIEW v AS SELECT 1"), None);
    }

    #[test]
    fn unsupported_kinds_follow_the_driver_capability_table() {
        assert_eq!(
            unsupported_object_kinds(DriverKind::Sqlite),
            vec!["sequence", "function", "procedure", "materialized_view"]
        );
        assert_eq!(
            unsupported_object_kinds(DriverKind::Mysql),
            vec!["sequence", "materialized_view"]
        );
        assert!(unsupported_object_kinds(DriverKind::Postgres).is_empty());
    }

    fn od(kind: &str, name: &str, table: Option<&str>, sig: Option<&str>) -> ObjectDiff {
        ObjectDiff {
            kind: kind.into(),
            name: name.into(),
            signature: sig.map(str::to_string),
            table: table.map(str::to_string),
            status: DiffStatus::Different,
            source_definition: None,
            target_definition: None,
        }
    }

    #[test]
    fn drop_sql_per_driver() {
        assert_eq!(
            drop_object_sql(DriverKind::Mysql, &od("view", "v", None, None)),
            "DROP VIEW `v`"
        );
        assert_eq!(
            drop_object_sql(
                DriverKind::Postgres,
                &od("function", "f", None, Some("a integer, b text"))
            ),
            "DROP FUNCTION \"f\"(a integer, b text)"
        );
        assert_eq!(
            drop_object_sql(
                DriverKind::Postgres,
                &od("trigger", "t", Some("orders"), None)
            ),
            "DROP TRIGGER \"t\" ON \"orders\""
        );
        assert_eq!(
            drop_object_sql(DriverKind::Sqlite, &od("trigger", "t", Some("o"), None)),
            "DROP TRIGGER \"t\""
        );
        assert_eq!(
            drop_object_sql(
                DriverKind::Postgres,
                &od("materialized_view", "m", None, None)
            ),
            "DROP MATERIALIZED VIEW \"m\""
        );
        assert_eq!(
            drop_object_sql(DriverKind::Postgres, &od("sequence", "s", None, None)),
            "DROP SEQUENCE \"s\""
        );
    }

    #[test]
    fn replace_sql_per_driver() {
        let v = od("view", "v", None, None);
        assert_eq!(
            replace_object_sql(
                DriverKind::Mysql,
                &v,
                "CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v` AS select 1;"
            ),
            "CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v` AS select 1"
        );
        let p = od("procedure", "p", None, None);
        assert_eq!(
            replace_object_sql(DriverKind::Mysql, &p, "CREATE PROCEDURE `p`() SELECT 1"),
            "DROP PROCEDURE `p`;\nCREATE PROCEDURE `p`() SELECT 1"
        );
        assert_eq!(
            replace_object_sql(DriverKind::Sqlite, &v, "CREATE VIEW v AS SELECT 2"),
            "DROP VIEW \"v\";\nCREATE VIEW v AS SELECT 2"
        );
        let pg = replace_object_sql(DriverKind::Postgres, &v, "CREATE VIEW \"v\" AS\nSELECT 2");
        assert!(
            pg.starts_with("DO $noobdb$\nBEGIN\n  DROP VIEW \"v\";\n  CREATE VIEW \"v\" AS"),
            "{pg}"
        );
        assert!(pg.ends_with("END\n$noobdb$"), "{pg}");
        let f = od("function", "f", None, Some("a integer"));
        assert_eq!(
            replace_object_sql(
                DriverKind::Postgres,
                &f,
                "CREATE FUNCTION f(a integer) RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql"
            ),
            "CREATE OR REPLACE FUNCTION f(a integer) RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql"
        );
        let s = od("sequence", "s", None, None);
        assert_eq!(
            replace_object_sql(
                DriverKind::Postgres,
                &s,
                "CREATE SEQUENCE \"s\" AS bigint INCREMENT BY 2"
            ),
            "ALTER SEQUENCE \"s\" AS bigint INCREMENT BY 2"
        );
    }

    #[test]
    fn do_block_tag_avoids_collisions() {
        let sql = pg_do_block(&["SELECT '$noobdb$'".into()]);
        assert!(sql.starts_with("DO $noobdb1$"), "{sql}");
    }

    #[test]
    fn create_order_puts_referenced_views_first() {
        let mut a = od("view", "a_top", None, None);
        a.source_definition = Some("CREATE VIEW a_top AS SELECT * FROM z_base".into());
        let mut z = od("view", "z_base", None, None);
        z.source_definition = Some("CREATE VIEW z_base AS SELECT 1".into());
        let mut f = od("function", "f", None, None);
        f.source_definition = Some("CREATE FUNCTION f()".into());
        let ordered = order_for_create(&[&a, &z, &f]);
        let names: Vec<&str> = ordered.iter().map(|o| o.name.as_str()).collect();
        assert_eq!(names, vec!["f", "z_base", "a_top"]);
    }

    #[test]
    fn create_order_survives_cycles() {
        let mut a = od("view", "a", None, None);
        a.source_definition = Some("CREATE VIEW a AS SELECT * FROM b".into());
        let mut b = od("view", "b", None, None);
        b.source_definition = Some("CREATE VIEW b AS SELECT * FROM a".into());
        assert_eq!(order_for_create(&[&a, &b]).len(), 2);
    }
}
