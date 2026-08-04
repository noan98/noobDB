//! スケジューラ純ロジック (#730)。次回発火時刻の計算と、アプリ起動時の
//! 「過ぎたスケジュールをどう扱うか」の判定を副作用なしで行う。すべて
//! `DateTime<Utc>` を明示的に受け取る形にしてあるので、`Utc::now()` に依存せず
//! 決定的にテストできる。
//!
//! 時刻はすべて UTC で解釈する。デスクトップアプリとしてはローカル時刻の方が
//! 直感的だが、タイムゾーン変換 (DST 境界の曖昧さ含む) を持ち込むとテストの
//! 決定性が損なわれるため、初版では UTC 固定にしている (既知の制約。HelpView に
//! 明記)。

use chrono::{DateTime, Duration, NaiveTime, TimeZone, Utc};

use super::TaskSchedule;

/// `from` より後の直近の発火時刻を返す。
pub fn next_run_after(schedule: &TaskSchedule, from: DateTime<Utc>) -> DateTime<Utc> {
    match schedule {
        TaskSchedule::Interval { minutes } => {
            let m = (*minutes).max(1) as i64;
            from + Duration::minutes(m)
        }
        TaskSchedule::Daily { hour, minute } => next_daily_utc(*hour, *minute, from),
    }
}

/// `from` より厳密に後の、UTC `hour:minute` の直近の発生時刻。`hour`/`minute` が
/// 範囲外 (24 時制超過) のときは 23:59 にクランプする — 呼び出し元 (フォーム
/// バリデーション) が弾く想定だが、ここでも安全側にフォールバックしておく。
fn next_daily_utc(hour: u32, minute: u32, from: DateTime<Utc>) -> DateTime<Utc> {
    let h = hour.min(23);
    let m = minute.min(59);
    let time = NaiveTime::from_hms_opt(h, m, 0).unwrap_or(from.time());

    let today = from.date_naive();
    let candidate_today = Utc.from_utc_datetime(&today.and_time(time));
    if candidate_today > from {
        return candidate_today;
    }
    let tomorrow = today + Duration::days(1);
    Utc.from_utc_datetime(&tomorrow.and_time(time))
}

/// アプリ起動時に、永続化されていた `next_run_at` (前回終了時点の予定) をどう
/// 引き継ぐかを決める。
///
/// - 一度もスケジュールされていない (`persisted` が `None`) — 新規タスクとして
///   `schedule` から次回発火時刻を計算する。
/// - 予定がまだ未来 — そのまま引き継ぐ。
/// - 予定がアプリの非起動中に過ぎていた:
///   - `catch_up_missed` が true — 過ぎた予定のまま返す。呼び出し側 (スケジューラの
///     tick) は「発火時刻 <= now」を実行条件にしているため、直後の tick で 1 回
///     だけ追い掛け実行される。
///   - false (既定) — 過ぎた分はスキップし、`schedule` から次の正規タイミングを
///     計算し直す。
pub fn resolve_startup_next_run(
    schedule: &TaskSchedule,
    persisted: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
    catch_up_missed: bool,
) -> DateTime<Utc> {
    match persisted {
        None => next_run_after(schedule, now),
        Some(t) if t > now => t,
        Some(t) => {
            if catch_up_missed {
                t
            } else {
                next_run_after(schedule, now)
            }
        }
    }
}

