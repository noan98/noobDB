use std::path::PathBuf;

use russh::client::{Handler, Session};
use russh::keys::{HashAlg, PublicKey};
use russh::ChannelId;

use crate::profiles::store::data_dir;

/// Client-side SSH handler. Implements TOFU known-hosts: on first encounter,
/// accept and persist the host key fingerprint; thereafter, require a match.
pub struct ClientHandler {
    pub host: String,
    pub port: u16,
    /// Overrides the known_hosts location. `None` resolves to the app data
    /// dir; only tests set this so they never touch the real user directory.
    known_hosts: Option<PathBuf>,
}

impl ClientHandler {
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Self {
            host: host.into(),
            port,
            known_hosts: None,
        }
    }

    #[cfg(test)]
    fn with_known_hosts(host: impl Into<String>, port: u16, known_hosts: PathBuf) -> Self {
        Self {
            host: host.into(),
            port,
            known_hosts: Some(known_hosts),
        }
    }

    fn known_hosts_path(&self) -> std::io::Result<PathBuf> {
        if let Some(path) = &self.known_hosts {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            return Ok(path.clone());
        }
        let dir = data_dir()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "data dir"))?;
        std::fs::create_dir_all(&dir)?;
        Ok(dir.join("known_hosts"))
    }

    fn lookup(&self) -> std::io::Result<Option<String>> {
        let path = self.known_hosts_path()?;
        if !path.exists() {
            return Ok(None);
        }
        let target = format!("{}:{}", self.host, self.port);
        let content = std::fs::read_to_string(&path)?;
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((endpoint, fp)) = line.split_once(' ') {
                if endpoint == target {
                    return Ok(Some(fp.to_string()));
                }
            }
        }
        Ok(None)
    }

    fn remember(&self, fingerprint: &str) -> std::io::Result<()> {
        use std::io::Write;
        let path = self.known_hosts_path()?;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        writeln!(f, "{}:{} {}", self.host, self.port, fingerprint)
    }

    /// Rewrite this endpoint's known_hosts entry with `fingerprint`, leaving
    /// every other line untouched.
    fn replace_entry(&self, fingerprint: &str) -> std::io::Result<()> {
        let path = self.known_hosts_path()?;
        let target = format!("{}:{}", self.host, self.port);
        let content = std::fs::read_to_string(&path)?;
        let mut out = String::with_capacity(content.len() + fingerprint.len());
        for line in content.lines() {
            let is_target = line
                .trim()
                .split_once(' ')
                .is_some_and(|(endpoint, _)| endpoint == target);
            if is_target {
                out.push_str(&format!("{target} {fingerprint}\n"));
            } else {
                out.push_str(line);
                out.push('\n');
            }
        }
        std::fs::write(&path, out)
    }
}

/// Pre-0.60 builds stored the bare base64 SHA-256 digest, while russh 0.60
/// renders fingerprints as `SHA256:<digest>`. When the stored value is the
/// legacy form of the *same* digest it denotes the same key, so we can migrate
/// it instead of treating a previously trusted host as a key mismatch.
fn is_legacy_fingerprint_of(stored: &str, current: &str) -> bool {
    match current.strip_prefix("SHA256:") {
        Some(digest) => !stored.contains(':') && stored == digest,
        None => false,
    }
}

impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        match self.lookup() {
            Ok(Some(known)) => {
                if known == fingerprint {
                    tracing::info!(host = %self.host, "ssh host key matches known_hosts");
                    Ok(true)
                } else if is_legacy_fingerprint_of(&known, &fingerprint) {
                    tracing::info!(
                        host = %self.host,
                        "migrating legacy known_hosts fingerprint to SHA256 format"
                    );
                    if let Err(e) = self.replace_entry(&fingerprint) {
                        tracing::warn!("failed to migrate known_hosts entry: {e}");
                    }
                    Ok(true)
                } else {
                    tracing::warn!(
                        host = %self.host,
                        "ssh host key mismatch (known={known}, got={fingerprint})"
                    );
                    Err(russh::Error::UnknownKey)
                }
            }
            Ok(None) => {
                tracing::info!(
                    host = %self.host,
                    "ssh host key not in known_hosts; trust-on-first-use, remembering {fingerprint}"
                );
                if let Err(e) = self.remember(&fingerprint) {
                    tracing::warn!("failed to persist known_hosts entry: {e}");
                }
                Ok(true)
            }
            Err(e) => {
                tracing::warn!("known_hosts lookup failed: {e}");
                Ok(true)
            }
        }
    }

    async fn data(
        &mut self,
        _channel: ChannelId,
        _data: &[u8],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use russh::client::Handler;
    use russh::keys::{HashAlg, PublicKey};

    use super::{is_legacy_fingerprint_of, ClientHandler};

    const KEY_A: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAMKERgfJi00O0JJUFdeZWxzeoGIj5adpKuyucDHztXc noobdb-test-a";
    const KEY_B: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMfU4e77CBUiLzxJVmNwfYqXpLG+y9jl8v8MGSYzQE1a noobdb-test-b";

    /// A unique known_hosts path under the temp dir so tests never read or
    /// write the real app data directory.
    fn temp_known_hosts() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mut dir = std::env::temp_dir();
        dir.push(format!("noobdb_kh_{}_{nanos}", std::process::id()));
        dir.join("known_hosts")
    }

    #[test]
    fn legacy_digest_matches_current_sha256() {
        assert!(is_legacy_fingerprint_of("abc123DEF", "SHA256:abc123DEF"));
    }

    #[test]
    fn legacy_digest_for_different_key_is_rejected() {
        assert!(!is_legacy_fingerprint_of("abc123DEF", "SHA256:zzz999"));
    }

    #[test]
    fn modern_stored_entry_is_not_treated_as_legacy() {
        assert!(!is_legacy_fingerprint_of(
            "SHA256:abc123DEF",
            "SHA256:abc123DEF"
        ));
    }

    #[test]
    fn non_sha256_current_fingerprint_never_migrates() {
        assert!(!is_legacy_fingerprint_of("abc123DEF", "MD5:ab:cd:ef"));
    }

    // Reproduces the russh 0.60 regression: a pre-existing legacy entry must be
    // migrated to the SHA256 form and the host accepted, not rejected.
    #[tokio::test]
    async fn legacy_entry_is_migrated_then_accepted() {
        let key = PublicKey::from_openssh(KEY_A).unwrap();
        let modern = key.fingerprint(HashAlg::Sha256).to_string();
        let legacy = modern.strip_prefix("SHA256:").unwrap();

        let path = temp_known_hosts();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, format!("ssh.example.com:22 {legacy}\n")).unwrap();

        let mut handler = ClientHandler::with_known_hosts("ssh.example.com", 22, path.clone());
        assert!(handler.check_server_key(&key).await.unwrap());

        let migrated = std::fs::read_to_string(&path).unwrap();
        assert_eq!(migrated.trim(), format!("ssh.example.com:22 {modern}"));

        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    // A genuinely different key for a trusted host is still rejected, so the
    // migration path does not weaken MITM detection.
    #[tokio::test]
    async fn changed_key_is_rejected() {
        let trusted = PublicKey::from_openssh(KEY_A).unwrap();
        let presented = PublicKey::from_openssh(KEY_B).unwrap();
        let trusted_fp = trusted.fingerprint(HashAlg::Sha256).to_string();

        let path = temp_known_hosts();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, format!("ssh.example.com:22 {trusted_fp}\n")).unwrap();

        let mut handler = ClientHandler::with_known_hosts("ssh.example.com", 22, path.clone());
        assert!(matches!(
            handler.check_server_key(&presented).await,
            Err(russh::Error::UnknownKey)
        ));

        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    // First contact with an unknown host records the modern fingerprint (TOFU).
    #[tokio::test]
    async fn first_use_records_modern_fingerprint() {
        let key = PublicKey::from_openssh(KEY_A).unwrap();
        let modern = key.fingerprint(HashAlg::Sha256).to_string();

        let path = temp_known_hosts();
        let mut handler = ClientHandler::with_known_hosts("ssh.example.com", 22, path.clone());
        assert!(handler.check_server_key(&key).await.unwrap());

        let recorded = std::fs::read_to_string(&path).unwrap();
        assert_eq!(recorded.trim(), format!("ssh.example.com:22 {modern}"));

        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
