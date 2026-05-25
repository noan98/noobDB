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
}

impl ClientHandler {
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Self {
            host: host.into(),
            port,
        }
    }

    fn known_hosts_path() -> std::io::Result<PathBuf> {
        let dir = data_dir()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "data dir"))?;
        std::fs::create_dir_all(&dir)?;
        Ok(dir.join("known_hosts"))
    }

    fn lookup(&self) -> std::io::Result<Option<String>> {
        let path = Self::known_hosts_path()?;
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
        let path = Self::known_hosts_path()?;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        writeln!(f, "{}:{} {}", self.host, self.port, fingerprint)
    }

    /// Rewrite this endpoint's known_hosts entry with `fingerprint`, leaving
    /// every other line untouched.
    fn replace_entry(&self, fingerprint: &str) -> std::io::Result<()> {
        let path = Self::known_hosts_path()?;
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
    use super::is_legacy_fingerprint_of;

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
}
