use std::path::PathBuf;

use async_trait::async_trait;
use russh::client::{Handler, Session};
use russh::keys::key::PublicKey;
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
}

#[async_trait]
impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint();
        match self.lookup() {
            Ok(Some(known)) => {
                if known == fingerprint {
                    tracing::info!(host = %self.host, "ssh host key matches known_hosts");
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
