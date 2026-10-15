//! スケジューラ純ロジック (#730)。次回発火時刻の計算と、アプリ起動時の
//! 「過ぎたスケジュールをどう扱うか」の判定を副作用なしで行う。すべて
//! `DateTime<Utc>` を明示的に受け取る形にしてあるので、`Utc::now()` に依存せず
//! 決定的にテストできる。
//!
//! 内部の時刻は UTC。`Daily` だけは IANA タイムゾーン (`timezone`、省略時は UTC) の
//! ローカル時刻で `hour:minute` を解釈し、`chrono-tz` で UTC へ変換する (#1621)。
//! DST の隙間にあたる時刻はその直後へ送り、重複する時刻は早い方で 1 回だけ発火する。
//! 曜日マスクも同じタイムゾーンのローカル日付で判定する。

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;

use super::{TaskSchedule, ALL_WEEKDAYS};

/// IANA タイムゾーン名を解釈する。`None` / 空は UTC。未知の名前は `None` を返す
/// (保存時の検証 [`validate_schedule`] で弾く。実行時に未知だった場合は UTC へ倒す)。
pub fn parse_timezone(name: Option<&str>) -> Option<Tz> {
    match name.map(str::trim) {
        None | Some("") => Some(Tz::UTC),
        Some(n) => n.parse::<Tz>().ok(),
    }
}

/// 保存前の検証: タイムゾーン名が実在し、時刻が範囲内であること。
pub fn validate_schedule(schedule: &TaskSchedule) -> Result<(), String> {
    if let TaskSchedule::Daily {
        hour,
        minute,
        timezone,
        weekdays,
    } = schedule
    {
        if *hour > 23 || *minute > 59 {
            return Err(format!("invalid daily time {hour}:{minute}"));
        }
        if parse_timezone(timezone.as_deref()).is_none() {
            return Err(format!(
                "unknown timezone '{}'",
                timezone.as_deref().unwrap_or_default()
            ));
        }
        if *weekdays & !ALL_WEEKDAYS != 0 {
            return Err(format!("invalid weekday mask {weekdays}"));
        }
    }
    Ok(())
}

/// `from` より後の直近の発火時刻を返す。
pub fn next_run_after(schedule: &TaskSchedule, from: DateTime<Utc>) -> DateTime<Utc> {
    match schedule {
        TaskSchedule::Interval { minutes } => {
            let m = (*minutes).max(1) as i64;
            from + Duration::minutes(m)
        }
        TaskSchedule::Daily {
            hour,
            minute,
            timezone,
            weekdays,
        } => {
            let tz = parse_timezone(timezone.as_deref()).unwrap_or(Tz::UTC);
            next_daily(*hour, *minute, tz, *weekdays, from)
        }
    }
}

/// 今後 `count` 回の発火時刻 (最初は `from` より後)。スケジュール編集中のプレビュー用 (#1621)。
pub fn upcoming_runs(
    schedule: &TaskSchedule,
    from: DateTime<Utc>,
    count: usize,
) -> Vec<DateTime<Utc>> {
    let mut out = Vec::with_capacity(count);
    let mut cursor = from;
    for _ in 0..count {
        cursor = next_run_after(schedule, cursor);
        out.push(cursor);
    }
    out
}

/// ローカル日付 `date` の `time` を UTC に直す。DST の隙間 (存在しない時刻) は隙間が終わる
/// 直後の時刻へ送り、重複する時刻 (秋の巻き戻し) は早い方を採る。
fn resolve_local(tz: Tz, date: NaiveDate, time: NaiveTime) -> Option<DateTime<Utc>> {
    let mut naive = date.and_time(time);
    // 隙間は通常 1 時間 (歴史的には最大 2 時間) なので、30 分刻みで最大 6 時間まで送る。
    for _ in 0..12 {
        match tz.from_local_datetime(&naive) {
            chrono::LocalResult::Single(dt) => return Some(dt.with_timezone(&Utc)),
            chrono::LocalResult::Ambiguous(early, _) => return Some(early.with_timezone(&Utc)),
            chrono::LocalResult::None => naive += Duration::minutes(30),
        }
    }
    None
}

/// 曜日マスクが `date` の曜日を許すか (0 = 毎日)。
fn weekday_allowed(weekdays: u8, date: NaiveDate) -> bool {
    let mask = weekdays & ALL_WEEKDAYS;
    mask == 0 || mask & (1 << date.weekday().num_days_from_monday()) != 0
}

