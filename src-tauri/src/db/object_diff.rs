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
    /// トリガーの対象表。PostgreSQL は `pg_trigger.tgrelid` から取った値 (定義の文字列を読むと
    /// 空白入りの引用名で壊れるため)。`None` のときは定義から読む (MySQL / SQLite)。
    pub table: Option<String>,
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

fn prepare(driver: DriverKind, from_db: &str, to_db: &str, def: &ObjectDefinition) -> Prepared {
    // 同期に使う本文: 自スキーマの修飾は消さず、target のスキーマ名へ置き換える。
    let portable = portable_definition(driver, from_db, to_db, &def.definition);
    // 比較用: 自スキーマの修飾を (両側とも) 取り除いてから空白を畳む。
    let normalized = normalize_definition(driver, from_db, &def.definition);
    let table = if def.kind == "trigger" {
        def.table
            .clone()
            .filter(|t| !t.is_empty())
            .or_else(|| trigger_table(&portable))
    } else {
        None
    };
    let identity = match (driver, def.kind.as_str()) {
        (DriverKind::Postgres, "function" | "procedure") => {
            collapse_whitespace(def.signature.as_deref().unwrap_or_default())
        }
        // 対象表が分からないトリガーは、同名のものを 1 つに潰さないよう定義で区別する。
        (DriverKind::Postgres, "trigger") => {
            table.clone().unwrap_or_else(|| format!("?{normalized}"))
        }
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
        let p = prepare(driver, source_db, target_db, d);
        src.insert(key(&p), p);
    }
    let mut tgt: BTreeMap<Key, Prepared> = BTreeMap::new();
    for d in target {
        let p = prepare(driver, target_db, target_db, d);
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

/// 空白の連続を 1 つに畳む (リテラル・引用符付き識別子・ドル引用の中は触らない)。
fn collapse_whitespace(s: &str) -> String {
    collapse_outside_literals(DriverKind::Postgres, s)
}

/// 比較用の正規化: 自スキーマの修飾 (と MySQL の DEFINER) を取り除き、リテラルの外の
/// 空白の連続を 1 つに畳み、末尾の `;` を除く。
fn normalize_definition(driver: DriverKind, db: &str, raw: &str) -> String {
    let mut s = raw.trim().trim_end_matches(';').trim_end().to_string();
    if driver == DriverKind::Mysql {
        s = strip_mysql_definer(&s);
    }
    s = rewrite_schema_qualifier(driver, db, "", &s);
    collapse_outside_literals(driver, &s)
        .trim_end_matches(';')
        .trim_end()
        .to_string()
}

fn is_ident_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// target にそのまま適用できる本文にする: 前後の空白と末尾の `;` を除き、MySQL の
/// `DEFINER=...` (適用先に無いアカウントだと失敗する) を外し、自スキーマの修飾を
/// target のスキーマ名へ置き換える。
fn portable_definition(driver: DriverKind, from_db: &str, to_db: &str, raw: &str) -> String {
    let mut s = raw.trim().trim_end_matches(';').trim_end().to_string();
    if driver == DriverKind::Mysql {
        s = strip_mysql_definer(&s);
    }
    let replacement = match driver {
        DriverKind::Sqlite => String::new(),
        d => format!("{}.", quote(d, to_db)),
    };
    rewrite_schema_qualifier(driver, from_db, &replacement, &s)
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

/// 字句の区分。`Code` 以外は書き換え・空白の畳み込みの対象にしない。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Seg<'a> {
    Code(&'a str),
    /// 引用符付き識別子 (`"x"` / `` `x` ``)。
    Quoted(&'a str),
    /// 文字列リテラル・ドル引用・コメント。
    Literal(&'a str),
}

/// `s` をコード / 引用符付き識別子 / リテラル (文字列・ドル引用・コメント) に分ける。
fn segments(driver: DriverKind, s: &str) -> Vec<Seg<'_>> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let (mut start, mut i) = (0usize, 0usize);
    fn flush<'a>(out: &mut Vec<Seg<'a>>, s: &'a str, from: usize, to: usize) {
        if to > from {
            out.push(Seg::Code(&s[from..to]));
        }
    }
    while i < b.len() {
        let c = b[i];
        let prev_ident = i > 0 && {
            let p = b[i - 1];
            p.is_ascii_alphanumeric() || p == b'_' || p == b'$' || p >= 0x80
        };
        let end_of = |from: usize| -> Option<(usize, bool)> {
            // from は開始引用符の位置。閉じ引用符の次の位置を返す。
            let q = b[from];
            let backslash = driver == DriverKind::Mysql && q != b'`';
            let mut j = from + 1;
            while j < b.len() {
                if backslash && b[j] == b'\\' {
                    j += 2;
                    continue;
                }
                if b[j] == q {
                    if b.get(j + 1) == Some(&q) {
                        j += 2;
                        continue;
                    }
                    return Some((j + 1, true));
                }
                j += 1;
            }
            Some((b.len(), false))
        };
        let seg: Option<(usize, bool)> = match c {
            b'\'' => end_of(i).map(|(e, _)| (e, false)),
            b'"' if driver == DriverKind::Mysql => end_of(i).map(|(e, _)| (e, false)),
            b'"' | b'`' => end_of(i).map(|(e, _)| (e, true)),
            b'-' if b.get(i + 1) == Some(&b'-') => {
                let e = s[i..].find('\n').map_or(b.len(), |n| i + n);
                Some((e, false))
            }
            b'#' if driver == DriverKind::Mysql => {
                let e = s[i..].find('\n').map_or(b.len(), |n| i + n);
                Some((e, false))
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                let e = s[i + 2..].find("*/").map_or(b.len(), |n| i + 2 + n + 2);
                Some((e, false))
            }
            b'$' if driver == DriverKind::Postgres && !prev_ident => {
                // `$tag$ ... $tag$`
                let mut j = i + 1;
                while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                    j += 1;
                }
                if b.get(j) == Some(&b'$') && !b.get(i + 1).is_some_and(|d| d.is_ascii_digit()) {
                    let tag = &s[i..=j];
                    let e = s[j + 1..]
                        .find(tag)
                        .map_or(b.len(), |n| j + 1 + n + tag.len());
                    Some((e, false))
                } else {
                    None
                }
            }
            _ => None,
        };
        match seg {
            Some((e, quoted)) => {
                flush(&mut out, s, start, i);
                out.push(if quoted {
                    Seg::Quoted(&s[i..e])
                } else {
                    Seg::Literal(&s[i..e])
                });
                i = e;
                start = e;
            }
            None => i += 1,
        }
    }
    flush(&mut out, s, start, b.len());
    out
}

/// リテラル・引用符付き識別子の外側の空白の連続を 1 つに畳む。
fn collapse_outside_literals(driver: DriverKind, s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for seg in segments(driver, s.trim()) {
        match seg {
            Seg::Code(c) => {
                let mut in_ws = false;
                for ch in c.chars() {
                    if ch.is_whitespace() {
                        if !in_ws {
                            out.push(' ');
                        }
                        in_ws = true;
                    } else {
                        in_ws = false;
                        out.push(ch);
                    }
                }
            }
            Seg::Quoted(t) | Seg::Literal(t) => out.push_str(t),
        }
    }
    out
}

/// 自スキーマの修飾 (`` `db`. `` / `"db".` / `db.`) を `replacement` (`""` なら削除) に置き換える。
/// 文字列リテラル・ドル引用・コメントの中は書き換えない。直前が `.` や識別子文字のものは
/// 別物 (`other.db.t` / `xdb.t`) なので残す。SQLite は修飾が付かないので何もしない。
fn rewrite_schema_qualifier(driver: DriverKind, db: &str, replacement: &str, s: &str) -> String {
    if db.is_empty() || driver == DriverKind::Sqlite {
        return s.to_string();
    }
    let quoted = quote(driver, db);
    let segs = segments(driver, s);
    let mut out = String::with_capacity(s.len());
    let mut skip_dot = false;
    let mut last: Option<char> = None;
    for (idx, seg) in segs.iter().enumerate() {
        match *seg {
            Seg::Quoted(t) => {
                let next_dot =
                    matches!(segs.get(idx + 1), Some(Seg::Code(c)) if c.starts_with('.'));
                if t == quoted && next_dot && last != Some('.') {
                    out.push_str(replacement);
                    skip_dot = true;
                } else {
                    out.push_str(t);
                }
                last = t.chars().next_back();
            }
            Seg::Literal(t) => {
                out.push_str(t);
                last = t.chars().next_back();
            }
            Seg::Code(c) => {
                let mut c = c;
                if skip_dot {
                    c = &c[1..];
                    skip_dot = false;
                }
                let (text, l) = rewrite_bare(driver, db, replacement, c, last);
                out.push_str(&text);
                last = l.or(last);
            }
        }
    }
    out
}

/// コード片の中の素の `db.` を置き換える (`last` はこの片の直前の 1 文字)。
fn rewrite_bare(
    driver: DriverKind,
    db: &str,
    replacement: &str,
    c: &str,
    last: Option<char>,
) -> (String, Option<char>) {
    // MySQL の素の `db.` は引用なしで書かれたものなので触らない (既知の制限)。
    if driver != DriverKind::Postgres {
        return (c.to_string(), c.chars().next_back());
    }
    let pat = format!("{db}.");
    let mut out = String::with_capacity(c.len());
    let mut rest = c;
    let mut prev = last;
    while let Some(pos) = rest.find(&pat) {
        let before = &rest[..pos];
        let p = before.chars().next_back().or(prev);
        let ok = !matches!(p, Some(ch) if ch == '.' || is_ident_char(ch) || ch == '"' || ch == '`');
        out.push_str(before);
        if ok {
            out.push_str(replacement);
        } else {
            out.push_str(&pat);
        }
        prev = Some('.');
        rest = &rest[pos + pat.len()..];
    }
    out.push_str(rest);
    let l = out.chars().next_back();
    (out, l)
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

/// 1 つの同期文に複数の文を載せるときの区切り行 (SQL コメント)。MySQL の実行側
/// (`MySqlConn::execute_transaction_guarded`) はこの行で分けて 1 文ずつテキストプロトコルで流す
/// (DROP + CREATE の置換・複数文は prepared protocol で通らないため)。PostgreSQL の定義にも
/// (マテビュー + 索引) 使い、DO ブロックにまとめる。
pub const STMT_SPLIT: &str = "-- noobdb:split";

/// [`STMT_SPLIT`] の行で分けた各文 (前後の空白と末尾の `;` を除く)。
pub fn split_statements(sql: &str) -> Vec<&str> {
    let mut parts: Vec<&str> = Vec::new();
    let (mut start, mut pos) = (0usize, 0usize);
    for line in sql.split('\n') {
        if line.trim() == STMT_SPLIT {
            parts.push(&sql[start..pos]);
            start = pos + line.len() + 1;
        }
        pos += line.len() + 1;
    }
    parts.push(&sql[start.min(sql.len())..]);
    parts
        .into_iter()
        .map(|p| p.trim().trim_end_matches(';').trim_end())
        .filter(|p| !p.is_empty())
        .collect()
}

/// MySQL がテキストプロトコルを要する文か: ルーチン・トリガーの CREATE / DROP (prepared
/// protocol だとエラー 1295) と、[`STMT_SPLIT`] を含む複数文。
pub fn needs_text_protocol(sql: &str) -> bool {
    if sql.lines().any(|l| l.trim() == STMT_SPLIT) {
        return true;
    }
    let head: String = sql
        .trim_start()
        .chars()
        .take(160)
        .collect::<String>()
        .to_ascii_uppercase();
    (head.starts_with("CREATE") || head.starts_with("DROP"))
        && [" PROCEDURE ", " FUNCTION ", " TRIGGER "]
            .iter()
            .any(|k| head.contains(k))
}

/// `CREATE ...` 文。`definition` は [`ObjectDiff::source_definition`]。複数文の定義
/// (マテビュー + 索引) は PostgreSQL では DO ブロックにまとめる (拡張プロトコルは 1 文だけ)。
pub fn create_object_sql(driver: DriverKind, definition: &str) -> String {
    let parts = split_statements(definition);
    if parts.len() > 1 && driver == DriverKind::Postgres {
        return pg_do_block(&parts.iter().map(|p| p.to_string()).collect::<Vec<_>>());
    }
    if parts.len() > 1 {
        return parts.join(&format!(";\n{STMT_SPLIT}\n"));
    }
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

/// この置換が元の定義を失いうるか (許可が要る)。MySQL のルーチン / トリガーは DROP + CREATE で
/// DDL が暗黙コミットされ、CREATE 失敗時に戻せない。マテビューの置換は DROP + CREATE で
/// データを再計算する。
pub fn replace_is_destructive(driver: DriverKind, kind: &str) -> bool {
    kind == "materialized_view"
        || (driver == DriverKind::Mysql && matches!(kind, "procedure" | "function" | "trigger"))
}

/// 定義が変わったオブジェクトを target で置き換える SQL。複数文になるとき、MySQL は
/// [`STMT_SPLIT`] 行で区切る (実行側が 1 文ずつ流す)、SQLite は `;` で区切る。PostgreSQL は
/// 拡張プロトコルが複数文を受けないため、DO ブロックで 1 文にする。
pub fn replace_object_sql(driver: DriverKind, d: &ObjectDiff, definition: &str) -> String {
    let create = create_object_sql(driver, definition);
    let drop = drop_object_sql(driver, d);
    match (driver, d.kind.as_str()) {
        // 値を持つシーケンスは DROP せず ALTER (採番の現在値を保つ)。
        (DriverKind::Postgres, "sequence") => match create.strip_prefix("CREATE SEQUENCE") {
            Some(rest) => format!("ALTER SEQUENCE{rest}"),
            None => create,
        },
        (DriverKind::Postgres, "function" | "procedure") => with_or_replace(&create),
        (DriverKind::Postgres, _) => {
            let mut parts = vec![drop];
            parts.extend(split_statements(definition).into_iter().map(str::to_string));
            pg_do_block(&parts)
        }
        (DriverKind::Mysql, "view") => with_or_replace(&create),
        (DriverKind::Mysql, _) => format!("{drop};\n{STMT_SPLIT}\n{create}"),
        (DriverKind::Sqlite, _) => format!("{drop};\n{create}"),
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
            table: None,
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
        // 修飾は消さず target のスキーマ名へ置き換える。
        assert!(sql.contains("FROM `prod`.`t`"), "{sql}");
        assert!(sql.starts_with("CREATE PROCEDURE `p`()"), "{sql}");
    }

    fn rw(db: &str, to: &str, s: &str) -> String {
        rewrite_schema_qualifier(DriverKind::Postgres, db, to, s)
    }

    #[test]
    fn qualifier_rewrite_keeps_longer_names() {
        // `xstg.` や `other.stg.` は自スキーマの修飾ではない。
        assert_eq!(
            rw("stg", "", "SELECT xstg.a, other.stg.b, stg.c FROM stg.t"),
            "SELECT xstg.a, other.stg.b, c FROM t"
        );
        assert_eq!(
            rw(
                "My Schema",
                "",
                "FROM \"My Schema\".t JOIN \"x\".\"My Schema\".u"
            ),
            "FROM t JOIN \"x\".\"My Schema\".u"
        );
    }

    #[test]
    fn qualifier_rewrite_replaces_with_target_schema() {
        assert_eq!(
            rw(
                "stg",
                "\"prod\".",
                "CREATE VIEW v AS SELECT * FROM stg.t JOIN \"stg\".u ON true"
            ),
            "CREATE VIEW v AS SELECT * FROM \"prod\".t JOIN \"prod\".u ON true"
        );
    }

    #[test]
    fn qualifier_rewrite_skips_literals_dollar_quotes_and_comments() {
        let src =
            "SELECT 'stg.users'::regclass, 'it''s stg.x', stg.t -- stg.c\n/* stg.d */ FROM stg.u";
        assert_eq!(
            rw("stg", "", src),
            "SELECT 'stg.users'::regclass, 'it''s stg.x', t -- stg.c\n/* stg.d */ FROM u"
        );
        let body = "CREATE FUNCTION stg.f() RETURNS int AS $body$ SELECT 'stg.x'::regclass; SELECT * FROM stg.t $body$ LANGUAGE sql";
        assert_eq!(
            rw("stg", "\"prod\".", body),
            "CREATE FUNCTION \"prod\".f() RETURNS int AS $body$ SELECT 'stg.x'::regclass; SELECT * FROM stg.t $body$ LANGUAGE sql"
        );
        // `$1` はドル引用ではない。
        assert_eq!(rw("stg", "", "SELECT $1, stg.t"), "SELECT $1, t");
    }

    #[test]
    fn mysql_qualifier_rewrite_skips_strings_and_comments() {
        let s = "SELECT `stg`.`t`.`a`, 'x `stg`.`y`', \"`stg`.`z`\" FROM `stg`.`t` # `stg`.`c`";
        assert_eq!(
            rewrite_schema_qualifier(DriverKind::Mysql, "stg", "`prod`.", s),
            "SELECT `prod`.`t`.`a`, 'x `stg`.`y`', \"`stg`.`z`\" FROM `prod`.`t` # `stg`.`c`"
        );
    }

    #[test]
    fn collapse_keeps_whitespace_inside_literals() {
        assert_eq!(
            collapse_outside_literals(DriverKind::Postgres, "a  =   'x   y'  AND\n b = \"c  d\" "),
            "a = 'x   y' AND b = \"c  d\""
        );
        // リテラルの中の空白だけが違う定義は別物。
        let s = [def("view", "v", "CREATE VIEW v AS SELECT 'a  b'")];
        let t = [def("view", "v", "CREATE VIEW v AS SELECT 'a b'")];
        let d = diffs(DriverKind::Sqlite, "main", "main", &s, &t);
        assert_eq!(d[0].status, DiffStatus::Different);
    }

    #[test]
    fn postgres_function_bodies_with_own_schema_are_compared_verbatim() {
        let mk = |schema: &str| {
            let mut d = def(
                "function",
                "f",
                &format!("CREATE FUNCTION {schema}.f() RETURNS int AS $$ SELECT '{schema}.t'::regclass $$"),
            );
            d.signature = Some(String::new());
            d
        };
        let d = diffs(
            DriverKind::Postgres,
            "stg",
            "prod",
            &[mk("stg")],
            &[mk("prod")],
        );
        // 本文のリテラルは書き換えないので、スキーマ名が違えば差分になる。
        assert_eq!(d[0].status, DiffStatus::Different);
    }

    #[test]
    fn postgres_trigger_without_table_does_not_collapse_same_names() {
        let mk = |body: &str| {
            let mut d = def("trigger", "audit", body);
            d.table = None;
            d
        };
        let s = [
            mk("CREATE TRIGGER audit one"),
            mk("CREATE TRIGGER audit two"),
        ];
        let d = diffs(DriverKind::Postgres, "public", "public", &s, &[]);
        assert_eq!(d.len(), 2);
    }

    #[test]
    fn postgres_trigger_table_comes_from_the_catalog_value() {
        let mut d = def(
            "trigger",
            "t",
            "CREATE TRIGGER t AFTER INSERT ON \"my table\" FOR EACH ROW EXECUTE FUNCTION f()",
        );
        d.table = Some("my table".into());
        let r = diffs(DriverKind::Postgres, "public", "public", &[d], &[]);
        assert_eq!(r[0].table.as_deref(), Some("my table"));
    }

    #[test]
    fn postgres_overloads_are_distinct_objects() {
        let mk = |sig: &str, body: &str| ObjectDefinition {
            kind: "function".into(),
            name: "f".into(),
            signature: Some(sig.into()),
            table: None,
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
            "DROP PROCEDURE `p`;\n-- noobdb:split\nCREATE PROCEDURE `p`() SELECT 1"
        );
        assert_eq!(
            split_statements(
                "DROP PROCEDURE `p`;\n-- noobdb:split\nCREATE PROCEDURE `p`() SELECT 1"
            ),
            vec!["DROP PROCEDURE `p`", "CREATE PROCEDURE `p`() SELECT 1"]
        );
        assert!(needs_text_protocol("DROP PROCEDURE `p`"));
        assert!(needs_text_protocol(
            "CREATE DEFINER=x TRIGGER `t` BEFORE INSERT ON `a` FOR EACH ROW SET @a=1"
        ));
        assert!(needs_text_protocol("a;\n-- noobdb:split\nb"));
        assert!(!needs_text_protocol("DROP TABLE `trigger_log`"));
        assert!(!needs_text_protocol(
            "CREATE OR REPLACE VIEW `v` AS select 1"
        ));
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
    fn postgres_matview_replace_recreates_indexes_in_one_do_block() {
        let m = od("materialized_view", "mv", None, None);
        let def = "CREATE MATERIALIZED VIEW \"mv\" AS\nSELECT 1 AS a\n-- noobdb:split\nCREATE INDEX mv_a ON \"prod\".mv USING btree (a)";
        let sql = replace_object_sql(DriverKind::Postgres, &m, def);
        assert!(
            sql.starts_with("DO $noobdb$\nBEGIN\n  DROP MATERIALIZED VIEW \"mv\";"),
            "{sql}"
        );
        assert!(
            sql.contains("CREATE MATERIALIZED VIEW \"mv\" AS\nSELECT 1 AS a;"),
            "{sql}"
        );
        assert!(sql.contains("CREATE INDEX mv_a"), "{sql}");
        // 作成だけでも 1 文 (DO ブロック) にまとまる。
        assert!(create_object_sql(DriverKind::Postgres, def).starts_with("DO $noobdb$"));
        assert!(replace_is_destructive(
            DriverKind::Postgres,
            "materialized_view"
        ));
        assert!(!replace_is_destructive(DriverKind::Postgres, "view"));
        assert!(replace_is_destructive(DriverKind::Mysql, "trigger"));
        assert!(!replace_is_destructive(DriverKind::Sqlite, "trigger"));
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
