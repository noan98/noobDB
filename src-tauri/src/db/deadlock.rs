//! デッドロックの事後解析 (#2328) の共通型と純ロジック。
//!
//! デッドロックはサーバがすぐ片方を巻き戻すので、利用者がエラー (MySQL 1213 / PostgreSQL 40P01) を
//! 見た時点では待機グラフ (`list_processes` の `blocked_by`) に何も残らない。そこで、サーバが残す報告を
//! あとから読んで構造化する。
//!
//! - **MySQL**: `SHOW ENGINE INNODB STATUS` の `LATEST DETECTED DEADLOCK` 節
//!   ([`parse_innodb_deadlock`])。`PROCESS` 権限が要る。
//! - **PostgreSQL**: 40P01 の DETAIL (`Process A waits for ShareLock on transaction X; blocked by
//!   process B.`) ([`parse_pg_deadlock_detail`])。相手の SQL はサーバログにしか出ない。
//! - **SQLite**: 行ロックが無くデッドロックは起きない。`SQLITE_BUSY` のときの切り分け材料だけ返す。
//!
//! 文字列解析はすべて純関数で、境界ケース (トランザクションが 3 つ以上・SQL が途中で切れている・
//! 報告なし) をユニットテストで固定する。取得 (SQL 実行) はドライバ側 (`mysql.rs` / `postgres.rs` /
//! `sqlite.rs`) が行う。

use serde::{Deserialize, Serialize};

/// 報告が「今回のエラーの報告か」の判定に使う許容差 (秒)。エラーが返るのと報告が書かれるのは
/// ほぼ同時だが、利用者が解析を開くまでの経過秒の丸めとサーバ時刻の秒精度を吸収する。
pub const REPORT_RELATION_TOLERANCE_SECS: i64 = 10;

/// 最新の報告と今回のエラーの関係 (`InnodbDeadlockView::relation` の値)。
pub const RELATION_RELATED: &str = "related";
/// 報告のほうがエラーより古い (今回のエラーは報告に残っていない)。
pub const RELATION_OLDER: &str = "older";
/// 報告のほうがエラーより新しい (その後に別のデッドロックが起きた)。
pub const RELATION_NEWER: &str = "newer";

/// 解析できなかった理由コード (`DeadlockAnalysis::unavailable`)。フロントが文言にマップする。
/// MySQL: `PROCESS` 権限が無く `SHOW ENGINE INNODB STATUS` を読めない。
pub const UNAVAILABLE_NEEDS_PROCESS: &str = "needs_process_privilege";
/// MySQL: 報告 (`LATEST DETECTED DEADLOCK`) がまだ無い。
pub const UNAVAILABLE_NO_REPORT: &str = "no_report";
/// PostgreSQL: エラー文が渡されていない、または DETAIL が無い / 読めない (ロケールが英語以外など)。
pub const UNAVAILABLE_NO_DETAIL: &str = "no_detail";

/// InnoDB が報告したロック 1 件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InnodbLock {
    /// `record` (レコードロック) / `table` (テーブルロック)。
    pub kind: String,
    /// `db.table` (バッククォートは除去済み)。
    pub table: Option<String>,
    /// レコードロックのインデックス名 (`PRIMARY` など)。
    pub index: Option<String>,
    /// ロックモード (`X locks rec but not gap` / `IX` など)。
    pub mode: Option<String>,
    /// 報告に載っていたレコード位置 (`heap no 3`)。
    pub record: Option<String>,
}

/// デッドロックに加わったトランザクション 1 件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InnodbTransaction {
    /// 報告上の番号 (`(1)` / `(2)` …)。`WE ROLL BACK TRANSACTION (n)` と対応する。
    pub label: i64,
    /// `TRANSACTION 421` の 421。
    pub trx_id: Option<String>,
    /// `MySQL thread id` (プロセス監視の ID と同じ)。
    pub thread_id: Option<i64>,
    pub user: Option<String>,
    pub host: Option<String>,
    /// スレッドの状態 (`updating` / `starting index read` など)。
    pub state: Option<String>,
    /// `ACTIVE n sec` の n。
    pub active_secs: Option<i64>,
    /// 実行中だった SQL。資格情報リテラルは伏せ字にしたもの。
    pub sql: Option<String>,
    /// SQL が途中で切れている (報告の切り詰め / 出力の途切れ)。
    pub sql_truncated: bool,
    /// 保持していたロック。
    pub holds: Vec<InnodbLock>,
    /// 待っていたロック。
    pub waits_for: Option<InnodbLock>,
    /// 待っている相手 (`label`)。待ち先のロックを保持しているトランザクション。
    pub waits_on: Vec<i64>,
    /// 巻き戻された側 (`WE ROLL BACK TRANSACTION`)。
    pub rolled_back: bool,
}

/// `LATEST DETECTED DEADLOCK` 節を構造化したもの。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InnodbDeadlockReport {
    /// 検出時刻 (サーバのローカル時刻、`YYYY-MM-DD HH:MM:SS`)。
    pub detected_at: Option<String>,
    pub transactions: Vec<InnodbTransaction>,
    /// `WE ROLL BACK TRANSACTION` まで読めなかった (出力が途中で切れている)。
    pub incomplete: bool,
}

