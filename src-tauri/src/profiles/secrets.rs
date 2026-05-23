use keyring::Entry;

use crate::error::Result;

const SERVICE: &str = "noobDB";

fn target(profile_id: &str, kind: &str) -> String {
    format!("{profile_id}/{kind}")
}

pub fn set_db_password(profile_id: &str, password: &str) -> Result<()> {
    let entry = Entry::new(SERVICE, &target(profile_id, "db_password"))?;
    entry.set_password(password)?;
    Ok(())
}

pub fn get_db_password(profile_id: &str) -> Result<Option<String>> {
    let entry = Entry::new(SERVICE, &target(profile_id, "db_password"))?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_db_password(profile_id: &str) -> Result<()> {
    let entry = Entry::new(SERVICE, &target(profile_id, "db_password"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub fn set_ssh_passphrase(profile_id: &str, passphrase: &str) -> Result<()> {
    let entry = Entry::new(SERVICE, &target(profile_id, "ssh_passphrase"))?;
    entry.set_password(passphrase)?;
    Ok(())
}

pub fn get_ssh_passphrase(profile_id: &str) -> Result<Option<String>> {
    let entry = Entry::new(SERVICE, &target(profile_id, "ssh_passphrase"))?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_ssh_passphrase(profile_id: &str) -> Result<()> {
    let entry = Entry::new(SERVICE, &target(profile_id, "ssh_passphrase"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub fn set_ssh_password(profile_id: &str, password: &str) -> Result<()> {
    let entry = Entry::new(SERVICE, &target(profile_id, "ssh_password"))?;
    entry.set_password(password)?;
    Ok(())
}

pub fn get_ssh_password(profile_id: &str) -> Result<Option<String>> {
    let entry = Entry::new(SERVICE, &target(profile_id, "ssh_password"))?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_ssh_password(profile_id: &str) -> Result<()> {
    let entry = Entry::new(SERVICE, &target(profile_id, "ssh_password"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_all(profile_id: &str) -> Result<()> {
    delete_db_password(profile_id)?;
    delete_ssh_passphrase(profile_id)?;
    delete_ssh_password(profile_id)?;
    Ok(())
}
