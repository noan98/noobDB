//! ローカル横断クエリ (#740) — 複数接続の結果セットを、駆動元セッションを持たない
//! 特殊セッション (「ローカル」接続) 上のローカル SQLite エンジンへ取り込み、
//! 異種 DB 間で JOIN・再分析できるようにする。
//!
//! 「ローカル」接続は他の接続と同じ `Session` / `Connection::Sqlite` を使うだけの
//! 一時ファイルバックド SQLite セッションで、クエリ実行は既存の `run_query` /
//! `run_query_stream` 等をそのまま再利用する (新しい実行経路は増やさない)。この
//! モジュールが増やすのは「作る」「登録する」「一覧する」「消す」「ファイルへ保存する」
//! という管理系 IPC のみ。

use serde::Deserialize;
use tauri::State;

use crate::db::types::{Column, LocalTableMeta, Value};
use crate::db::{Connection, DbConnectOptions, DriverKind};
use crate::error::{AppError, Result};
use crate::state::{new_session_id, random_slug, AppState, Session, SessionId};

/// 1 回の登録で取り込める最大行数。フロントは「取得済み (prefetch 済み) 範囲」しか
/// そもそも渡せないためこれより先に事実上の上限がかかっているが、それでも大きすぎる
/// 一括登録でローカル SQLite / UI を詰まらせないための最終防波堤として明示する。
/// 受け入れ条件の「上限行数を明示する」は、この定数とフロント側の同名ガード
/// (`localQuery.ts` の `MAX_LOCAL_TABLE_ROWS`) の 2 か所で表現している。
pub const MAX_LOCAL_TABLE_ROWS: usize = 200_000;

/// ローカルセッションの一時 DB ファイルを置くディレクトリ (OS 標準の一時領域配下)。
/// data_dir (プロファイル等の永続領域) ではなく敢えて OS temp を使うのは、
/// 「既定で揮発」という設計を置き場所のレベルからも裏付けるため — アプリが
/// 異常終了して `disconnect` のクリーンアップが走らなくても、OS が temp を
/// 掃除する対象になる。
///
/// **注意**: `std::env::temp_dir()` は全ユーザ共有の書き込み可能領域 (Unix では
/// 通常 `/tmp`)。このディレクトリには複数 DB を横断結合した実データが入るため、
/// 同一マシンの他ユーザに読まれたり、固定パスを先回りされて (ディレクトリ/
/// シンボリックリンクの事前作成で) 書き込み先ごと乗っ取られたりしないよう、
/// 実際の準備は [`prepare_local_temp_dir`] / ファイル作成側の `mode(0o600)` で
/// 検証・強制する (Unix 限定。他 OS では従来どおり)。
fn local_temp_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("noobdb-local")
}

/// 現在のプロセスの実効 UID。所有者検証 (`prepare_local_temp_dir` /
/// `cleanup_stale_local_files`) にだけ使う 1 関数のために `libc` クレート依存を
/// 増やしたくないので、`geteuid(2)` を直接 `extern "C"` 宣言する。Unix ターゲットは
/// ビルド時に必ずシステム libc をリンクするため、追加のビルド設定は不要。
#[cfg(unix)]
fn current_uid() -> u32 {
    extern "C" {
        fn geteuid() -> u32;
    }
    // SAFETY: `geteuid` は引数を取らず失敗しない純粋な問い合わせ syscall。
    unsafe { geteuid() }
}

/// [`local_temp_dir`] を、他ユーザに乗っ取られていないことを検証したうえで用意する
/// (Unix 限定)。
///
/// - まだ何も存在しなければ `0700` (自分だけが rwx) で新規作成する。
/// - 既に何か存在する場合は **黙って使わず**、次をすべて確認する:
///   - シンボリックリンクでないこと (差し替えによる書き込み先ハイジャックを検出)。
///   - 実在するディレクトリであること。
///   - 所有者が自分 (`current_uid()`) であること (他ユーザの先回り作成を検出)。
///   - group/other に一切の権限が無いこと (`mode & 0o077 == 0`)。
///
///   いずれかを満たさなければ分かりやすいエラーで拒否する。
///
/// `symlink_metadata` (lstat 相当、シンボリックリンクを辿らない) で存在確認と
/// 種別判定を同時に行うことで、「確認してから使う」の間に TOCTOU が入り込む余地を
/// 最小化している。
#[cfg(unix)]
fn prepare_local_temp_dir(dir: &std::path::Path) -> Result<()> {
    use std::os::unix::fs::DirBuilderExt;

    match std::fs::symlink_metadata(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::DirBuilder::new().mode(0o700).create(dir) {
                Ok(()) => Ok(()),
                // 「存在しない」を見てから作るまでの間に、別スレッド (ローカル
                // セッションは同時に複数開ける) が先に作ることがある。作成の
                // 成否ではなく「最終的に検証を満たすディレクトリがあるか」が
                // 目的なので、その場合は検証側へ回して判定させる。ここで素直に
                // エラーにすると、正常な並行オープンが `AlreadyExists` で
                // 落ちてしまう。
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    verify_local_temp_dir(dir)
                }
                Err(e) => Err(e.into()),
            }
        }
        Err(e) => Err(e.into()),
        Ok(meta) => verify_local_temp_dir_meta(dir, &meta),
    }
}