/// `next_run_at` <= `now` なら発火すべき。`next_run_at` が無い (未スケジュール)
/// タスクは発火しない — 呼び出し側がスケジュール時に必ず設定するので通常は
/// 起きないが、壊れたデータに対する安全側のフォールバック。
pub fn is_due(next_run_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    matches!(next_run_at, Some(t) if t <= now)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    #[test]
    fn interval_adds_minutes() {
        let sched = TaskSchedule::Interval { minutes: 90 };
        let from = dt(2026, 1, 1, 10, 0);
        assert_eq!(next_run_after(&sched, from), dt(2026, 1, 1, 11, 30));
    }

    // 0 分 (壊れた設定/丸め誤差) は最低 1 分に切り上げる — 無限ループ的な即時
    // 再発火を避ける。
    #[test]
    fn interval_clamps_zero_minutes_to_one() {
        let sched = TaskSchedule::Interval { minutes: 0 };
        let from = dt(2026, 1, 1, 10, 0);
        assert_eq!(next_run_after(&sched, from), dt(2026, 1, 1, 10, 1));
    }

    #[test]
    fn daily_same_day_when_time_still_ahead() {
        let sched = TaskSchedule::Daily {
            hour: 18,
            minute: 30,
        };
        let from = dt(2026, 1, 1, 9, 0);
        assert_eq!(next_run_after(&sched, from), dt(2026, 1, 1, 18, 30));
    }

    #[test]
    fn daily_rolls_to_next_day_when_time_already_passed() {
        let sched = TaskSchedule::Daily { hour: 8, minute: 0 };
        let from = dt(2026, 1, 1, 9, 0);
        assert_eq!(next_run_after(&sched, from), dt(2026, 1, 2, 8, 0));
    }

    // ちょうど一致する瞬間は「まだ来ていない」扱いで翌日に送る (`next_run_after`
    // は常に厳密に未来を返す契約)。
    #[test]
    fn daily_exact_match_rolls_to_next_day() {
        let sched = TaskSchedule::Daily { hour: 8, minute: 0 };
        let from = dt(2026, 1, 1, 8, 0);
        assert_eq!(next_run_after(&sched, from), dt(2026, 1, 2, 8, 0));
    }

    #[test]
    fn daily_handles_month_and_year_rollover() {
        let sched = TaskSchedule::Daily { hour: 0, minute: 0 };
        let from = dt(2025, 12, 31, 23, 59);
        assert_eq!(next_run_after(&sched, from), dt(2026, 1, 1, 0, 0));
    }

    #[test]
    fn startup_new_task_schedules_from_now() {
        let sched = TaskSchedule::Interval { minutes: 30 };
        let now = dt(2026, 1, 1, 10, 0);
        assert_eq!(
            resolve_startup_next_run(&sched, None, now, false),
            dt(2026, 1, 1, 10, 30)
        );
    }

    #[test]
    fn startup_future_run_is_kept_unchanged() {
        let sched = TaskSchedule::Interval { minutes: 30 };
        let now = dt(2026, 1, 1, 10, 0);
        let persisted = dt(2026, 1, 1, 10, 15);
        assert_eq!(
            resolve_startup_next_run(&sched, Some(persisted), now, false),
            persisted
        );
        assert_eq!(
            resolve_startup_next_run(&sched, Some(persisted), now, true),
            persisted
        );
    }

    // アプリが閉じていた間に過ぎたスケジュール: catch_up_missed=false ならスキップして
    // 次の正規タイミングへ、true なら過ぎた時刻のまま返して直後の tick で追い掛ける。
    #[test]
    fn startup_missed_run_skips_or_catches_up() {
        let sched = TaskSchedule::Interval { minutes: 30 };
        let now = dt(2026, 1, 1, 12, 0);
        let missed = dt(2026, 1, 1, 9, 0);

        let skipped = resolve_startup_next_run(&sched, Some(missed), now, false);
        assert_eq!(skipped, dt(2026, 1, 1, 12, 30));

        let caught_up = resolve_startup_next_run(&sched, Some(missed), now, true);
        assert_eq!(caught_up, missed);
        // 追い掛け対象と判定されること (tick 側の実行条件と整合)。
        assert!(is_due(Some(caught_up), now));
    }

    #[test]
    fn is_due_true_when_at_or_before_now() {
        let now = dt(2026, 1, 1, 10, 0);
        assert!(is_due(Some(now), now));
        assert!(is_due(Some(now - Duration::minutes(1)), now));
        assert!(!is_due(Some(now + Duration::minutes(1)), now));
        assert!(!is_due(None, now));
    }
}
