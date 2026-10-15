use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufWriter};
use tokio::process::Command;

use crate::db::types::{StreamBatch, Value};
use crate::db::{DbConnectOptions, DriverKind};
use crate::error::{AppError, Result};
use crate::state::{AppState, Session, StreamHandle, StreamKind};

/// Emit a `dump-stream:progress` at most this often (bytes) to avoid flooding
/// the frontend on a large dump.
const PROGRESS_BYTES: u64 = 256 * 1024;
/// Read buffer size when piping an external dump tool's stdout to the file.
const PIPE_CHUNK: usize = 64 * 1024;

const EV_DUMP_PROGRESS: &str = "dump-stream:progress";
const EV_DUMP_DONE: &str = "dump-stream:done";
const EV_DUMP_ERROR: &str = "dump-stream:error";

// 構造体・フィールドの `pub` は #825 の zod ⇔ serde ゴールデン
// (`serde_schema_parity.rs`) が `__test_api` 経由で代表インスタンスを組み立てる
// ためのもの。IPC 経路としては引き続き非公開モジュール内に留まる (#824 の
// LogView と同じ最小限の可視性拡張パターン)。
#[derive(Debug, Serialize, Clone)]
pub struct DumpProgressEvent {
    #[serde(rename = "streamId")]
    pub stream_id: String,
    pub bytes: u64,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
    /// Processed / total tables for the SQLite path; `null` for external tools
    /// where only bytes are known (#686).
    pub tables: Option<u64>,
    #[serde(rename = "tablesTotal")]
    pub tables_total: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct DumpDoneEvent {
    #[serde(rename = "streamId")]
    pub stream_id: String,
    pub bytes: u64,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct DumpErrorEvent {
    #[serde(rename = "streamId")]
    pub stream_id: String,
    pub error: String,
}

/// RAII guard that deletes a partially written dump file unless `commit`ted.
/// A dump can fail, time out, or be cancelled (`cancel_stream` aborts the task,
/// dropping its future); in every non-success path this `Drop` removes the
/// half-written output rather than leaving a truncated `.sql` behind — the same
/// approach the streaming export uses (#686).
struct PartialFileCleanup {
    path: PathBuf,
    committed: bool,
}

impl PartialFileCleanup {
    fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            committed: false,
        }
    }
    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for PartialFileCleanup {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Checkbox-selected `mysqldump` flags. The frontend sends every field, so the
/// defaults here only matter for forward compatibility if a field is omitted.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DumpOptions {
    /// `--single-transaction`: dump within one transaction (consistent InnoDB
    /// snapshot without locking the whole database).
    pub single_transaction: bool,
    /// `--routines`: include stored procedures and functions.
    pub routines: bool,
    /// `--events`: include scheduled events.
    pub events: bool,
    /// Include triggers. mysqldump dumps triggers by default; when false we
    /// pass `--skip-triggers`.
    pub triggers: bool,
    /// Emit `DROP TABLE` before each `CREATE TABLE` (on by default in
    /// mysqldump; when false we pass `--skip-add-drop-table`).
    pub add_drop_table: bool,
    /// Use multi-row `INSERT` statements (on by default; when false we pass
    /// `--skip-extended-insert` for one row per statement).
    pub extended_insert: bool,
    /// `--complete-insert`: write column names in every `INSERT`.
    pub complete_insert: bool,
    /// `--no-data`: dump only the schema (no row data). For PostgreSQL maps to
    /// `--schema-only`; for SQLite, skips `INSERT` statements.
    pub no_data: bool,
    /// `--no-create-info`: dump only the data (no `CREATE TABLE`). For PostgreSQL
    /// maps to `--data-only`; for SQLite, skips schema (`CREATE` / index / trigger).
    pub no_create_info: bool,

    // ── PostgreSQL-specific. Ignored by other drivers. ──
    /// `pg_dump --no-owner`: do not emit `ALTER ... OWNER TO` statements.
    #[serde(default)]
    pub no_owner: bool,
    /// `pg_dump --no-privileges`: do not dump `GRANT` / `REVOKE`.
    #[serde(default)]
    pub no_privileges: bool,
    /// `pg_dump -n <schema>`: restrict the dump to a single schema. Empty/None
    /// dumps every schema in the database.
    #[serde(default)]
    pub pg_schema: Option<String>,

    // ── 全ドライバ共通 (#546) ──
    /// 書き出した SQL をバックエンドの整形ユーティリティ (`db::format::format_sql`)
    /// で整形して保存する。既定オフで後方互換 (オフなら出力はサーバ/生成そのまま)。
    /// 可読性向上が目的の best-effort で、MySQL の `/*!...*/` 条件付きコメントなどは
    /// 内容は保たれるが配置が変わりうるため、再取り込み重視ならオフのままにする。
    #[serde(default)]
    pub format_sql: bool,
    /// 完成したダンプを gzip 圧縮して保存する (`.sql.gz`, #1539)。全ドライバ共通の後段処理
    /// (整形 → 圧縮の順)。既定オフ。保存先パスの拡張子は呼び出し側が決める
    /// (バックエンドは付け替えない)。進捗のバイト数は圧縮前、完了時のバイト数は圧縮後。
    #[serde(default)]
    pub gzip: bool,

    // ── テーブル指定 (#1399) ──
    /// 指定したテーブルだけをダンプする (スキーマツリーで複数選択したテーブルの一括ダンプ)。
    /// `None` は従来どおりデータベース全体。`Some` のときは空リスト・空名を `InvalidInput`
    /// で拒否する (空のままだと「全体ダンプ」に化けて意図より大きく書き出してしまうため)。
    /// - MySQL: `mysqldump <db> <tbl>...`。`routines` / `events` が真でも `--routines` /
    ///   `--events` は付けない (付けるとテーブル指定でもルーチン等が出てしまうため)。
    /// - PostgreSQL: `pg_dump --table "<schema>"."<tbl>"` を表ごとに。スキーマは `pg_schema`、
    ///   空なら `dump_database` の `database` 引数 (ツリーのスキーマ) で修飾する。
    /// - SQLite: 指定テーブルとその索引 / トリガーだけを書き出す (ビューは含めない)。存在しない
    ///   テーブル名は `InvalidInput`
    #[serde(default)]
    pub tables: Option<Vec<String>>,

    // ── MySQL 追加オプション (#1624) ──
    /// `mysqldump --no-tablespaces`: `CREATE TABLESPACE` 文を出さない。PROCESS 権限が無い
    /// ユーザ (マネージド DB で多い) は、これが無いと mysqldump が失敗する。既定オフ。
    #[serde(default)]
    pub no_tablespaces: bool,
    /// `mysqldump --set-gtid-purged=OFF`: `SET @@GLOBAL.GTID_PURGED` を出さない。GTID 有効の
    /// サーバから別サーバへ復元するときの衝突を避ける。既定オフ (mysqldump の既定のまま)。
    #[serde(default)]
    pub set_gtid_purged_off: bool,

    // ── 全ドライバ共通 (#1624) ──
    /// 完成したダンプの SHA-256 を `<保存先>.sha256` (`sha256sum -c` 形式) に書く。gzip 後の
    /// 最終ファイルが対象。既定オフ。
    #[serde(default)]
    pub write_checksum: bool,

    // ── SQLite 専用 (#1624) ──
    /// SQL ではなく `VACUUM INTO` による整合したバイナリ・スナップショット (`.db`) を作る。
    /// SQLite 以外では `InvalidInput`。`tables` / `format_sql` / `no_data` などの SQL 形式向け
    /// オプションは無視する (`tables` との併用は拒否)。`gzip` は併用できる。
    #[serde(default)]
    pub sqlite_snapshot: bool,
}

/// `DumpOptions::tables` を検証して重複を除いた一覧にする。`None` は全体ダンプ。
fn selected_tables(options: &DumpOptions) -> Result<Option<Vec<String>>> {
    let Some(tables) = options.tables.as_ref() else {
        return Ok(None);
    };
    if tables.is_empty() {
        return Err(AppError::InvalidInput("table list is empty".into()));
    }
    let mut out: Vec<String> = Vec::with_capacity(tables.len());
    for name in tables {
        if name.trim().is_empty() || name.contains('\0') {
            return Err(AppError::InvalidInput("table name is invalid".into()));
        }
        if !out.contains(name) {
            out.push(name.clone());
        }
    }
    Ok(Some(out))
}

/// 指定テーブルがすべて存在することを確かめる (SQLite の部分ダンプ)。無い名前があれば
/// 黙って落とさず `InvalidInput` にする。
fn ensure_tables_exist<'a>(
    selected: &[String],
    existing: impl Iterator<Item = &'a str>,
) -> Result<()> {
    let existing: Vec<&str> = existing.collect();
    let missing: Vec<&str> = selected
        .iter()
        .map(String::as_str)
        .filter(|n| !existing.contains(n))
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!(
            "table not found: {}",
            missing.join(", ")
        )))
    }
}

/// 接続プロファイルの DB 名 (前後空白除去、空なら None)。pg_dump の `--dbname` と .pgpass の DB 欄に使う。
fn pg_connect_database(opts: &DbConnectOptions) -> Option<&str> {
    opts.database
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// `pg_dump --dbname` / .pgpass の DB 欄に使う接続先 DB。タスク経路 (`database_is_connection_db`) は
/// 入力された `database` (空白除去済み) をそのまま、ツリー / DumpModal 経路は接続プロファイルの DB。
fn pg_dbname<'a>(
    opts: &'a DbConnectOptions,
    database: &'a str,
    database_is_connection_db: bool,
) -> Option<&'a str> {
    if database_is_connection_db {
        Some(database)
    } else {
        pg_connect_database(opts)
    }
}

/// `pg_dump --table` に渡すパターン。二重引用符で囲むと大文字小文字を保ち、`*` / `?` /
/// `.` もワイルドカード扱いされない (同名の別テーブルを巻き込まない)。
fn pg_table_pattern(schema: Option<&str>, table: &str) -> String {
    let quote = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    match schema {
        Some(s) if !s.is_empty() => format!("{}.{}", quote(s), quote(table)),
        _ => quote(table),
    }
}