/// 既存の [`local_temp_dir`] を lstat し直して検証する ([`prepare_local_temp_dir`]
/// の作成が競合で `AlreadyExists` になったときの合流点)。
#[cfg(unix)]
fn verify_local_temp_dir(dir: &std::path::Path) -> Result<()> {
    let meta = std::fs::symlink_metadata(dir)?;
    verify_local_temp_dir_meta(dir, &meta)
}

/// 既存エントリが「自分だけが読み書きできる実ディレクトリ」であることの検証。
#[cfg(unix)]
fn verify_local_temp_dir_meta(dir: &std::path::Path, meta: &std::fs::Metadata) -> Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    if meta.file_type().is_symlink() {
        return Err(AppError::Other(format!(
            "refusing to use local session directory {}: it is a symbolic link (possible hijack)",
            dir.display()
        )));
    }
    if !meta.is_dir() {
        return Err(AppError::Other(format!(
            "refusing to use local session directory {}: not a directory",
            dir.display()
        )));
    }
    if meta.uid() != current_uid() {
        return Err(AppError::Other(format!(
            "refusing to use local session directory {}: not owned by the current user",
            dir.display()
        )));
    }
    let mode = meta.permissions().mode();
    if mode & 0o077 != 0 {
        return Err(AppError::Other(format!(
            "refusing to use local session directory {}: group or other has access (mode {:o})",
            dir.display(),
            mode & 0o777
        )));
    }
    Ok(())
}

/// Windows など Unix 以外では、所有者/パーミッション概念が異なるため従来どおり
/// `create_dir_all` するだけ (挙動を変えない)。
#[cfg(not(unix))]
fn prepare_local_temp_dir(dir: &std::path::Path) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    Ok(())
}

/// ローカルセッションの SQLite ファイルを新規作成する。`dump.rs::DefaultsFile::
/// create` と同じパターン (Unix では `mode(0o600)`) を踏襲し、他ユーザに読まれない
/// パーミッションで作る。`create_new` (= `O_CREAT | O_EXCL`) を使うのは、`create`
/// (`O_CREAT | O_TRUNC`) だと既存のシンボリックリンクを辿って書き込んでしまうため
/// — ファイル名は `random_slug(12)` を含み衝突はまず起きない前提なので、
/// 「既に存在するなら異常」として素直にエラーにできる。
#[cfg(unix)]
fn create_local_session_file(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    Ok(())
}

#[cfg(not(unix))]
fn create_local_session_file(path: &std::path::Path) -> std::io::Result<()> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    Ok(())
}

