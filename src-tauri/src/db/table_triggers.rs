//! テーブルのトリガー一覧 (#1867) の純層。PostgreSQL の `pg_trigger.tgtype` のビット分解と、
//! SQLite の `CREATE TRIGGER` 文からのタイミング・イベントの読み取り。DB 無しでテストできる。

/// `pg_trigger.tgtype` を (タイミング, イベント) にする。ビットは PostgreSQL の
/// `TRIGGER_TYPE_*`: 2 = BEFORE, 4 = INSERT, 8 = DELETE, 16 = UPDATE, 32 = TRUNCATE, 64 = INSTEAD OF
/// (どちらも立たなければ AFTER)。
pub fn pg_timing_and_event(tgtype: i32) -> (String, String) {
    let timing = if tgtype & 64 != 0 {
        "INSTEAD OF"
    } else if tgtype & 2 != 0 {
        "BEFORE"
    } else {
        "AFTER"
    };
    let mut events = Vec::new();
    for (bit, name) in [
        (4, "INSERT"),
        (16, "UPDATE"),
        (8, "DELETE"),
        (32, "TRUNCATE"),
    ] {
        if tgtype & bit != 0 {
            events.push(name);
        }
    }
    (timing.to_string(), events.join(" OR "))
}

/// `CREATE [TEMP] TRIGGER [IF NOT EXISTS] [schema.]name [BEFORE|AFTER|INSTEAD OF] INSERT|DELETE|UPDATE ...`
/// からタイミングとイベントを読む。コメントは無視し、スキーマ修飾付きの名前も読み進める。
/// タイミング省略は BEFORE (SQLite の既定)。読めなければ空文字。
pub fn parse_sqlite_trigger(sql: &str) -> (String, String) {
    let tokens = tokenize(&strip_comments(sql));
    let upper = |i: usize| tokens.get(i).map(|t| t.to_ascii_uppercase());
    let Some(mut i) = (0..tokens.len()).find(|&i| upper(i).as_deref() == Some("TRIGGER")) else {
        return (String::new(), String::new());
    };
    i += 1;
    if upper(i).as_deref() == Some("IF") {
        i += 3; // IF NOT EXISTS
    }
    i += 1; // トリガー名 (引用符付きでも 1 トークン)
    while tokens.get(i).map(String::as_str) == Some(".") {
        i += 2; // `.` とその次の名前 (スキーマ修飾)
    }
    let mut timing = "BEFORE";
    match upper(i).as_deref() {
        Some("BEFORE") => i += 1,
        Some("AFTER") => {
            timing = "AFTER";
            i += 1;
        }
        Some("INSTEAD") => {
            timing = "INSTEAD OF";
            i += 2;
        }
        _ => {}
    }
    match upper(i).as_deref() {
        Some(e @ ("INSERT" | "DELETE" | "UPDATE")) => (timing.to_string(), e.to_string()),
        _ => (String::new(), String::new()),
    }
}

/// 引用符の閉じ文字 (`[` は `]`)。
fn closing_quote(c: char) -> Option<char> {
    match c {
        '"' | '`' | '\'' => Some(c),
        '[' => Some(']'),
        _ => None,
    }
}

