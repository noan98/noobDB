use crate::error::{AppError, Result};

/// エディタへ取り込めるテキストファイルのサイズ上限 (8 MiB)。ドラッグ&ドロップ
/// で巨大ファイルを誤って落としたときに、エディタへ全文を載せてフロントを
/// 固めてしまうのを防ぐためのガード。
const MAX_TEXT_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// `write_binary_file` が一度に書き出せるサイズの上限 (32 MiB)。チャート/ER 図の
/// 画像エクスポート (#643) など、フロントで生成したバイト列をユーザが選んだパスへ
/// 保存するためのガード。巨大な誤データでディスクを埋めないようにする。
const MAX_WRITE_FILE_BYTES: usize = 32 * 1024 * 1024;

/// フロントで生成したバイト列 (チャート/ER 図の PNG・SVG など) を、ユーザが保存
/// ダイアログ (`dialog:allow-save`) で選んだ `path` へ書き出すコマンド。フロントが
/// fs プラグインを直に叩かず、バックエンド経由で書く (capabilities を最小に保つ方針。
/// #643)。空パスとサイズ超過は拒否する。書き込んだバイト数を返す。
#[tauri::command]
pub async fn write_binary_file(path: String, data: Vec<u8>) -> Result<u64> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("save path is empty".into()));
    }
    if data.len() > MAX_WRITE_FILE_BYTES {
        return Err(AppError::InvalidInput(format!(
            "data too large to write ({} bytes, limit {} bytes)",
            data.len(),
            MAX_WRITE_FILE_BYTES
        )));
    }
    let len = data.len() as u64;
    tokio::fs::write(&path, &data).await?;
    Ok(len)
}

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
    async fn write_binary_file_writes_bytes() {
        let path = std::env::temp_dir().join(format!("noobdb_write_{}.bin", std::process::id()));
        let data = vec![0u8, 1, 2, 3, 255];
        let n = write_binary_file(path.to_string_lossy().into_owned(), data.clone())
            .await
            .unwrap();
        assert_eq!(n, data.len() as u64);
        assert_eq!(tokio::fs::read(&path).await.unwrap(), data);
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn write_binary_file_rejects_empty_path() {
        let err = write_binary_file("  ".into(), vec![1, 2, 3])
            .await
            .unwrap_err();
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