/// 起動時に呼ばれるベストエフォートの掃除。前回異常終了で残った一時 DB ファイルは
/// この時点でどのセッションからも参照されていない (アプリを再起動した = 全セッションが
/// 消えている) ので、ディレクトリごと削除して構わない。失敗してもログに残すだけで
/// 起動は継続する (#740)。
///
/// **Unix ではディレクトリの実体を検証してから消す。** `dir.exists()` (stat 相当、
/// シンボリックリンクを辿る) で存在確認して素朴に `remove_dir_all` すると、
/// 攻撃者が `noobdb-local` を他ディレクトリへのシンボリックリンクへ差し替えていた
/// 場合にリンク先のディレクトリを丸ごと再帰削除しかねない。`symlink_metadata`
/// (lstat) でリンクそのものかどうかを見極め、リンクなら中身を辿らずエントリ自体
/// だけを消す。所有者が自分でない場合も (他ユーザの先回り作成の可能性) 中身には
/// 触れず、次回 `create_local_session` 側の検証に判断を委ねる。
pub fn cleanup_stale_local_files() {
    let dir = local_temp_dir();
    let meta = match std::fs::symlink_metadata(&dir) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            tracing::warn!(path = %dir.display(), error = %e, "failed to stat local-session temp directory during startup cleanup");
            return;
        }
    };

    #[cfg(unix)]
    {
        if meta.file_type().is_symlink() {
            if let Err(e) = std::fs::remove_file(&dir) {
                tracing::warn!(path = %dir.display(), error = %e, "failed to remove hijacked local-session symlink");
            }
            return;
        }
        use std::os::unix::fs::MetadataExt;
        if meta.is_dir() && meta.uid() != current_uid() {
            tracing::warn!(path = %dir.display(), "local-session temp directory is not owned by the current user; leaving it alone");
            return;
        }
    }
    // 非 Unix ビルドでは上の `#[cfg(unix)]` ブロックが丸ごと消えるため `meta` が
    // 未使用になる。存在確認だけが目的の変数なので明示的に握りつぶしておく。
    let _ = &meta;

    if let Err(e) = std::fs::remove_dir_all(&dir) {
        tracing::warn!(path = %dir.display(), error = %e, "failed to clean up stale local-session temp files");
    }
}

/// テーブル名の最低限の妥当性チェック。SQL インジェクションは常に `quote_ident`
/// (二重引用符 + 内部クオートの二重化) で防いでいるため、ここでは「明らかに
/// おかしい入力」だけを弾く: 空文字列、NUL バイト、長すぎる名前。
fn validate_table_name(name: &str) -> Result<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput(
            "table name must not be empty".into(),
        ));
    }
    if trimmed.contains('\0') {
        return Err(AppError::InvalidInput("invalid table name".into()));
    }
    if trimmed.chars().count() > 128 {
        return Err(AppError::InvalidInput(
            "table name is too long (max 128 characters)".into(),
        ));
    }
    Ok(())
}

/// 対象セッションがローカル (一時ファイルバックド SQLite) セッションであることを
/// 確認して返す。通常の接続に対して登録系 IPC を誤って呼んでも、ユーザの実 DB に
/// 触れる前にここで弾かれる。
async fn get_local_session(state: &AppState, session_id: &str) -> Result<std::sync::Arc<Session>> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    if session.local_temp_file.is_none() {
        return Err(AppError::InvalidInput(
            "this session is not a local cross-connection query session".into(),
        ));
    }
    Ok(session)
}

/// 「ローカル」接続セッションを新規に開く (#740)。一時ファイルバックド SQLite を
/// `Connection::Sqlite` として確立するだけで、駆動元の実接続は持たない。空ファイルを
/// 事前に touch するのは、SQLite ドライバの `connect` が `create_if_missing(false)`
/// で開くため (0 バイトの空ファイルは SQLite にとって有効な未初期化 DB として扱われる)。
#[tauri::command]
pub async fn create_local_session(state: State<'_, AppState>) -> Result<SessionId> {
    create_local_session_inner(&state).await
}

/// Core of [`create_local_session`], split out so integration tests can drive
/// it without a Tauri runtime (exposed via `__test_api`).
pub async fn create_local_session_inner(state: &AppState) -> Result<SessionId> {
    let dir = local_temp_dir();
    // 乗っ取り検証込みの準備 (Unix): シンボリックリンク/他ユーザ所有/群書き込み
    // 可能な場合はここでエラーになる。エラーメッセージは既に状況を明示しているので
    // そのまま伝播する。
    prepare_local_temp_dir(&dir)?;
    let file_name = format!("local-{}.sqlite", random_slug(12));
    let path = dir.join(file_name);
    create_local_session_file(&path)
        .map_err(|e| AppError::Other(format!("failed to create local session file: {e}")))?;

    let opts = DbConnectOptions {
        host: String::new(),
        port: 0,
        user: String::new(),
        password: String::new(),
        database: None,
        driver: DriverKind::Sqlite,
        file_path: Some(path.to_string_lossy().into_owned()),
        ssl_mode: None,
        ssl_root_cert: None,
        ssl_client_cert: None,
        ssl_client_key: None,
        init_sql: None,
    };
    let conn = match Connection::connect(&opts).await {
        Ok(c) => c,
        Err(e) => {
            // Nothing was registered under AppState yet, so the file we just
            // touched would otherwise leak until the next startup cleanup.
            let _ = std::fs::remove_file(&path);
            return Err(e);
        }
    };

    let session = Session {
        id: new_session_id(),
        profile_id: None,
        conn,
        connect_options: opts,
        read_only: false,
        emergency_write: std::sync::atomic::AtomicBool::new(false),
        // ローカル分析は使い捨てのことが多く、かつ「接続」に紐づく profile_id を
        // 持たないため、通常のクエリ履歴 (プロファイル単位のフィルタ・削除を前提とする
        // UI) に None プロファイルの行を混ぜない方針。
        skip_history: true,
        reconnect_ssh: None,
        _tunnel: None,
        local_temp_file: Some(path),
    };
    let id = state.insert(session).await;
    tracing::info!(session_id = %id, "local session created");
    Ok(id)
}

