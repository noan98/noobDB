use tokio::io::AsyncReadExt;

use serde::Serialize;

use crate::error::{AppError, Result};
use crate::text_encoding::{self, TextEncoding};

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
    // 保存先を直接開いて書くと、途中失敗で既存ファイルが切り詰められる。一時ファイル経由で
    // 置き換える (#1593)。同期 I/O なので blocking スレッドへ逃がす。
    let path = std::path::PathBuf::from(path);
    let len = data.len() as u64;
    let data = data.to_vec();
    tokio::task::spawn_blocking(move || crate::atomic_write::write_atomic(&path, &data))
        .await
        .map_err(|e| AppError::Other(format!("write task failed: {e}")))??;
    Ok(len)
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
///
/// `encoding` (#1535) を渡すと、その文字コード (Shift_JIS / EUC-JP / UTF-16 / BOM 付き
/// UTF-8) に変換して書く。省略 (`None`) は従来どおり BOM なし UTF-8。その文字コードで
/// 表せない文字があれば、置換せずエラーにする。
#[tauri::command]
pub async fn write_text_file(
    path: String,
    content: String,
    encoding: Option<TextEncoding>,
) -> Result<u64> {
    match encoding {
        None | Some(TextEncoding::Utf8) => write_bytes_checked(&path, content.as_bytes()).await,
        Some(enc) => {
            let bytes = text_encoding::encode(&content, enc)?;
            write_bytes_checked(&path, &bytes).await
        }
    }
}

/// 「保存先を開く」の対象ディレクトリを決める (#1631)。ディレクトリならそれ自身、ファイルなら
/// 親ディレクトリ。存在しないパスと空パスは拒否する。**ファイルそのものは開かない** (実行可能
/// ファイルを OS の既定動作で起動してしまわないため、常にディレクトリだけを OS のファイル
/// マネージャへ渡す)。
pub(crate) fn resolve_reveal_dir(path: &str) -> Result<std::path::PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput("path is empty".into()));
    }
    // 絶対パスだけを受け付ける。相対パスや `-` 始まりの文字列がファイルマネージャのコマンドの
    // オプションとして解釈されないようにする。
    if trimmed.starts_with('-') {
        return Err(AppError::InvalidInput(
            "path must not start with '-'".into(),
        ));
    }
    let p = std::path::PathBuf::from(trimmed);
    if !p.is_absolute() {
        return Err(AppError::InvalidInput("path must be absolute".into()));
    }
    let meta = std::fs::metadata(&p)
        .map_err(|e| AppError::InvalidInput(format!("path does not exist: {e}")))?;
    if meta.is_dir() {
        return Ok(p);
    }
    match p.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => Ok(parent.to_path_buf()),
        _ => Err(AppError::InvalidInput(
            "path has no parent directory".into(),
        )),
    }
}

/// OS のファイルマネージャでディレクトリを開く (待たずに起動だけする)。
fn spawn_file_manager(dir: &std::path::Path) -> Result<()> {
    #[cfg(target_os = "windows")]
    let mut cmd = std::process::Command::new("explorer");
    #[cfg(target_os = "macos")]
    let mut cmd = {
        // `open <dir>` は `.app` バンドル (実体はディレクトリ) だとアプリを起動してしまうので、
        // `-R` で Finder 上に表示するだけにする。
        let mut c = std::process::Command::new("open");
        c.arg("-R");
        c
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| AppError::Other(format!("failed to open the file manager: {e}")))
}

/// 書き出し・ダンプの保存先を OS のファイルマネージャで開く (#1631)。`path` はディレクトリ、
/// またはそこにあるファイル (その場合は親ディレクトリを開く)。フロントがシェルプラグインを
/// 直に叩かずバックエンド経由で起動する (capabilities を最小に保つ方針)。
#[tauri::command]
pub async fn reveal_in_file_manager(path: String) -> Result<()> {
    let dir = resolve_reveal_dir(&path)?;
    tokio::task::spawn_blocking(move || spawn_file_manager(&dir))
        .await
        .map_err(|e| AppError::Other(format!("reveal task failed: {e}")))?
}

/// ドロップされた `.sql` / `.txt` の内容を読んでエディタへ流し込むための読み取り
/// コマンド。フロントが fs プラグインを直に叩かず、バックエンド経由で読む
/// (capabilities を最小に保つ方針)。UTF-8 として不正なバイトを含むファイル
/// (Shift_JIS / EUC-JP 等) は**エラーにする**。置換文字へ黙って化けさせると、そのまま
/// 保存・実行したときに元の文字を復元できないため。
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String> {
    let bytes = read_limited(&path).await?;
    String::from_utf8(bytes).map_err(|_| {
        AppError::InvalidInput(
            "file is not valid UTF-8 (Shift_JIS / EUC-JP etc. are not supported by this command); open it as a SQL file and pick the encoding"
                .into(),
        )
    })
}