/// MySQL のデッドロック解析結果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InnodbDeadlockView {
    pub detected_at: Option<String>,
    /// 解析時のサーバ時刻 (`NOW()`)。
    pub server_now: Option<String>,
    /// 報告と今回のエラーの関係。`related` / `older` / `newer`。エラーの経過が不明なら `None`。
    pub relation: Option<String>,
    /// `innodb_print_all_deadlocks`。OFF だと最新 1 件しか残らない。読めなければ `None`。
    pub print_all_deadlocks: Option<bool>,
    pub incomplete: bool,
    pub transactions: Vec<InnodbTransaction>,
}

/// PostgreSQL の待機の 1 辺 (`Process A waits for ShareLock on transaction X; blocked by process B.`)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PgDeadlockEdge {
    pub waiter_pid: i64,
    /// `ShareLock` / `ExclusiveLock` など。
    pub lock_mode: String,
    /// `transaction 7001` / `tuple (0,1) of relation 16384 of database 16383` など。
    pub target: String,
    pub blocker_pid: i64,
}

/// 循環に現れたバックエンド 1 つの現在の様子 (`pg_stat_activity`)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PgDeadlockProcess {
    pub pid: i64,
    /// いまも `pg_stat_activity` に居るか。居なければ接続ごと終わっている。
    pub alive: bool,
    pub user: Option<String>,
    pub application_name: Option<String>,
    pub state: Option<String>,
    /// 現在 (または直近) のクエリ。デッドロック時のクエリとは限らない。資格情報リテラルは伏せ字。
    pub query: Option<String>,
    /// クエリ本文が権限で隠されている (`<insufficient privilege>`)。
    pub query_hidden: bool,
}

/// PostgreSQL のデッドロック解析結果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PgDeadlockView {
    /// エラーを受け取った (= 検出して中止された) バックエンドの pid。DETAIL の先頭の待機側。
    pub victim_pid: Option<i64>,
    pub edges: Vec<PgDeadlockEdge>,
    /// エラーの CONTEXT (`while updating tuple (0,1) in relation "accounts"`)。
    pub context: Option<String>,
    pub processes: Vec<PgDeadlockProcess>,
    /// `log_lock_waits` の設定値 (`on` / `off`)。
    pub log_lock_waits: Option<String>,
    /// `deadlock_timeout` の設定値 (`1s` など)。
    pub deadlock_timeout: Option<String>,
}

/// SQLite で同じファイルを開いたまま明示トランザクションを保持している接続。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SqliteTxHolder {
    pub session_id: String,
    pub profile_id: Option<String>,
}

/// SQLite の `SQLITE_BUSY` (database is locked) の切り分け材料。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SqliteBusyView {
    /// `PRAGMA journal_mode` (`wal` / `delete` など)。
    pub journal_mode: Option<String>,
    /// `PRAGMA busy_timeout` (ミリ秒)。0 は待たずに即エラー。
    pub busy_timeout_ms: Option<i64>,
    /// アプリ内で同じファイルを開き、明示トランザクションを保持している他の接続。
    pub holders: Vec<SqliteTxHolder>,
}

/// `analyze_deadlock` の応答。ドライバごとに該当するものだけが入る。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeadlockAnalysis {
    /// 解析できなかった理由コード (`needs_process_privilege` / `no_report` / `no_detail`)。
    pub unavailable: Option<String>,
    pub mysql: Option<InnodbDeadlockView>,
    pub postgres: Option<PgDeadlockView>,
    pub sqlite: Option<SqliteBusyView>,
}

// ───────────────────────── MySQL (InnoDB STATUS) ─────────────────────────

fn is_dash_line(line: &str) -> bool {
    let t = line.trim();
    t.len() >= 3 && t.chars().all(|c| c == '-')
}

/// 行頭の `YYYY-MM-DD HH:MM:SS` (19 文字) を取る。
fn leading_timestamp(line: &str) -> Option<String> {
    let t = line.trim_start();
    let head: String = t.chars().take(19).collect();
    let b = head.as_bytes();
    let ok = b.len() == 19
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b' ' || *c == b'T',
            13 | 16 => *c == b':',
            _ => c.is_ascii_digit(),
        });
    ok.then(|| head.replace('T', " "))
}

/// `*** (N) <rest>` の `(N)` と `rest`。
fn numbered_header(line: &str) -> Option<(i64, &str)> {
    let rest = line.trim().strip_prefix("*** (")?;
    let (n, rest) = rest.split_once(')')?;
    Some((n.trim().parse().ok()?, rest.trim()))
}

/// `*** WE ROLL BACK TRANSACTION (N)` の N。
fn rollback_label(line: &str) -> Option<i64> {
    let rest = line.trim().strip_prefix("*** WE ROLL BACK TRANSACTION")?;
    rest.trim()
        .strip_prefix('(')?
        .split_once(')')?
        .0
        .trim()
        .parse()
        .ok()
}