/// Dump `database` to `path` as a streaming, cancelable operation (#686).
///
/// Progress is reported via `dump-stream:progress` (bytes / elapsed / SQLite
/// table counts) and terminates with `dump-stream:done` or `:error`, keyed by
/// `stream_id` — the same 3-piece contract as the other streaming commands.
/// `cancel_stream` aborts the task: for external tools `kill_on_drop` kills the
/// child, and either way the partially written file is deleted.
///
/// - MySQL: `mysqldump` (credentials via a temp option file), stdout piped to
///   the file so bytes are counted as they flow.
/// - PostgreSQL: `pg_dump` (password via a temp `PGPASSFILE`), same piping.
/// - SQLite: generated table-by-table from the live connection, written
///   incrementally (no whole-dump `String` in memory).
#[tauri::command]
pub async fn dump_database(
    app: AppHandle,
    session_id: String,
    stream_id: String,
    database: String,
    path: String,
    options: DumpOptions,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;

    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("save path is empty".into()));
    }

    // Bytes-written counter shared with AppState so a cancel can report how far
    // the dump got (reuses the StreamHandle row counter as a byte counter).
    let counter = Arc::new(AtomicU64::new(0));

    // Gate the task on register_stream completing first, mirroring the other
    // streaming commands so a fast/failed dump can't forget_stream before it is
    // registered (a leftover handle would make a later cancel wrongly succeed).
    // The oneshot carries the token `register_stream` issues; the task uses it
    // to `forget_stream` only *its own* registration — `stream_id` is
    // client-supplied and can be reused, so without the token a late cleanup
    // from a stale task could erase a newer dump's entry (#state.rs の I4 対応)。
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<u64>();
    let stream_id_for_task = stream_id.clone();
    let counter_for_task = counter.clone();
    let handle = tokio::spawn(async move {
        let Ok(token) = ready_rx.await else {
            return;
        };
        spawn_dump(
            app,
            session,
            stream_id_for_task,
            token,
            database,
            path,
            options,
            counter_for_task,
        )
        .await;
    });
    let token = state
        .register_stream(
            stream_id,
            StreamHandle {
                abort: handle.abort_handle(),
                delivered_rows: counter,
                kind: StreamKind::Dump,
                // #1096: Dump ストリームは引き続き `app.emit()` の名前付き
                // イベント (`dump-stream:cancelled`) 経由でキャンセルを通知する
                // (query/preview だけが Channel 経由の `on_cancel` を使う)。
                on_cancel: None,
            },
        )
        .await;
    let _ = ready_tx.send(token);
    Ok(())
}

/// Runs the dump and emits the terminal `dump-stream:done` / `:error` event,
/// then forgets the stream. Errors are best-effort surfaced; the partial file is
/// cleaned up inside the driver paths.
#[allow(clippy::too_many_arguments)]
async fn spawn_dump(
    app: AppHandle,
    session: Arc<Session>,
    stream_id: String,
    stream_token: u64,
    database: String,
    path: String,
    options: DumpOptions,
    counter: Arc<AtomicU64>,
) {
    let started = Instant::now();
    let result = run_dump(
        &app, &session, &stream_id, &database, false, &path, &options, &counter, started,
    )
    .await;

    match result {
        Ok(bytes) => {
            tracing::info!(stream_id = %stream_id, bytes, "database dump completed");
            let _ = app.emit(
                EV_DUMP_DONE,
                DumpDoneEvent {
                    stream_id: stream_id.clone(),
                    bytes,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                },
            );
        }
        Err(e) => {
            tracing::error!(stream_id = %stream_id, error = %e, "database dump failed");
            let _ = app.emit(
                EV_DUMP_ERROR,
                DumpErrorEvent {
                    stream_id: stream_id.clone(),
                    error: e.to_string(),
                },
            );
        }
    }

    if let Some(state) = app.try_state::<AppState>() {
        state.forget_stream(&stream_id, stream_token).await;
    }
}

/// Dispatch the dump on the session's driver, then apply the optional SQL
/// reformat (#546). Returns the final byte count.
///
/// The whole dump (and any reformat) is written to a **temporary file in the
/// same directory**, and only renamed onto `final_path` after everything
/// succeeds (#84). This way a failed / cancelled dump — or a reformat error —
/// can never truncate or delete a pre-existing file at `final_path` (e.g. an
/// earlier backup the user is overwriting): the partial output lives on the
/// temp file, which `PartialFileCleanup` removes, leaving `final_path` intact.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_dump(
    app: &AppHandle,
    session: &Session,
    stream_id: &str,
    database: &str,
    // `database` を PostgreSQL の接続先 DB 名として扱うか (タスク実行の自由入力)。false は
    // ツリー / DumpModal 経路で、`database` は pg_namespace (スキーマ) 名。
    database_is_connection_db: bool,
    final_path: &str,
    options: &DumpOptions,
    counter: &Arc<AtomicU64>,
    started: Instant,
) -> Result<u64> {
    // Reserve the temp file up front with a symlink-safe `create_new` open
    // and thread the already-open handle down to whichever driver path
    // actually writes into it, rather than letting each path re-open the
    // path by name (which would reintroduce the TOCTOU window).
    //
    // `cleanup` owns the temp file for the *entire* remaining span of this
    // function — dispatch, optional reformat, and the final rename — and is
    // only `commit()`ted once the rename succeeds. Centralizing it here
    // (rather than letting `stream_external_dump`/`dump_sqlite` each guard
    // only their own slice) matters because the file now exists *before* we
    // know whether e.g. the `mysqldump`/`pg_dump` binary is even installed or
    // the credentials file could be written: any `?` early return from
    // `dump_mysql`/`dump_postgres`/`dump_sqlite` below (including failures
    // that happen before they ever touch the file) must still delete this
    // reserved-but-unused temp file, which only a guard spanning the whole
    // function can guarantee.
    if options.sqlite_snapshot && session.connect_options.driver != DriverKind::Sqlite {
        return Err(AppError::InvalidInput(
            "sqliteSnapshot is only supported for SQLite connections".into(),
        ));
    }
    let (tmp, tmp_file) = create_dump_temp_file(final_path).await?;
    let tmp_str = tmp.to_string_lossy().to_string();
    let mut cleanup = PartialFileCleanup::new(tmp.clone());

    // AWS IAM 認証 (#734) のセッションは `connect_options.password` が空なので、
    // 外部ダンプツールへ渡す直前に今有効なトークンを作って差し込む (トークンは
    // 一時オプションファイル / PGPASSFILE にのみ書かれ、ダンプ後に消える)。
    let dump_opts = crate::db::aws_iam::with_fresh_password(&session.connect_options).await?;
    let bytes = match session.connect_options.driver {
        DriverKind::Mysql => {
            dump_mysql(
                app, stream_id, &dump_opts, database, tmp_file, options, counter, started,
            )
            .await?
        }
        DriverKind::Postgres => {
            dump_postgres(
                app,
                stream_id,
                &dump_opts,
                database,
                database_is_connection_db,
                tmp_file,
                options,
                counter,
                started,
            )
            .await?
        }
        DriverKind::Sqlite if options.sqlite_snapshot => {
            dump_sqlite_snapshot(&session.conn, tmp_file, &tmp_str, options, counter).await?
        }
        DriverKind::Sqlite => {
            dump_sqlite(
                app,
                stream_id,
                &session.conn,
                tmp_file,
                options,
                counter,
                started,
            )
            .await?
        }
    };

    // 整形オプションが有効なら、書き出した SQL を整形して保存し直す (#546)。整形も
    // 一時ファイル上で行う。失敗時は `cleanup` (未 commit) が末尾の Drop で消す。
    let bytes = if options.format_sql && bytes > 0 && !options.sqlite_snapshot {
        format_dump_file(tmp_str).await?
    } else {
        bytes
    };

    // gzip 圧縮 (#1539)。完成した一時ファイルを別の一時ファイルへ圧縮し、成功したときだけ
    // そちらを保存先へ rename する。元の (未圧縮) 一時ファイルは `cleanup` の Drop が消す。
    if options.gzip {
        let (gz_tmp, gz_file) = create_dump_temp_file(final_path).await?;
        let mut gz_cleanup = PartialFileCleanup::new(gz_tmp.clone());
        let gz_bytes = gzip_dump_file(tmp.clone(), gz_file.into_std().await).await?;
        let digest = if options.write_checksum {
            Some(sha256_hex_of_file(gz_tmp.clone()).await?)
        } else {
            None
        };
        tokio::fs::rename(&gz_tmp, final_path)
            .await
            .map_err(AppError::Io)?;
        gz_cleanup.commit();
        if let Some(digest) = digest {
            write_checksum_sidecar(final_path, &digest).await?;
        }
        // `cleanup` は未 commit のまま関数末尾で Drop され、未圧縮の一時ファイルを消す。
        return Ok(gz_bytes);
    }

    let digest = if options.write_checksum {
        Some(sha256_hex_of_file(tmp.clone()).await?)
    } else {
        None
    };
    // Everything succeeded: atomically move the temp file onto the final path,
    // replacing any existing file only now (not mid-write). Failure here is
    // also covered by `cleanup`'s Drop.
    tokio::fs::rename(&tmp, final_path)
        .await
        .map_err(AppError::Io)?;
    cleanup.commit();
    if let Some(digest) = digest {
        write_checksum_sidecar(final_path, &digest).await?;
    }
    Ok(bytes)
}

/// ファイルの SHA-256 を 16 進で返す (#1624)。ストリームで読むので巨大なダンプでもメモリに
/// 載せない。同期 I/O は blocking スレッドで行う。
async fn sha256_hex_of_file(path: PathBuf) -> Result<String> {
    use sha2::{Digest, Sha256};
    tokio::task::spawn_blocking(move || -> Result<String> {
        let mut input = std::io::BufReader::new(std::fs::File::open(&path)?);
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = std::io::Read::read(&mut input, &mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect())
    })
    .await
    .map_err(|e| AppError::Other(format!("dump checksum task failed: {e}")))?
}

/// `<final_path>.sha256` のパス。
fn checksum_sidecar_path(final_path: &str) -> PathBuf {
    let mut os = std::ffi::OsString::from(final_path);
    os.push(".sha256");
    PathBuf::from(os)
}

/// `sha256sum -c` で検証できる形式 (`<hex>  <ファイル名>`) で、保存先の隣へサイドカーを書く。
async fn write_checksum_sidecar(final_path: &str, digest: &str) -> Result<()> {
    let name = Path::new(final_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let body = format!("{digest}  {name}\n");
    tokio::fs::write(checksum_sidecar_path(final_path), body)
        .await
        .map_err(|e| {
            AppError::Other(format!(
                "dump was saved, but writing the .sha256 checksum file failed: {e}"
            ))
        })
}

/// SQLite の整合スナップショット (#1624): 予約済みの空の一時ファイルへ `VACUUM INTO` する。
/// `VACUUM INTO` は単一トランザクションの一貫したコピーを作り、`.db` としてそのまま開ける。
/// SQL 生成の進捗は無いので完了時にまとめてバイト数を数える。
async fn dump_sqlite_snapshot(
    conn: &crate::db::Connection,
    file: tokio::fs::File,
    tmp_path: &str,
    options: &DumpOptions,
    counter: &Arc<AtomicU64>,
) -> Result<u64> {
    if options.tables.is_some() {
        return Err(AppError::InvalidInput(
            "a SQLite snapshot copies the whole database; table selection is not supported".into(),
        ));
    }
    // `VACUUM INTO` は自分でファイルを作る (空ファイルは許容される)。予約したハンドルは閉じる。
    drop(file);
    conn.vacuum_into(tmp_path).await?;
    let bytes = tokio::fs::metadata(tmp_path).await?.len();
    counter.store(bytes, Ordering::SeqCst);
    Ok(bytes)
}

/// A sibling temp path (`.<name>.dumping.<pid>.<seq>`) in the same directory as
/// `final_path`, so the atomic `rename` onto `final_path` stays within one
/// filesystem. The per-process counter keeps concurrent dumps from colliding.
fn dump_temp_path(final_path: &str) -> PathBuf {
    use std::sync::atomic::AtomicUsize;
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let p = Path::new(final_path);
    let dir = p.parent().unwrap_or_else(|| Path::new("."));
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "dump.sql".to_string());
    dir.join(format!(".{name}.dumping.{}.{seq}", std::process::id()))
}

