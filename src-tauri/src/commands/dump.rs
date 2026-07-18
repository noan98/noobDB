use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufWriter};
use tokio::process::Command;

use crate::db::types::Value;
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

#[derive(Debug, Serialize, Clone)]
struct DumpProgressEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    bytes: u64,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: u64,
    /// Processed / total tables for the SQLite path; `null` for external tools
    /// where only bytes are known (#686).
    tables: Option<u64>,
    #[serde(rename = "tablesTotal")]
    tables_total: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
struct DumpDoneEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    bytes: u64,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: u64,
}

#[derive(Debug, Serialize, Clone)]
struct DumpErrorEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    error: String,
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
#[derive(Debug, Clone, Deserialize, Default)]
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
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
    let stream_id_for_task = stream_id.clone();
    let counter_for_task = counter.clone();
    let handle = tokio::spawn(async move {
        let _ = ready_rx.await;
        spawn_dump(
            app,
            session,
            stream_id_for_task,
            database,
            path,
            options,
            counter_for_task,
        )
        .await;
    });
    state
        .register_stream(
            stream_id,
            StreamHandle {
                abort: handle.abort_handle(),
                delivered_rows: counter,
                kind: StreamKind::Dump,
            },
        )
        .await;
    let _ = ready_tx.send(());
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
    database: String,
    path: String,
    options: DumpOptions,
    counter: Arc<AtomicU64>,
) {
    let started = Instant::now();
    let result = run_dump(
        &app, &session, &stream_id, &database, &path, &options, &counter, started,
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
        state.forget_stream(&stream_id).await;
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
async fn run_dump(
    app: &AppHandle,
    session: &Session,
    stream_id: &str,
    database: &str,
    final_path: &str,
    options: &DumpOptions,
    counter: &Arc<AtomicU64>,
    started: Instant,
) -> Result<u64> {
    let tmp = dump_temp_path(final_path);
    let tmp_str = tmp.to_string_lossy().to_string();

    let bytes = match session.connect_options.driver {
        DriverKind::Mysql => {
            dump_mysql(
                app,
                stream_id,
                &session.connect_options,
                database,
                &tmp_str,
                options,
                counter,
                started,
            )
            .await?
        }
        DriverKind::Postgres => {
            dump_postgres(
                app,
                stream_id,
                &session.connect_options,
                database,
                &tmp_str,
                options,
                counter,
                started,
            )
            .await?
        }
        DriverKind::Sqlite => {
            dump_sqlite(
                app,
                stream_id,
                &session.conn,
                &tmp_str,
                options,
                counter,
                started,
            )
            .await?
        }
    };

    // 整形オプションが有効なら、書き出した SQL を整形して保存し直す (#546)。整形も
    // 一時ファイル上で行う。
    let bytes = if options.format_sql && bytes > 0 {
        match format_dump_file(tmp_str.clone()).await {
            Ok(b) => b,
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(e);
            }
        }
    } else {
        bytes
    };

    // Everything succeeded: atomically move the temp file onto the final path,
    // replacing any existing file only now (not mid-write).
    if let Err(e) = tokio::fs::rename(&tmp, final_path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(AppError::Io(e));
    }
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

/// Pipe an external dump tool's stdout to `path` while counting bytes and
/// emitting throttled `dump-stream:progress` events. `kill_on_drop` is set so a
/// `cancel_stream` abort (which drops this future) kills the child; the
/// `PartialFileCleanup` guard removes the half-written file on any non-success
/// path. stdout and stderr are drained concurrently to avoid a pipe deadlock.
async fn stream_external_dump(
    app: &AppHandle,
    stream_id: &str,
    mut cmd: Command,
    tool_name: &str,
    path: &str,
    counter: &Arc<AtomicU64>,
    started: Instant,
) -> Result<u64> {
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::null());
    // Aborting the task must kill the child rather than leave it running (#686).
    cmd.kill_on_drop(true);

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

    // Create the output file only after a successful spawn, guarded for cleanup.
    let mut cleanup = PartialFileCleanup::new(path);
    let file = tokio::fs::File::create(path).await?;
    let mut writer = BufWriter::new(file);

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

    let bytes = counter.load(Ordering::SeqCst);
    cleanup.commit();
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

/// 書き出し済みのダンプファイルを `db::format::format_sql` で整形して書き戻し、
/// 整形後のバイト数を返す。CPU バウンドな整形と同期 I/O は blocking スレッドで行う。
async fn format_dump_file(path: String) -> Result<u64> {
    tokio::task::spawn_blocking(move || -> Result<u64> {
        let raw = std::fs::read_to_string(&path)?;
        let formatted = crate::db::format::format_sql(&raw);
        std::fs::write(&path, formatted.as_bytes())?;
        Ok(std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0))
    })
    .await
    .map_err(|e| AppError::Other(format!("dump format task failed: {e}")))?
}

/// Run `mysqldump` for `database`, streaming SQL to `path`.
#[allow(clippy::too_many_arguments)]
async fn dump_mysql(
    app: &AppHandle,
    stream_id: &str,
    connect_options: &DbConnectOptions,
    database: &str,
    path: &str,
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

    let mut cmd = Command::new("mysqldump");
    // `--defaults-extra-file` must be the first option on the command line.
    cmd.arg(format!(
        "--defaults-extra-file={}",
        defaults.path().display()
    ));
    if options.single_transaction {
        cmd.arg("--single-transaction");
    }
    if options.routines {
        cmd.arg("--routines");
    }
    if options.events {
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
    // `--` でオプション終端を明示し、以降の引数 (DB 名) をオプションとして解釈させない。
    // `--all-databases` や `--result-file=...` のような値を DB 名として渡された場合の
    // 引数インジェクションを防ぐ (上の `starts_with('-')` チェックと合わせた多層防御)。
    cmd.arg("--");
    cmd.arg(database);

    // Hold the option file until the child finishes reading it — the streamer
    // spawns the child, so keeping `defaults` alive across the await is required.
    let result =
        stream_external_dump(app, stream_id, cmd, "mysqldump", path, counter, started).await;
    drop(defaults);
    result
}

/// Run `pg_dump` for `database`, writing SQL to `path`. The password is
/// passed via a temp `PGPASSFILE` (mode 0600 on unix) and `--no-password`, so it
/// never appears in process arguments, the environment, or logs.
#[allow(clippy::too_many_arguments)]
async fn dump_postgres(
    app: &AppHandle,
    stream_id: &str,
    connect_options: &DbConnectOptions,
    database: &str,
    path: &str,
    options: &DumpOptions,
    counter: &Arc<AtomicU64>,
    started: Instant,
) -> Result<u64> {
    let database = validate_dump_database(database)?;

    let pgpass = PgPassFile::create(connect_options, database)?;

    let mut cmd = Command::new("pg_dump");
    cmd.arg("--host").arg(&connect_options.host);
    cmd.arg("--port").arg(connect_options.port.to_string());
    cmd.arg("--username").arg(&connect_options.user);
    cmd.arg("--dbname").arg(database);
    // Never prompt for a password interactively; rely on PGPASSFILE instead.
    cmd.arg("--no-password");
    if options.no_data {
        cmd.arg("--schema-only");
    }
    if options.no_create_info {
        cmd.arg("--data-only");
    }
    if options.add_drop_table {
        cmd.arg("--clean");
    }
    if options.no_owner {
        cmd.arg("--no-owner");
    }
    if options.no_privileges {
        cmd.arg("--no-privileges");
    }
    if let Some(schema) = options.pg_schema.as_deref() {
        let schema = schema.trim();
        if !schema.is_empty() {
            cmd.arg("--schema").arg(schema);
        }
    }
    // Keep the password out of the environment except for the pass-file pointer.
    cmd.env("PGPASSFILE", pgpass.path());
    cmd.env_remove("PGPASSWORD");

    // Hold the pass file until the child finishes authenticating.
    let result = stream_external_dump(app, stream_id, cmd, "pg_dump", path, counter, started).await;
    drop(pgpass);
    result
}

/// Generate a `sqlite3 .dump`-style SQL script for the live SQLite connection,
/// writing it to `path` **table by table** instead of building the whole dump as
/// one in-memory `String` first (#686). PATH-independent: no external `sqlite3`
/// binary is needed. Progress is reported per processed table via
/// `dump-stream:progress`; a cancel aborts the task and the partial file is
/// removed by `PartialFileCleanup`.
#[allow(clippy::too_many_arguments)]
async fn dump_sqlite(
    app: &AppHandle,
    stream_id: &str,
    conn: &crate::db::Connection,
    path: &str,
    options: &DumpOptions,
    counter: &Arc<AtomicU64>,
    started: Instant,
) -> Result<u64> {
    let mut cleanup = PartialFileCleanup::new(path);
    let file = tokio::fs::File::create(path).await?;
    let mut writer = BufWriter::new(file);

    write_chunk(
        &mut writer,
        counter,
        "PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n",
    )
    .await?;

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
    let total_tables = tables.rows.len() as u64;
    let mut processed = 0u64;
    for row in &tables.rows {
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
        if !options.no_data {
            let data = conn
                .execute(
                    &format!("SELECT * FROM {}", sqlite_quote_ident(&name)),
                    None,
                )
                .await?;
            let cols: Vec<String> = data
                .columns
                .iter()
                .map(|c| sqlite_quote_ident(&c.name))
                .collect();
            for r in &data.rows {
                let vals: Vec<String> = r.iter().map(sqlite_literal).collect();
                chunk.push_str(&format!(
                    "INSERT INTO {} ({}) VALUES ({});\n",
                    sqlite_quote_ident(&name),
                    cols.join(", "),
                    vals.join(", ")
                ));
            }
        }
        write_chunk(&mut writer, counter, &chunk).await?;
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
                "SELECT sql FROM sqlite_master \
                 WHERE type IN ('index','trigger','view') AND name NOT LIKE 'sqlite_%' \
                 AND sql IS NOT NULL ORDER BY type, name",
                None,
            )
            .await?;
        let mut chunk = String::new();
        for row in &objs.rows {
            if let Some(Value::String(sql)) = row.first() {
                chunk.push_str(sql);
                chunk.push_str(";\n");
            }
        }
        write_chunk(&mut writer, counter, &chunk).await?;
    }

    write_chunk(&mut writer, counter, "COMMIT;\n").await?;
    writer.flush().await?;
    let bytes = counter.load(Ordering::SeqCst);
    cleanup.commit();
    Ok(bytes)
}

/// Write `s` to the dump file and add its byte length to the shared counter.
async fn write_chunk(
    writer: &mut BufWriter<tokio::fs::File>,
    counter: &Arc<AtomicU64>,
    s: &str,
) -> Result<()> {
    writer.write_all(s.as_bytes()).await?;
    counter.fetch_add(s.len() as u64, Ordering::SeqCst);
    Ok(())
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

/// A temporary MySQL option file holding connection credentials. Removed from
/// disk when dropped.
struct DefaultsFile {
    path: PathBuf,
}

impl DefaultsFile {
    fn create(opts: &DbConnectOptions) -> Result<Self> {
        use std::io::Write;

        // Unique temp file name. An 8-char slug from a 31-char alphabet is more
        // than enough uniqueness for a short-lived per-dump option file.
        let name = format!("noobdb-dump-{}.cnf", crate::state::random_slug(8));
        let path = std::env::temp_dir().join(name);

        let mut content = String::from("[client]\n");
        content.push_str(&format!("host={}\n", opts.host));
        content.push_str(&format!("port={}\n", opts.port));
        content.push_str(&format!("user={}\n", my_cnf_quote(&opts.user)));
        content.push_str(&format!("password={}\n", my_cnf_quote(&opts.password)));
        // sqlx connects over TCP; force the client to do the same so a
        // "localhost" host doesn't silently switch to a unix socket.
        content.push_str("protocol=TCP\n");

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
    fn create(opts: &DbConnectOptions, database: &str) -> Result<Self> {
        use std::io::Write;

        let name = format!("noobdb-dump-{}.pgpass", crate::state::random_slug(8));
        let path = std::env::temp_dir().join(name);
        // `.pgpass` is colon-delimited; backslash-escape any literal ':' or '\'
        // in field values so they aren't misread as separators.
        let line = format!(
            "{}:{}:{}:{}:{}\n",
            pgpass_escape(&opts.host),
            opts.port,
            pgpass_escape(database),
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
        let opts = DbConnectOptions {
            host: "127.0.0.1".into(),
            port: 5432,
            user: "postgres".into(),
            password: "p:w".into(),
            database: None,
            driver: DriverKind::Postgres,
            file_path: None,
            ssl_mode: None,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
            init_sql: None,
        };
        let path = {
            let f = PgPassFile::create(&opts, "testdb").expect("create");
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
}