fn strip_ticks(s: &str) -> String {
    s.chars().filter(|c| *c != '`').collect()
}

/// 数字の連続を読む。
fn leading_int(s: &str) -> Option<i64> {
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// `RECORD LOCKS ...` / `TABLE LOCK ...` の 1 行をロックにする。
fn parse_lock_line(line: &str) -> Option<InnodbLock> {
    let t = line.trim();
    if t.starts_with("RECORD LOCKS") {
        let index = t
            .split_once(" index ")
            .and_then(|(_, r)| r.split_once(" of table "))
            .map(|(i, _)| strip_ticks(i).trim().to_string());
        let table = t
            .split_once(" of table ")
            .map(|(_, r)| r.split(" trx id ").next().unwrap_or(r))
            .map(|s| strip_ticks(s).trim().to_string());
        // レコードロックは `lock_mode X ...`、S ロックなどは `lock mode S ...` と出ることがある。
        let mode = t
            .split_once("lock_mode ")
            .or_else(|| t.split_once("lock mode "))
            .map(|(_, m)| {
                m.trim()
                    .trim_end_matches("waiting")
                    .trim()
                    .trim_end_matches(',')
                    .to_string()
            });
        Some(InnodbLock {
            kind: "record".into(),
            table,
            index,
            mode,
            record: None,
        })
    } else if t.starts_with("TABLE LOCK") {
        let table = t
            .split_once(" table ")
            .map(|(_, r)| r.split(" trx id ").next().unwrap_or(r))
            .map(|s| strip_ticks(s).trim().to_string());
        let mode = t.split_once("lock mode ").map(|(_, m)| {
            m.trim()
                .trim_end_matches("waiting")
                .trim()
                .trim_end_matches(',')
                .to_string()
        });
        Some(InnodbLock {
            kind: "table".into(),
            table,
            index: None,
            mode,
            record: None,
        })
    } else {
        None
    }
}

/// `Record lock, heap no 3 PHYSICAL RECORD: ...` の `heap no 3`。
fn parse_heap_no(line: &str) -> Option<String> {
    let t = line.trim();
    if !t.starts_with("Record lock") {
        return None;
    }
    let rest = t.split_once("heap no ")?.1;
    let n = leading_int(rest)?;
    Some(format!("heap no {n}"))
}

/// IPv4 / IPv6 のアドレスらしいトークンか。
fn looks_like_ip(tok: &str) -> bool {
    !tok.is_empty()
        && (tok.contains('.') || tok.contains(':'))
        && tok
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '.' || c == ':')
}

/// `MySQL thread id 8, OS thread handle 140..., query id 52 localhost root updating` を分解する。
/// 戻り値は (thread_id, host, user, state)。ホストは `host ip` の 2 トークンで来ることがある
/// (ユーザ名・状態に空白が入りうるため、ホスト直後の IP らしいトークンだけを特別扱いする)。
fn parse_thread_line(line: &str) -> (Option<i64>, Option<String>, Option<String>, Option<String>) {
    let t = line.trim();
    let thread_id = t.strip_prefix("MySQL thread id ").and_then(leading_int);
    let after = t
        .split_once("query id ")
        .map(|(_, r)| r.trim_start_matches(|c: char| c.is_ascii_digit()).trim());
    let Some(after) = after else {
        return (thread_id, None, None, None);
    };
    let toks: Vec<&str> = after.split_whitespace().collect();
    let Some(host) = toks.first() else {
        return (thread_id, None, None, None);
    };
    let (host_disp, user_idx) = match toks.get(1) {
        Some(ip) if looks_like_ip(ip) && toks.len() >= 3 => (format!("{host} ({ip})"), 2),
        _ => ((*host).to_string(), 1),
    };
    let user = toks.get(user_idx).map(|s| (*s).to_string());
    let state = if toks.len() > user_idx + 1 {
        Some(toks[user_idx + 1..].join(" "))
    } else {
        None
    };
    (thread_id, Some(host_disp), user, state)
}

/// SQL がこの長さ (バイト) 以上なら InnoDB の切り詰めの可能性が高い。
const INNODB_QUERY_LIMIT_BYTES: usize = 3000;

#[derive(PartialEq, Clone, Copy)]
enum Section {
    Txn,
    Holds,
    Waits,
}