/// `/* ... */` と `-- ...` を空白に置き換える。引用符の中は触らない。
fn strip_comments(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        if let Some(close) = closing_quote(c) {
            out.push(c);
            while let Some(n) = chars.next() {
                out.push(n);
                if n == close {
                    if close != ']' && chars.peek() == Some(&close) {
                        if let Some(d) = chars.next() {
                            out.push(d);
                        }
                        continue;
                    }
                    break;
                }
            }
        } else if c == '-' && chars.peek() == Some(&'-') {
            for n in chars.by_ref() {
                if n == '\n' {
                    break;
                }
            }
            out.push('\n');
        } else if c == '/' && chars.peek() == Some(&'*') {
            chars.next();
            let mut prev = '\0';
            for n in chars.by_ref() {
                if prev == '*' && n == '/' {
                    break;
                }
                prev = n;
            }
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out
}

/// 空白区切りのトークン化。引用符付き識別子は 1 トークン (`""` の二重化エスケープ対応)、
/// `.` と `(` は単独のトークン。
fn tokenize(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = sql.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        let mut tok = String::new();
        if let Some(close) = closing_quote(c) {
            tok.push(c);
            chars.next();
            while let Some(n) = chars.next() {
                tok.push(n);
                if n == close {
                    if close != ']' && chars.peek() == Some(&close) {
                        if let Some(d) = chars.next() {
                            tok.push(d);
                        }
                        continue;
                    }
                    break;
                }
            }
        } else if matches!(c, '.' | '(') {
            tok.push(c);
            chars.next();
        } else {
            while let Some(&n) = chars.peek() {
                if n.is_whitespace() || n == '.' || n == '(' || closing_quote(n).is_some() {
                    break;
                }
                tok.push(n);
                chars.next();
            }
        }
        out.push(tok);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pg_bits_are_decomposed() {
        // ROW(1) + BEFORE(2) + INSERT(4) + UPDATE(16)
        assert_eq!(
            pg_timing_and_event(1 | 2 | 4 | 16),
            ("BEFORE".into(), "INSERT OR UPDATE".into())
        );
        assert_eq!(
            pg_timing_and_event(1 | 8),
            ("AFTER".into(), "DELETE".into())
        );
        assert_eq!(
            pg_timing_and_event(1 | 64 | 4),
            ("INSTEAD OF".into(), "INSERT".into())
        );
        assert_eq!(pg_timing_and_event(32), ("AFTER".into(), "TRUNCATE".into()));
    }

    #[test]
    fn sqlite_timing_and_event() {
        let t = |s| parse_sqlite_trigger(s);
        assert_eq!(
            t("CREATE TRIGGER trg AFTER UPDATE OF a ON t BEGIN SELECT 1; END"),
            ("AFTER".into(), "UPDATE".into())
        );
        assert_eq!(
            t("create trigger if not exists \"my trg\" before delete on t begin select 1; end"),
            ("BEFORE".into(), "DELETE".into())
        );
        assert_eq!(
            t("CREATE TEMP TRIGGER [x y] INSTEAD OF INSERT ON v BEGIN SELECT 1; END"),
            ("INSTEAD OF".into(), "INSERT".into())
        );
        // タイミング省略は BEFORE。
        assert_eq!(
            t("CREATE TRIGGER trg INSERT ON t BEGIN SELECT 1; END"),
            ("BEFORE".into(), "INSERT".into())
        );
        assert_eq!(t("garbage"), (String::new(), String::new()));
        // コメントを挟んでも読める。
        assert_eq!(
            t("CREATE /* x AFTER */ TRIGGER -- note INSERT\n trg /* c */ AFTER UPDATE ON t BEGIN SELECT 1; END"),
            ("AFTER".into(), "UPDATE".into())
        );
        // スキーマ修飾付きの名前。
        assert_eq!(
            t("CREATE TRIGGER \"main\".\"trg\" AFTER DELETE ON t BEGIN SELECT 1; END"),
            ("AFTER".into(), "DELETE".into())
        );
        assert_eq!(
            t("CREATE TRIGGER main.\"trg\" INSTEAD OF UPDATE ON v BEGIN SELECT 1; END"),
            ("INSTEAD OF".into(), "UPDATE".into())
        );
        assert_eq!(
            t("CREATE TRIGGER main.trg AFTER INSERT ON t BEGIN SELECT 1; END"),
            ("AFTER".into(), "INSERT".into())
        );
        // 二重化した引用符を含む名前 (名前中の AFTER は拾わない)。
        assert_eq!(
            t("CREATE TRIGGER \"a\"\" AFTER \" BEFORE DELETE ON t BEGIN SELECT 1; END"),
            ("BEFORE".into(), "DELETE".into())
        );
    }
}
