use tokio::io::AsyncReadExt;

use crate::error::{AppError, Result};

/// エディタへ取り込めるテキストファイルのサイズ上限 (8 MiB)。ドラッグ&ドロップ
/// で巨大ファイルを誤って落としたときに、エディタへ全文を載せてフロントを
/// 固めてしまうのを防ぐためのガード。
const MAX_TEXT_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// `write_binary_file` が一度に書き出せるサイズの上限 (32 MiB)。チャート/ER 図の
/// 画像エクスポート (#643) など、フロントで生成したバイト列をユーザが選んだパスへ
/// 保存するためのガード。巨大な誤データでディスクを埋めないようにする。
const MAX_WRITE_FILE_BYTES: usize = 32 * 1024 * 1024;

/// `write_binary_file` が保存先パスを運ぶリクエストヘッダ名。ボディは生バイト列
/// そのものなので、パスはヘッダで渡す (#1258)。
pub const WRITE_PATH_HEADER: &str = "x-noobdb-path";

/// ヘッダ値 (パーセントエンコードされた UTF-8) を元のパス文字列へ戻す。ヘッダ値は
/// ASCII に限られるため、フロントは `encodeURIComponent` で日本語や Windows パス
/// (`C:\Users\...`) を運ぶ。`%` の後ろが 16 進 2 桁でない・復号結果が UTF-8 で
/// ない場合は拒否する (黙って別のパスへ書かないため)。
pub(crate) fn decode_path_header(raw: &str) -> Result<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes
                .get(i + 1..i + 3)
                .and_then(|h| std::str::from_utf8(h).ok())
                .and_then(|h| u8::from_str_radix(h, 16).ok())
                .ok_or_else(|| AppError::InvalidInput("save path header is malformed".into()))?;
            out.push(hex);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out)
        .map_err(|_| AppError::InvalidInput("save path header is not valid UTF-8".into()))
}

/// 検証つきでバイト列をファイルへ書く共通処理。空パスとサイズ超過は拒否する。
async fn write_bytes_checked(path: &str, data: &[u8]) -> Result<u64> {
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
    tokio::fs::write(path, data).await?;
    Ok(data.len() as u64)
}

/// フロントで生成したバイト列 (チャート/ER 図の PNG・SVG など) を、ユーザが保存
/// ダイアログ (`dialog:allow-save`) で選んだパスへ書き出すコマンド。フロントが
/// fs プラグインを直に叩かず、バックエンド経由で書く (capabilities を最小に保つ方針。
/// #643)。ボディは Tauri 2 の raw ボディ (`InvokeBody::Raw`) で、JSON の数値配列
/// (約 4 倍) を経由しない (#1258)。パスはヘッダ [`WRITE_PATH_HEADER`] に
/// パーセントエンコードして載せる。空パスとサイズ超過は拒否する。書き込んだ
/// バイト数を返す。
#[tauri::command]
pub async fn write_binary_file(request: tauri::ipc::Request<'_>) -> Result<u64> {
    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => data,
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(AppError::InvalidInput(
                "write_binary_file expects a raw binary body".into(),
            ))
        }
    };
    let raw_path = request
        .headers()
        .get(WRITE_PATH_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::InvalidInput("save path header is missing".into()))?;
    let path = decode_path_header(raw_path)?;
    write_bytes_checked(&path, data).await
}

