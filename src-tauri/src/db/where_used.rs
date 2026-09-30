//! オブジェクト依存検索 (Where-used / 影響分析、#1027) の参照検出 (#1261 で Rust へ移植)。
//!
//! 以前はフロント (`components/whereUsed.ts`) が定義本文を 1 件ずつ IPC で取得し、JS で
//! 走査していた。ここでは定義本文を Rust 側でまとめて取得して走査し、ヒット位置だけを
//! 返す。検出規則は旧 TS 実装と**同一**で、共有ゴールデン
//! `src/__tests__/fixtures/whereUsedVectors.json` が Rust / TS (オラクル) の両方で
//! 結果を固定する。
//!
//! ## パーサではない
//!
//! 本物の SQL パーサではなく、「コメント / 文字列リテラルをマスクしてから識別子
//! トークンを照合する」ベストエフォートの走査。影響分析では**見落としの方が誤検出より
//! 危険**なので、判定に迷うものは除外せず `possible` (候補) として残す。
//!
//! ## 識別子境界の規則
//!
//! 1. 照合はトークン単位 (`orders` は `orders_archive` にマッチしない)。識別子文字は
//!    Unicode の文字・数字・`_`・`$`。
//! 2. 大小文字は無視する。
//! 3. 引用形式は `"x"` (MySQL 以外)・`` `x` ``・`[x]` (SQLite)。MySQL の `"x"` は文字列。
//! 4. `@x` / `@@x` / `:x` (`::` キャストは除く) / `$1` / 数字始まりの語は識別子ではない。
//! 5. ドット連鎖 (`schema.table.column`) を 1 単位として読む。テーブルは連鎖の末尾か
//!    末尾の 1 つ手前。修飾子があれば対象のスキーマ / DB のときだけ採用する。列は連鎖の
//!    末尾だけ。別テーブルと確定できるものは除外、解決できない修飾子と無修飾の列は、
//!    本文が対象テーブルを参照していれば直接、していなければ候補。
//!
//! ## UTF-16 で走査する理由
//!
//! 旧実装は JS の文字列 (UTF-16 コードユニット) を添字で走査しており、ヒット位置・
//! 行内範囲・160 文字の切り詰めもコードユニット単位だった。フロントはその位置で
//! 文字列を切り出して強調表示するため、ここでも UTF-16 コードユニット列
//! (`Vec<u16>`) の上で走査し、オフセットを同一に保つ。

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::object_search::is_js_space;
use super::{mask_for_driver, DriverKind};

/// 検索対象。`column` が `None` ならテーブル (またはビュー) そのものへの参照を探す。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WhereUsedTarget {
    /// ツリーの「データベース」ノード名 (PostgreSQL はスキーマ)。
    pub database: String,
    pub table: String,
    #[serde(default)]
    pub column: Option<String>,
}

/// 参照の確からしさ。`Possible` は「対象テーブルとの結び付きを確認できなかった」候補。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReferenceConfidence {
    Direct,
    Possible,
}

/// 定義本文 (UTF-16 コードユニット) 上のヒット範囲 `[start, end)`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReferenceHit {
    pub start: usize,
    pub end: usize,
    pub confidence: ReferenceConfidence,
}

/// 表示用に 1 行へまとめた該当箇所。`ranges` は `text` 内のオフセット (UTF-16)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceLine {
    /// 1 始まりの行番号。
    pub line: usize,
    pub text: String,
    pub ranges: Vec<(i64, i64)>,
    /// 長い行の先頭 / 末尾を省略したか (表示側で「…」を付ける)。
    pub clipped_start: bool,
    pub clipped_end: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionAnalysis {
    pub confidence: ReferenceConfidence,
    pub hit_count: usize,
    pub lines: Vec<ReferenceLine>,
}

// ---------------------------------------------------------------------------
// 文字クラス (UTF-16 コードユニット単位)
// ---------------------------------------------------------------------------

fn unit(c: char) -> u16 {
    // 呼び出しは ASCII のみ。
    c as u16
}