/// `read_sql_file` の結果。`encoding` は実際に使った文字コード (自動判定の結果、または
/// 指定どおり)。保存時に同じ文字コードへ戻すため、フロントがタブに覚えておく。
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct SqlFileContent {
    pub content: String,
    pub encoding: TextEncoding,
}

/// SQL ファイルを文字コード付きで読む (#1535)。`encoding` が `None` なら BOM → UTF-8 の
/// 妥当性 → Shift_JIS / EUC-JP の順に自動判定し、指定があればその文字コードで読む。
/// 不正なバイトは U+FFFD に置換せずエラーにする (化けたまま保存・実行しないため)。
/// 先頭の BOM は本文から取り除き、`encoding` (`utf-8-bom` / `utf-16*`) に反映する。
/// サイズ上限は [`read_text_file`] と同じ。
#[tauri::command]
pub async fn read_sql_file(path: String, encoding: Option<TextEncoding>) -> Result<SqlFileContent> {
    let bytes = read_limited(&path).await?;
    let enc = text_encoding::detect_with(&bytes, encoding).map_err(|e| e.into_app_error())?;
    let content = text_encoding::decode_all(&bytes, enc)?;
    Ok(SqlFileContent {
        content,
        encoding: enc,
    })
}

/// `preview_sql_file_encodings` の結果 (#1627)。
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqlEncodingPreview {
    /// 自動判定の結果。どの文字コードとしても読めなければ `None`。
    pub detected: Option<TextEncoding>,
    /// 判定に失敗した理由 (`detected` が `None` のとき)。
    pub detect_error: Option<String>,
    /// 候補ごとの先頭数行。
    pub candidates: Vec<text_encoding::EncodingPreview>,
}

/// SQL ファイルの文字コードの自動判定結果と、候補ごとに先頭数 KB を読んだプレビューを返す
/// (#1627)。利用者が判定の誤りに気づいて文字コードを選び直せるようにする読み取り専用コマンド。
/// 判定の失敗はエラーにせず `detect_error` に載せる (その場合も候補のプレビューは返す)。
#[tauri::command]
pub async fn preview_sql_file_encodings(path: String) -> Result<SqlEncodingPreview> {
    let bytes = read_limited(&path).await?;
    tokio::task::spawn_blocking(move || {
        let (detected, detect_error) = match text_encoding::detect_with(&bytes, None) {
            Ok(enc) => (Some(enc), None),
            Err(e) => (None, Some(e.into_app_error().to_string())),
        };
        SqlEncodingPreview {
            detected,
            detect_error,
            candidates: text_encoding::preview_candidates(&bytes),
        }
    })
    .await
    .map_err(|e| AppError::Other(format!("preview task failed: {e}")))
}