/// Upper bound on retries in [`create_dump_temp_file`]. `dump_temp_path`
/// already mixes in the current PID and a per-process sequence number, so a
/// collision here should be all but impossible in practice; the loop exists
/// only so a genuine (or attacker-forced) collision doesn't fail the dump
/// outright when trying the very next candidate would have worked.
const DUMP_TEMP_FILE_MAX_ATTEMPTS: u32 = 8;

/// Opens a **new** temp dump file, refusing to follow anything already at that
/// path — including a symlink planted by another local user with write access
/// to the target directory.
///
/// `tokio::fs::File::create` (`O_CREAT|O_TRUNC`) follows an existing symlink
/// and truncates whatever it points at, so a pre-planted link in the dump
/// directory could redirect the dump's contents onto an arbitrary file the
/// attacker doesn't otherwise have permission to write (TOCTOU: the directory
/// is checked for a moment, then written to as if nothing had changed).
/// `OpenOptions::create_new` maps to `O_CREAT|O_EXCL`, which atomically fails
/// with `AlreadyExists` when the final path component exists at all (symlink
/// or not, dangling or not) instead of following it — the same defense
/// `DefaultsFile::create` / `PgPassFile::create` below already use for the
/// credential files.
///
/// On `AlreadyExists` this retries with a fresh candidate path (bumping
/// `dump_temp_path`'s sequence number) rather than failing immediately, since
/// a single collision doesn't mean the directory is hostile — the next
/// candidate is very likely available. Returns the actual path used (the
/// caller must use *this* path, not whatever it might have computed itself,
/// for the follow-up reformat/rename) together with the open handle.
async fn create_dump_temp_file(final_path: &str) -> Result<(PathBuf, tokio::fs::File)> {
    let mut last_err: Option<std::io::Error> = None;
    for _ in 0..DUMP_TEMP_FILE_MAX_ATTEMPTS {
        let candidate = dump_temp_path(final_path);
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
            .await
        {
            Ok(file) => return Ok((candidate, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                last_err = Some(e);
                continue;
            }
            Err(e) => return Err(AppError::Io(e)),
        }
    }
    Err(AppError::Other(format!(
        "failed to create a unique temp dump file after {DUMP_TEMP_FILE_MAX_ATTEMPTS} attempts: {}",
        last_err.map(|e| e.to_string()).unwrap_or_default()
    )))
}

/// Pipe an external dump tool's stdout to the already-open `file` while
/// counting bytes and emitting throttled `dump-stream:progress` events.
/// `kill_on_drop` is set so a `cancel_stream` abort (which drops this future)
/// kills the child. stdout and stderr are drained concurrently to avoid a
/// pipe deadlock.
///
/// `file` was reserved up front by [`create_dump_temp_file`] in `run_dump`
/// (symlink-safe via `create_new`) and its cleanup-on-failure is owned by
/// `run_dump`'s `PartialFileCleanup` guard, not this function — this function
/// only ever writes into the handle it was given, it never re-opens the path
/// by name (which would reintroduce the TOCTOU window `create_dump_temp_file`
/// closes) and never deletes it itself (a "binary not found" failure can
/// happen before this function is even called, e.g. while writing the
/// credentials file in `dump_mysql`/`dump_postgres`, so only a guard spanning
/// the whole dispatch in `run_dump` can cover every early-return path).
async fn stream_external_dump(
    app: &AppHandle,
    stream_id: &str,
    mut cmd: Command,
    tool_name: &str,
    file: tokio::fs::File,
    counter: &Arc<AtomicU64>,
    started: Instant,
) -> Result<u64> {
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::null());
    // Aborting the task must kill the child rather than leave it running (#686).
    cmd.kill_on_drop(true);

    let mut writer = BufWriter::new(file);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::Other(format!(
                "{tool_name} command not found. Install the client tools and make sure \
                 {tool_name} is on your PATH."
            )));
        }
        Err(e) => return Err(AppError::Io(e)),
    };

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Other("dump child stdout was not piped".into()))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Other("dump child stderr was not piped".into()))?;

    // Drain stderr concurrently in its own task so its pipe can't fill and block
    // the child while we're busy writing stdout to the file.
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        buf
    });

    let pump = async {
        let mut buf = vec![0u8; PIPE_CHUNK];
        let mut last_emit = 0u64;
        loop {
            let n = stdout.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            writer.write_all(&buf[..n]).await?;
            let total = counter.fetch_add(n as u64, Ordering::SeqCst) + n as u64;
            if total - last_emit >= PROGRESS_BYTES {
                last_emit = total;
                emit_bytes_progress(app, stream_id, total, started);
            }
        }
        writer.flush().await?;
        Ok::<(), AppError>(())
    };

    let pump_res = pump.await;
    // If writing the file failed (e.g. disk full), the child may still be
    // blocked writing to a stdout pipe we've stopped reading. Kill it so it
    // can't deadlock, then collect stderr and surface the pump error.
    if pump_res.is_err() {
        let _ = child.start_kill();
    }
    let stderr_buf = stderr_task.await.unwrap_or_default();
    pump_res?;

    let status = child.wait().await?;
    if !status.success() {
        let msg = String::from_utf8_lossy(&stderr_buf);
        let msg = msg.trim();
        let code = status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".into());
        return Err(AppError::Other(format!(
            "{tool_name} failed (exit {code}): {}",
            if msg.is_empty() {
                "no error output"
            } else {
                msg
            }
        )));
    }

    // 一時ファイルの後始末は呼び出し元 (`run_dump`) が持つ `PartialFileCleanup`
    // に一元化してある (rename が成功した時点で commit される)。ここで commit
    // すると、整形や rename が失敗したときに書きかけのファイルが残ってしまう。
    let bytes = counter.load(Ordering::SeqCst);
    Ok(bytes)
}

/// Validate a database name for an external dump tool: non-empty after trim, and
/// not starting with `-` (which could be misread as an option like
/// `--all-databases`). Returns the trimmed name. Extracted so the guard is
/// unit-testable without a Tauri runtime (#686).
fn validate_dump_database(database: &str) -> Result<&str> {
    let database = database.trim();
    if database.is_empty() {
        return Err(AppError::InvalidInput("database name is empty".into()));
    }
    if database.starts_with('-') {
        return Err(AppError::InvalidInput(
            "database name must not start with '-'".into(),
        ));
    }
    Ok(database)
}

/// Emit a bytes-only progress event (external dump tools).
fn emit_bytes_progress(app: &AppHandle, stream_id: &str, bytes: u64, started: Instant) {
    let _ = app.emit(
        EV_DUMP_PROGRESS,
        DumpProgressEvent {
            stream_id: stream_id.to_string(),
            bytes,
            elapsed_ms: started.elapsed().as_millis() as u64,
            tables: None,
            tables_total: None,
        },
    );
}

/// `src` の内容を gzip 圧縮して、既に開いてある `dst` へ書き、圧縮後のバイト数を返す (#1539)。
/// ストリームコピーなので巨大なダンプでもメモリに載せない。CPU 負荷が高いので blocking
/// スレッドで行う。
async fn gzip_dump_file(src: PathBuf, dst: std::fs::File) -> Result<u64> {
    tokio::task::spawn_blocking(move || -> Result<u64> {
        let mut input = std::io::BufReader::new(std::fs::File::open(&src)?);
        let mut encoder = flate2::write::GzEncoder::new(
            std::io::BufWriter::new(dst),
            flate2::Compression::default(),
        );
        std::io::copy(&mut input, &mut encoder)?;
        let writer = encoder.finish()?;
        let file = writer
            .into_inner()
            .map_err(|e| AppError::Io(e.into_error()))?;
        Ok(file.metadata()?.len())
    })
    .await
    .map_err(|e| AppError::Other(format!("dump gzip task failed: {e}")))?
}

/// 書き出し済みのダンプファイルを `db::format::format_sql` で整形して書き戻し、
/// 整形後のバイト数を返す。CPU バウンドな整形と同期 I/O は blocking スレッドで行う。
///
/// ダンプが UTF-8 として不正なバイトを含む場合 (`pg_dump` は DB の文字コードのまま流す
/// ので SQL_ASCII の DB などで起こる) は、整形を**スキップして元のバイト列を残す**。
/// 整形は任意の可読性向上機能なので、失敗で数時間かけたダンプ全体を捨てたり、置換文字
/// へ化けさせて内容を壊したりしない。
async fn format_dump_file(path: String) -> Result<u64> {
    // spawn_blocking のタスクは future を落としても止まらない。キャンセルで呼び出し側が
    // 落ちたら (一時ファイルは `PartialFileCleanup` が削除済み) 整形結果を書き戻さない
    // ようフラグで知らせる。書き戻しは開いたままのハンドルで行うので、削除済みの
    // パスへ同名ファイルが再作成されることもない。
    let cancelled = Arc::new(AtomicBool::new(false));
    let _guard = CancelOnDrop(cancelled.clone());
    tokio::task::spawn_blocking(move || {
        format_dump_file_blocking(&path, FORMAT_DUMP_MAX_BYTES, &cancelled)
    })
    .await
    .map_err(|e| AppError::Other(format!("dump format task failed: {e}")))?
}

/// 整形対象にするダンプの最大サイズ (バイト)。整形は全量を 1 回で処理するため入力と出力の
/// 2 本分のメモリを同時に持つ。これを超えるダンプは整形を**スキップして元のまま残す**
/// (整形は任意の可読性向上機能で、巨大ダンプで OOM させる価値はない)。
const FORMAT_DUMP_MAX_BYTES: u64 = 256 * 1024 * 1024;

/// Drop 時にフラグを立てる (整形タスクの呼び出し側がキャンセルされたことを伝える)。
struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

