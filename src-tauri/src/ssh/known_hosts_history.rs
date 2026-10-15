//! known_hosts の信頼・削除・取り込みの履歴 (#1630)。
//!
//! 「いつ・どのホストの・どの指紋を変えたか」を残し、サーバの鍵ローテーションなのか中間者
//! 攻撃なのかを後から確認できるようにする。保存するのは操作種別・時刻・ホスト名・ポート・
//! 公開鍵の SHA-256 指紋だけで、鍵そのものや秘密情報は含まない。新しい順に最大
//! [`MAX_EVENTS`] 件まで保持し、超えた古い記録は捨てる。

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::json_store::JsonStore;

/// 保持する履歴の上限件数。
pub const MAX_EVENTS: usize = 500;

/// 履歴に残す操作。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnownHostAction {
    /// 指紋を明示的に pin した (ホスト鍵不一致ダイアログの「信頼して再接続」)。
    Trust,
    /// エントリを削除した。
    Forget,
    /// OpenSSH の known_hosts から取り込んだ。
    Import,
}

/// 履歴 1 件。`fingerprint` は操作後 (削除では削除した) の指紋、`previous_fingerprint` は
/// 置き換えられた旧指紋 (初めての登録・削除では `None`)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnownHostEvent {
    /// 操作時刻 (UTC, RFC 3339)。
    pub at: String,
    pub action: KnownHostAction,
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
    #[serde(default)]
    pub previous_fingerprint: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct HistoryFile {
    /// 古い順に追記する。
    #[serde(default)]
    events: Vec<KnownHostEvent>,
}

static STORE: JsonStore = JsonStore::new("known_hosts_history.json");

fn push_event(file: &mut HistoryFile, event: KnownHostEvent) {
    file.events.push(event);
    if file.events.len() > MAX_EVENTS {
        let excess = file.events.len() - MAX_EVENTS;
        file.events.drain(..excess);
    }
}

/// 履歴を新しい順で返す。
pub fn list_events() -> Result<Vec<KnownHostEvent>> {
    let file: HistoryFile = STORE.read()?;
    let mut events = file.events;
    events.reverse();
    Ok(events)
}

/// 履歴を 1 件追記する。
pub fn record(
    action: KnownHostAction,
    host: &str,
    port: u16,
    fingerprint: &str,
    previous_fingerprint: Option<String>,
) -> Result<()> {
    let event = KnownHostEvent {
        at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        action,
        host: host.trim().to_ascii_lowercase(),
        port,
        fingerprint: fingerprint.trim().to_string(),
        previous_fingerprint,
    };
    STORE.update::<HistoryFile, _>(|f| push_event(f, event))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(n: usize) -> KnownHostEvent {
        KnownHostEvent {
            at: format!("t{n}"),
            action: KnownHostAction::Trust,
            host: "h".into(),
            port: 22,
            fingerprint: format!("SHA256:{n}"),
            previous_fingerprint: None,
        }
    }

    #[test]
    fn history_is_capped_dropping_oldest() {
        let mut file = HistoryFile::default();
        for n in 0..MAX_EVENTS + 5 {
            push_event(&mut file, ev(n));
        }
        assert_eq!(file.events.len(), MAX_EVENTS);
        assert_eq!(file.events[0].at, "t5");
        assert_eq!(
            file.events.last().unwrap().at,
            format!("t{}", MAX_EVENTS + 4)
        );
    }

    #[test]
    fn event_serializes_snake_case_action_without_key_material() {
        let json = serde_json::to_value(ev(1)).unwrap();
        assert_eq!(json["action"], "trust");
        let keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        assert!(keys.iter().all(|k| [
            "at",
            "action",
            "host",
            "port",
            "fingerprint",
            "previous_fingerprint"
        ]
        .contains(&k.as_str())));
    }
}
