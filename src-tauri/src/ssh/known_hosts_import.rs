//! OpenSSH の `~/.ssh/known_hosts` の取り込み (#1630)。
//!
//! 平文のホスト名で書かれたエントリだけを読み、公開鍵の SHA-256 指紋を計算して noobDB の
//! known_hosts (`host:port 指紋`) へ移行できる形にする。`HashKnownHosts` のハッシュ化
//! エントリ (`|1|...`) は元のホスト名を復元できないので読み飛ばし、件数だけ返す。
//! ワイルドカード / 否定パターン、`@cert-authority` / `@revoked` も取り込まない。
//! 読み取り専用で、書き込みは呼び出し側が選択されたエントリだけ `set_host_key` で行う。

use russh::keys::{HashAlg, PublicKey};
use serde::Serialize;

use super::known_hosts::KnownHost;

/// 取り込み候補 1 件の、noobDB 側の現状との関係。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportStatus {
    /// noobDB には未登録。
    New,
    /// 既に同じ指紋で登録済み。
    Same,
    /// 既に別の指紋で登録済み (取り込むと置き換わる)。
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportCandidate {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
    pub key_type: String,
    pub status: ImportStatus,
    /// `Conflict` のときの現在の指紋。
    pub existing_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ImportScan {
    /// OpenSSH の known_hosts ファイルが存在したか。
    pub found: bool,
    pub candidates: Vec<ImportCandidate>,
    /// ハッシュ化されていて読み飛ばした行数。
    pub hashed_skipped: usize,
    /// ワイルドカード / 否定 / マーカー付き / 解釈不能で読み飛ばした行数。
    pub other_skipped: usize,
}

/// 鍵種別の優先度 (小さいほど優先)。russh が既定で最初に提示する ed25519 を最優先にし、
/// 同一ホストに複数種別があるとき接続時に実際に提示される鍵と合いやすくする。
fn key_rank(key_type: &str) -> u8 {
    match key_type {
        "ssh-ed25519" => 0,
        t if t.starts_with("ecdsa-sha2-") => 1,
        "ssh-rsa" | "rsa-sha2-256" | "rsa-sha2-512" => 2,
        _ => 3,
    }
}

/// `host` / `[host]:port` を (ホスト, ポート) にする。ワイルドカード・否定・ハッシュは `None`。
fn parse_host_token(token: &str) -> Option<(String, u16)> {
    if token.is_empty() || token.starts_with('!') || token.contains(['*', '?', '|']) {
        return None;
    }
    if let Some(rest) = token.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        if host.is_empty() {
            return None;
        }
        let port = match after.strip_prefix(':') {
            Some(p) => p.parse().ok()?,
            None if after.is_empty() => 22,
            None => return None,
        };
        return Some((host.to_ascii_lowercase(), port));
    }
    if token.chars().any(char::is_whitespace) {
        return None;
    }
    Some((token.to_ascii_lowercase(), 22))
}

/// OpenSSH known_hosts の本文を取り込み候補にする。`existing` は noobDB の現行エントリ。
pub fn scan_content(content: &str, existing: &[KnownHost]) -> ImportScan {
    let mut scan = ImportScan {
        found: true,
        ..Default::default()
    };
    // (host, port) → 優先度が最も高い鍵。出現順を保つため Vec で持つ。
    let mut picked: Vec<(ImportCandidate, u8)> = Vec::new();
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('@') {
            scan.other_skipped += 1;
            continue;
        }
        let mut parts = line.split_whitespace();
        let (Some(hosts), Some(key_type), Some(b64)) = (parts.next(), parts.next(), parts.next())
        else {
            scan.other_skipped += 1;
            continue;
        };
        if hosts.starts_with("|1|") {
            scan.hashed_skipped += 1;
            continue;
        }
        let Ok(key) = PublicKey::from_openssh(&format!("{key_type} {b64}")) else {
            scan.other_skipped += 1;
            continue;
        };
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let mut any = false;
        for token in hosts.split(',') {
            let Some((host, port)) = parse_host_token(token) else {
                continue;
            };
            any = true;
            let rank = key_rank(key_type);
            let current = existing
                .iter()
                .find(|k| k.port == port && k.host.eq_ignore_ascii_case(&host));
            let (status, existing_fingerprint) = match current {
                None => (ImportStatus::New, None),
                Some(k) if k.fingerprint == fingerprint => (ImportStatus::Same, None),
                Some(k) => (ImportStatus::Conflict, Some(k.fingerprint.clone())),
            };
            let cand = ImportCandidate {
                host,
                port,
                fingerprint: fingerprint.clone(),
                key_type: key_type.to_string(),
                status,
                existing_fingerprint,
            };
            match picked
                .iter_mut()
                .find(|(c, _)| c.host == cand.host && c.port == cand.port)
            {
                Some(slot) if rank < slot.1 => *slot = (cand, rank),
                Some(_) => {}
                None => picked.push((cand, rank)),
            }
        }
        if !any {
            scan.other_skipped += 1;
        }
    }
    scan.candidates = picked.into_iter().map(|(c, _)| c).collect();
    scan
}

