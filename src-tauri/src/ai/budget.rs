//! AI の月次予算の判定 (#1620)。
//!
//! 使用量台帳 (`usage`、日 × タスク × モデルのトークン数) を JST の月初から集計し、単価表
//! (`AiModel::price`) を掛けた概算コストが設定の月次予算以上なら、`run_ai_request` が実行前に
//! 止める。判定は純関数 (`month_cost_usd` / `check_budget`) に切り出してあり、台帳の読み込みだけが
//! I/O。台帳に単価の分からないモデルが残っていてもその分は 0 円扱い (下限の目安)。
//! 保存するのは設定値 (予算額) だけで、秘密情報は一切扱わない。

use chrono::{DateTime, Utc};

use super::models::AiModel;
use super::usage::{self, AiUsageRecord};
use crate::error::{AppError, Result};

/// 1 レコードの概算コスト (USD)。単価の分からないモデルは `None`。
pub fn record_cost_usd(r: &AiUsageRecord) -> Option<f64> {
    let p = AiModel::from_id(&r.model)?.price();
    Some(
        (r.input_tokens as f64 * p.input
            + r.output_tokens as f64 * p.output
            + r.cache_read_input_tokens as f64 * p.cache_read
            + r.cache_creation_input_tokens as f64 * p.cache_write)
            / 1_000_000.0,
    )
}

/// `now` と同じ月 (JST) に入るレコードの概算コストの合計 (USD)。
pub fn month_cost_usd(records: &[AiUsageRecord], now: DateTime<Utc>) -> f64 {
    // `YYYY-MM-DD` の先頭 7 文字 (`YYYY-MM`) が一致する日が同じ月。
    let today = usage::jst_day(now);
    let month = today.get(..7).unwrap_or(&today);
    records
        .iter()
        .filter(|r| r.day.starts_with(month))
        .filter_map(record_cost_usd)
        .sum()
}

/// 予算を超えていれば `AiBudgetExceeded`。`budget` が `None` / 0 以下 / 非有限なら上限なし。
pub fn check_budget(budget: Option<f64>, spent: f64) -> Result<()> {
    match budget {
        Some(limit) if limit.is_finite() && limit > 0.0 && spent >= limit => {
            Err(AppError::AiBudgetExceeded(format!(
                "this month's AI usage (about ${spent:.2}) has reached the monthly budget (${limit:.2})"
            )))
        }
        _ => Ok(()),
    }
}

/// 台帳を読んで予算を確認する。予算未設定のときは台帳を読まない。
pub async fn ensure_within_budget(budget: Option<f64>) -> Result<()> {
    if budget.is_none() {
        return Ok(());
    }
    let records = usage::load_all().await?;
    check_budget(budget, month_cost_usd(&records, Utc::now()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn rec(day: &str, model: &str, input: u64, output: u64) -> AiUsageRecord {
        AiUsageRecord {
            day: day.into(),
            task: "generic".into(),
            model: model.into(),
            calls: 1,
            input_tokens: input,
            output_tokens: output,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
        }
    }

    #[test]
    fn cost_uses_the_price_table() {
        // Sonnet: input $2 / output $10 per MTok → 1M + 1M = $12。
        let r = rec("2026-10-01", "claude-sonnet-5-5", 1_000_000, 1_000_000);
        assert!((record_cost_usd(&r).unwrap_or(-1.0) - 12.0).abs() < 1e-9);
        assert!(record_cost_usd(&rec("2026-10-01", "unknown", 1, 1)).is_none());
    }

    #[test]
    fn month_cost_counts_only_the_current_jst_month() {
        let records = vec![
            rec("2026-09-30", "claude-sonnet-5-5", 1_000_000, 0),
            rec("2026-10-01", "claude-sonnet-5-5", 1_000_000, 0),
            rec("2026-10-15", "claude-sonnet-5-5", 500_000, 0),
            rec("2026-10-15", "unknown-model", 9_000_000, 0),
        ];
        let now = Utc.with_ymd_and_hms(2026, 10, 15, 3, 0, 0).unwrap();
        assert!((month_cost_usd(&records, now) - 3.0).abs() < 1e-9);
    }

    #[test]
    fn month_boundary_follows_jst() {
        // UTC 9/30 16:00 = JST 10/1 01:00 → 10 月扱い。
        let records = vec![
            rec("2026-09-30", "claude-sonnet-5-5", 1_000_000, 0),
            rec("2026-10-01", "claude-sonnet-5-5", 1_000_000, 0),
        ];
        let now = Utc.with_ymd_and_hms(2026, 9, 30, 16, 0, 0).unwrap();
        assert!((month_cost_usd(&records, now) - 2.0).abs() < 1e-9);
    }

    #[test]
    fn budget_check_boundaries() {
        assert!(check_budget(None, 1e9).is_ok());
        assert!(check_budget(Some(0.0), 1.0).is_ok());
        assert!(check_budget(Some(f64::NAN), 1.0).is_ok());
        assert!(check_budget(Some(10.0), 9.99).is_ok());
        let err = check_budget(Some(10.0), 10.0).unwrap_err();
        assert_eq!(err.kind(), "aiBudgetExceeded");
        assert!(check_budget(Some(10.0), 12.5).is_err());
    }
}