/// サイズ上限つきでファイル全体を読む共通処理 (エディタへ取り込むテキスト用)。
async fn read_limited(path: &str) -> Result<Vec<u8>> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("file path is empty".into()));
    }
    // metadata による事前チェックは通常ファイルに対する早期リジェクトとして残す
    // (エラーメッセージが素早く出る)。ただし metadata だけに頼ると、(a) チェック
    // 後に追記されたぶんが素通りする TOCTOU、(b) /dev/zero や /proc の一部、
    // 名前付きパイプなど metadata 長が 0 または不定な特殊ファイルで上限が効かず
    // 無制限に読む (あるいは FIFO で永久ブロックする) 問題がある。そのため実際の
    // 読み取り側でも `take` で打ち切り、実読み取りバイト数で上限を強制する。
    if let Ok(meta) = tokio::fs::metadata(path).await {
        if meta.len() > MAX_TEXT_FILE_BYTES {
            return Err(AppError::InvalidInput(format!(
                "file too large to open in the editor ({} bytes, limit {} bytes)",
                meta.len(),
                MAX_TEXT_FILE_BYTES
            )));
        }
    }

    let file = tokio::fs::File::open(path).await?;
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
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_reveal_dir_accepts_dir_and_uses_parent_for_files() {
        let dir = std::env::temp_dir().join(format!("noobdb_reveal_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.sql");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(resolve_reveal_dir(&dir.to_string_lossy()).unwrap(), dir);
        assert_eq!(resolve_reveal_dir(&file.to_string_lossy()).unwrap(), dir);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_reveal_dir_rejects_relative_and_option_like_paths() {
        assert!(matches!(
            resolve_reveal_dir("relative/dir"),
            Err(AppError::InvalidInput(_))
        ));
        assert!(matches!(
            resolve_reveal_dir("-R"),
            Err(AppError::InvalidInput(_))
        ));
        assert!(matches!(
            resolve_reveal_dir(" --help"),
            Err(AppError::InvalidInput(_))
        ));
    }

    #[test]
    fn resolve_reveal_dir_rejects_empty_and_missing_paths() {
        assert!(matches!(
            resolve_reveal_dir("  "),
            Err(AppError::InvalidInput(_))
        ));
        let missing = std::env::temp_dir().join("noobdb_reveal_missing_dir_xyz");
        assert!(matches!(
            resolve_reveal_dir(&missing.to_string_lossy()),
            Err(AppError::InvalidInput(_))
        ));
    }

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
    async fn rejects_invalid_utf8_instead_of_replacing() {
        let path = std::env::temp_dir().join(format!("noobdb_read_bad_{}.txt", std::process::id()));
        tokio::fs::write(&path, [0xff, 0xfe, 0x41]).await.unwrap();
        // Shift_JIS 等は U+FFFD に化けさせず、エラーにする。
        let err = read_text_file(path.to_string_lossy().into_owned())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
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
            None,
        )
        .await
        .unwrap();
        let expected = "SELECT '日本語';\n";
        assert_eq!(n, expected.len() as u64);
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), expected);
        let _ = tokio::fs::remove_file(&path).await;
        let err = write_text_file("".into(), "x".into(), None)
            .await
            .unwrap_err();
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

    #[tokio::test]
    async fn read_sql_file_detects_and_round_trips_shift_jis() {
        let path = std::env::temp_dir().join(format!("noobdb_sjis_{}.sql", std::process::id()));
        let p = path.to_string_lossy().into_owned();
        let text = "INSERT INTO 顧客 VALUES ('山田太郎');\n";
        write_text_file(p.clone(), text.into(), Some(TextEncoding::ShiftJis))
            .await
            .unwrap();
        // 自動判定は Shift_JIS、本文は復元される。
        let r = read_sql_file(p.clone(), None).await.unwrap();
        assert_eq!(r.encoding, TextEncoding::ShiftJis);
        assert_eq!(r.content, text);
        // 手動で UTF-8 を指定すると不正バイトでエラー (置換しない)。
        let err = read_sql_file(p.clone(), Some(TextEncoding::Utf8))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        // read_text_file (UTF-8 固定) は従来どおり拒否。
        assert!(read_text_file(p).await.is_err());
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn preview_sql_file_encodings_reports_detection_and_candidates() {
        let path = std::env::temp_dir().join(format!("noobdb_prev_{}.sql", std::process::id()));
        let p = path.to_string_lossy().into_owned();
        write_text_file(
            p.clone(),
            "SELECT '山田太郎';\n".into(),
            Some(TextEncoding::ShiftJis),
        )
        .await
        .unwrap();
        let r = preview_sql_file_encodings(p.clone()).await.unwrap();
        assert_eq!(r.detected, Some(TextEncoding::ShiftJis));
        assert!(r.detect_error.is_none());
        assert_eq!(r.candidates.len(), 6);
        let sj = r
            .candidates
            .iter()
            .find(|c| c.encoding == TextEncoding::ShiftJis)
            .unwrap();
        assert!(sj.valid);
        assert_eq!(sj.lines, vec!["SELECT '山田太郎';"]);
        // どの文字コードでも読めないファイルは、エラーにせず detect_error に載せる。
        tokio::fs::write(&path, [0x80u8, 0x80, 0xFF, 0xFF])
            .await
            .unwrap();
        let r = preview_sql_file_encodings(p).await.unwrap();
        assert!(r.detected.is_none());
        assert!(r.detect_error.is_some());
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn read_sql_file_strips_bom_and_reports_it() {
        let path = std::env::temp_dir().join(format!("noobdb_bom_{}.sql", std::process::id()));
        let p = path.to_string_lossy().into_owned();
        write_text_file(p.clone(), "SELECT 1;".into(), Some(TextEncoding::Utf16Le))
            .await
            .unwrap();
        let r = read_sql_file(p.clone(), None).await.unwrap();
        assert_eq!(r.encoding, TextEncoding::Utf16Le);
        assert_eq!(r.content, "SELECT 1;");
        write_text_file(p.clone(), "SELECT 2;".into(), Some(TextEncoding::Utf8Bom))
            .await
            .unwrap();
        let r = read_sql_file(p, None).await.unwrap();
        assert_eq!(r.encoding, TextEncoding::Utf8Bom);
        assert_eq!(r.content, "SELECT 2;");
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn write_text_file_rejects_unmappable_characters() {
        let path = std::env::temp_dir().join(format!("noobdb_unmap_{}.sql", std::process::id()));
        let err = write_text_file(
            path.to_string_lossy().into_owned(),
            "SELECT '😀'".into(),
            Some(TextEncoding::ShiftJis),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        assert!(!path.exists());
    }
}
