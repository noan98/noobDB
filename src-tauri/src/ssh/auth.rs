use std::path::Path;
use std::sync::Arc;

use russh::keys::{decode_secret_key, key::KeyPair};

use crate::error::{AppError, Result};

/// Load a private key from a file path, optionally decrypting with a passphrase.
pub fn load_private_key(path: &Path, passphrase: Option<&str>) -> Result<Arc<KeyPair>> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| AppError::SshKey(format!("failed to read key file: {e}")))?;
    let key = decode_secret_key(&content, passphrase)
        .map_err(|e| AppError::SshKey(format!("failed to decode private key: {e}")))?;
    Ok(Arc::new(key))
}
