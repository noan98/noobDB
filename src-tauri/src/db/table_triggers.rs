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

/// `CREATE [TEMP] TRIGGER [IF NOT EXISTS] name [BEFORE|AFTER|INSTEAD OF] INSERT|DELETE|UPDATE ...`
/// からタイミングとイベントを読む。タイミング省略は BEFORE (SQLite の既定)。読めなければ空文字。
pub fn parse_sqlite_trigger(sql: &str) -> (String, String) {
    let tokens = tokenize(sql);
    let upper = |i: usize| tokens.get(i).map(|t| t.to_ascii_uppercase());
    let Some(mut i) = (0..tokens.len()).find(|&i| upper(i).as_deref() == Some("TRIGGER")) else {
        return (String::new(), String::new());
    };
    i += 1;
    if upper(i).as_deref() == Some("IF") {
        i += 3; // IF NOT EXISTS
    }
    i += 1; // トリガー名 (引用符付きでも 1 トークン)
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

/// 空白区切りのトークン化。`"..."` / `` `...` `` / `[...]` / `'...'` は 1 トークンにまとめる。
fn tokenize(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = sql.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        let close = match c {
            '"' => Some('"'),
            '`' => Some('`'),
            '\'' => Some('\''),
            '[' => Some(']'),
            _ => None,
        };
        let mut tok = String::new();
        if let Some(close) = close {
            tok.push(c);
            chars.next();
            for n in chars.by_ref() {
                tok.push(n);
                if n == close {
                    break;
                }
            }
        } else {
            while let Some(&n) = chars.peek() {
                if n.is_whitespace() || matches!(n, '"' | '`' | '\'' | '[' | '(') {
                    break;
                }
                tok.push(n);
                chars.next();
            }
            if tok.is_empty() {
                // '(' など区切り記号は 1 文字トークン。
                tok.push(c);
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
    }
}
