use crate::error::{AppError, Result};

/// エディタへ取り込めるテキストファイルのサイズ上限 (8 MiB)。ドラッグ&ドロップ
/// で巨大ファイルを誤って落としたときに、エディタへ全文を載せてフロントを
/// 固めてしまうのを防ぐためのガード。
const MAX_TEXT_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// ドロップされた `.sql` / `.txt` の内容を読んでエディタへ流し込むための読み取り
/// コマンド。フロントが fs プラグインを直に叩かず、バックエンド経由で読む
/// (capabilities を最小に保つ方針)。UTF-8 として不正なバイトは置換文字へ
/// ロッシーにデコードする (エディタ表示が目的で、厳密な往復は要らない)。
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("file path is empty".into()));
    }
    let meta = tokio::fs::metadata(&path).await?;
    if meta.len() > MAX_TEXT_FILE_BYTES {
        return Err(AppError::InvalidInput(format!(
            "file too large to open in the editor ({} bytes, limit {} bytes)",
            meta.len(),
            MAX_TEXT_FILE_BYTES
        )));
    }
    let bytes = tokio::fs::read(&path).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_utf8_text_file() {
        let path = std::env::temp_dir().join(format!("noobdb_read_{}.sql", std::process::id()));
        tokio::fs::write(&path, "SELECT 1;\n").await.unwrap();
        let content = read_text_file(path.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert_eq!(content, "SELECT 1;\n");
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn lossily_decodes_invalid_utf8() {
        let path = std::env::temp_dir().join(format!("noobdb_read_bad_{}.txt", std::process::id()));
        tokio::fs::write(&path, [0xff, 0xfe, 0x41]).await.unwrap();
        let content = read_text_file(path.to_string_lossy().into_owned())
            .await
            .unwrap();
        // 末尾の 'A' は残り、不正バイトは置換文字へ。パニックせず文字列を返す。
        assert!(content.ends_with('A'));
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn rejects_empty_path() {
        let err = read_text_file("   ".into()).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn errors_when_file_missing() {
        let err = read_text_file("/nonexistent/noobdb/does-not-exist.sql".into())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
    }
}