/// `SHOW ENGINE INNODB STATUS` の本文から `LATEST DETECTED DEADLOCK` 節を構造化する。
/// 節が無ければ `None`。出力が途中で切れていても、読めた範囲を返す (`incomplete`)。
pub fn parse_innodb_deadlock(status: &str) -> Option<InnodbDeadlockReport> {
    let lines: Vec<&str> = status.lines().collect();
    let header = lines
        .iter()
        .position(|l| l.trim() == "LATEST DETECTED DEADLOCK")?;
    // 見出しの直後の罫線を飛ばし、次の罫線 (= 次の節の見出しの手前) までが本文。
    let mut start = header + 1;
    if lines.get(start).is_some_and(|l| is_dash_line(l)) {
        start += 1;
    }
    let end = lines[start..]
        .iter()
        .position(|l| is_dash_line(l))
        .map_or(lines.len(), |i| start + i);
    let body = &lines[start..end];

    let detected_at = body.iter().find_map(|l| leading_timestamp(l));

    let mut txns: Vec<InnodbTransaction> = Vec::new();
    let mut section = Section::Txn;
    let mut victim: Option<i64> = None;
    // 現在の `Txn` セクションで、スレッド行を読んだあとの SQL を溜める。
    let mut sql_lines: Vec<&str> = Vec::new();
    let mut seen_thread = false;
    // `waiting` 付きのロック行を読んだか (Waits セクションの最初のロック行だけを採る)。
    let mut cur_lock_idx: Option<usize> = None;

    fn flush_sql(txn: &mut InnodbTransaction, sql_lines: &mut Vec<&str>) {
        if sql_lines.is_empty() {
            return;
        }
        let joined = sql_lines.join("\n");
        let sql = joined.trim().to_string();
        if !sql.is_empty() {
            txn.sql_truncated = sql.len() >= INNODB_QUERY_LIMIT_BYTES || sql.ends_with("...");
            txn.sql = Some(sql);
        }
        sql_lines.clear();
    }

    for raw in body {
        let line = *raw;
        if let Some(n) = rollback_label(line) {
            if let Some(t) = txns.last_mut() {
                flush_sql(t, &mut sql_lines);
            }
            victim = Some(n);
            continue;
        }
        if let Some((n, rest)) = numbered_header(line) {
            let upper = rest.to_ascii_uppercase();
            if upper.starts_with("TRANSACTION") {
                if let Some(t) = txns.last_mut() {
                    flush_sql(t, &mut sql_lines);
                }
                txns.push(InnodbTransaction {
                    label: n,
                    trx_id: None,
                    thread_id: None,
                    user: None,
                    host: None,
                    state: None,
                    active_secs: None,
                    sql: None,
                    sql_truncated: false,
                    holds: Vec::new(),
                    waits_for: None,
                    waits_on: Vec::new(),
                    rolled_back: false,
                });
                section = Section::Txn;
                seen_thread = false;
                cur_lock_idx = None;
                continue;
            }
            if upper.starts_with("HOLDS THE LOCK") || upper.starts_with("WAITING FOR THIS LOCK") {
                if let Some(t) = txns.iter_mut().find(|t| t.label == n) {
                    // SQL はスレッド行のあと、次の見出しの手前までなのでここで確定する。
                    flush_sql(t, &mut sql_lines);
                }
                section = if upper.starts_with("HOLDS") {
                    Section::Holds
                } else {
                    Section::Waits
                };
                cur_lock_idx = None;
                continue;
            }
        }
        let Some(txn) = txns.last_mut() else {
            continue;
        };
        match section {
            Section::Txn => {
                let t = line.trim();
                if seen_thread {
                    sql_lines.push(line);
                } else if let Some(rest) = t.strip_prefix("TRANSACTION ") {
                    // `TRANSACTION 421, ACTIVE 11 sec starting index read`
                    txn.trx_id = rest.split(',').next().map(|s| s.trim().to_string());
                    txn.active_secs = rest.split_once("ACTIVE ").and_then(|(_, r)| leading_int(r));
                } else if t.starts_with("MySQL thread id") {
                    let (tid, host, user, state) = parse_thread_line(t);
                    txn.thread_id = tid;
                    txn.host = host;
                    txn.user = user;
                    txn.state = state;
                    seen_thread = true;
                }
            }
            Section::Holds | Section::Waits => {
                if let Some(lock) = parse_lock_line(line) {
                    if section == Section::Holds {
                        txn.holds.push(lock);
                        cur_lock_idx = Some(txn.holds.len() - 1);
                    } else {
                        // 待機中のロックは 1 トランザクションに 1 つ。
                        txn.waits_for = Some(lock);
                        cur_lock_idx = Some(usize::MAX);
                    }
                } else if let Some(rec) = parse_heap_no(line) {
                    match cur_lock_idx {
                        Some(usize::MAX) => {
                            if let Some(w) = txn.waits_for.as_mut() {
                                w.record.get_or_insert(rec);
                            }
                        }
                        Some(i) => {
                            if let Some(h) = txn.holds.get_mut(i) {
                                h.record.get_or_insert(rec);
                            }
                        }
                        None => {}
                    }
                }
            }
        }
    }
    // 本文が SQL の途中で終わった (巻き戻し行まで出力が届かなかった)。
    let ended_in_sql = victim.is_none() && !sql_lines.is_empty();
    if let Some(t) = txns.last_mut() {
        flush_sql(t, &mut sql_lines);
        if ended_in_sql {
            t.sql_truncated = true;
        }
    }

    for t in &mut txns {
        t.rolled_back = victim == Some(t.label);
    }
    link_waits(&mut txns);

    Some(InnodbDeadlockReport {
        detected_at,
        transactions: txns,
        incomplete: victim.is_none(),
    })
}