#[derive(Debug, Deserialize)]
pub struct RegisterLocalTableRequest {
    pub session_id: SessionId,
    pub table_name: String,
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Value>>,
    /// 表示用の由来情報。すべて非秘密 — 接続情報そのもの (ホスト/資格情報) は
    /// 含まない。
    pub source_profile: Option<String>,
    pub source_sql: String,
    pub source_driver: Option<String>,
}

/// 結果セットを 1 つのローカルテーブルとして登録する。データはワイヤフォーマット
/// (`db::types::{Column, Value}`) のままここまで渡ってきており、変換はここから
/// `db::sqlite::SqliteConn::register_local_table` への 1 本だけ (#740 の設計方針)。
#[tauri::command]
pub async fn register_local_table(
    req: RegisterLocalTableRequest,
    state: State<'_, AppState>,
) -> Result<LocalTableMeta> {
    register_local_table_inner(&state, req).await
}

/// Core of [`register_local_table`] (exposed via `__test_api`).
pub async fn register_local_table_inner(
    state: &AppState,
    req: RegisterLocalTableRequest,
) -> Result<LocalTableMeta> {
    validate_table_name(&req.table_name)?;
    if req.columns.is_empty() {
        return Err(AppError::InvalidInput(
            "cannot register a table with no columns".into(),
        ));
    }
    if req.rows.len() > MAX_LOCAL_TABLE_ROWS {
        return Err(AppError::InvalidInput(format!(
            "too many rows to register locally ({} rows; limit is {MAX_LOCAL_TABLE_ROWS})",
            req.rows.len()
        )));
    }
    let session = get_local_session(state, &req.session_id).await?;

    let meta = LocalTableMeta {
        name: req.table_name.trim().to_string(),
        source_profile: req.source_profile,
        source_sql: req.source_sql,
        source_driver: req.source_driver,
        fetched_at_ms: now_ms(),
        row_count: req.rows.len() as i64,
    };
    session
        .conn
        .register_local_table(&meta, &req.columns, &req.rows)
        .await?;
    tracing::info!(
        session_id = %req.session_id,
        table = %meta.name,
        rows = meta.row_count,
        "registered local table"
    );
    Ok(meta)
}

#[tauri::command]
pub async fn list_local_tables(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<LocalTableMeta>> {
    list_local_tables_inner(&state, &session_id).await
}

/// Core of [`list_local_tables`] (exposed via `__test_api`).
pub async fn list_local_tables_inner(
    state: &AppState,
    session_id: &str,
) -> Result<Vec<LocalTableMeta>> {
    let session = get_local_session(state, session_id).await?;
    session.conn.list_local_tables().await
}

#[tauri::command]
pub async fn drop_local_table(
    session_id: String,
    table_name: String,
    state: State<'_, AppState>,
) -> Result<()> {
    drop_local_table_inner(&state, &session_id, &table_name).await
}

/// Core of [`drop_local_table`] (exposed via `__test_api`).
pub async fn drop_local_table_inner(
    state: &AppState,
    session_id: &str,
    table_name: &str,
) -> Result<()> {
    validate_table_name(table_name)?;
    let session = get_local_session(state, session_id).await?;
    session.conn.drop_local_table(table_name).await
}

/// ローカル DB を丸ごと 1 ファイルへ永続化する ("ファイルに保存")。セッション自体は
/// 引き続き揮発のままで、これは独立したスナップショットを作るだけ (#740)。
#[tauri::command]
pub async fn save_local_database(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<()> {
    save_local_database_inner(&state, &session_id, &path).await
}

/// Core of [`save_local_database`] (exposed via `__test_api`).
pub async fn save_local_database_inner(
    state: &AppState,
    session_id: &str,
    path: &str,
) -> Result<()> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("save path must not be empty".into()));
    }
    let session = get_local_session(state, session_id).await?;
    session.conn.vacuum_into(path).await
}

