//! Shared read/write logic for the TOFU known_hosts file (#682).
//!
//! The file lives at `<data_dir>/known_hosts`, one entry per line in the form
//! `host:port fingerprint` (see [`crate::ssh::handler`], which records and
//! verifies entries during a connection). Before #682 the only recovery from a
//! host-key mismatch was to hand-edit this file; this module backs the
//! `list_known_hosts` / `forget_host_key` IPC commands so the app can list and
//! forget entries itself, and offer an in-app "re-trust and reconnect" flow
//! after a legitimate server-key rotation.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::Serialize;

use crate::error::{AppError, Result};
use crate::profiles::store::data_dir;

/// Serializes every read-modify-write of the known_hosts file so concurrent
/// mutations don't lose each other's changes (the update is read → rewrite →
/// atomic `rename`, and without a lock the last rename would clobber a
/// concurrent one). Every mutator — `forget_host_key_at`, `set_host_key_at`, and
/// the handler's `remember` / `replace_entry` — must hold this for its whole
/// read→write sequence. Poisoning is recovered (`into_inner`): a panic mid-update
/// can't corrupt the file because `write_atomic` only renames a fully-written
/// temp, so the protected data is still consistent.
pub(crate) static KNOWN_HOSTS_LOCK: Mutex<()> = Mutex::new(());

/// Acquire [`KNOWN_HOSTS_LOCK`], recovering from poisoning. The guard must be
/// held for the entire read-modify-write, so callers bind it to a local.
pub(crate) fn lock_known_hosts() -> std::sync::MutexGuard<'static, ()> {
    KNOWN_HOSTS_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// One trusted host entry: the `host:port` endpoint and the SHA-256 fingerprint
/// recorded on first use. Serialized to the frontend for the known_hosts
/// management UI.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct KnownHost {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
}

/// The known_hosts path under the app data dir, creating the dir if missing.
/// Matches the location [`crate::ssh::handler::ClientHandler`] uses (both derive
/// it from [`data_dir`]) so listing/forgetting operate on the very file the TOFU
/// check reads.
pub fn default_known_hosts_path() -> Result<PathBuf> {
    let dir = data_dir().ok_or(AppError::ConfigDir)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("known_hosts"))
}

/// Parse known_hosts file content into entries, skipping blank/comment lines and
/// any malformed line (missing separator, unparsable port). Tolerant by design:
/// a stray line must never make the whole list un-viewable.
pub fn parse_known_hosts(content: &str) -> Vec<KnownHost> {
    let mut out = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((endpoint, fingerprint)) = line.split_once(' ') else {
            continue;
        };
        // `endpoint` is `host:port`; split on the LAST ':' so IPv6-ish hosts
        // (unlikely here, but harmless) don't break parsing of the port.
        let Some((host, port_str)) = endpoint.rsplit_once(':') else {
            continue;
        };
        let Ok(port) = port_str.parse::<u16>() else {
            continue;
        };
        if host.is_empty() || fingerprint.is_empty() {
            continue;
        }
        out.push(KnownHost {
            host: host.to_string(),
            port,
            fingerprint: fingerprint.to_string(),
        });
    }
    out
}

/// List known_hosts entries at `path`. A missing file is an empty list (not an
/// error) — the file is created lazily on the first trusted host.
pub fn list_known_hosts_at(path: &Path) -> Result<Vec<KnownHost>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(path)?;
    Ok(parse_known_hosts(&content))
}

/// List every trusted host from the default known_hosts file.
pub fn list_known_hosts() -> Result<Vec<KnownHost>> {
    list_known_hosts_at(&default_known_hosts_path()?)
}

