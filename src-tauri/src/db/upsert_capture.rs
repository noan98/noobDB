//! UPSERT (`INSERT … ON CONFLICT` / `ON DUPLICATE KEY UPDATE`) をフライトレコーダに記録するための
//! 純粋な解析 (#1626)。DB には触れない。
//!
//! 通常の INSERT 記録は「新規行 = 実行後にだけ現れた主キー」と見なすが、UPSERT は既存行の
//! 更新も起こすので、そのままでは更新された既存行を新規行と取り違えて Undo が無関係な行を
//! 削除しかねない (そのため以前は記録を辞退していた)。そこで、
//!
//! 1. `INSERT INTO t (cols) VALUES (…), (…) ON …` の形で、**主キー列の値がすべて単純なリテラル**
//!    であるときだけ、その主キーを持つ行を前後で読む (`UpsertHint::anchor_where`)。
//! 2. 前に無く後にある行は新規 (Undo = DELETE)、前後で値が変わった行は更新 (Undo = 元の値へ
//!    UPDATE) と分類する (`db::mod` の `analyze_capture`)。
//!
//! 主キー以外の一意キーでの衝突、`INSERT … SELECT`、式・パラメータの主キー値などは対象外
//! (記録を辞退する。書き込み自体は 1 回実行される)。

/// VALUES の 1 つの値。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Lit {
    /// 数値 / `'…'` 文字列の単純なリテラル (SQL 上の表記そのまま)。
    Simple(String),
    Null,
    /// 式・関数・`DEFAULT`・プレースホルダなど。
    Complex,
}

/// 解析した UPSERT の `INSERT INTO t (列…) VALUES (…), …` の部分。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpsertHint {
    /// 列名 (引用符を外して小文字化)。
    columns: Vec<String>,
    tuples: Vec<Vec<Lit>>,
    /// `ON CONFLICT … DO UPDATE … WHERE …` のように、競合しても更新が見送られうる条件を持つか。
    /// 影響行数からは更新の有無を正確に数えられないので、PostgreSQL / SQLite では辞退する。
    update_where: bool,
    /// `ON CONFLICT … DO UPDATE` か (`DO NOTHING` / MySQL の `ON DUPLICATE KEY UPDATE` は偽)。
    do_update: bool,
    /// `ON CONFLICT (列…)` の競合先の列 (小文字)。省略・`ON CONSTRAINT`・式のときは `None`。
    conflict_target: Option<Vec<String>>,
}

/// 1 文で扱う VALUES の行数の上限。超えると主キー条件が長くなりすぎるので辞退する。
const MAX_TUPLES: usize = 200;

impl UpsertHint {
    /// PG / SQLite の `DO UPDATE` で、競合先が主キー列と集合として完全一致しているか。一致しないと
    /// 主キーの行ではなく別の一意キーの行が更新される (主キーの書き換えも起こりうる) ので記録できない。
    /// `DO UPDATE` でなければ (`DO NOTHING` や MySQL) 常に真。
    pub(crate) fn conflict_target_is_primary_key(&self, primary_key: &[String]) -> bool {
        if !self.do_update {
            return true;
        }
        let Some(target) = &self.conflict_target else {
            return false;
        };
        let mut a: Vec<String> = target.clone();
        let mut b: Vec<String> = primary_key.iter().map(|c| c.to_ascii_lowercase()).collect();
        a.sort();
        a.dedup();
        b.sort();
        b.dedup();
        a == b
    }

    /// 競合時の更新に `WHERE` 条件があるか (文字列リテラルの外に語 `where` がある)。
    pub(crate) fn has_update_where(&self) -> bool {
        self.update_where
    }

    /// 主キー列の値で行を引く `WHERE …` を組み立てる。主キー列が列リストに無い・値が単純な
    /// リテラルでない (NULL・式・`DEFAULT`) ときは `None`。
    pub(crate) fn anchor_where(
        &self,
        primary_key: &[String],
        quote: fn(&str) -> String,
    ) -> Option<String> {
        if primary_key.is_empty() {
            return None;
        }
        let idx: Vec<usize> = primary_key
            .iter()
            .map(|pk| {
                let want = pk.to_ascii_lowercase();
                self.columns.iter().position(|c| *c == want)
            })
            .collect::<Option<Vec<_>>>()?;
        let mut seen = std::collections::HashSet::new();
        let mut clauses = Vec::new();
        for tuple in &self.tuples {
            let mut parts = Vec::with_capacity(idx.len());
            for (pk, &i) in primary_key.iter().zip(&idx) {
                match tuple.get(i) {
                    Some(Lit::Simple(text)) => parts.push(format!("{} = {}", quote(pk), text)),
                    _ => return None,
                }
            }
            let clause = parts.join(" AND ");
            if seen.insert(clause.clone()) {
                clauses.push(format!("({clause})"));
            }
        }
        if clauses.is_empty() {
            return None;
        }
        Some(format!("WHERE {}", clauses.join(" OR ")))
    }
}