/// JS の `/[\p{L}\p{N}]/u` を 1 コードユニットに当てた結果。サロゲート単体は
/// 文字ではないので偽 (補助平面の文字は 2 ユニットに割れて識別子を切る — 旧実装と同じ)。
fn is_letter_or_number_unit(u: u16) -> bool {
    if u < 128 {
        return (u as u8).is_ascii_alphanumeric();
    }
    let Some(c) = char::from_u32(u32::from(u)) else {
        return false;
    };
    match letter_number_regex() {
        Some(re) => {
            let mut buf = [0u8; 4];
            re.is_match(c.encode_utf8(&mut buf))
        }
        None => c.is_alphanumeric(),
    }
}

fn letter_number_regex() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[\p{L}\p{N}]$").ok())
        .as_ref()
}

fn letter_regex() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\p{L}$").ok()).as_ref()
}

/// `/[\p{L}\p{N}_$]/u`
fn is_word(u: u16) -> bool {
    u == unit('_') || u == unit('$') || is_letter_or_number_unit(u)
}

/// `/[\p{L}_]/u`
fn is_word_start(u: u16) -> bool {
    if u == unit('_') {
        return true;
    }
    if u < 128 {
        return (u as u8).is_ascii_alphabetic();
    }
    let Some(c) = char::from_u32(u32::from(u)) else {
        return false;
    };
    match letter_regex() {
        Some(re) => {
            let mut buf = [0u8; 4];
            re.is_match(c.encode_utf8(&mut buf))
        }
        None => c.is_alphabetic(),
    }
}

fn is_space_unit(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(is_js_space)
}

fn double_quote_is_identifier(driver: DriverKind) -> bool {
    driver != DriverKind::Mysql
}

fn bracket_is_identifier(driver: DriverKind) -> bool {
    driver == DriverKind::Sqlite
}

fn to_units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn from_units(u: &[u16]) -> String {
    String::from_utf16_lossy(u)
}

// ---------------------------------------------------------------------------
// マスク (maskLiterals の再利用)
// ---------------------------------------------------------------------------

/// `mask_for_driver` (Rust 側の安全網と同じマスク) を UTF-16 コードユニット列へ展開する。
/// マスクは「同じ文字のまま」か「空白 1 文字」のどちらかだけを返すので、空白化された
/// 文字が補助平面の文字なら 2 ユニットの空白にして、JS の `maskLiterals` の出力と
/// 長さ・位置を一致させる。
fn mask_units(sql: &str, driver: DriverKind) -> Vec<u16> {
    let src: Vec<char> = sql.chars().collect();
    let masked = mask_for_driver(driver, &src);
    let mut out = Vec::with_capacity(sql.len());
    for (s, m) in src.iter().zip(masked.iter()) {
        if s == m {
            let mut buf = [0u16; 2];
            out.extend_from_slice(s.encode_utf16(&mut buf));
        } else {
            for _ in 0..s.len_utf16() {
                out.push(unit(' '));
            }
        }
    }
    out
}

/// ドル引用の開始タグ (`$$` / `$tag$`) の長さ。`pos` の位置だけを見る。
fn dollar_tag_len(text: &[u16], pos: usize) -> Option<usize> {
    if text.get(pos) != Some(&unit('$')) {
        return None;
    }
    let mut j = pos + 1;
    if let Some(&first) = text.get(j) {
        if first < 128 && ((first as u8).is_ascii_alphabetic() || first == unit('_')) {
            j += 1;
            while let Some(&u) = text.get(j) {
                if u < 128 && ((u as u8).is_ascii_alphanumeric() || u == unit('_')) {
                    j += 1;
                } else {
                    break;
                }
            }
        }
    }
    if text.get(j) == Some(&unit('$')) {
        Some(j + 1 - pos)
    } else {
        None
    }
}

