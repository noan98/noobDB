//! 進捗イベントの間引き (#1258)。
//!
//! チャンクごとに `emit` すると、巨大なエクスポート / 転送 / 取り込みで IPC が
//! 進捗イベントで溢れる。`script.rs` の `PROGRESS_INTERVAL` + `last_emit` と同じ
//! 方式で、最小間隔より短い呼び出しを捨てる。最後の進捗を必ず送る責任は呼び出し側
//! (完了時に [`ProgressThrottle::needs_final_emit`] で未送信の最新値を確認する) が持つ。

use std::time::{Duration, Instant};

/// 進捗イベントの最小間隔。`script.rs` の `PROGRESS_INTERVAL` と同じ 150ms。
pub(crate) const PROGRESS_INTERVAL: Duration = Duration::from_millis(150);

/// 最小間隔で進捗の emit を間引く。
#[derive(Debug)]
pub(crate) struct ProgressThrottle {
    interval: Duration,
    last_emit: Option<Instant>,
}

impl ProgressThrottle {
    pub(crate) fn new(interval: Duration) -> Self {
        Self {
            interval,
            last_emit: None,
        }
    }

    /// 既定間隔 (150ms) の間引き。
    pub(crate) fn standard() -> Self {
        Self::new(PROGRESS_INTERVAL)
    }

    /// 今 emit してよいなら true を返し、送信時刻を記録する。最初の呼び出しは
    /// 常に true (開始直後の進捗を遅らせない)。
    pub(crate) fn ready(&mut self) -> bool {
        let now = Instant::now();
        match self.last_emit {
            Some(last) if now.duration_since(last) < self.interval => false,
            _ => {
                self.last_emit = Some(now);
                true
            }
        }
    }
}

/// 「最後に実際に送った値」を共有して、完了時に未送信の最新値だけを追い送りする
/// ための小さなヘルパ。`emitted` は emit した累積値、`latest` は最新の値。
pub(crate) fn needs_final_emit(emitted: u64, latest: u64) -> bool {
    emitted != latest
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_call_passes_then_throttles() {
        let mut t = ProgressThrottle::new(Duration::from_secs(3600));
        assert!(t.ready());
        assert!(!t.ready());
        assert!(!t.ready());
    }

    #[test]
    fn zero_interval_never_throttles() {
        let mut t = ProgressThrottle::new(Duration::ZERO);
        assert!(t.ready());
        assert!(t.ready());
    }

    #[test]
    fn passes_again_after_the_interval() {
        let mut t = ProgressThrottle::new(Duration::from_millis(20));
        assert!(t.ready());
        assert!(!t.ready());
        std::thread::sleep(Duration::from_millis(40));
        assert!(t.ready());
    }

    #[test]
    fn final_emit_only_when_latest_differs() {
        assert!(needs_final_emit(100, 250));
        assert!(!needs_final_emit(250, 250));
    }
}