#[cfg(test)]
mod tests {
    use super::*;

    const ED: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAMKERgfJi00O0JJUFdeZWxzeoGIj5adpKuyucDHztXc";
    const ED2: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMfU4e77CBUiLzxJVmNwfYqXpLG+y9jl8v8MGSYzQE1a";

    fn fp(k: &str) -> String {
        PublicKey::from_openssh(k)
            .unwrap()
            .fingerprint(HashAlg::Sha256)
            .to_string()
    }

    #[test]
    fn plain_hosts_ports_and_aliases_are_read() {
        let content =
            format!("# c\nExample.COM,10.0.0.1 {ED} comment\n[db.example.com]:2222 {ED2}\n");
        let scan = scan_content(&content, &[]);
        assert!(scan.found);
        assert_eq!(scan.candidates.len(), 3);
        assert_eq!(scan.candidates[0].host, "example.com");
        assert_eq!(scan.candidates[0].port, 22);
        assert_eq!(scan.candidates[0].fingerprint, fp(ED));
        assert_eq!(scan.candidates[1].host, "10.0.0.1");
        assert_eq!(scan.candidates[2].host, "db.example.com");
        assert_eq!(scan.candidates[2].port, 2222);
        assert!(scan
            .candidates
            .iter()
            .all(|c| c.status == ImportStatus::New));
    }

    #[test]
    fn hashed_wildcard_marker_and_garbage_lines_are_counted_not_imported() {
        let content = format!(
            "|1|abc=|def= {ED}\n*.example.com {ED}\n@cert-authority host {ED}\nbroken line\nok.example {ED}\n!neg.example {ED}\n"
        );
        let scan = scan_content(&content, &[]);
        assert_eq!(scan.hashed_skipped, 1);
        assert_eq!(scan.other_skipped, 4);
        assert_eq!(scan.candidates.len(), 1);
        assert_eq!(scan.candidates[0].host, "ok.example");
    }

    #[test]
    fn status_reflects_existing_trust() {
        let existing = vec![
            KnownHost {
                host: "same.example".into(),
                port: 22,
                fingerprint: fp(ED),
            },
            KnownHost {
                host: "diff.example".into(),
                port: 22,
                fingerprint: fp(ED2),
            },
        ];
        let content = format!("same.example {ED}\ndiff.example {ED}\nnew.example {ED}\n");
        let scan = scan_content(&content, &existing);
        assert_eq!(scan.candidates[0].status, ImportStatus::Same);
        assert_eq!(scan.candidates[1].status, ImportStatus::Conflict);
        assert_eq!(scan.candidates[1].existing_fingerprint, Some(fp(ED2)));
        assert_eq!(scan.candidates[2].status, ImportStatus::New);
    }

    #[test]
    fn preferred_key_type_wins_for_duplicate_endpoint() {
        // 同一ホストに ED25519 が 2 つ並ぶ場合は先勝ち (同順位は置き換えない)。
        let content = format!("h.example {ED}\nh.example {ED2}\n");
        let scan = scan_content(&content, &[]);
        assert_eq!(scan.candidates.len(), 1);
        assert_eq!(scan.candidates[0].fingerprint, fp(ED));
    }
}