fn index_of(hay: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

fn index_of_unit(hay: &[u16], needle: u16, from: usize) -> Option<usize> {
    (from..hay.len()).find(|&i| hay[i] == needle)
}

/// コメントと文字列リテラルだけを空白にし、引用識別子とドル引用の本文 (PostgreSQL の
/// 関数本体) はコードとして残した同じ長さ (UTF-16) の列を返す。
fn prepare_units(sql: &[u16], driver: DriverKind) -> Vec<u16> {
    // `mask_units` は &str を取るので、ここでは sql を文字列へ戻してマスクする。
    let sql_str = from_units(sql);
    let masked = if sql_str.encode_utf16().count() == sql.len() {
        mask_units(&sql_str, driver)
    } else {
        // 単体のサロゲートを含む列 (ドル引用の切り出しで起こりうる) は往復で長さが
        // 変わるので、マスクを諦めて全体を空白にする (ここに来るのは極めて稀)。
        vec![unit(' '); sql.len()]
    };
    let mut out = masked.clone();
    let n = masked.len();
    let mut i = 0;
    while i < n {
        let c = masked[i];
        if c == unit('`') || (c == unit('"') && double_quote_is_identifier(driver)) {
            let Some(close) = index_of_unit(&masked, c, i + 1) else {
                break;
            };
            out[(i + 1)..close].copy_from_slice(&sql[(i + 1)..close]);
            i = close + 1;
            continue;
        }
        if c == unit('$') && (i == 0 || !is_word(masked[i - 1])) {
            if let Some(tag_len) = dollar_tag_len(&masked, i) {
                let tag = &masked[i..i + tag_len];
                if let Some(close) = index_of(&masked, tag, i + tag_len) {
                    let inner = prepare_units(&sql[i + tag_len..close], driver);
                    out[i + tag_len..i + tag_len + inner.len()].copy_from_slice(&inner);
                    i = close + tag_len;
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

/// コメントと文字列リテラルだけを空白にし、引用識別子とドル引用の本文はコードとして
/// 残した同じ長さの文字列を返す (テスト・ゴールデン用)。
pub fn prepare_for_reference_scan(sql: &str, driver: DriverKind) -> String {
    from_units(&prepare_units(&to_units(sql), driver))
}

// ---------------------------------------------------------------------------
// トークン化
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct IdentToken {
    /// 引用を外し、二重化エスケープを解除した名前。
    name: String,
    start: usize,
    end: usize,
}

/// 識別子のドット連鎖 (`a.b.c`) と、連鎖の直後に続く「別名候補」トークン。
#[derive(Debug)]
struct IdentChain {
    parts: Vec<IdentToken>,
    next: Option<IdentToken>,
}

fn skip_spaces(text: &[u16], pos: usize) -> usize {
    let mut j = pos;
    while j < text.len() && is_space_unit(text[j]) {
        j += 1;
    }
    j
}

fn js_trim_units_is_empty(text: &[u16], from: usize, to: usize) -> bool {
    if from >= to {
        return true;
    }
    text[from..to].iter().all(|&u| is_space_unit(u))
}

/// `pos` から識別子 1 つを読む。識別子でなければ `None`。
fn read_ident(text: &[u16], pos: usize, driver: DriverKind) -> Option<IdentToken> {
    let c = *text.get(pos)?;
    let quoted = |close: u16| -> Option<IdentToken> {
        let mut j = pos + 1;
        let mut name: Vec<u16> = Vec::new();
        while j < text.len() {
            if text[j] == close {
                if text.get(j + 1) == Some(&close) {
                    name.push(close);
                    j += 2;
                    continue;
                }
                let trimmed_empty = name.iter().all(|&u| is_space_unit(u));
                return if trimmed_empty {
                    None
                } else {
                    Some(IdentToken {
                        name: from_units(&name),
                        start: pos,
                        end: j + 1,
                    })
                };
            }
            name.push(text[j]);
            j += 1;
        }
        None
    };
    if c == unit('`') {
        return quoted(unit('`'));
    }
    if c == unit('"') && double_quote_is_identifier(driver) {
        return quoted(unit('"'));
    }
    if c == unit('[') && bracket_is_identifier(driver) {
        return quoted(unit(']'));
    }
    if is_word_start(c) {
        let mut j = pos + 1;
        while j < text.len() && is_word(text[j]) {
            j += 1;
        }
        return Some(IdentToken {
            name: from_units(&text[pos..j]),
            start: pos,
            end: j,
        });
    }
    None
}

/// テーブル名の直後に来ても別名ではない語。
fn alias_stopwords() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        [
            "as",
            "on",
            "using",
            "where",
            "join",
            "inner",
            "left",
            "right",
            "full",
            "outer",
            "cross",
            "natural",
            "lateral",
            "set",
            "values",
            "select",
            "from",
            "group",
            "order",
            "having",
            "limit",
            "offset",
            "fetch",
            "union",
            "intersect",
            "except",
            "returning",
            "window",
            "for",
            "when",
            "then",
            "else",
            "end",
            "begin",
            "before",
            "after",
            "instead",
            "of",
            "each",
            "row",
            "execute",
            "with",
            "into",
            "default",
            "and",
            "or",
            "not",
            "is",
            "in",
            "partition",
            "tablesample",
            "straight_join",
            "force",
            "use",
            "ignore",
            "loop",
            "declare",
            "if",
            "return",
            "returns",
            "language",
            "referencing",
            "update",
            "insert",
            "delete",
            "by",
            "asc",
            "desc",
            "nulls",
            "procedure",
            "function",
        ]
        .into_iter()
        .collect()
    })
}

fn tokenize_chains(text: &[u16], driver: DriverKind) -> Vec<IdentChain> {
    let mut chains: Vec<IdentChain> = Vec::new();
    let mut i = 0;
    let n = text.len();
    while i < n {
        let c = text[i];
        let prev = if i > 0 { Some(text[i - 1]) } else { None };
        let next = text.get(i + 1).copied();
        // 変数・バインド・位置パラメータ・数値は識別子として扱わず語ごと読み飛ばす。
        if c == unit('@')
            || (c == unit(':') && next != Some(unit(':')) && prev != Some(unit(':')))
            || c == unit('$')
            || (c >= unit('0') && c <= unit('9'))
        {
            let mut j = i + 1;
            while j < n && (text[j] == unit('@') || is_word(text[j])) {
                j += 1;
            }
            i = j;
            continue;
        }
        let Some(tok) = read_ident(text, i, driver) else {
            i += 1;
            continue;
        };
        let mut end = tok.end;
        let mut parts = vec![tok];
        loop {
            let dot = skip_spaces(text, end);
            if text.get(dot) != Some(&unit('.')) {
                break;
            }
            let after = skip_spaces(text, dot + 1);
            match read_ident(text, after, driver) {
                Some(next_tok) => {
                    end = next_tok.end;
                    parts.push(next_tok);
                }
                None => {
                    end = dot + 1;
                    break;
                }
            }
        }
        chains.push(IdentChain { parts, next: None });
        i = end;
    }
    // 別名候補は「連鎖の直後の単独トークン」。連鎖同士の隣接関係から埋める。
    for k in 0..chains.len().saturating_sub(1) {
        let last_end = match chains[k].parts.last() {
            Some(p) => p.end,
            None => continue,
        };
        let mut cand_idx = k + 1;
        let cand_start = chains[cand_idx].parts[0].start;
        if !js_trim_units_is_empty(text, last_end, cand_start) {
            continue;
        }
        if chains[cand_idx].parts.len() == 1
            && chains[cand_idx].parts[0].name.to_lowercase() == "as"
            && k + 2 < chains.len()
        {
            let as_end = chains[cand_idx].parts[0].end;
            let after_as_start = chains[k + 2].parts[0].start;
            if !js_trim_units_is_empty(text, as_end, after_as_start) {
                continue;
            }
            cand_idx = k + 2;
        }
        let cand = &chains[cand_idx];
        if cand.parts.len() == 1
            && !alias_stopwords().contains(cand.parts[0].name.to_lowercase().as_str())
        {
            let tok = cand.parts[0].clone();
            chains[k].next = Some(tok);
        }
    }
    chains
}

// ---------------------------------------------------------------------------
// 照合
// ---------------------------------------------------------------------------

fn eq(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// テーブル名の修飾子として「対象と同じスキーマ / DB」を意味する名前 (小文字)。
/// SQLite の既定スキーマは `main`。
fn table_qualifiers(driver: DriverKind, database: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if !database.is_empty() {
        out.push(database.to_lowercase());
    }
    if driver == DriverKind::Sqlite && !out.iter().any(|q| q == "main") {
        out.push("main".to_string());
    }
    out
}

/// 定義本文 (元の SQL) から対象への参照位置を返す。オフセットは `sql` の UTF-16
/// コードユニット位置。テーブル検索ではテーブル参照、列検索では列参照を返す。
pub fn find_references(
    sql: &str,
    target: &WhereUsedTarget,
    driver: DriverKind,
) -> Vec<ReferenceHit> {
    find_references_units(&to_units(sql), target, driver)
}

fn find_references_units(
    sql: &[u16],
    target: &WhereUsedTarget,
    driver: DriverKind,
) -> Vec<ReferenceHit> {
    let text = prepare_units(sql, driver);
    let chains = tokenize_chains(&text, driver);
    let qualifiers = table_qualifiers(driver, &target.database);
    let is_our_qualifier = |q: &IdentToken| qualifiers.contains(&q.name.to_lowercase());

    // テーブル参照 (列検索でも「本文が対象テーブルを参照しているか」の判定に使う)。
    let mut table_hits: Vec<ReferenceHit> = Vec::new();
    let mut aliases: HashSet<String> = HashSet::new();
    for chain in &chains {
        let len = chain.parts.len();
        // 連鎖の末尾 → 末尾の 1 つ手前の順に調べる。
        let candidates = [Some(len - 1), len.checked_sub(2)];
        for idx in candidates.into_iter().flatten() {
            if !eq(&chain.parts[idx].name, &target.table) {
                continue;
            }
            if idx > 0 && !is_our_qualifier(&chain.parts[idx - 1]) {
                continue;
            }
            table_hits.push(ReferenceHit {
                start: chain.parts[idx].start,
                end: chain.parts[idx].end,
                confidence: ReferenceConfidence::Direct,
            });
            if idx == len - 1 {
                if let Some(next) = &chain.next {
                    aliases.insert(next.name.to_lowercase());
                }
            }
            break;
        }
    }
    let Some(column) = target.column.as_deref() else {
        return table_hits;
    };

    let references_table = !table_hits.is_empty();
    let unresolved = if references_table {
        ReferenceConfidence::Direct
    } else {
        ReferenceConfidence::Possible
    };
    let mut col_hits: Vec<ReferenceHit> = Vec::new();
    for chain in &chains {
        let len = chain.parts.len();
        let last = &chain.parts[len - 1];
        if !eq(&last.name, column) {
            continue;
        }
        let hit = |confidence| ReferenceHit {
            start: last.start,
            end: last.end,
            confidence,
        };
        if len == 1 {
            col_hits.push(hit(unresolved));
            continue;
        }
        let qual = &chain.parts[len - 2];
        if eq(&qual.name, &target.table) {
            // `s.orders.col` なら s が同じスキーマのときだけ。`orders.col` はそのまま。
            if len >= 3 && !is_our_qualifier(&chain.parts[len - 3]) {
                continue;
            }
            col_hits.push(hit(ReferenceConfidence::Direct));
            continue;
        }
        // `s.other.col` — スキーマ修飾された別テーブルと確定できるので除外。
        if len >= 3 {
            continue;
        }
        if aliases.contains(&qual.name.to_lowercase()) {
            col_hits.push(hit(ReferenceConfidence::Direct));
            continue;
        }
        // 別名が解決できない (サブクエリ別名・トリガーの NEW/OLD など)。見落としより
        // 誤検出の方が安全なので残し、テーブル参照の有無で確からしさを分ける。
        col_hits.push(hit(unresolved));
    }
    col_hits
}

/// 長い行を表示するときの最大文字数 (UTF-16 コードユニット)。ヒット周辺を切り出す。
const MAX_LINE_CHARS: i64 = 160;

fn trim_start_len(units: &[u16]) -> usize {
    units.iter().take_while(|&&u| is_space_unit(u)).count()
}

/// ヒット位置を行単位にまとめる (行番号・前後の空白を落とした本文・行内の範囲)。
fn to_reference_lines_units(sql: &[u16], hits: &[ReferenceHit]) -> Vec<ReferenceLine> {
    if hits.is_empty() {
        return Vec::new();
    }
    let mut line_starts: Vec<usize> = vec![0];
    for (i, &u) in sql.iter().enumerate() {
        if u == unit('\n') {
            line_starts.push(i + 1);
        }
    }
    let line_of = |pos: usize| -> usize {
        let (mut lo, mut hi) = (0usize, line_starts.len() - 1);
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            if line_starts[mid] <= pos {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        lo
    };
    // 行番号ごとにヒット範囲を集める (行は開始位置順 = 行番号の昇順で現れる)。
    let mut sorted: Vec<&ReferenceHit> = hits.iter().collect();
    sorted.sort_by_key(|h| h.start);
    let mut by_line: Vec<(usize, Vec<(i64, i64)>)> = Vec::new();
    for h in sorted {
        let ln = line_of(h.start);
        let range = (
            h.start as i64 - line_starts[ln] as i64,
            h.end as i64 - line_starts[ln] as i64,
        );
        match by_line.iter_mut().find(|(l, _)| *l == ln) {
            Some((_, ranges)) => ranges.push(range),
            None => by_line.push((ln, vec![range])),
        }
    }
    let mut out = Vec::with_capacity(by_line.len());
    for (ln, ranges) in by_line {
        let start_pos = line_starts[ln];
        let end_pos = if ln + 1 < line_starts.len() {
            line_starts[ln + 1] - 1
        } else {
            sql.len()
        };
        let mut raw: &[u16] = &sql[start_pos..end_pos.max(start_pos)];
        if raw.last() == Some(&unit('\r')) {
            raw = &raw[..raw.len() - 1];
        }
        let lead = trim_start_len(raw);
        let trimmed_start = &raw[lead..];
        let trailing = trimmed_start
            .iter()
            .rev()
            .take_while(|&&u| is_space_unit(u))
            .count();
        let mut text: &[u16] = &trimmed_start[..trimmed_start.len() - trailing];
        let mut shifted: Vec<(i64, i64)> = ranges
            .iter()
            .map(|&(s, e)| (s - lead as i64, e - lead as i64))
            .collect();
        let mut clipped_start = false;
        let mut clipped_end = false;
        if text.len() as i64 > MAX_LINE_CHARS {
            let text_len = text.len() as i64;
            let from = 0.max((shifted[0].0 - 40).min(text_len - MAX_LINE_CHARS));
            let to = from + MAX_LINE_CHARS;
            clipped_start = from > 0;
            clipped_end = to < text_len;
            text = &text[from as usize..to.min(text_len) as usize];
            shifted = shifted
                .into_iter()
                .map(|(s, e)| (s - from, (e - from).min(MAX_LINE_CHARS)))
                .filter(|&(s, _)| (0..MAX_LINE_CHARS).contains(&s))
                .collect();
        }
        out.push(ReferenceLine {
            line: ln + 1,
            text: from_units(text),
            ranges: shifted,
            clipped_start,
            clipped_end,
        });
    }
    out
}

/// 1 つの定義本文を解析する。参照が無ければ `None`。
pub fn analyze_definition(
    sql: &str,
    target: &WhereUsedTarget,
    driver: DriverKind,
) -> Option<DefinitionAnalysis> {
    let units = to_units(sql);
    let hits = find_references_units(&units, target, driver);
    if hits.is_empty() {
        return None;
    }
    let confidence = if hits
        .iter()
        .any(|h| h.confidence == ReferenceConfidence::Direct)
    {
        ReferenceConfidence::Direct
    } else {
        ReferenceConfidence::Possible
    };
    Some(DefinitionAnalysis {
        confidence,
        hit_count: hits.len(),
        lines: to_reference_lines_units(&units, &hits),
    })
}

/// ドライバごとに定義本文を取得できるオブジェクト種別。
///
/// - MySQL: ビュー / プロシージャ / 関数 / トリガー
/// - PostgreSQL: 上記 + マテリアライズドビュー
/// - SQLite: ビュー / トリガーのみ (ストアドルーチンが存在しない)
pub fn supports_kind(driver: DriverKind, kind: &str) -> bool {
    match driver {
        DriverKind::Mysql => matches!(kind, "view" | "procedure" | "function" | "trigger"),
        DriverKind::Postgres => matches!(
            kind,
            "view" | "materialized_view" | "procedure" | "function" | "trigger"
        ),
        DriverKind::Sqlite => matches!(kind, "view" | "trigger"),
    }
}

/// スニペットがこの接続のドライバで使えるものか (ドライバ未指定は全ドライバ共通)。
pub fn snippet_applies_to_driver(snippet_driver: Option<&str>, driver: DriverKind) -> bool {
    snippet_driver.map_or(true, |d| d == driver.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(db: &str, table: &str, column: Option<&str>) -> WhereUsedTarget {
        WhereUsedTarget {
            database: db.into(),
            table: table.into(),
            column: column.map(Into::into),
        }
    }

    fn hit_texts(sql: &str, t: &WhereUsedTarget, driver: DriverKind) -> Vec<String> {
        let units = to_units(sql);
        find_references(sql, t, driver)
            .iter()
            .map(|h| from_units(&units[h.start..h.end]))
            .collect()
    }

    #[test]
    fn table_reference_is_token_based() {
        let t = target("shop", "orders", None);
        let sql = "SELECT * FROM orders o JOIN orders_archive a ON a.id = o.id JOIN old_orders x";
        assert_eq!(hit_texts(sql, &t, DriverKind::Mysql), vec!["orders"]);
    }

    #[test]
    fn comments_and_literals_are_ignored() {
        let t = target("shop", "orders", None);
        let sql = "-- orders\nSELECT 'orders' FROM users /* orders */";
        assert!(find_references(sql, &t, DriverKind::Postgres).is_empty());
    }

    #[test]
    fn quoted_identifier_is_matched_on_its_content() {
        let t = target("main", "Order Items", None);
        let sql = "SELECT * FROM \"Order Items\"";
        assert_eq!(
            hit_texts(sql, &t, DriverKind::Sqlite),
            vec!["\"Order Items\""]
        );
        // MySQL の "x" は文字列リテラル。
        assert!(find_references(sql, &t, DriverKind::Mysql).is_empty());
    }

    #[test]
    fn column_reference_uses_alias_and_confidence() {
        let t = target("shop", "orders", Some("total"));
        let direct = analyze_definition(
            "SELECT o.total FROM orders o WHERE total > 0",
            &t,
            DriverKind::Mysql,
        );
        assert_eq!(
            direct.map(|a| a.confidence),
            Some(ReferenceConfidence::Direct)
        );
        let possible = analyze_definition("SELECT total FROM other", &t, DriverKind::Mysql);
        assert_eq!(
            possible.map(|a| a.confidence),
            Some(ReferenceConfidence::Possible)
        );
    }

    #[test]
    fn dollar_quoted_function_body_is_scanned() {
        let t = target("public", "orders", None);
        let sql = "CREATE FUNCTION f() RETURNS void AS $function$\nBEGIN\n  DELETE FROM orders;\nEND\n$function$ LANGUAGE plpgsql";
        let a = analyze_definition(sql, &t, DriverKind::Postgres);
        assert_eq!(a.as_ref().map(|a| a.hit_count), Some(1));
        assert_eq!(a.map(|a| a.lines[0].line), Some(3));
    }

    #[test]
    fn long_lines_are_clipped_around_the_hit() {
        let t = target("shop", "orders", None);
        let sql = format!("SELECT {} FROM orders", "x, ".repeat(100));
        let a = analyze_definition(&sql, &t, DriverKind::Mysql);
        let line = &a.as_ref().map(|a| a.lines[0].clone());
        assert!(line.as_ref().is_some_and(|l| l.clipped_start));
    }

    #[test]
    fn astral_characters_keep_utf16_offsets() {
        let t = target("shop", "orders", None);
        // 😀 は UTF-16 で 2 コードユニット。
        let sql = "-- 😀\nSELECT * FROM orders";
        let hits = find_references(sql, &t, DriverKind::Mysql);
        assert_eq!(hits.len(), 1);
        let units = to_units(sql);
        assert_eq!(from_units(&units[hits[0].start..hits[0].end]), "orders");
    }
}