/// 識別子 1 つ (引用符つき可) を読み、引用符を外して小文字にして返す。
fn read_ident(chars: &[char], i: &mut usize) -> Option<String> {
    let c = *chars.get(*i)?;
    let (close, quoted) = match c {
        '`' => ('`', true),
        '"' => ('"', true),
        '[' => (']', true),
        _ => (' ', false),
    };
    if quoted {
        *i += 1;
        let start = *i;
        while *i < chars.len() && chars[*i] != close {
            *i += 1;
        }
        if *i >= chars.len() {
            return None;
        }
        let s: String = chars[start..*i].iter().collect();
        *i += 1;
        Some(s.to_ascii_lowercase())
    } else {
        let start = *i;
        while *i < chars.len() && (chars[*i].is_alphanumeric() || chars[*i] == '_') {
            *i += 1;
        }
        if *i == start {
            return None;
        }
        Some(
            chars[start..*i]
                .iter()
                .collect::<String>()
                .to_ascii_lowercase(),
        )
    }
}

fn skip_ws(chars: &[char], i: &mut usize) {
    while *i < chars.len() && chars[*i].is_whitespace() {
        *i += 1;
    }
}

fn peek_word(chars: &[char], i: usize) -> String {
    let mut j = i;
    while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
        j += 1;
    }
    chars[i..j].iter().collect::<String>().to_ascii_lowercase()
}

/// 1 つの値を読む。`,` か `)` の手前 (深さ 0) まで進める。
fn read_value(chars: &[char], i: &mut usize) -> Option<Lit> {
    skip_ws(chars, i);
    let start = *i;
    let mut depth = 0i32;
    let mut simple_string = true;
    while *i < chars.len() {
        let c = chars[*i];
        match c {
            '\'' => {
                // 文字列リテラル。`''` は引用符 1 個。バックslash は方言で意味が変わるので
                // 単純なリテラルとは見なさない (式扱いで辞退する)。
                *i += 1;
                loop {
                    let ch = *chars.get(*i)?;
                    if ch == '\\' {
                        simple_string = false;
                    }
                    if ch == '\'' {
                        if chars.get(*i + 1) == Some(&'\'') {
                            *i += 2;
                            continue;
                        }
                        *i += 1;
                        break;
                    }
                    *i += 1;
                }
            }
            '(' => {
                depth += 1;
                *i += 1;
            }
            ')' => {
                if depth == 0 {
                    break;
                }
                depth -= 1;
                *i += 1;
            }
            ',' if depth == 0 => break,
            _ => *i += 1,
        }
    }
    let text: String = chars[start..*i].iter().collect();
    let text = text.trim().to_string();
    if text.is_empty() {
        return None;
    }
    if text.eq_ignore_ascii_case("null") {
        return Some(Lit::Null);
    }
    if is_plain_number(&text) {
        return Some(Lit::Simple(text));
    }
    if simple_string
        && text.len() >= 2
        && text.starts_with('\'')
        && text.ends_with('\'')
        && is_single_string(&text)
    {
        return Some(Lit::Simple(text));
    }
    Some(Lit::Complex)
}

fn is_plain_number(s: &str) -> bool {
    let body = s.strip_prefix(['-', '+']).unwrap_or(s);
    if body.is_empty() {
        return false;
    }
    let mut dots = 0;
    for c in body.chars() {
        match c {
            '0'..='9' => {}
            '.' => dots += 1,
            _ => return false,
        }
    }
    dots <= 1 && body != "." && body.chars().next().is_some_and(|c| c.is_ascii_digit())
}