/// `from` より厳密に後の、`tz` のローカル `hour:minute` の直近の発生時刻 (曜日マスク付き)。
/// `hour`/`minute` が範囲外 (24 時制超過) のときは 23:59 にクランプする — 呼び出し元
/// (フォームバリデーション) が弾く想定だが、ここでも安全側にフォールバックしておく。
fn next_daily(hour: u32, minute: u32, tz: Tz, weekdays: u8, from: DateTime<Utc>) -> DateTime<Utc> {
    let h = hour.min(23);
    let m = minute.min(59);
    let time = NaiveTime::from_hms_opt(h, m, 0).unwrap_or(NaiveTime::MIN);

    let start = from.with_timezone(&tz).date_naive();
    // 曜日が 1 つでも許されていれば 7 日以内に当たる。DST の隙間で候補が `from` 以前に
    // なるような境界に備えて 1 日余分に見る。
    for offset in 0..9 {
        let date = start + Duration::days(offset);
        if !weekday_allowed(weekdays, date) {
            continue;
        }
        if let Some(candidate) = resolve_local(tz, date, time) {
            if candidate > from {
                return candidate;
            }
        }
    }
    // 到達しない想定 (全曜日が許されない不正マスクは validate で弾く)。安全側に翌日の UTC。
    from + Duration::days(1)
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

    fn daily(hour: u32, minute: u32) -> TaskSchedule {
        TaskSchedule::Daily {
            hour,
            minute,
            timezone: None,
            weekdays: 0,
        }
    }

    fn daily_tz(hour: u32, minute: u32, tz: &str, weekdays: u8) -> TaskSchedule {
        TaskSchedule::Daily {
            hour,
            minute,
            timezone: Some(tz.into()),
            weekdays,
        }
    }

    /// 月 = bit0 … 日 = bit6 のマスク。
    const WEEKDAYS: u8 = 0b001_1111;

    #[test]
    fn daily_in_jst_converts_local_time_to_utc() {
        // 毎日 JST 9:00 = UTC 0:00。UTC 1/1 10:00 (JST 19:00) の次は 1/2 の UTC 0:00。
        let sched = daily_tz(9, 0, "Asia/Tokyo", 0);
        assert_eq!(
            next_run_after(&sched, dt(2026, 1, 1, 10, 0)),
            dt(2026, 1, 2, 0, 0)
        );
        // UTC 1/1 23:00 は JST 1/2 08:00 なので、まだ同じ JST 日の 9:00 (= UTC 1/2 0:00)。
        assert_eq!(
            next_run_after(&sched, dt(2026, 1, 1, 23, 0)),
            dt(2026, 1, 2, 0, 0)
        );
        // 日付をまたぐ負のオフセット: America/New_York 22:00 (冬 = UTC-5) は UTC 翌日 3:00。
        let ny = daily_tz(22, 0, "America/New_York", 0);
        assert_eq!(
            next_run_after(&ny, dt(2026, 1, 1, 12, 0)),
            dt(2026, 1, 2, 3, 0)
        );
    }

    #[test]
    fn missing_or_empty_timezone_means_utc_and_old_json_still_loads() {
        let old: TaskSchedule =
            serde_json::from_str(r#"{"kind":"daily","hour":8,"minute":30}"#).unwrap();
        assert_eq!(old, daily(8, 30));
        assert_eq!(
            next_run_after(&old, dt(2026, 1, 1, 0, 0)),
            dt(2026, 1, 1, 8, 30)
        );
        let empty = daily_tz(8, 30, "", 0);
        assert_eq!(
            next_run_after(&empty, dt(2026, 1, 1, 0, 0)),
            dt(2026, 1, 1, 8, 30)
        );
    }

    #[test]
    fn dst_gap_moves_forward_and_fold_fires_once_at_the_earlier_time() {
        // 2026-03-08 米東部は 2:00 → 3:00 に飛ぶ (2:30 は存在しない)。隙間の直後 (3:00 EDT = UTC 7:00)。
        let gap = daily_tz(2, 30, "America/New_York", 0);
        assert_eq!(
            next_run_after(&gap, dt(2026, 3, 8, 0, 0)),
            dt(2026, 3, 8, 7, 0)
        );
        // 通常の日は 2:30 EST = UTC 7:30。
        assert_eq!(
            next_run_after(&gap, dt(2026, 3, 7, 0, 0)),
            dt(2026, 3, 7, 7, 30)
        );
        // 2026-11-01 は 1:00-2:00 が 2 回ある。1:30 は早い方 (EDT = UTC 5:30) で 1 回だけ。
        let fold = daily_tz(1, 30, "America/New_York", 0);
        assert_eq!(
            next_run_after(&fold, dt(2026, 11, 1, 0, 0)),
            dt(2026, 11, 1, 5, 30)
        );
        // その直後の次回は翌日の 1:30 EST (UTC 6:30)。同日の 2 回目は来ない。
        assert_eq!(
            next_run_after(&fold, dt(2026, 11, 1, 5, 30)),
            dt(2026, 11, 2, 6, 30)
        );
    }

    #[test]
    fn offset_changes_across_dst_keep_the_local_wall_clock_time() {
        // 毎日ロンドン 9:00: 冬 (GMT) は UTC 9:00、夏 (BST、3/29 以降) は UTC 8:00。
        let sched = daily_tz(9, 0, "Europe/London", 0);
        assert_eq!(
            next_run_after(&sched, dt(2026, 3, 28, 12, 0)),
            dt(2026, 3, 29, 8, 0)
        );
        assert_eq!(
            next_run_after(&sched, dt(2026, 3, 27, 12, 0)),
            dt(2026, 3, 28, 9, 0)
        );
    }

    #[test]
    fn weekday_mask_skips_to_the_next_allowed_local_day() {
        // 平日のみ UTC 9:00。2026-01-02 は金曜日 → 次は月曜 (1/5)。
        let sched = daily_tz(9, 0, "UTC", WEEKDAYS);
        assert_eq!(
            next_run_after(&sched, dt(2026, 1, 2, 10, 0)),
            dt(2026, 1, 5, 9, 0)
        );
        // 金曜 8:00 ならその日の 9:00。
        assert_eq!(
            next_run_after(&sched, dt(2026, 1, 2, 8, 0)),
            dt(2026, 1, 2, 9, 0)
        );
        // 土曜 (1/3) から見ても月曜。
        assert_eq!(
            next_run_after(&sched, dt(2026, 1, 3, 0, 0)),
            dt(2026, 1, 5, 9, 0)
        );
    }

    #[test]
    fn weekday_mask_is_judged_in_the_schedule_timezone_not_utc() {
        // 平日のみ JST 7:00 (= UTC 前日 22:00)。月曜 JST 7:00 は UTC 日曜 22:00 なので、
        // UTC の曜日で判定すると日曜として落ちてしまう。JST のローカル日付 (月曜) で採る。
        let sched = daily_tz(7, 0, "Asia/Tokyo", WEEKDAYS);
        assert_eq!(
            next_run_after(&sched, dt(2026, 1, 3, 0, 0)),
            dt(2026, 1, 4, 22, 0)
        );
        // 土曜 JST 7:00 (= UTC 金曜 22:00) は平日ではないので採らない。金曜 UTC 12:00 から見た次は
        // 月曜 JST 7:00 = UTC 日曜 22:00。
        assert_eq!(
            next_run_after(&sched, dt(2026, 1, 2, 12, 0)),
            dt(2026, 1, 4, 22, 0)
        );
        // 木曜 JST 21:00 (= UTC 木曜 12:00) の次は、金曜 JST 7:00 (= UTC 木曜 22:00)。
        assert_eq!(
            next_run_after(&sched, dt(2026, 1, 1, 12, 0)),
            dt(2026, 1, 1, 22, 0)
        );
    }

    #[test]
    fn single_weekday_mask_and_upcoming_runs() {
        // 日曜のみ (bit6)。
        let sched = daily_tz(12, 0, "UTC", 1 << 6);
        let runs = upcoming_runs(&sched, dt(2026, 1, 1, 0, 0), 3);
        assert_eq!(
            runs,
            vec![
                dt(2026, 1, 4, 12, 0),
                dt(2026, 1, 11, 12, 0),
                dt(2026, 1, 18, 12, 0)
            ]
        );
        let every = upcoming_runs(&daily(9, 0), dt(2026, 1, 1, 10, 0), 2);
        assert_eq!(every, vec![dt(2026, 1, 2, 9, 0), dt(2026, 1, 3, 9, 0)]);
        assert!(upcoming_runs(&daily(9, 0), dt(2026, 1, 1, 10, 0), 0).is_empty());
    }

    #[test]
    fn validate_schedule_rejects_unknown_timezones_and_bad_masks() {
        assert!(validate_schedule(&daily_tz(9, 0, "Asia/Tokyo", WEEKDAYS)).is_ok());
        assert!(validate_schedule(&daily(9, 0)).is_ok());
        assert!(validate_schedule(&daily_tz(9, 0, "Mars/Olympus", 0)).is_err());
        assert!(validate_schedule(&daily(24, 0)).is_err());
        assert!(validate_schedule(&daily(9, 60)).is_err());
        assert!(validate_schedule(&daily_tz(9, 0, "UTC", 0b1000_0000)).is_err());
        assert!(validate_schedule(&TaskSchedule::Interval { minutes: 5 }).is_ok());
    }

    #[test]
    fn unknown_timezone_at_runtime_falls_back_to_utc() {
        let sched = daily_tz(9, 0, "Mars/Olympus", 0);
        assert_eq!(
            next_run_after(&sched, dt(2026, 1, 1, 0, 0)),
            dt(2026, 1, 1, 9, 0)
        );
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
        let sched = daily(18, 30);
        let from = dt(2026, 1, 1, 9, 0);
        assert_eq!(next_run_after(&sched, from), dt(2026, 1, 1, 18, 30));
    }

    #[test]
    fn daily_rolls_to_next_day_when_time_already_passed() {
        let sched = daily(8, 0);
        let from = dt(2026, 1, 1, 9, 0);
        assert_eq!(next_run_after(&sched, from), dt(2026, 1, 2, 8, 0));
    }

    // ちょうど一致する瞬間は「まだ来ていない」扱いで翌日に送る (`next_run_after`
    // は常に厳密に未来を返す契約)。
    #[test]
    fn daily_exact_match_rolls_to_next_day() {
        let sched = daily(8, 0);
        let from = dt(2026, 1, 1, 8, 0);
        assert_eq!(next_run_after(&sched, from), dt(2026, 1, 2, 8, 0));
    }

    #[test]
    fn daily_handles_month_and_year_rollover() {
        let sched = daily(0, 0);
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
