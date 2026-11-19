//! 明示トランザクションが他セッションをブロックしているかの純ロジック (#2447)。
//!
//! 保持接続のバックエンド ID (MySQL `CONNECTION_ID()` / PostgreSQL `pg_backend_pid()`) を
//! BEGIN 時に控えておき、別接続から読んだ「待つ側 / ブロックする側」の組を数える。

/// `(待たされているセッション, ブロッカー)` の組のうち、`holder` にブロックされている
/// **セッション数** (重複する待ちは 1 と数える)。`holder` 自身が待つ側の組は数えない。
pub fn count_blocked_by(pairs: &[(i64, i64)], holder: i64) -> u32 {
    let mut waiters: Vec<i64> = pairs
        .iter()
        .filter(|(waiter, blocker)| *blocker == holder && *waiter != holder)
        .map(|(waiter, _)| *waiter)
        .collect();
    waiters.sort_unstable();
    waiters.dedup();
    u32::try_from(waiters.len()).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_distinct_waiters_of_holder() {
        let pairs = [(10, 1), (11, 1), (10, 1), (12, 2)];
        assert_eq!(count_blocked_by(&pairs, 1), 2);
        assert_eq!(count_blocked_by(&pairs, 2), 1);
    }

    #[test]
    fn ignores_unrelated_and_self_waits() {
        assert_eq!(count_blocked_by(&[], 1), 0);
        assert_eq!(count_blocked_by(&[(5, 6)], 1), 0);
        assert_eq!(count_blocked_by(&[(1, 1)], 1), 0);
    }
}