/// `'…'` 全体がちょうど 1 つの文字列リテラルか (`'a' || 'b'` のような連結を弾く)。
fn is_single_string(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    let mut i = 1;
    while i < chars.len() {
        if chars[i] == '\'' {
            if chars.get(i + 1) == Some(&'\'') {
                i += 2;
                continue;
            }
            return i == chars.len() - 1;
        }
        i += 1;
    }
    false
}

/// UPSERT 文を `INSERT INTO t (列…) VALUES (…), … ON …` として解析する。`sql` はコメント除去済みを
/// 渡す。形が合わない (`INSERT OR REPLACE`、`INSERT … SELECT`、列リスト無し、行数超過など) と `None`。
///
/// SQL 全体にバックスラッシュが 1 文字でもあれば辞退する (MySQL の `NO_BACKSLASH_ESCAPES` や
/// PostgreSQL の `E'…'` で文字列の終端が変わり、VALUES の読み取りがずれるため)。
pub(crate) fn parse_upsert(sql: &str) -> Option<UpsertHint> {
    if sql.contains('\\') {
        return None;
    }
    let chars: Vec<char> = sql.chars().collect();
    let mut i = 0;
    skip_ws(&chars, &mut i);
    if peek_word(&chars, i) != "insert" {
        return None;
    }
    i += "insert".len();
    skip_ws(&chars, &mut i);
    // MySQL の `INSERT IGNORE` / `LOW_PRIORITY` などの修飾子。`OR REPLACE` 等は対象外。
    loop {
        match peek_word(&chars, i).as_str() {
            "ignore" | "low_priority" | "delayed" | "high_priority" => {
                i += peek_word(&chars, i).len();
                skip_ws(&chars, &mut i);
            }
            "or" => return None,
            _ => break,
        }
    }
    if peek_word(&chars, i) != "into" {
        return None;
    }
    i += "into".len();
    skip_ws(&chars, &mut i);
    // 表名 (`db.schema.table` のような修飾つき可)。
    read_ident(&chars, &mut i)?;
    loop {
        skip_ws(&chars, &mut i);
        if chars.get(i) == Some(&'.') {
            i += 1;
            skip_ws(&chars, &mut i);
            read_ident(&chars, &mut i)?;
        } else {
            break;
        }
    }
    skip_ws(&chars, &mut i);
    if chars.get(i) != Some(&'(') {
        return None;
    }
    i += 1;
    let mut columns = Vec::new();
    loop {
        skip_ws(&chars, &mut i);
        columns.push(read_ident(&chars, &mut i)?);
        skip_ws(&chars, &mut i);
        match chars.get(i)? {
            ',' => i += 1,
            ')' => {
                i += 1;
                break;
            }
            _ => return None,
        }
    }
    skip_ws(&chars, &mut i);
    let kw = peek_word(&chars, i);
    if kw != "values" && kw != "value" {
        return None;
    }
    i += kw.len();
    let mut tuples = Vec::new();
    loop {
        skip_ws(&chars, &mut i);
        if chars.get(i) != Some(&'(') {
            return None;
        }
        i += 1;
        let mut tuple = Vec::new();
        loop {
            tuple.push(read_value(&chars, &mut i)?);
            skip_ws(&chars, &mut i);
            match chars.get(i)? {
                ',' => i += 1,
                ')' => {
                    i += 1;
                    break;
                }
                _ => return None,
            }
        }
        if tuple.len() != columns.len() {
            return None;
        }
        tuples.push(tuple);
        if tuples.len() > MAX_TUPLES {
            return None;
        }
        skip_ws(&chars, &mut i);
        if chars.get(i) == Some(&',') {
            i += 1;
            continue;
        }
        break;
    }
    // 残りは `ON CONFLICT …` / `ON DUPLICATE KEY UPDATE …` (呼び出し側が UPSERT と確認済み)。
    // 末尾の `;` と空白だけは許す。
    skip_ws(&chars, &mut i);
    if peek_word(&chars, i) != "on" {
        return None;
    }
    let words = tail_words(&chars[i..]);
    let update_where = words.iter().any(|w| w == "where");
    let do_update = words.windows(2).any(|w| w[0] == "do" && w[1] == "update");
    let conflict_target = parse_conflict_target(&chars, i);
    Some(UpsertHint {
        columns,
        tuples,
        update_where,
        do_update,
        conflict_target,
    })
}