/// 各トランザクションの「待っている相手」を決める。待ち先のロックと同じ表・インデックスのロックを
/// 保持しているトランザクションが相手。保持ロックが報告に無い (見つからない) ときは、
/// 2 つしか無いデッドロックなら相手は必ずもう一方なので、それを補う。
fn link_waits(txns: &mut [InnodbTransaction]) {
    let snapshot: Vec<(i64, Vec<InnodbLock>)> =
        txns.iter().map(|t| (t.label, t.holds.clone())).collect();
    let two = txns.len() == 2;
    for t in txns.iter_mut() {
        let Some(w) = t.waits_for.clone() else {
            continue;
        };
        let mut on: Vec<i64> = snapshot
            .iter()
            .filter(|(label, holds)| {
                *label != t.label
                    && holds
                        .iter()
                        .any(|h| h.table == w.table && h.index == w.index)
            })
            .map(|(label, _)| *label)
            .collect();
        if on.is_empty() && two {
            on = snapshot
                .iter()
                .filter(|(label, _)| *label != t.label)
                .map(|(label, _)| *label)
                .collect();
        }
        t.waits_on = on;
    }
}

/// `YYYY-MM-DD HH:MM:SS` を (1970-01-01 からの) 秒にする。
fn parse_epoch_secs(s: &str) -> Option<i64> {
    chrono::NaiveDateTime::parse_from_str(s.trim(), "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|d| d.and_utc().timestamp())
}

/// 最新の報告 (`detected_at`) が今回のエラーの報告か判定する。`server_now` は解析時のサーバ時刻、
/// `error_age_secs` は「エラーが返ってから解析するまでの経過秒」。報告の経過 (`server_now - detected_at`) が
/// エラーの経過と許容差以内なら `related`、報告のほうが古ければ `older`、新しければ `newer`。
/// 時刻が読めなければ `None`。
pub fn classify_report_age(
    detected_at: &str,
    server_now: &str,
    error_age_secs: i64,
) -> Option<&'static str> {
    let report_age = parse_epoch_secs(server_now)? - parse_epoch_secs(detected_at)?;
    let diff = report_age - error_age_secs.max(0);
    Some(if diff.abs() <= REPORT_RELATION_TOLERANCE_SECS {
        RELATION_RELATED
    } else if diff > 0 {
        RELATION_OLDER
    } else {
        RELATION_NEWER
    })
}

// ───────────────────────── PostgreSQL (40P01 の DETAIL) ─────────────────────────

/// 1 行 (`Process 123 waits for ShareLock on transaction 456; blocked by process 789.`) を辺にする。
fn parse_pg_edge_line(line: &str) -> Option<PgDeadlockEdge> {
    let t = line.trim();
    let t = t.strip_prefix("DETAIL:").map_or(t, str::trim);
    let rest = t.strip_prefix("Process ")?;
    let waiter_pid = leading_int(rest)?;
    let rest = rest.trim_start_matches(|c: char| c.is_ascii_digit());
    let rest = rest.trim_start().strip_prefix("waits for ")?;
    let (lock_mode, rest) = rest.split_once(" on ")?;
    let (target, rest) = rest.split_once("; blocked by process ")?;
    let blocker_pid = leading_int(rest)?;
    Some(PgDeadlockEdge {
        waiter_pid,
        lock_mode: lock_mode.trim().to_string(),
        target: target.trim().to_string(),
        blocker_pid,
    })
}

/// 40P01 のエラー文 (DETAIL / CONTEXT つき) から待機の辺と CONTEXT を取り出す。
/// 辺が 1 つも読めなければ `None` (英語以外のロケールなど)。
pub fn parse_pg_deadlock_detail(message: &str) -> Option<(Vec<PgDeadlockEdge>, Option<String>)> {
    let edges: Vec<PgDeadlockEdge> = message.lines().filter_map(parse_pg_edge_line).collect();
    if edges.is_empty() {
        return None;
    }
    let mut context: Option<String> = None;
    let mut in_context = false;
    for line in message.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("CONTEXT:") {
            context = Some(rest.trim().to_string());
            in_context = true;
        } else if in_context {
            if let Some(c) = context.as_mut() {
                c.push('\n');
                c.push_str(t);
            }
        }
    }
    Some((edges, context.filter(|c| !c.is_empty())))
}