/// Remove the entry for `host:port` from the file at `path`, leaving every other
/// line byte-for-byte intact. Returns `true` when a matching entry was removed,
/// `false` when there was nothing to remove (unknown host, or no file yet).
///
/// This is the recovery primitive: after a host-key mismatch the user forgets
/// the stale entry, and the next connection re-trusts the new key via TOFU.
pub fn forget_host_key_at(path: &Path, host: &str, port: u16) -> Result<bool> {
    // Hold the lock across the whole read-modify-write so a concurrent mutation
    // can't clobber this one (see KNOWN_HOSTS_LOCK).
    let _guard = lock_known_hosts();
    if !path.exists() {
        return Ok(false);
    }
    let content = std::fs::read_to_string(path)?;
    let target = format!("{host}:{port}");
    let mut removed = false;
    let mut out = String::with_capacity(content.len());
    for line in content.lines() {
        let is_target = line
            .trim()
            .split_once(' ')
            .is_some_and(|(endpoint, _)| endpoint == target);
        if is_target {
            removed = true;
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    if removed {
        write_atomic(path, out.as_bytes())?;
    }
    Ok(removed)
}

/// Forget `host:port` in the default known_hosts file.
pub fn forget_host_key(host: &str, port: u16) -> Result<bool> {
    forget_host_key_at(&default_known_hosts_path()?, host, port)
}

/// Pin `host:port` to exactly `fingerprint` in the file at `path`, replacing any
/// existing entry for that endpoint and leaving every other line intact.
///
/// This is the *secure* recovery primitive for a host-key mismatch (#682): the
/// user approves the newly-presented fingerprint in the mismatch dialog and we
/// pin it here, so the following reconnect verifies the server against that
/// exact key via the normal TOFU check. A plain forget + reconnect would instead
/// TOFU-accept whatever key is presented on reconnect — an active MITM could
/// slip a *different* key in during that window. Pinning closes that window: a
/// key other than the approved one mismatches again and is rejected.
pub fn set_host_key_at(path: &Path, host: &str, port: u16, fingerprint: &str) -> Result<()> {
    let host = host.trim();
    let fingerprint = fingerprint.trim();
    // Reject anything that would corrupt the line-based format (embedded spaces
    // would be parsed as a second field / new endpoint).
    if host.is_empty() || host.contains(char::is_whitespace) {
        return Err(AppError::InvalidInput(
            "invalid host for known_hosts".into(),
        ));
    }
    if fingerprint.is_empty() || fingerprint.contains(char::is_whitespace) {
        return Err(AppError::InvalidInput(
            "invalid host key fingerprint".into(),
        ));
    }
    // Hold the lock across the whole read-modify-write (see KNOWN_HOSTS_LOCK).
    let _guard = lock_known_hosts();
    let target = format!("{host}:{port}");
    let existing = if path.exists() {
        std::fs::read_to_string(path)?
    } else {
        String::new()
    };
    let mut out = String::with_capacity(existing.len() + target.len() + fingerprint.len() + 2);
    for line in existing.lines() {
        let is_target = line
            .trim()
            .split_once(' ')
            .is_some_and(|(endpoint, _)| endpoint == target);
        if is_target {
            // Drop the stale entry; the fresh one is appended below.
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.push_str(&format!("{target} {fingerprint}\n"));
    write_atomic(path, out.as_bytes())?;
    Ok(())
}

/// Pin `host:port` to `fingerprint` in the default known_hosts file.
pub fn set_host_key(host: &str, port: u16, fingerprint: &str) -> Result<()> {
    set_host_key_at(&default_known_hosts_path()?, host, port, fingerprint)
}

/// Atomically replace `path`'s contents: write a sibling temp file, `sync_all`,
/// then `rename` (atomic within one filesystem). Prevents a crash/power-loss/
/// disk-full mid-write from leaving a half-written known_hosts that would break
/// later host-key verification. Shared by the handler's entry migration and the
/// forget path so both mutate the file safely.
pub(crate) fn write_atomic(path: &Path, content: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};
    // Per-process counter so two concurrent writes (PID is shared) can't collide
    // on the same temp file name and corrupt each other's output.
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp_path = dir.join(format!(
        ".{}.tmp.{}.{}",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "known_hosts".to_string()),
        std::process::id(),
        seq
    ));
    {
        let mut f = std::fs::File::create(&tmp_path)?;
        f.write_all(content)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mut dir = std::env::temp_dir();
        dir.push(format!("noobdb_kh_mod_{}_{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("known_hosts")
    }

    #[test]
    fn parse_skips_blank_comment_and_malformed_lines() {
        let content = "\
# a comment\n\
\n\
ssh.example.com:22 SHA256:abc\n\
malformed-no-space\n\
host-no-port SHA256:def\n\
db.internal:2222 SHA256:xyz\n";
        let entries = parse_known_hosts(content);
        assert_eq!(
            entries,
            vec![
                KnownHost {
                    host: "ssh.example.com".into(),
                    port: 22,
                    fingerprint: "SHA256:abc".into()
                },
                KnownHost {
                    host: "db.internal".into(),
                    port: 2222,
                    fingerprint: "SHA256:xyz".into()
                },
            ]
        );
    }

    #[test]
    fn list_missing_file_is_empty() {
        let path = temp_path().with_file_name("does_not_exist");
        assert_eq!(list_known_hosts_at(&path).unwrap(), Vec::new());
    }

    #[test]
    fn forget_removes_only_the_target_entry() {
        let path = temp_path();
        std::fs::write(
            &path,
            "a.example.com:22 SHA256:aaa\nb.example.com:22 SHA256:bbb\nc.example.com:2200 SHA256:ccc\n",
        )
        .unwrap();

        // Removing b leaves a and c untouched.
        assert!(forget_host_key_at(&path, "b.example.com", 22).unwrap());
        let after = list_known_hosts_at(&path).unwrap();
        assert_eq!(after.len(), 2);
        assert!(after.iter().any(|k| k.host == "a.example.com"));
        assert!(after.iter().any(|k| k.host == "c.example.com"));
        assert!(!after.iter().any(|k| k.host == "b.example.com"));

        // A port must match too: same host, wrong port removes nothing.
        assert!(!forget_host_key_at(&path, "c.example.com", 22).unwrap());
        assert_eq!(list_known_hosts_at(&path).unwrap().len(), 2);

        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn forget_missing_file_returns_false() {
        let path = temp_path().with_file_name("nope");
        assert!(!forget_host_key_at(&path, "x", 22).unwrap());
    }

    #[test]
    fn set_pins_fingerprint_replacing_stale_entry() {
        let path = temp_path();
        std::fs::write(
            &path,
            "a.example.com:22 SHA256:aaa\ndb.internal:2222 SHA256:old\n",
        )
        .unwrap();

        // Pinning replaces db.internal's entry and leaves a untouched.
        set_host_key_at(&path, "db.internal", 2222, "SHA256:new").unwrap();
        let after = list_known_hosts_at(&path).unwrap();
        assert_eq!(after.len(), 2);
        assert!(after
            .iter()
            .any(|k| k.host == "a.example.com" && k.fingerprint == "SHA256:aaa"));
        let pinned = after.iter().find(|k| k.host == "db.internal").unwrap();
        assert_eq!(pinned.port, 2222);
        assert_eq!(pinned.fingerprint, "SHA256:new");
        // Exactly one db.internal entry — the stale one was removed, not appended.
        assert_eq!(after.iter().filter(|k| k.host == "db.internal").count(), 1);

        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn set_creates_file_when_missing() {
        let path = temp_path().with_file_name("fresh_known_hosts");
        set_host_key_at(&path, "new.example.com", 22, "SHA256:zzz").unwrap();
        let entries = list_known_hosts_at(&path).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].fingerprint, "SHA256:zzz");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn set_rejects_malformed_fingerprint_or_host() {
        let path = temp_path().with_file_name("reject_known_hosts");
        // A fingerprint with embedded whitespace would corrupt the line format.
        assert!(set_host_key_at(&path, "h", 22, "SHA256:a b").is_err());
        assert!(set_host_key_at(&path, "h", 22, "  ").is_err());
        assert!(set_host_key_at(&path, "", 22, "SHA256:a").is_err());
        // Nothing should have been written.
        assert!(!path.exists());
    }
}