/// テキスト (SQL・Markdown・JSON など) を UTF-8 でユーザが選んだ `path` へ書き出す
/// コマンド (#1258)。`write_binary_file` と同じ上限 (32 MiB) を課す。フロントで
/// `TextEncoder` → 数値配列へ変換する無駄を避けるため、文字列のまま渡す。
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<u64> {
    write_bytes_checked(&path, content.as_bytes()).await
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
    // metadata による事前チェックは通常ファイルに対する早期リジェクトとして残す
    // (エラーメッセージが素早く出る)。ただし metadata だけに頼ると、(a) チェック
    // 後に追記されたぶんが素通りする TOCTOU、(b) /dev/zero や /proc の一部、
    // 名前付きパイプなど metadata 長が 0 または不定な特殊ファイルで上限が効かず
    // 無制限に読む (あるいは FIFO で永久ブロックする) 問題がある。そのため実際の
    // 読み取り側でも `take` で打ち切り、実読み取りバイト数で上限を強制する。
    if let Ok(meta) = tokio::fs::metadata(&path).await {
        if meta.len() > MAX_TEXT_FILE_BYTES {
            return Err(AppError::InvalidInput(format!(
                "file too large to open in the editor ({} bytes, limit {} bytes)",
                meta.len(),
                MAX_TEXT_FILE_BYTES
            )));
        }
    }

    let file = tokio::fs::File::open(&path).await?;
    // 上限ちょうどのファイルを正しく許可しつつ超過を検出するため、上限 + 1 バイト
    // まで読む。読めたバイト数が上限を超えていれば拒否する。
    let mut limited = file.take(MAX_TEXT_FILE_BYTES + 1);
    let mut bytes = Vec::new();
    limited.read_to_end(&mut bytes).await?;
    if bytes.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err(AppError::InvalidInput(format!(
            "file too large to open in the editor (limit {MAX_TEXT_FILE_BYTES} bytes)"
        )));
    }
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
    async fn write_bytes_checked_writes_bytes() {
        let path = std::env::temp_dir().join(format!("noobdb_write_{}.bin", std::process::id()));
        let data = vec![0u8, 1, 2, 3, 255];
        let n = write_bytes_checked(&path.to_string_lossy(), &data)
            .await
            .unwrap();
        assert_eq!(n, data.len() as u64);
        assert_eq!(tokio::fs::read(&path).await.unwrap(), data);
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn write_bytes_checked_rejects_empty_path() {
        let err = write_bytes_checked("  ", &[1, 2, 3]).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn write_bytes_checked_limit_is_inclusive() {
        let path =
            std::env::temp_dir().join(format!("noobdb_write_lim_{}.bin", std::process::id()));
        let at_limit = vec![7u8; MAX_WRITE_FILE_BYTES];
        let n = write_bytes_checked(&path.to_string_lossy(), &at_limit)
            .await
            .unwrap();
        assert_eq!(n, MAX_WRITE_FILE_BYTES as u64);
        let over = vec![7u8; MAX_WRITE_FILE_BYTES + 1];
        let err = write_bytes_checked(&path.to_string_lossy(), &over)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn write_text_file_writes_utf8_and_rejects_empty_path() {
        let path =
            std::env::temp_dir().join(format!("noobdb_write_txt_{}.sql", std::process::id()));
        let n = write_text_file(
            path.to_string_lossy().into_owned(),
            "SELECT '日本語';\n".into(),
        )
        .await
        .unwrap();
        let expected = "SELECT '日本語';\n";
        assert_eq!(n, expected.len() as u64);
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), expected);
        let _ = tokio::fs::remove_file(&path).await;
        let err = write_text_file("".into(), "x".into()).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn decode_path_header_handles_non_ascii_and_windows_paths() {
        // encodeURIComponent("/tmp/日本語 dir/ファイル.png")
        let enc =
            "%2Ftmp%2F%E6%97%A5%E6%9C%AC%E8%AA%9E%20dir%2F%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB.png";
        assert_eq!(
            decode_path_header(enc).unwrap(),
            "/tmp/日本語 dir/ファイル.png"
        );
        // encodeURIComponent("C:\\Users\\太郎\\a+b%.txt")
        let win = "C%3A%5CUsers%5C%E5%A4%AA%E9%83%8E%5Ca%2Bb%25.txt";
        assert_eq!(
            decode_path_header(win).unwrap(),
            "C:\\Users\\太郎\\a+b%.txt"
        );
        assert_eq!(decode_path_header("plain.txt").unwrap(), "plain.txt");
    }

    #[test]
    fn decode_path_header_rejects_malformed_input() {
        assert!(decode_path_header("%").is_err());
        assert!(decode_path_header("%4").is_err());
        assert!(decode_path_header("%zz").is_err());
        // 復号結果が UTF-8 でない (単独の継続バイト)。
        assert!(decode_path_header("%80").is_err());
    }

    #[tokio::test]
    async fn errors_when_file_missing() {
        let err = read_text_file("/nonexistent/noobdb/does-not-exist.sql".into())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
    }

    // H6: 上限ちょうどのファイルは許可され、1 バイトでも超えると拒否されること。
    // metadata の事前チェックだけでなく実読み取り側 (`take`) でも上限が効いて
    // いることを、境界値の両側で確認する。
    #[tokio::test]
    async fn accepts_file_exactly_at_the_size_limit() {
        let path =
            std::env::temp_dir().join(format!("noobdb_read_at_limit_{}.sql", std::process::id()));
        let data = vec![b'a'; MAX_TEXT_FILE_BYTES as usize];
        tokio::fs::write(&path, &data).await.unwrap();
        let content = read_text_file(path.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert_eq!(content.len() as u64, MAX_TEXT_FILE_BYTES);
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn rejects_file_one_byte_over_the_size_limit() {
        let path =
            std::env::temp_dir().join(format!("noobdb_read_over_limit_{}.sql", std::process::id()));
        let data = vec![b'a'; MAX_TEXT_FILE_BYTES as usize + 1];
        tokio::fs::write(&path, &data).await.unwrap();
        let err = read_text_file(path.to_string_lossy().into_owned())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        let _ = tokio::fs::remove_file(&path).await;
    }
}
