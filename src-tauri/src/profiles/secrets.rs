use keyring::Entry;

use crate::error::Result;

const SERVICE: &str = "noobDB";

fn target(profile_id: &str, kind: &str) -> String {
    format!("{profile_id}/{kind}")
}

/// Stores a secret in the OS keyring. Only the profile id and the secret *kind*
/// are ever logged — never the value itself.
fn set_secret(profile_id: &str, kind: &str, value: &str) -> Result<()> {
    let entry = Entry::new(SERVICE, &target(profile_id, kind))?;
    match entry.set_password(value) {
        Ok(()) => Ok(()),
        Err(e) => {
            tracing::error!(profile_id, kind, error = %e, "keyring: failed to set secret");
            Err(e.into())
        }
    }
}

/// Reads a secret. A missing entry (`NoEntry`) is normal and returns `None`
/// without logging; any other failure is logged as an error.
fn get_secret(profile_id: &str, kind: &str) -> Result<Option<String>> {
    let entry = Entry::new(SERVICE, &target(profile_id, kind))?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => {
            tracing::error!(profile_id, kind, error = %e, "keyring: failed to read secret");
            Err(e.into())
        }
    }
}

/// Deletes a secret. A missing entry is treated as success; other failures are
/// logged as errors.
fn delete_secret(profile_id: &str, kind: &str) -> Result<()> {
    let entry = Entry::new(SERVICE, &target(profile_id, kind))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => {
            tracing::error!(profile_id, kind, error = %e, "keyring: failed to delete secret");
            Err(e.into())
        }
    }
}

/// Returns whether a secret of `kind` exists for the profile, without exposing
/// the value. A read failure (other than a missing entry) degrades to `false`
/// since callers use this only as a display hint; `get_secret` already logged
/// the underlying error.
fn has_secret(profile_id: &str, kind: &str) -> bool {
    matches!(get_secret(profile_id, kind), Ok(Some(_)))
}

pub fn set_db_password(profile_id: &str, password: &str) -> Result<()> {
    set_secret(profile_id, "db_password", password)
}

pub fn get_db_password(profile_id: &str) -> Result<Option<String>> {
    get_secret(profile_id, "db_password")
}

pub fn has_db_password(profile_id: &str) -> bool {
    has_secret(profile_id, "db_password")
}

pub fn delete_db_password(profile_id: &str) -> Result<()> {
    delete_secret(profile_id, "db_password")
}

pub fn set_ssh_passphrase(profile_id: &str, passphrase: &str) -> Result<()> {
    set_secret(profile_id, "ssh_passphrase", passphrase)
}

pub fn get_ssh_passphrase(profile_id: &str) -> Result<Option<String>> {
    get_secret(profile_id, "ssh_passphrase")
}

pub fn has_ssh_passphrase(profile_id: &str) -> bool {
    has_secret(profile_id, "ssh_passphrase")
}

pub fn delete_ssh_passphrase(profile_id: &str) -> Result<()> {
    delete_secret(profile_id, "ssh_passphrase")
}

pub fn set_ssh_password(profile_id: &str, password: &str) -> Result<()> {
    set_secret(profile_id, "ssh_password", password)
}

pub fn get_ssh_password(profile_id: &str) -> Result<Option<String>> {
    get_secret(profile_id, "ssh_password")
}

pub fn has_ssh_password(profile_id: &str) -> bool {
    has_secret(profile_id, "ssh_password")
}

pub fn delete_ssh_password(profile_id: &str) -> Result<()> {
    delete_secret(profile_id, "ssh_password")
}

pub fn delete_all(profile_id: &str) -> Result<()> {
    delete_db_password(profile_id)?;
    delete_ssh_passphrase(profile_id)?;
    delete_ssh_password(profile_id)?;
    Ok(())
}