/// 辺から循環に現れる pid を重複なしで (出現順に) 返す。
pub fn pg_cycle_pids(edges: &[PgDeadlockEdge]) -> Vec<i64> {
    let mut out: Vec<i64> = Vec::new();
    for e in edges {
        for p in [e.waiter_pid, e.blocker_pid] {
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATUS_TWO: &str = "\
=====================================
2026-11-14 10:20:35 0x7f1 INNODB MONITOR OUTPUT
=====================================
------------------------
LATEST DETECTED DEADLOCK
------------------------
2026-11-14 10:20:30 0x7f9c0c0f4700
*** (1) TRANSACTION:
TRANSACTION 421, ACTIVE 11 sec starting index read
mysql tables in use 1, locked 1
LOCK WAIT 3 lock struct(s), heap size 1128, 2 row lock(s)
MySQL thread id 8, OS thread handle 140234, query id 52 localhost root updating
UPDATE accounts SET balance = balance - 10 WHERE id = 2
*** (1) HOLDS THE LOCK(S):
RECORD LOCKS space id 2 page no 4 n bits 72 index PRIMARY of table `bank`.`accounts` trx id 421 lock_mode X locks rec but not gap
Record lock, heap no 2 PHYSICAL RECORD: n_fields 4; compact format; info bits 0
 0: len 4; hex 80000001; asc     ;;

*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 2 page no 4 n bits 72 index PRIMARY of table `bank`.`accounts` trx id 421 lock_mode X locks rec but not gap waiting
Record lock, heap no 3 PHYSICAL RECORD: n_fields 4; compact format; info bits 0
 0: len 4; hex 80000002; asc     ;;

*** (2) TRANSACTION:
TRANSACTION 422, ACTIVE 10 sec starting index read
mysql tables in use 1, locked 1
3 lock struct(s), heap size 1128, 2 row lock(s)
MySQL thread id 9, OS thread handle 140235, query id 53 db1 192.0.2.7 app updating
UPDATE accounts
  SET balance = balance + 10
  WHERE id = 1
*** (2) HOLDS THE LOCK(S):
RECORD LOCKS space id 2 page no 4 n bits 72 index PRIMARY of table `bank`.`accounts` trx id 422 lock_mode X locks rec but not gap
Record lock, heap no 3 PHYSICAL RECORD: n_fields 4; compact format; info bits 0

*** (2) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 2 page no 4 n bits 72 index PRIMARY of table `bank`.`accounts` trx id 422 lock_mode X locks rec but not gap waiting
Record lock, heap no 2 PHYSICAL RECORD: n_fields 4; compact format; info bits 0

*** WE ROLL BACK TRANSACTION (2)
------------
TRANSACTIONS
------------
Trx id counter 500
";

    #[test]
    fn two_transactions_are_parsed_with_locks_and_victim() {
        let r = parse_innodb_deadlock(STATUS_TWO).expect("report");
        assert_eq!(r.detected_at.as_deref(), Some("2026-11-14 10:20:30"));
        assert!(!r.incomplete);
        assert_eq!(r.transactions.len(), 2);
        let (a, b) = (&r.transactions[0], &r.transactions[1]);
        assert_eq!((a.label, b.label), (1, 2));
        assert_eq!(a.trx_id.as_deref(), Some("421"));
        assert_eq!(a.active_secs, Some(11));
        assert_eq!(a.thread_id, Some(8));
        assert_eq!(a.host.as_deref(), Some("localhost"));
        assert_eq!(a.user.as_deref(), Some("root"));
        assert_eq!(a.state.as_deref(), Some("updating"));
        assert_eq!(
            a.sql.as_deref(),
            Some("UPDATE accounts SET balance = balance - 10 WHERE id = 2")
        );
        assert!(!a.sql_truncated);
        assert_eq!(a.holds.len(), 1);
        assert_eq!(a.holds[0].table.as_deref(), Some("bank.accounts"));
        assert_eq!(a.holds[0].index.as_deref(), Some("PRIMARY"));
        assert_eq!(a.holds[0].mode.as_deref(), Some("X locks rec but not gap"));
        assert_eq!(a.holds[0].record.as_deref(), Some("heap no 2"));
        let w = a.waits_for.as_ref().expect("waits");
        assert_eq!(w.record.as_deref(), Some("heap no 3"));
        assert_eq!(w.mode.as_deref(), Some("X locks rec but not gap"));
        assert_eq!(a.waits_on, vec![2]);
        assert_eq!(b.waits_on, vec![1]);
        assert!(!a.rolled_back);
        assert!(b.rolled_back);
        // ホストと IP の 2 トークン、複数行の SQL。
        assert_eq!(b.host.as_deref(), Some("db1 (192.0.2.7)"));
        assert_eq!(b.user.as_deref(), Some("app"));
        assert_eq!(
            b.sql.as_deref(),
            Some("UPDATE accounts\n  SET balance = balance + 10\n  WHERE id = 1")
        );
    }

    #[test]
    fn no_report_section_is_none() {
        let s = "------------\nTRANSACTIONS\n------------\nTrx id counter 5\n";
        assert!(parse_innodb_deadlock(s).is_none());
        assert!(parse_innodb_deadlock("").is_none());
    }

    #[test]
    fn three_transactions_form_a_cycle_by_lock_target() {
        let s = "\
LATEST DETECTED DEADLOCK
------------------------
2026-11-14 10:20:30 0x7f
*** (1) TRANSACTION:
TRANSACTION 1, ACTIVE 1 sec
MySQL thread id 1, OS thread handle 1, query id 1 localhost u updating
UPDATE a SET x = 1
*** (1) HOLDS THE LOCK(S):
RECORD LOCKS space id 1 page no 1 n bits 8 index PRIMARY of table `d`.`a` trx id 1 lock_mode X locks rec but not gap
*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 1 page no 1 n bits 8 index PRIMARY of table `d`.`b` trx id 1 lock_mode X locks rec but not gap waiting
*** (2) TRANSACTION:
TRANSACTION 2, ACTIVE 1 sec
MySQL thread id 2, OS thread handle 2, query id 2 localhost u updating
UPDATE b SET x = 1
*** (2) HOLDS THE LOCK(S):
RECORD LOCKS space id 1 page no 1 n bits 8 index PRIMARY of table `d`.`b` trx id 2 lock_mode X locks rec but not gap
*** (2) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 1 page no 1 n bits 8 index PRIMARY of table `d`.`c` trx id 2 lock_mode X locks rec but not gap waiting
*** (3) TRANSACTION:
TRANSACTION 3, ACTIVE 1 sec
MySQL thread id 3, OS thread handle 3, query id 3 localhost u updating
UPDATE c SET x = 1
*** (3) HOLDS THE LOCK(S):
RECORD LOCKS space id 1 page no 1 n bits 8 index PRIMARY of table `d`.`c` trx id 3 lock_mode X locks rec but not gap
*** (3) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 1 page no 1 n bits 8 index PRIMARY of table `d`.`a` trx id 3 lock_mode X locks rec but not gap waiting
*** WE ROLL BACK TRANSACTION (3)
------------
TRANSACTIONS
";
        let r = parse_innodb_deadlock(s).expect("report");
        assert_eq!(r.transactions.len(), 3);
        assert_eq!(r.transactions[0].waits_on, vec![2]);
        assert_eq!(r.transactions[1].waits_on, vec![3]);
        assert_eq!(r.transactions[2].waits_on, vec![1]);
        let victims: Vec<i64> = r
            .transactions
            .iter()
            .filter(|t| t.rolled_back)
            .map(|t| t.label)
            .collect();
        assert_eq!(victims, vec![3]);
        assert!(!r.incomplete);
    }

    #[test]
    fn output_cut_off_inside_sql_is_marked_incomplete_and_truncated() {
        let s = "\
LATEST DETECTED DEADLOCK
------------------------
2026-11-14 10:20:30 0x7f
*** (1) TRANSACTION:
TRANSACTION 1, ACTIVE 1 sec
MySQL thread id 1, OS thread handle 1, query id 1 localhost u updating
UPDATE a SET x = 1
*** (1) HOLDS THE LOCK(S):
RECORD LOCKS space id 1 page no 1 n bits 8 index PRIMARY of table `d`.`a` trx id 1 lock_mode X locks rec but not gap
*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 1 page no 1 n bits 8 index PRIMARY of table `d`.`b` trx id 1 lock_mode X locks rec but not gap waiting
*** (2) TRANSACTION:
TRANSACTION 2, ACTIVE 1 sec
MySQL thread id 2, OS thread handle 2, query id 2 localhost u updating
UPDATE b SET name = 'a very lo";
        let r = parse_innodb_deadlock(s).expect("report");
        assert!(r.incomplete);
        assert_eq!(r.transactions.len(), 2);
        let t2 = &r.transactions[1];
        assert_eq!(t2.sql.as_deref(), Some("UPDATE b SET name = 'a very lo"));
        assert!(t2.sql_truncated);
        assert!(!r.transactions[0].sql_truncated);
        assert!(r.transactions.iter().all(|t| !t.rolled_back));
        // 2 つしかないので、保持ロックが読めなくても相手は補える。
        assert_eq!(r.transactions[1].waits_on, Vec::<i64>::new());
        assert_eq!(r.transactions[0].waits_on, vec![2]);
    }

    #[test]
    fn long_sql_is_flagged_as_truncated() {
        let long = "X".repeat(3000);
        let s = format!(
            "LATEST DETECTED DEADLOCK\n------------------------\n2026-11-14 10:20:30 0x7f\n\
*** (1) TRANSACTION:\nTRANSACTION 1, ACTIVE 1 sec\n\
MySQL thread id 1, OS thread handle 1, query id 1 localhost u updating\n{long}\n\
*** WE ROLL BACK TRANSACTION (1)\n------------\n"
        );
        let r = parse_innodb_deadlock(&s).expect("report");
        assert!(r.transactions[0].sql_truncated);
    }

    #[test]
    fn table_lock_and_missing_holds_section_are_handled() {
        let s = "\
LATEST DETECTED DEADLOCK
------------------------
2026-11-14 10:20:30 0x7f
*** (1) TRANSACTION:
TRANSACTION 1, ACTIVE 1 sec
MySQL thread id 1, OS thread handle 1, query id 1 localhost u updating
LOCK TABLES t WRITE
*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
TABLE LOCK table `d`.`t` trx id 1 lock mode IX waiting
*** (2) TRANSACTION:
TRANSACTION 2, ACTIVE 1 sec
MySQL thread id 2, OS thread handle 2, query id 2 localhost u updating
ALTER TABLE t ADD c INT
*** (2) WAITING FOR THIS LOCK TO BE GRANTED:
TABLE LOCK table `d`.`t` trx id 2 lock mode X waiting
*** WE ROLL BACK TRANSACTION (1)
------------
";
        let r = parse_innodb_deadlock(s).expect("report");
        let w = r.transactions[0].waits_for.as_ref().expect("waits");
        assert_eq!(w.kind, "table");
        assert_eq!(w.table.as_deref(), Some("d.t"));
        assert_eq!(w.mode.as_deref(), Some("IX"));
        assert!(r.transactions[0].holds.is_empty());
        // 保持ロックが無くても、2 件なので相手はもう一方。
        assert_eq!(r.transactions[0].waits_on, vec![2]);
        assert!(r.transactions[0].rolled_back);
    }

    #[test]
    fn report_age_relation() {
        let now = "2026-11-14 10:30:00";
        // 5 分 (300 秒) 前の報告、エラーも 300 秒前 → 今回の報告。
        assert_eq!(
            classify_report_age("2026-11-14 10:25:00", now, 300),
            Some(RELATION_RELATED)
        );
        // 許容差以内のずれ。
        assert_eq!(
            classify_report_age("2026-11-14 10:25:08", now, 300),
            Some(RELATION_RELATED)
        );
        // 報告のほうが 1 時間古い → 今回のエラーは報告に残っていない。
        assert_eq!(
            classify_report_age("2026-11-14 09:30:00", now, 300),
            Some(RELATION_OLDER)
        );
        // 報告のほうが新しい (エラーの後に別のデッドロック)。
        assert_eq!(
            classify_report_age("2026-11-14 10:29:30", now, 300),
            Some(RELATION_NEWER)
        );
        assert_eq!(classify_report_age("broken", now, 300), None);
    }

    #[test]
    fn report_age_one_hour_older_is_judged_older() {
        // 時刻はサーバ側で SYSTEM に揃えてあるので、1 時間の差も本当に古い報告として扱う。
        assert_eq!(
            classify_report_age("2026-11-14 09:25:00", "2026-11-14 10:30:00", 300),
            Some(RELATION_OLDER)
        );
    }

    #[test]
    fn shared_lock_mode_with_space_is_parsed() {
        let l = parse_lock_line(
            "RECORD LOCKS space id 2 page no 4 n bits 72 index PRIMARY of table `d`.`t` trx id 9 lock mode S locks rec but not gap waiting",
        )
        .expect("lock");
        assert_eq!(l.mode.as_deref(), Some("S locks rec but not gap"));
        assert_eq!(l.index.as_deref(), Some("PRIMARY"));
    }

    #[test]
    fn pg_detail_is_parsed_into_a_cycle() {
        let msg = "sqlx error: error returned from database: deadlock detected\n\
DETAIL: Process 12345 waits for ShareLock on transaction 7001; blocked by process 12346.\n\
Process 12346 waits for ShareLock on transaction 7000; blocked by process 12345.\n\
CONTEXT: while updating tuple (0,1) in relation \"accounts\"";
        let (edges, ctx) = parse_pg_deadlock_detail(msg).expect("edges");
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0].waiter_pid, 12345);
        assert_eq!(edges[0].lock_mode, "ShareLock");
        assert_eq!(edges[0].target, "transaction 7001");
        assert_eq!(edges[0].blocker_pid, 12346);
        assert_eq!(edges[1].waiter_pid, 12346);
        assert_eq!(edges[1].blocker_pid, 12345);
        assert_eq!(
            ctx.as_deref(),
            Some("while updating tuple (0,1) in relation \"accounts\"")
        );
        assert_eq!(pg_cycle_pids(&edges), vec![12345, 12346]);
    }

    #[test]
    fn pg_three_process_cycle_and_non_english_detail() {
        let msg = "DETAIL: Process 1 waits for ExclusiveLock on tuple (0,1) of relation 16384 of database 16383; blocked by process 2.\n\
Process 2 waits for ShareLock on transaction 9; blocked by process 3.\n\
Process 3 waits for ShareLock on transaction 8; blocked by process 1.";
        let (edges, ctx) = parse_pg_deadlock_detail(msg).expect("edges");
        assert_eq!(edges.len(), 3);
        assert_eq!(edges[0].lock_mode, "ExclusiveLock");
        assert_eq!(
            edges[0].target,
            "tuple (0,1) of relation 16384 of database 16383"
        );
        assert_eq!(ctx, None);
        assert_eq!(pg_cycle_pids(&edges), vec![1, 2, 3]);
        // 英語以外のロケールや DETAIL なしは None (解析不能として扱う)。
        assert!(
            parse_pg_deadlock_detail("error returned from database: deadlock detected").is_none()
        );
        assert!(
            parse_pg_deadlock_detail("プロセス 1 は、トランザクション 2 を待機しています。")
                .is_none()
        );
    }
}