/// エポックミリ秒。フロントの `Date.now()` と同じ単位に揃え、`LocalTableMeta.
/// fetched_at_ms` をフロントで直接 `new Date(...)` に渡せるようにする。
fn now_ms() -> i64 {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    dur.as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_table_name_rejects_empty_and_nul() {
        assert!(validate_table_name("").is_err());
        assert!(validate_table_name("   ").is_err());
        assert!(validate_table_name("a\0b").is_err());
    }

    #[test]
    fn validate_table_name_rejects_overlong_names() {
        let long = "a".repeat(129);
        assert!(validate_table_name(&long).is_err());
        let ok = "a".repeat(128);
        assert!(validate_table_name(&ok).is_ok());
    }

    #[test]
    fn validate_table_name_accepts_ordinary_names() {
        assert!(validate_table_name("r1").is_ok());
        assert!(validate_table_name("orders_prod").is_ok());
        // Quoting (not rejection) is how embedded quotes/spaces are made safe.
        assert!(validate_table_name("weird name \"x\"").is_ok());
    }

    #[test]
    fn now_ms_is_plausible_epoch_millis() {
        // Sanity bound: some time after this file was written, well before
        // any realistic clock skew could make it fail.
        assert!(now_ms() > 1_700_000_000_000);
    }

    // ローカル横断クエリの一時ディレクトリ/ファイルの権限強制 (Unix 限定)。
    #[cfg(unix)]
    mod unix_permissions {
        use super::*;
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        fn scratch_dir(tag: &str) -> std::path::PathBuf {
            let mut p = std::env::temp_dir();
            p.push(format!(
                "noobdb_local_perm_test_{tag}_{}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ));
            p
        }

        #[test]
        fn prepare_local_temp_dir_creates_with_mode_0700() {
            let dir = scratch_dir("fresh");
            prepare_local_temp_dir(&dir).unwrap();
            let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700, "got mode {mode:o}");
            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn prepare_local_temp_dir_is_idempotent_for_a_properly_secured_dir() {
            let dir = scratch_dir("idempotent");
            prepare_local_temp_dir(&dir).unwrap();
            // 2 回目も、自分が作った 0700 ディレクトリなのでそのまま通る。
            prepare_local_temp_dir(&dir).unwrap();
            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn prepare_local_temp_dir_rejects_a_symlink() {
            let target = scratch_dir("symlink_target");
            std::fs::create_dir_all(&target).unwrap();
            let link = scratch_dir("symlink_link");
            std::os::unix::fs::symlink(&target, &link).unwrap();

            let err = prepare_local_temp_dir(&link).unwrap_err();
            assert!(
                err.to_string().contains("symbolic link"),
                "unexpected error: {err}"
            );

            std::fs::remove_file(&link).ok();
            std::fs::remove_dir_all(&target).ok();
        }

        #[test]
        fn prepare_local_temp_dir_rejects_group_or_other_writable_existing_dir() {
            let dir = scratch_dir("loose_perms");
            std::fs::create_dir_all(&dir).unwrap();
            // 意図的に group/other へ書き込み権限を残す (乗っ取りシナリオの模擬)。
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();

            let err = prepare_local_temp_dir(&dir).unwrap_err();
            assert!(
                err.to_string().contains("group or other has access"),
                "unexpected error: {err}"
            );

            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn create_local_session_file_creates_with_mode_0600() {
            let dir = scratch_dir("file_mode");
            prepare_local_temp_dir(&dir).unwrap();
            let path = dir.join("probe.sqlite");
            create_local_session_file(&path).unwrap();
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "got mode {mode:o}");
            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn create_local_session_file_refuses_to_overwrite_an_existing_path() {
            let dir = scratch_dir("file_exists");
            prepare_local_temp_dir(&dir).unwrap();
            let path = dir.join("probe.sqlite");
            create_local_session_file(&path).unwrap();
            // 2 回目 (同じパスに何か既に存在する) は `create_new` により拒否
            // される — シンボリックリンクへ追従して書き込む経路を作らない。
            assert!(create_local_session_file(&path).is_err());
            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn current_uid_matches_metadata_of_a_freshly_created_file() {
            let dir = scratch_dir("uid_probe");
            std::fs::create_dir_all(&dir).unwrap();
            let uid = std::fs::metadata(&dir).unwrap().uid();
            assert_eq!(uid, current_uid());
            std::fs::remove_dir_all(&dir).ok();
        }
    }
}