fn format_dump_file_blocking(path: &str, max_bytes: u64, cancelled: &AtomicBool) -> Result<u64> {
    use std::io::{Read, Seek, SeekFrom, Write};
    // 最初にハンドルを確保する。以後の読み書きはパスではなくこのハンドル経由なので、
    // 途中でパスが削除されても (Unix では) 削除済みの inode に書くだけで済む。
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?;
    let len = file.metadata()?.len();
    if len > max_bytes {
        tracing::warn!(
            "dump is larger than {max_bytes} bytes; skipping SQL formatting to bound memory use"
        );
        return Ok(len);
    }
    let mut bytes = Vec::with_capacity(len as usize);
    file.read_to_end(&mut bytes)?;
    let Ok(raw) = String::from_utf8(bytes) else {
        tracing::warn!("dump is not valid UTF-8; skipping SQL formatting");
        return Ok(len);
    };
    let formatted = crate::db::format::format_sql(&raw);
    drop(raw);
    if cancelled.load(Ordering::SeqCst) {
        return Err(AppError::Other("dump format cancelled".into()));
    }
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(formatted.as_bytes())?;
    file.flush()?;
    Ok(formatted.len() as u64)
}

/// Run `mysqldump` for `database`, streaming SQL into the already-open `file`
/// (symlink-safe, reserved by [`create_dump_temp_file`] in `run_dump`, which
/// also owns cleaning it up on failure).
#[allow(clippy::too_many_arguments)]
async fn dump_mysql(
    app: &AppHandle,
    stream_id: &str,
    connect_options: &DbConnectOptions,
    database: &str,
    file: tokio::fs::File,
    options: &DumpOptions,
    counter: &Arc<AtomicU64>,
    started: Instant,
) -> Result<u64> {
    // `-` 始まりの DB 名はオプションとして誤解釈されうる (`--all-databases` 等)。
    // `--` によるオプション終端 (下記) と合わせた多層防御として、そもそも受け付けない。
    let database = validate_dump_database(database)?;

    // Credentials go into a temp option file (mode 0600 on unix) so the
    // password never appears in the process arguments or environment.
    let defaults = DefaultsFile::create(connect_options)?;

    // PATH に無くても既知のインストール先 (Homebrew の keg-only な mysql-client や
    // winget で入れた `Program Files\MySQL\...\bin`) にあれば使う (dump_tools.rs)。
    let mut cmd = Command::new(
        super::dump_tools::resolve_dump_tool("mysqldump").unwrap_or_else(|| "mysqldump".into()),
    );
    // `--defaults-extra-file` must be the first option on the command line.
    cmd.arg(format!(
        "--defaults-extra-file={}",
        defaults.path().display()
    ));
    if options.single_transaction {
        cmd.arg("--single-transaction");
    }
    // テーブル指定時は mysqldump が `--routines` / `--events` でもルーチン等を出してしまうので、
    // バックエンドで付けないことを保証する (#1399)。
    let table_scoped = options.tables.is_some();
    if options.routines && !table_scoped {
        cmd.arg("--routines");
    }
    if options.events && !table_scoped {
        cmd.arg("--events");
    }
    cmd.arg(if options.triggers {
        "--triggers"
    } else {
        "--skip-triggers"
    });
    cmd.arg(if options.add_drop_table {
        "--add-drop-table"
    } else {
        "--skip-add-drop-table"
    });
    cmd.arg(if options.extended_insert {
        "--extended-insert"
    } else {
        "--skip-extended-insert"
    });
    if options.complete_insert {
        cmd.arg("--complete-insert");
    }
    if options.no_data {
        cmd.arg("--no-data");
    }
    if options.no_create_info {
        cmd.arg("--no-create-info");
    }
    if options.no_tablespaces {
        cmd.arg("--no-tablespaces");
    }
    if options.set_gtid_purged_off {
        cmd.arg("--set-gtid-purged=OFF");
    }
    // `--` でオプション終端を明示し、以降の引数 (DB 名) をオプションとして解釈させない。
    // `--all-databases` や `--result-file=...` のような値を DB 名として渡された場合の
    // 引数インジェクションを防ぐ (上の `starts_with('-')` チェックと合わせた多層防御)。
    cmd.arg("--");
    cmd.arg(database);
    // テーブル指定 (#1399): DB 名のあとにテーブル名を並べる。`--` の後ろなので、
    // `-` 始まりの名前もオプションとして解釈されない。
    if let Some(tables) = selected_tables(options)? {
        cmd.args(&tables);
    }

    // Hold the option file until the child finishes reading it — the streamer
    // spawns the child, so keeping `defaults` alive across the await is required.
    let result =
        stream_external_dump(app, stream_id, cmd, "mysqldump", file, counter, started).await;
    drop(defaults);
    result
}

/// Run `pg_dump` for `database`, writing SQL into the already-open `file`
/// (symlink-safe, reserved by [`create_dump_temp_file`] in `run_dump`, which
/// also owns cleaning it up on failure). The password is passed via a temp
/// `PGPASSFILE` (mode 0600 on unix) and `--no-password`, so it never appears
/// in process arguments, the environment, or logs.
#[allow(clippy::too_many_arguments)]
async fn dump_postgres(
    app: &AppHandle,
    stream_id: &str,
    connect_options: &DbConnectOptions,
    database: &str,
    database_is_connection_db: bool,
    file: tokio::fs::File,
    options: &DumpOptions,
    counter: &Arc<AtomicU64>,
    started: Instant,
) -> Result<u64> {
    let database = validate_dump_database(database)?;

    // PostgreSQL のツリーの「database」階層は pg_namespace (スキーマ) なので、`database` は
    // 接続先 DB 名ではない。`--dbname` / .pgpass の DB 欄は接続プロファイルの DB を使い、
    // 未指定なら `--dbname` を付けない (pg_dump の既定 = PGDATABASE / ユーザ名に任せる)。
    let dbname = pg_dbname(connect_options, database, database_is_connection_db);
    let pgpass = PgPassFile::create(connect_options, dbname)?;

    let mut cmd = Command::new(
        super::dump_tools::resolve_dump_tool("pg_dump").unwrap_or_else(|| "pg_dump".into()),
    );
    cmd.arg("--host").arg(&connect_options.host);
    cmd.arg("--port").arg(connect_options.port.to_string());
    cmd.arg("--username").arg(&connect_options.user);
    if let Some(db) = dbname {
        cmd.arg("--dbname").arg(db);
    }
    // Never prompt for a password interactively; rely on PGPASSFILE instead.
    cmd.arg("--no-password");
    if options.no_data {
        cmd.arg("--schema-only");
    }
    if options.no_create_info {
        cmd.arg("--data-only");
    }
    if options.add_drop_table {
        // `--if-exists` が無いと、空の復元先で DROP が「存在しない」エラーになる。
        // SQLite / MySQL の `DROP TABLE IF EXISTS` と挙動を揃える。
        cmd.arg("--clean").arg("--if-exists");
    }
    if options.no_owner {
        cmd.arg("--no-owner");
    }
    if options.no_privileges {
        cmd.arg("--no-privileges");
    }
    let pg_schema = options
        .pg_schema
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(tables) = selected_tables(options)? {
        // テーブル指定 (#1399): スキーマ修飾したパターンで表ごとに `--table`。
        // `--schema` との併用は積集合になり分かりづらいので、修飾で絞る。
        // `pg_schema` が空なら、ツリーで選んだスキーマ (= `database` 引数) で修飾する。
        // タスク経路 (`database` が接続先 DB 名) ではスキーマ扱いしないので、テーブル指定する
        // 場合は `pg_schema` が必要 (無いと非修飾の表名になり search_path 依存)。
        let schema = if database_is_connection_db {
            pg_schema
        } else {
            pg_schema.or(Some(database))
        };
        for table in &tables {
            cmd.arg("--table").arg(pg_table_pattern(schema, table));
        }
    } else if let Some(schema) = pg_schema {
        cmd.arg("--schema").arg(schema);
    }
    // 通常接続 (db/postgres.rs の apply_tls) と同じ TLS 設定を pg_dump にも渡す。
    // 渡さないと pg_dump の既定 (prefer) で検証なしに格下げされる。
    for (key, value) in pg_tls_env(connect_options) {
        cmd.env(key, value);
    }
    // Keep the password out of the environment except for the pass-file pointer.
    cmd.env("PGPASSFILE", pgpass.path());
    cmd.env_remove("PGPASSWORD");

    // Hold the pass file until the child finishes authenticating.
    let result = stream_external_dump(app, stream_id, cmd, "pg_dump", file, counter, started).await;
    drop(pgpass);
    result
}