/// `ON …` 以降の語 (小文字)。文字列リテラルと引用符つき識別子の中身は読み飛ばし、引用符の手前で
/// 語を確定させる (`WHERE"t".v` のように引用符が語に直結していても見逃さない)。
fn tail_words(tail: &[char]) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut i = 0;
    while i < tail.len() {
        let c = tail[i];
        if c == '\'' || c == '"' || c == '`' {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
            let close = c;
            i += 1;
            while i < tail.len() && tail[i] != close {
                i += 1;
            }
        } else if c.is_alphanumeric() || c == '_' {
            word.push(c.to_ascii_lowercase());
        } else if !word.is_empty() {
            words.push(std::mem::take(&mut word));
        }
        i += 1;
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}

/// `ON CONFLICT (列, …)` の列を読む。`ON CONFLICT` の直後が `(` でない (競合先の省略・
/// `ON CONSTRAINT`) か、列が識別子だけでない (式・部分インデックスの述語) ときは `None`。
fn parse_conflict_target(chars: &[char], start: usize) -> Option<Vec<String>> {
    let mut i = start;
    skip_ws(chars, &mut i);
    if peek_word(chars, i) != "on" {
        return None;
    }
    i += 2;
    skip_ws(chars, &mut i);
    if peek_word(chars, i) != "conflict" {
        return None;
    }
    i += "conflict".len();
    skip_ws(chars, &mut i);
    if chars.get(i) != Some(&'(') {
        return None;
    }
    i += 1;
    let mut cols = Vec::new();
    loop {
        skip_ws(chars, &mut i);
        cols.push(read_ident(chars, &mut i)?);
        skip_ws(chars, &mut i);
        match chars.get(i)? {
            ',' => i += 1,
            ')' => break,
            _ => return None,
        }
    }
    Some(cols)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflict_target_must_equal_the_primary_key_for_do_update() {
        let pk = vec!["id".to_string()];
        let on = |tail: &str| {
            super::parse_upsert(&format!("INSERT INTO t (id, email) VALUES (5, 'a') {tail}"))
                .unwrap()
        };
        assert!(on("ON CONFLICT (id) DO UPDATE SET email = excluded.email")
            .conflict_target_is_primary_key(&pk));
        assert!(
            on("ON CONFLICT (\"ID\") DO UPDATE SET email = excluded.email")
                .conflict_target_is_primary_key(&pk)
        );
        // 主キー以外の列 / 省略 / ON CONSTRAINT / 主キーの一部だけ。
        assert!(!on("ON CONFLICT (email) DO UPDATE SET id = excluded.id")
            .conflict_target_is_primary_key(&pk));
        assert!(!on("ON CONFLICT DO UPDATE SET email = excluded.email")
            .conflict_target_is_primary_key(&pk));
        assert!(
            !on("ON CONFLICT ON CONSTRAINT t_pkey DO UPDATE SET email = 'x'")
                .conflict_target_is_primary_key(&pk)
        );
        let composite = vec!["a".to_string(), "b".to_string()];
        assert!(!on("ON CONFLICT (a) DO UPDATE SET email = 'x'")
            .conflict_target_is_primary_key(&composite));
        // DO NOTHING は競合先を問わない。MySQL の ON DUPLICATE KEY UPDATE も対象外
        // (影響行数の照合で守る)。
        assert!(on("ON CONFLICT (email) DO NOTHING").conflict_target_is_primary_key(&pk));
        assert!(on("ON CONFLICT DO NOTHING").conflict_target_is_primary_key(&pk));
        assert!(
            on("ON DUPLICATE KEY UPDATE email = VALUES(email)").conflict_target_is_primary_key(&pk)
        );
    }

    fn parse_upsert(sql: &str) -> Option<UpsertHint> {
        super::parse_upsert(sql)
    }

    #[test]
    fn detects_do_update_where_and_mysql_backslash() {
        let h = parse_upsert(
            "INSERT INTO t (id, v) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET v = 1 WHERE t.v < 5",
        )
        .unwrap();
        assert!(h.has_update_where());
        let h = parse_upsert(
            "INSERT INTO t (id, v) VALUES (1, 'where') ON CONFLICT (id) DO UPDATE SET v = 'where'",
        )
        .unwrap();
        assert!(!h.has_update_where());
        assert!(parse_upsert(
            "INSERT INTO t (id, v) VALUES (1, 'a') ON DUPLICATE KEY UPDATE v = 'x\\y'"
        )
        .is_none());
        // 引用符が語に直結していても WHERE を見逃さない。
        let h = parse_upsert(
            "INSERT INTO t (id, v) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET v = 1 WHERE\"t\".v < 5",
        )
        .unwrap();
        assert!(h.has_update_where());
        // PostgreSQL の E'…' など、バックスラッシュを含むものは辞退。
        assert!(parse_upsert(
            "INSERT INTO t (id, v) VALUES (1, E'a\\'b') ON CONFLICT (id) DO NOTHING"
        )
        .is_none());
    }

    fn q(s: &str) -> String {
        format!("\"{s}\"")
    }

    #[test]
    fn parses_single_and_multi_row_upserts() {
        let h = parse_upsert(
            "INSERT INTO users (id, name) VALUES (1, 'a'), (2, 'it''s') ON CONFLICT (id) DO UPDATE SET name = excluded.name",
        )
        .unwrap();
        assert_eq!(h.columns, vec!["id", "name"]);
        assert_eq!(h.tuples.len(), 2);
        assert_eq!(
            h.anchor_where(&["id".to_string()], q).unwrap(),
            "WHERE (\"id\" = 1) OR (\"id\" = 2)"
        );
    }

    #[test]
    fn parses_mysql_duplicate_key_update_with_quoted_identifiers() {
        let h = parse_upsert(
            "INSERT INTO `db`.`t` (`ID`, `v`) VALUES (7, 'x') ON DUPLICATE KEY UPDATE v = VALUES(v)",
        )
        .unwrap();
        assert_eq!(
            h.anchor_where(&["id".to_string()], q).unwrap(),
            "WHERE (\"id\" = 7)"
        );
    }

    #[test]
    fn composite_keys_and_string_keys_are_anchored() {
        let h = parse_upsert(
            "INSERT INTO t (a, b, v) VALUES ('x', 2, 0) ON CONFLICT (a, b) DO NOTHING",
        )
        .unwrap();
        assert_eq!(
            h.anchor_where(&["a".to_string(), "b".to_string()], q)
                .unwrap(),
            "WHERE (\"a\" = 'x' AND \"b\" = 2)"
        );
    }

    #[test]
    fn declines_when_the_key_is_not_a_plain_literal() {
        let h = parse_upsert("INSERT INTO t (id, v) VALUES (DEFAULT, 1) ON CONFLICT DO NOTHING")
            .unwrap();
        assert!(h.anchor_where(&["id".to_string()], q).is_none());
        let h =
            parse_upsert("INSERT INTO t (id, v) VALUES (1 + 1, 1) ON CONFLICT DO NOTHING").unwrap();
        assert!(h.anchor_where(&["id".to_string()], q).is_none());
        let h =
            parse_upsert("INSERT INTO t (id, v) VALUES (NULL, 1) ON CONFLICT DO NOTHING").unwrap();
        assert!(h.anchor_where(&["id".to_string()], q).is_none());
        // 主キー列が列リストに無い。
        let h = parse_upsert("INSERT INTO t (v) VALUES (1) ON CONFLICT DO NOTHING").unwrap();
        assert!(h.anchor_where(&["id".to_string()], q).is_none());
        // バックスラッシュを含む文字列は方言で意味が変わるので式扱い。
        let h = parse_upsert(r"INSERT INTO t (id) VALUES ('a\'b') ON CONFLICT DO NOTHING");
        assert!(h.is_none() || h.unwrap().anchor_where(&["id".to_string()], q).is_none());
    }

    #[test]
    fn unsupported_shapes_return_none() {
        assert!(parse_upsert("INSERT OR REPLACE INTO t (id) VALUES (1)").is_none());
        assert!(parse_upsert("INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING").is_none());
        assert!(
            parse_upsert("INSERT INTO t (id) SELECT id FROM s ON CONFLICT DO NOTHING").is_none()
        );
        assert!(parse_upsert("INSERT INTO t (a, b) VALUES (1) ON CONFLICT DO NOTHING").is_none());
        assert!(parse_upsert("INSERT INTO t (id) VALUES (1)").is_none());
        assert!(parse_upsert("UPDATE t SET a = 1").is_none());
    }

    #[test]
    fn string_concatenation_is_not_a_plain_literal() {
        let h =
            parse_upsert("INSERT INTO t (id) VALUES ('a' || 'b') ON CONFLICT DO NOTHING").unwrap();
        assert!(h.anchor_where(&["id".to_string()], q).is_none());
    }
}