/// Generate a `sqlite3 .dump`-style SQL script for the live SQLite connection,
/// writing it to the already-open `file` **table by table** instead of
/// building the whole dump as one in-memory `String` first (#686).
/// PATH-independent: no external `sqlite3` binary is needed. Progress is
/// reported per processed table via `dump-stream:progress`; a cancel aborts
/// the task and the partial file is removed by `run_dump`'s
/// `PartialFileCleanup` (this function does not own that guard itself — see
/// [`create_dump_temp_file`] and the doc comment on `run_dump`).
#[allow(clippy::too_many_arguments)]
async fn dump_sqlite(
    app: &AppHandle,
    stream_id: &str,
    conn: &crate::db::Connection,
    file: tokio::fs::File,
    options: &DumpOptions,
    counter: &Arc<AtomicU64>,
    started: Instant,
) -> Result<u64> {
    // テーブル指定 (#1399)。検証は書き込み開始前に済ませる。
    let selected = selected_tables(options)?;
    // 行データは `execute_stream` の同期コールバックから書くので、同期の BufWriter を
    // 共有する (エクスポートの sink と同じ方式)。表単位ではなく行単位で書き出すため、
    // 巨大な 1 表でも全行を同時にメモリへ載せない (#1530)。
    let writer = Arc::new(std::sync::Mutex::new(std::io::BufWriter::new(
        file.into_std().await,
    )));

    write_chunk(
        &writer,
        counter,
        "PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n",
    )?;

    // Tables: CREATE then row data, in name order. `sqlite_%` internal tables and
    // rows without a stored `sql` (implicit indexes) are skipped.
    let tables = conn
        .execute(
            "SELECT name, sql FROM sqlite_master \
             WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL \
             ORDER BY name",
            None,
        )
        .await?;
    // 仮想テーブル (FTS / R-Tree) のシャドウテーブルは CREATE VIRTUAL TABLE が再生成する
    // ので書き出さない (通常表として DROP / CREATE すると索引が壊れる)。
    let all_tables: Vec<(String, String)> = tables
        .rows
        .iter()
        .filter_map(|r| match (r.first(), r.get(1)) {
            (Some(Value::String(n)), Some(Value::String(s))) => Some((n.clone(), s.clone())),
            _ => None,
        })
        .collect();
    // 3.37+ は `table_list` の type='shadow' が正確。使えない (古い) ときだけサフィックス表。
    let shadow_tables: std::collections::HashSet<String> = match conn
        .execute(
            "SELECT name FROM pragma_table_list WHERE type = 'shadow'",
            None,
        )
        .await
    {
        Ok(r) => r
            .rows
            .iter()
            .filter_map(|row| match row.first() {
                Some(Value::String(n)) => Some(n.clone()),
                _ => None,
            })
            .collect(),
        Err(_) => sqlite_shadow_tables(&all_tables),
    };
    let virtual_tables: std::collections::HashSet<&str> = all_tables
        .iter()
        .filter(|(_, sql)| {
            sql.trim_start()
                .to_ascii_lowercase()
                .starts_with("create virtual")
        })
        .map(|(n, _)| n.as_str())
        .collect();
    let table_rows: Vec<&Vec<Value>> = tables
        .rows
        .iter()
        .filter(|row| !matches!(row.first(), Some(Value::String(n)) if shadow_tables.contains(n)))
        .filter(|row| match (&selected, row.first()) {
            (Some(sel), Some(Value::String(n))) => sel.contains(n),
            (Some(_), _) => false,
            (None, _) => true,
        })
        .collect();
    if let Some(sel) = &selected {
        let existing = tables.rows.iter().filter_map(|r| match r.first() {
            Some(Value::String(n)) => Some(n.as_str()),
            _ => None,
        });
        ensure_tables_exist(sel, existing)?;
    }
    let total_tables = table_rows.len() as u64;
    let mut processed = 0u64;
    for row in table_rows {
        let (name, create_sql) = match (row.first(), row.get(1)) {
            (Some(Value::String(n)), Some(Value::String(s))) => (n.clone(), s.clone()),
            _ => {
                processed += 1;
                continue;
            }
        };
        // Build only this one table's SQL, then flush it — the whole dump is
        // never materialized in memory at once.
        let mut chunk = String::new();
        // Only emit DROP TABLE when the schema (CREATE) is also emitted: a
        // data-only dump (`no_create_info`) that dropped the table would leave
        // the following INSERTs targeting a non-existent table on restore (#686).
        if options.add_drop_table && !options.no_create_info {
            chunk.push_str(&format!(
                "DROP TABLE IF EXISTS {};\n",
                sqlite_quote_ident(&name)
            ));
        }
        if !options.no_create_info {
            chunk.push_str(&create_sql);
            chunk.push_str(";\n");
        }
        // 表の DDL までを先に書き出し、行データは下でストリーミングする。
        write_chunk(&writer, counter, &chunk)?;
        if !options.no_data {
            let quoted = sqlite_quote_ident(&name);
            // 仮想テーブルは rowid を明示して出す。外部コンテンツ FTS などで復元時に rowid が
            // 振り直されると、元の表との対応が壊れるため。なお content='' のコンテンツレス
            // FTS は本文を保持しないので、行を INSERT しても復元できない (既知の制約)。
            let is_virtual = virtual_tables.contains(name.as_str());
            let select_sql = if is_virtual {
                format!("SELECT rowid AS rowid, * FROM {quoted}")
            } else {
                format!("SELECT * FROM {quoted}")
            };
            let mut insert_prefix = String::new();
            let writer_cb = writer.clone();
            let counter_cb = counter.clone();
            let app_cb = app.clone();
            let stream_id_cb = stream_id.to_string();
            let mut last_progress_bytes = counter.load(Ordering::SeqCst);
            let mut last_progress_at = Instant::now();
            let tables_done = processed;
            conn.execute_stream(
                &select_sql,
                None,
                DUMP_STREAM_BATCH,
                DUMP_STREAM_BATCH,
                move |batch| {
                    match batch {
                        StreamBatch::Columns(columns) => {
                            let cols: Vec<String> = columns
                                .iter()
                                .map(|c| sqlite_quote_ident(&c.name))
                                .collect();
                            insert_prefix =
                                format!("INSERT INTO {quoted} ({}) VALUES (", cols.join(", "));
                        }
                        StreamBatch::Rows(rows) => {
                            let mut buf = String::new();
                            for r in &rows {
                                let vals: Vec<String> = r.iter().map(sqlite_literal).collect();
                                buf.push_str(&insert_prefix);
                                buf.push_str(&vals.join(", "));
                                buf.push_str(");\n");
                            }
                            write_chunk_off_worker(&writer_cb, &counter_cb, &buf)?;
                            // 1 表が長くても止まって見えないよう、一定バイトごと (または
                            // 一定時間ごと) に進捗を出す。
                            let bytes = counter_cb.load(Ordering::SeqCst);
                            if bytes.saturating_sub(last_progress_bytes) >= DUMP_PROGRESS_BYTES
                                || last_progress_at.elapsed() >= DUMP_PROGRESS_INTERVAL
                            {
                                last_progress_bytes = bytes;
                                last_progress_at = Instant::now();
                                emit_table_progress(
                                    &app_cb,
                                    &stream_id_cb,
                                    bytes,
                                    tables_done,
                                    total_tables,
                                    started,
                                );
                            }
                        }
                    }
                    Ok(())
                },
            )
            .await?;
        }
        processed += 1;
        emit_table_progress(
            app,
            stream_id,
            counter.load(Ordering::SeqCst),
            processed,
            total_tables,
            started,
        );
    }

    // Indexes / triggers / views come after the data (they may reference table
    // rows). Skipped entirely for a data-only dump.
    if !options.no_create_info {
        let objs = conn
            .execute(
                "SELECT sql, type, tbl_name, name FROM sqlite_master \
                 WHERE type IN ('index','trigger','view') AND name NOT LIKE 'sqlite_%' \
                 AND sql IS NOT NULL \
                 ORDER BY CASE type WHEN 'index' THEN 0 WHEN 'view' THEN 1 ELSE 2 END, name",
                None,
            )
            .await?;
        let mut chunk = String::new();
        for row in &objs.rows {
            // シャドウテーブルに紐づく索引は仮想テーブルが再生成するので出さない。
            if matches!(row.get(2), Some(Value::String(tbl)) if shadow_tables.contains(tbl)) {
                continue;
            }
            if let Some(sel) = &selected {
                // テーブル指定時は、指定テーブルに紐づく索引 / トリガーだけを書き出す
                // (ビューは別オブジェクトなので含めない)。
                let owned = matches!(
                    (row.get(1), row.get(2)),
                    (Some(Value::String(ty)), Some(Value::String(tbl)))
                        if ty != "view" && sel.contains(tbl)
                );
                if !owned {
                    continue;
                }
            }
            if let Some(Value::String(sql)) = row.first() {
                // ビューは表と違い表の DROP で消えないので、既存 DB への復元で
                // "already exists" にならないよう個別に DROP する。索引・トリガーは
                // 親の表の DROP と一緒に消える。
                if options.add_drop_table {
                    if let (Some(Value::String(ty)), Some(Value::String(name))) =
                        (row.get(1), row.get(3))
                    {
                        if ty == "view" {
                            chunk.push_str(&format!(
                                "DROP VIEW IF EXISTS {};\n",
                                sqlite_quote_ident(name)
                            ));
                        }
                    }
                }
                chunk.push_str(sql);
                chunk.push_str(";\n");
            }
        }
        write_chunk(&writer, counter, &chunk)?;
    }

    write_chunk(&writer, counter, "COMMIT;\n")?;
    {
        use std::io::Write;
        let mut w = writer
            .lock()
            .map_err(|_| AppError::Other("dump writer lock poisoned".into()))?;
        w.flush()?;
    }
    let bytes = counter.load(Ordering::SeqCst);
    Ok(bytes)
}

/// SQLite ダンプの行ストリームを 1 回に受け取る行数。
const DUMP_STREAM_BATCH: usize = 500;
/// 1 表の行データ書き出し中に進捗を出す間隔 (バイト)。
const DUMP_PROGRESS_BYTES: u64 = 1024 * 1024;
/// 同じく時間基準の上限 (遅い表でもこの間隔で進捗が動く)。
const DUMP_PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);

/// Write `s` to the dump file and add its byte length to the shared counter.
fn write_chunk(
    writer: &Arc<std::sync::Mutex<std::io::BufWriter<std::fs::File>>>,
    counter: &Arc<AtomicU64>,
    s: &str,
) -> Result<()> {
    use std::io::Write;
    let mut w = writer
        .lock()
        .map_err(|_| AppError::Other("dump writer lock poisoned".into()))?;
    w.write_all(s.as_bytes())?;
    counter.fetch_add(s.len() as u64, Ordering::SeqCst);
    Ok(())
}

/// 行バッチの書き出し (数十 KiB〜の同期ディスク I/O) 用。マルチスレッドランタイム上では
/// `block_in_place` でワーカーを他タスクへ明け渡してから書き、同じワーカー上の他の IPC 応答が
/// 遅れないようにする。`block_in_place` は current_thread ランタイム (単体テストなど) では
/// panic するので、その場合は従来どおりそのまま書く。
fn write_chunk_off_worker(
    writer: &Arc<std::sync::Mutex<std::io::BufWriter<std::fs::File>>>,
    counter: &Arc<AtomicU64>,
    s: &str,
) -> Result<()> {
    let multi_thread = tokio::runtime::Handle::try_current()
        .is_ok_and(|h| h.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread);
    if multi_thread {
        tokio::task::block_in_place(|| write_chunk(writer, counter, s))
    } else {
        write_chunk(writer, counter, s)
    }
}

/// Emit a progress event carrying both bytes and processed/total table counts
/// (SQLite path).
fn emit_table_progress(
    app: &AppHandle,
    stream_id: &str,
    bytes: u64,
    tables: u64,
    tables_total: u64,
    started: Instant,
) {
    let _ = app.emit(
        EV_DUMP_PROGRESS,
        DumpProgressEvent {
            stream_id: stream_id.to_string(),
            bytes,
            elapsed_ms: started.elapsed().as_millis() as u64,
            tables: Some(tables),
            tables_total: Some(tables_total),
        },
    );
}

/// Quote a SQLite identifier with double quotes, doubling any embedded quote.
fn sqlite_quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Render a decoded [`Value`] as a SQLite SQL literal for a dump's `INSERT`.
fn sqlite_literal(value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        Value::Bool(b) => if *b { "1" } else { "0" }.to_string(),
        Value::Int(i) => i.to_string(),
        Value::UInt(u) => u.to_string(),
        Value::Float(f) => {
            // SQLite can't store non-finite floats; fall back to NULL.
            if f.is_finite() {
                f.to_string()
            } else {
                "NULL".to_string()
            }
        }
        Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        // BLOBs arrive hex-encoded (optionally `0x`-prefixed); emit X'...'.
        Value::Bytes(hex) => {
            let h = hex
                .strip_prefix("0x")
                .or_else(|| hex.strip_prefix("0X"))
                .unwrap_or(hex);
            format!("X'{h}'")
        }
    }
}

/// The filename prefix shared by every temp credential file `DefaultsFile` /
/// `PgPassFile` create (see below), used to scope
/// [`cleanup_stale_dump_credential_files`] to files this module owns.
const DUMP_CREDENTIAL_FILE_PREFIX: &str = "noobdb-dump-";

/// 起動時に呼ばれるベストエフォートの掃除。`DefaultsFile` / `PgPassFile`
/// (下記) は、ダンプ実行中だけ生きる一時的な資格情報ファイル
/// (`noobdb-dump-<slug>.cnf` / `.pgpass`、OS 標準の一時ディレクトリ直下。DB
/// パスワードを平文で含む) を作り、通常は `Drop` で確実に削除する。しかし
/// アプリが SIGKILL / OOM / クラッシュなど `Drop` を経由しない形で終了すると
/// この削除は走らず、平文パスワードを含むファイルがそのままディスクに残り
/// 続けてしまう (`commands::local::cleanup_stale_local_files` が「ローカル
/// 横断クエリの一時 DB」に対して既に解決している問題と同種)。
///
/// 前回起動のダンプ処理はプロセスごと終了しているのでどのセッションからも
/// 参照されておらず、次回起動時点でこの命名規約に一致するファイルを削除して
/// 安全 — 失敗してもログに残すだけで起動は継続するベストエフォートである点も
/// `cleanup_stale_local_files` と同じ。
///
/// OS 標準の一時ディレクトリは他プロセスとも共有される場所なので、
/// ディレクトリごと削除する local セッションの掃除とは違い、
/// **自分たちの命名規約 (`noobdb-dump-` プレフィックス + `.cnf`/`.pgpass`
/// 拡張子) に厳密一致するファイルだけ**を 1 件ずつ判定して削除する — 他人の
/// ファイルを巻き込まないための最小限のスコープ。
pub fn cleanup_stale_dump_credential_files() {
    let dir = std::env::temp_dir();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!(
                path = %dir.display(),
                error = %e,
                "failed to scan temp dir for stale dump credential files"
            );
            return;
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(DUMP_CREDENTIAL_FILE_PREFIX) {
            continue;
        }
        if !(name.ends_with(".cnf") || name.ends_with(".pgpass")) {
            continue;
        }
        // 別インスタンスが実行中のダンプの資格情報ファイル (`noobdb-dump-<pid>-*`) は消さない。
        let pid = name
            .strip_prefix(DUMP_CREDENTIAL_FILE_PREFIX)
            .and_then(|rest| rest.split_once('-'))
            .and_then(|(pid, _)| pid.parse::<u32>().ok());
        let modified = entry.metadata().ok().and_then(|m| m.modified().ok());
        if crate::commands::local::is_owner_alive(pid, modified) {
            continue;
        }
        let path = entry.path();
        if let Err(e) = std::fs::remove_file(&path) {
            tracing::warn!(
                path = %path.display(),
                error = %e,
                "failed to clean up a stale dump credential file"
            );
        }
    }
}

/// 空白だけの値を未指定として扱う (`db` 層の `non_empty` と同じ規則)。
fn non_blank(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// 通常接続と同じ規則で TLS モードを決める (AWS IAM は `require` 以上に引き上げ)。
fn effective_ssl_mode(opts: &DbConnectOptions) -> Option<crate::db::SslMode> {
    match opts.aws_iam {
        Some(_) => Some(crate::db::aws_iam::enforce_tls(opts.ssl_mode)),
        None => opts.ssl_mode,
    }
}

/// mysqldump の `[client]` オプションファイルに書く TLS 行。
///
/// `prefer` (= クライアントの既定) のときは何も書かない。MariaDB 版の mysqldump は
/// `ssl-mode` を知らず、未知のオプションで即終了するため、既定のプロファイルで
/// 壊さないようにする。それ以外は `loose-` 接頭辞を付け、未知なら無視させる
/// (MariaDB 向けには `ssl` / `ssl-verify-server-cert` も併記)。
fn mysql_tls_lines(opts: &DbConnectOptions) -> Vec<String> {
    use crate::db::SslMode;
    let mut lines = Vec::new();
    if let Some(mode) = effective_ssl_mode(opts) {
        let v = match mode {
            SslMode::Prefer => None,
            SslMode::Disable => Some("DISABLED"),
            SslMode::Require => Some("REQUIRED"),
            SslMode::VerifyCa => Some("VERIFY_CA"),
            SslMode::VerifyFull => Some("VERIFY_IDENTITY"),
        };
        if let Some(v) = v {
            lines.push(format!("loose-ssl-mode={v}"));
        }
        if matches!(
            mode,
            SslMode::Require | SslMode::VerifyCa | SslMode::VerifyFull
        ) {
            lines.push("loose-ssl".to_string());
        }
        if matches!(mode, SslMode::VerifyCa | SslMode::VerifyFull) {
            lines.push("loose-ssl-verify-server-cert".to_string());
        }
    }
    for (key, val) in [
        ("ssl-ca", &opts.ssl_root_cert),
        ("ssl-cert", &opts.ssl_client_cert),
        ("ssl-key", &opts.ssl_client_key),
    ] {
        if let Some(path) = non_blank(val) {
            lines.push(format!("{key}={}", my_cnf_quote(path)));
        }
    }
    lines
}

/// pg_dump に渡す TLS 用の環境変数 (`PGSSLMODE` / `PGSSLROOTCERT` / `PGSSLCERT` /
/// `PGSSLKEY`)。パスは非秘密 (秘密はパスワードのみで PGPASSFILE 経由)。
fn pg_tls_env(opts: &DbConnectOptions) -> Vec<(&'static str, String)> {
    use crate::db::SslMode;
    let mut env = Vec::new();
    if let Some(mode) = effective_ssl_mode(opts) {
        let v = match mode {
            SslMode::Disable => "disable",
            SslMode::Prefer => "prefer",
            SslMode::Require => "require",
            SslMode::VerifyCa => "verify-ca",
            SslMode::VerifyFull => "verify-full",
        };
        env.push(("PGSSLMODE", v.to_string()));
    }
    for (key, val) in [
        ("PGSSLROOTCERT", &opts.ssl_root_cert),
        ("PGSSLCERT", &opts.ssl_client_cert),
        ("PGSSLKEY", &opts.ssl_client_key),
    ] {
        if let Some(path) = non_blank(val) {
            env.push((key, path.to_string()));
        }
    }
    env
}

/// SQLite の仮想テーブル (FTS / R-Tree) が自動生成するシャドウテーブル名の集合。
/// `(name, sql)` の全テーブル一覧から、`CREATE VIRTUAL TABLE ... USING <module>` の
/// モジュールごとの既知サフィックスで導く (SQLite 3.37+ なら呼び出し側が
/// `PRAGMA table_list` の `shadow` を優先し、これは古い SQLite 向けのフォールバック)。シャドウは仮想テーブルの CREATE で再生成
/// されるので、通常の表として DROP / CREATE / INSERT してはいけない。
fn sqlite_shadow_tables(tables: &[(String, String)]) -> std::collections::HashSet<String> {
    let mut shadows = std::collections::HashSet::new();
    for (name, sql) in tables {
        let lower = sql.to_ascii_lowercase();
        let mut words = lower.split_whitespace();
        if words.next() != Some("create") || words.next() != Some("virtual") {
            continue;
        }
        // 空白・改行・タブ区切りの `USING <module>` からモジュール名を取る。
        let Some(token) = lower
            .split_whitespace()
            .skip_while(|w| *w != "using")
            .nth(1)
        else {
            continue;
        };
        let module: String = token
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        let suffixes: &[&str] = match module.as_str() {
            "fts3" | "fts4" => &["content", "segments", "segdir", "docsize", "stat"],
            "fts5" => &["data", "idx", "content", "docsize", "config"],
            "rtree" | "rtree_i32" | "geopoly" => &["node", "rowid", "parent"],
            _ => &[],
        };
        for suffix in suffixes {
            shadows.insert(format!("{name}_{suffix}"));
        }
    }
    // 仮想テーブル自身 (CREATE VIRTUAL TABLE) は shadow ではないので、同名が紛れても除く。
    for (name, sql) in tables {
        if sql
            .trim_start()
            .to_ascii_lowercase()
            .starts_with("create virtual")
        {
            shadows.remove(name);
        }
    }
    shadows
}

/// A temporary MySQL option file holding connection credentials. Removed from
/// disk when dropped.
struct DefaultsFile {
    path: PathBuf,
}

impl DefaultsFile {
    fn create(opts: &DbConnectOptions) -> Result<Self> {
        use std::io::Write;

        // Unique temp file name. An 8-char slug from a 31-char alphabet is more
        // than enough uniqueness for a short-lived per-dump option file. The
        // `DUMP_CREDENTIAL_FILE_PREFIX`/`.cnf` naming is also what
        // `cleanup_stale_dump_credential_files` matches on at startup.
        let name = format!(
            "{DUMP_CREDENTIAL_FILE_PREFIX}{}-{}.cnf",
            std::process::id(),
            crate::state::random_slug(8)
        );
        let path = std::env::temp_dir().join(name);

        let mut content = String::from("[client]\n");
        content.push_str(&format!("host={}\n", opts.host));
        content.push_str(&format!("port={}\n", opts.port));
        content.push_str(&format!("user={}\n", my_cnf_quote(&opts.user)));
        content.push_str(&format!("password={}\n", my_cnf_quote(&opts.password)));
        // sqlx connects over TCP; force the client to do the same so a
        // "localhost" host doesn't silently switch to a unix socket.
        content.push_str("protocol=TCP\n");
        if opts.aws_iam.is_some() {
            // AWS IAM auth (#734): the RDS auth token is sent with the
            // mysql_clear_password plugin, which is only safe (and only
            // accepted by RDS) over TLS.
            content.push_str("enable-cleartext-plugin\n");
        }
        // 通常接続 (db/mysql.rs の apply_tls) と同じ TLS 設定を mysqldump にも渡す。
        for line in mysql_tls_lines(opts) {
            content.push_str(&line);
            content.push('\n');
        }

        #[cfg(unix)]
        let mut file = {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&path)?
        };
        #[cfg(not(unix))]
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;

        // Register the guard before writing so a failed write still cleans up.
        let guard = DefaultsFile { path };
        file.write_all(content.as_bytes())?;
        Ok(guard)
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for DefaultsFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// A temporary PostgreSQL `.pgpass`-format file holding one line:
/// `host:port:database:user:password`. Created with mode 0600 on unix and removed
/// when dropped, so the password never reaches the process arguments, the
/// environment, or logs (only `PGPASSFILE` pointing at the path is exported).
struct PgPassFile {
    path: PathBuf,
}

impl PgPassFile {
    fn create(opts: &DbConnectOptions, dbname: Option<&str>) -> Result<Self> {
        use std::io::Write;

        // `DUMP_CREDENTIAL_FILE_PREFIX`/`.pgpass` naming is also what
        // `cleanup_stale_dump_credential_files` matches on at startup.
        let name = format!(
            "{DUMP_CREDENTIAL_FILE_PREFIX}{}-{}.pgpass",
            std::process::id(),
            crate::state::random_slug(8)
        );
        let path = std::env::temp_dir().join(name);
        // `.pgpass` is colon-delimited; backslash-escape any literal ':' or '\'
        // in field values so they aren't misread as separators.
        let line = format!(
            "{}:{}:{}:{}:{}\n",
            pgpass_escape(&opts.host),
            opts.port,
            // DB 未指定のときは任意の DB に一致するワイルドカード。
            dbname.map_or_else(|| "*".to_string(), pgpass_escape),
            pgpass_escape(&opts.user),
            pgpass_escape(&opts.password),
        );

        #[cfg(unix)]
        let mut file = {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&path)?
        };
        #[cfg(not(unix))]
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;

        let guard = PgPassFile { path };
        file.write_all(line.as_bytes())?;
        Ok(guard)
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for PgPassFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Escape `:` and `\` for a `.pgpass` field (the only two metacharacters).
fn pgpass_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace(':', "\\:")
}

/// Quote a value for a MySQL option file. The option-file parser strips
/// surrounding whitespace and treats `#` as a comment, so values are wrapped in
/// double quotes with the recognized escape sequences applied.
fn my_cnf_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `cleanup_stale_dump_credential_files` scans the *whole* OS temp
    /// directory indiscriminately, so it could race with (and steal a file
    /// out from under) `defaults_file_is_removed_on_drop` /
    /// `pgpass_file_is_removed_on_drop`, which run concurrently by default
    /// under `cargo test`. This lock serializes every test that touches
    /// `noobdb-dump-*` credential files in the shared temp dir so none of
    /// them observe another's file appearing/disappearing mid-assertion.
    static CRED_FILE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn dump_temp_path_is_a_sibling_in_the_same_dir() {
        let tmp = dump_temp_path("/backups/db_2026.sql");
        // Same directory (so the later rename stays on one filesystem)...
        assert_eq!(tmp.parent(), Some(Path::new("/backups")));
        // ...a hidden, distinct name (never the final path itself).
        let name = tmp.file_name().unwrap().to_string_lossy();
        assert!(name.starts_with(".db_2026.sql.dumping."));
        assert_ne!(tmp, Path::new("/backups/db_2026.sql"));
        // Two calls never collide (per-process counter).
        assert_ne!(dump_temp_path("/backups/db_2026.sql"), tmp);
    }

    #[test]
    fn sqlite_literal_renders_each_value_kind() {
        assert_eq!(sqlite_literal(&Value::Null), "NULL");
        assert_eq!(sqlite_literal(&Value::Bool(true)), "1");
        assert_eq!(sqlite_literal(&Value::Bool(false)), "0");
        assert_eq!(sqlite_literal(&Value::Int(-7)), "-7");
        assert_eq!(sqlite_literal(&Value::UInt(42)), "42");
        assert_eq!(sqlite_literal(&Value::String("a'b".into())), "'a''b'");
        assert_eq!(sqlite_literal(&Value::Bytes("0xDEAD".into())), "X'DEAD'");
        assert_eq!(sqlite_literal(&Value::Bytes("beef".into())), "X'beef'");
        assert_eq!(sqlite_literal(&Value::Float(f64::INFINITY)), "NULL");
    }

    #[test]
    fn selected_tables_validates_and_dedups() {
        let mut o = DumpOptions::default();
        assert_eq!(selected_tables(&o).unwrap(), None);
        o.tables = Some(vec![]);
        assert!(matches!(
            selected_tables(&o),
            Err(AppError::InvalidInput(_))
        ));
        o.tables = Some(vec!["a".into(), "  ".into()]);
        assert!(matches!(
            selected_tables(&o),
            Err(AppError::InvalidInput(_))
        ));
        o.tables = Some(vec!["b".into(), "a".into(), "b".into()]);
        assert_eq!(
            selected_tables(&o).unwrap(),
            Some(vec!["b".to_string(), "a".to_string()])
        );
    }

    #[test]
    fn ensure_tables_exist_rejects_unknown_names() {
        let sel = vec!["a".to_string(), "b".to_string()];
        assert!(ensure_tables_exist(&sel, ["a", "b", "c"].into_iter()).is_ok());
        match ensure_tables_exist(&sel, ["a", "c"].into_iter()) {
            Err(AppError::InvalidInput(m)) => assert!(m.ends_with(": b"), "{m}"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn pg_connect_database_uses_profile_db_not_schema() {
        let mut o = DbConnectOptions {
            host: "h".into(),
            port: 5432,
            user: "u".into(),
            password: "p".into(),
            database: Some(" app ".into()),
            driver: DriverKind::Postgres,
            file_path: None,
            ssl_mode: None,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
            init_sql: None,
            aws_iam: None,
        };
        assert_eq!(pg_connect_database(&o), Some("app"));
        o.database = Some("  ".into());
        assert_eq!(pg_connect_database(&o), None);
        o.database = None;
        assert_eq!(pg_connect_database(&o), None);
    }

    #[test]
    fn pg_dbname_task_path_uses_input_tree_path_uses_profile() {
        let mut o = DbConnectOptions {
            host: "h".into(),
            port: 5432,
            user: "u".into(),
            password: "p".into(),
            database: Some("profiledb".into()),
            driver: DriverKind::Postgres,
            file_path: None,
            ssl_mode: None,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
            init_sql: None,
            aws_iam: None,
        };
        // タスク経路: 入力された DB 名が --dbname になる。
        assert_eq!(pg_dbname(&o, "realdb", true), Some("realdb"));
        // ツリー経路: database はスキーマ名なので、プロファイルの DB を使う。
        assert_eq!(pg_dbname(&o, "public", false), Some("profiledb"));
        o.database = None;
        assert_eq!(pg_dbname(&o, "public", false), None);
        assert_eq!(pg_dbname(&o, "realdb", true), Some("realdb"));
    }

    #[test]
    fn pg_table_pattern_quotes_and_qualifies() {
        assert_eq!(pg_table_pattern(None, "Users"), "\"Users\"");
        assert_eq!(
            pg_table_pattern(Some("public"), "a*b"),
            "\"public\".\"a*b\""
        );
        assert_eq!(pg_table_pattern(Some(""), "t"), "\"t\"");
        assert_eq!(
            pg_table_pattern(Some("s\"x"), "t\"y"),
            "\"s\"\"x\".\"t\"\"y\""
        );
    }

    #[test]
    fn dump_options_tables_defaults_to_none_when_omitted() {
        let o: DumpOptions = serde_json::from_str(
            r#"{"singleTransaction":true,"routines":false,"events":false,"triggers":true,
                "addDropTable":true,"extendedInsert":true,"completeInsert":false,
                "noData":false,"noCreateInfo":false}"#,
        )
        .unwrap();
        assert!(o.tables.is_none());
        let o: DumpOptions = serde_json::from_str(
            r#"{"singleTransaction":true,"routines":false,"events":false,"triggers":true,
                "addDropTable":true,"extendedInsert":true,"completeInsert":false,
                "noData":false,"noCreateInfo":false,"tables":["a","b"]}"#,
        )
        .unwrap();
        assert_eq!(o.tables, Some(vec!["a".to_string(), "b".to_string()]));
    }

    #[test]
    fn dump_options_new_flags_default_off() {
        let o: DumpOptions = serde_json::from_str(
            r#"{"singleTransaction":true,"routines":false,"events":false,"triggers":true,"addDropTable":true,"extendedInsert":true,"completeInsert":false,"noData":false,"noCreateInfo":false}"#,
        )
        .unwrap();
        assert!(
            !o.no_tablespaces && !o.set_gtid_purged_off && !o.write_checksum && !o.sqlite_snapshot
        );
        let o: DumpOptions = serde_json::from_str(
            r#"{"singleTransaction":true,"routines":false,"events":false,"triggers":true,"addDropTable":true,"extendedInsert":true,"completeInsert":false,"noData":false,"noCreateInfo":false,"noTablespaces":true,"setGtidPurgedOff":true,"writeChecksum":true,"sqliteSnapshot":true}"#,
        )
        .unwrap();
        assert!(o.no_tablespaces && o.set_gtid_purged_off && o.write_checksum && o.sqlite_snapshot);
    }

    #[test]
    fn checksum_sidecar_path_appends_sha256() {
        assert_eq!(
            checksum_sidecar_path("/tmp/a/dump.sql.gz"),
            PathBuf::from("/tmp/a/dump.sql.gz.sha256")
        );
    }

    #[tokio::test]
    async fn sha256_sidecar_matches_sha256sum_format() {
        let dir = std::env::temp_dir().join(format!("noobdb-sha-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("d.sql");
        std::fs::write(&f, b"abc").unwrap();
        let digest = sha256_hex_of_file(f.clone()).await.unwrap();
        assert_eq!(
            digest,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        write_checksum_sidecar(f.to_str().unwrap(), &digest)
            .await
            .unwrap();
        let body = std::fs::read_to_string(dir.join("d.sql.sha256")).unwrap();
        assert_eq!(body, format!("{digest}  d.sql\n"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sqlite_quote_ident_doubles_quotes() {
        assert_eq!(sqlite_quote_ident("users"), "\"users\"");
        assert_eq!(sqlite_quote_ident("a\"b"), "\"a\"\"b\"");
    }

    #[test]
    fn pgpass_escape_protects_separators() {
        assert_eq!(pgpass_escape("plain"), "plain");
        assert_eq!(pgpass_escape("a:b"), "a\\:b");
        assert_eq!(pgpass_escape("a\\b"), "a\\\\b");
    }

    #[test]
    fn pgpass_file_is_removed_on_drop() {
        let _guard = CRED_FILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let opts = DbConnectOptions {
            host: "127.0.0.1".into(),
            port: 5432,
            user: "postgres".into(),
            password: "p:w".into(),
            database: Some("testdb".into()),
            driver: DriverKind::Postgres,
            file_path: None,
            ssl_mode: None,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
            init_sql: None,
            aws_iam: None,
        };
        let path = {
            let f = PgPassFile::create(&opts, Some("testdb")).expect("create");
            let p = f.path().to_path_buf();
            assert!(p.exists());
            let body = std::fs::read_to_string(&p).expect("read");
            // Password colon is escaped; fields are colon-delimited.
            assert!(body.contains("127.0.0.1:5432:testdb:postgres:p\\:w"));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&p).unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o600);
            }
            p
        };
        assert!(!path.exists(), "temp pgpass file should be deleted on drop");
    }

    #[test]
    fn quotes_and_escapes_special_chars() {
        assert_eq!(my_cnf_quote("simple"), "\"simple\"");
        assert_eq!(my_cnf_quote("p@ss#word"), "\"p@ss#word\"");
        assert_eq!(my_cnf_quote("a\"b\\c"), "\"a\\\"b\\\\c\"");
        assert_eq!(my_cnf_quote("line\nbreak"), "\"line\\nbreak\"");
    }

    #[tokio::test]
    async fn format_dump_file_reformats_in_place() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("noobdb_dump_fmt_{}.sql", std::process::id()));
        std::fs::write(&path, "select a,b from t where a=1;").unwrap();
        let bytes = format_dump_file(path.to_string_lossy().to_string())
            .await
            .unwrap();
        let out = std::fs::read_to_string(&path).unwrap();
        // 整形により列が 2 スペース字下げで改行されること。返り値は整形後のサイズ。
        assert!(out.contains("\n  a,"), "got: {out}");
        assert_eq!(bytes as usize, out.len());
        let _ = std::fs::remove_file(&path);
    }

    // #1539: gzip 圧縮した結果が元の内容に伸長でき、返り値が圧縮後のファイルサイズと一致する。
    #[tokio::test]
    async fn gzip_dump_file_roundtrips_and_reports_compressed_size() {
        use std::io::Read;
        let dir = std::env::temp_dir();
        let src = dir.join(format!("noobdb_dump_gz_src_{}.sql", std::process::id()));
        let dst = dir.join(format!("noobdb_dump_gz_dst_{}.sql.gz", std::process::id()));
        let body = "INSERT INTO t VALUES (1, 'あ');\n".repeat(2000);
        std::fs::write(&src, &body).unwrap();
        let bytes = gzip_dump_file(src.clone(), std::fs::File::create(&dst).unwrap())
            .await
            .unwrap();
        let gz = std::fs::read(&dst).unwrap();
        assert_eq!(bytes as usize, gz.len());
        assert!(gz.len() < body.len() / 4, "should compress well");
        assert_eq!(&gz[..2], &[0x1f, 0x8b], "gzip magic");
        let mut out = String::new();
        flate2::read::GzDecoder::new(&gz[..])
            .read_to_string(&mut out)
            .unwrap();
        assert_eq!(out, body);
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    fn test_opts() -> DbConnectOptions {
        DbConnectOptions {
            host: "127.0.0.1".into(),
            port: 3306,
            user: "root".into(),
            password: "secret".into(),
            database: None,
            driver: DriverKind::Mysql,
            file_path: None,
            ssl_mode: None,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
            init_sql: None,
            aws_iam: None,
        }
    }

    #[test]
    fn mysql_tls_lines_pass_mode_and_cert_paths() {
        use crate::db::SslMode;
        let mut o = test_opts();
        assert!(mysql_tls_lines(&o).is_empty());
        o.ssl_mode = Some(SslMode::VerifyFull);
        o.ssl_root_cert = Some(" /etc/ca.pem ".into());
        o.ssl_client_cert = Some("   ".into());
        o.ssl_client_key = Some("/k.pem".into());
        assert_eq!(
            mysql_tls_lines(&o),
            vec![
                "loose-ssl-mode=VERIFY_IDENTITY".to_string(),
                "loose-ssl".to_string(),
                "loose-ssl-verify-server-cert".to_string(),
                "ssl-ca=\"/etc/ca.pem\"".to_string(),
                "ssl-key=\"/k.pem\"".to_string(),
            ]
        );
        o.ssl_mode = Some(SslMode::VerifyCa);
        assert_eq!(mysql_tls_lines(&o)[0], "loose-ssl-mode=VERIFY_CA");
        // prefer (既定) は何も書かない (MariaDB の mysqldump は ssl-mode を知らない)。
        o.ssl_mode = Some(SslMode::Prefer);
        o.ssl_root_cert = None;
        o.ssl_client_key = None;
        assert!(mysql_tls_lines(&o).is_empty());
        o.ssl_mode = Some(SslMode::Disable);
        assert_eq!(
            mysql_tls_lines(&o),
            vec!["loose-ssl-mode=DISABLED".to_string()]
        );
    }

    #[test]
    fn pg_tls_env_passes_mode_and_cert_paths() {
        use crate::db::SslMode;
        let mut o = test_opts();
        assert!(pg_tls_env(&o).is_empty());
        o.ssl_mode = Some(SslMode::VerifyFull);
        o.ssl_root_cert = Some("/ca.pem".into());
        o.ssl_client_cert = Some("/c.pem".into());
        o.ssl_client_key = Some("/k.pem".into());
        let env = pg_tls_env(&o);
        assert!(env.contains(&("PGSSLMODE", "verify-full".to_string())));
        assert!(env.contains(&("PGSSLROOTCERT", "/ca.pem".to_string())));
        assert!(env.contains(&("PGSSLCERT", "/c.pem".to_string())));
        assert!(env.contains(&("PGSSLKEY", "/k.pem".to_string())));
    }

    #[test]
    fn sqlite_shadow_tables_detects_fts_and_rtree_only() {
        let t = |n: &str, s: &str| (n.to_string(), s.to_string());
        let tables = vec![
            t("notes", "CREATE VIRTUAL TABLE notes USING fts5(body)"),
            t(
                "notes_data",
                "CREATE TABLE 'notes_data'(id INTEGER PRIMARY KEY, block BLOB)",
            ),
            t("notes_idx", "CREATE TABLE 'notes_idx'(segid, term, pgno)"),
            t("notes_archive", "CREATE TABLE notes_archive(id)"),
            t("geo", "CREATE VIRTUAL TABLE geo\n\tUSING\trtree (id, a, b)"),
            t(
                "geo_node",
                "CREATE TABLE \"geo_node\"(nodeno INTEGER PRIMARY KEY, data)",
            ),
        ];
        let s = sqlite_shadow_tables(&tables);
        assert!(s.contains("notes_data") && s.contains("notes_idx") && s.contains("geo_node"));
        assert!(!s.contains("notes_archive"));
        assert!(!s.contains("notes") && !s.contains("geo"));
    }

    #[test]
    fn format_dump_file_skips_oversized_dump() {
        let path =
            std::env::temp_dir().join(format!("noobdb_dump_fmt_big_{}.sql", std::process::id()));
        std::fs::write(&path, "select a,b from t;").unwrap();
        let flag = AtomicBool::new(false);
        let n = format_dump_file_blocking(&path.to_string_lossy(), 4, &flag).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "select a,b from t;"
        );
        assert_eq!(n, 18);
        let _ = std::fs::remove_file(&path);
    }

    // キャンセル後に整形が走っても、削除済みのパスへ書き戻さない。
    #[test]
    fn format_dump_file_does_not_recreate_deleted_path_when_cancelled() {
        let path =
            std::env::temp_dir().join(format!("noobdb_dump_fmt_cancel_{}.sql", std::process::id()));
        std::fs::write(&path, "select a,b from t;").unwrap();
        let flag = AtomicBool::new(true);
        let r = format_dump_file_blocking(&path.to_string_lossy(), u64::MAX, &flag);
        assert!(r.is_err());
        // 未キャンセルでも、開いた後にパスが消えたら再作成しない (Unix)。
        let _ = std::fs::remove_file(&path);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn format_dump_file_skips_non_utf8_dump() {
        let path =
            std::env::temp_dir().join(format!("noobdb_dump_fmt_bad_{}.sql", std::process::id()));
        let raw: Vec<u8> = b"select 'caf\xe9' from t;".to_vec();
        std::fs::write(&path, &raw).unwrap();
        let bytes = format_dump_file(path.to_string_lossy().to_string())
            .await
            .unwrap();
        // 失敗せず、元のバイト列をそのまま残す。
        assert_eq!(std::fs::read(&path).unwrap(), raw);
        assert_eq!(bytes as usize, raw.len());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn validate_dump_database_rejects_dash_and_empty() {
        // `-` 始まりの DB 名はオプションとして誤解釈されうるため外部プロセス起動前に拒否
        // する (引数インジェクション対策の多層防御の 1 つ目)。
        assert!(matches!(
            validate_dump_database("--all-databases"),
            Err(AppError::InvalidInput(_))
        ));
        assert!(matches!(
            validate_dump_database("   "),
            Err(AppError::InvalidInput(_))
        ));
        // 正常な名前は trim されて通る。
        assert_eq!(validate_dump_database("  mydb  ").unwrap(), "mydb");
    }

    #[test]
    fn defaults_file_is_removed_on_drop() {
        let _guard = CRED_FILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let opts = DbConnectOptions {
            host: "127.0.0.1".into(),
            port: 3306,
            user: "root".into(),
            password: "secret".into(),
            database: None,
            driver: DriverKind::Mysql,
            file_path: None,
            ssl_mode: None,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
            init_sql: None,
            aws_iam: None,
        };
        let path = {
            let f = DefaultsFile::create(&opts).expect("create");
            let p = f.path().to_path_buf();
            assert!(p.exists());
            let body = std::fs::read_to_string(&p).expect("read");
            assert!(body.contains("password=\"secret\""));
            assert!(body.contains("protocol=TCP"));
            p
        };
        assert!(!path.exists(), "temp option file should be deleted on drop");
    }

    // 起動時クリーンアップ: 前回起動がクラッシュして Drop を経由せず
    // 残った `noobdb-dump-*.cnf` / `.pgpass` は削除され、命名規約に一致しない
    // ファイル (無関係な一時ファイル・拡張子違い・プレフィックス違い) は無傷で
    // 残ることを確認する。
    #[test]
    fn cleanup_stale_dump_credential_files_removes_only_matching_names() {
        let _guard = CRED_FILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir();
        let unique = crate::state::random_slug(8);

        // クラッシュで残った想定の資格情報ファイル (実際の DefaultsFile/PgPassFile
        // と同じ命名規約)。中身はダミーで良い — 削除対象かどうかは名前だけで
        // 判定されるため。
        let stale_cnf = dir.join(format!("noobdb-dump-{unique}.cnf"));
        let stale_pgpass = dir.join(format!("noobdb-dump-{unique}.pgpass"));
        std::fs::write(&stale_cnf, "[client]\npassword=\"leftover\"\n").unwrap();
        std::fs::write(&stale_pgpass, "127.0.0.1:5432:db:user:leftover\n").unwrap();

        // 命名規約に一致しないファイル: プレフィックス違い・拡張子違い。これらは
        // 消してはいけない (他人のファイルを巻き込まないためのスコープ限定)。
        let unrelated_prefix = dir.join(format!("not-noobdb-dump-{unique}.cnf"));
        let unrelated_ext = dir.join(format!("noobdb-dump-{unique}.sql"));
        std::fs::write(&unrelated_prefix, "unrelated").unwrap();
        std::fs::write(&unrelated_ext, "unrelated").unwrap();

        cleanup_stale_dump_credential_files();

        assert!(
            !stale_cnf.exists(),
            "stale .cnf credential file should be removed"
        );
        assert!(
            !stale_pgpass.exists(),
            "stale .pgpass credential file should be removed"
        );
        assert!(
            unrelated_prefix.exists(),
            "a file with a different prefix must not be touched"
        );
        assert!(
            unrelated_ext.exists(),
            "a file with a different extension must not be touched"
        );

        let _ = std::fs::remove_file(&unrelated_prefix);
        let _ = std::fs::remove_file(&unrelated_ext);
    }
}
