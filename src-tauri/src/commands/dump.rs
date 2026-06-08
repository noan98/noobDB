use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Deserialize;
use tauri::State;
use tokio::process::Command;

use crate::db::types::Value;
use crate::db::{DbConnectOptions, DriverKind};
use crate::error::{AppError, Result};
use crate::state::AppState;

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

    // ── PostgreSQL-specific (#471). Ignored by other drivers. ──
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
}

/// Dump `database` to `path`, dispatching on the session's driver (#471).
/// Returns the number of bytes written on success.
///
/// - MySQL: `mysqldump` (credentials via a temp option file).
/// - PostgreSQL: `pg_dump` (password via a temp `PGPASSFILE`).
/// - SQLite: generated from the live connection (no external client needed).
#[tauri::command]
pub async fn dump_database(
    session_id: String,
    database: String,
    path: String,
    options: DumpOptions,
    state: State<'_, AppState>,
) -> Result<u64> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;

    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("save path is empty".into()));
    }

    match session.connect_options.driver {
        DriverKind::Mysql => dump_mysql(&session.connect_options, &database, &path, &options).await,
        DriverKind::Postgres => {
            dump_postgres(&session.connect_options, &database, &path, &options).await
        }
        DriverKind::Sqlite => dump_sqlite(&session.conn, &path, &options).await,
    }
}

/// Run `mysqldump` for `database`, writing SQL to `path`.
async fn dump_mysql(
    connect_options: &DbConnectOptions,
    database: &str,
    path: &str,
    options: &DumpOptions,
) -> Result<u64> {
    let database = database.trim();
    if database.is_empty() {
        return Err(AppError::InvalidInput("database name is empty".into()));
    }

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
    cmd.arg(database);

    let out_file = std::fs::File::create(path)?;
    cmd.stdout(Stdio::from(out_file));
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::null());

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let _ = std::fs::remove_file(path);
            return Err(AppError::Other(
                "mysqldump command not found. Install the MySQL client tools and \
                 make sure mysqldump is on your PATH."
                    .into(),
            ));
        }
        Err(e) => {
            let _ = std::fs::remove_file(path);
            return Err(AppError::Io(e));
        }
    };

    let output = child.wait_with_output().await?;
    // Hold the option file until the child has finished reading it.
    drop(defaults);

    if !output.status.success() {
        let _ = std::fs::remove_file(path);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = stderr.trim();
        let code = output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".into());
        return Err(AppError::Other(format!(
            "mysqldump failed (exit {}): {}",
            code,
            if msg.is_empty() {
                "no error output"
            } else {
                msg
            }
        )));
    }

    let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    Ok(bytes)
}

/// Run `pg_dump` for `database`, writing SQL to `path` (#471). The password is
/// passed via a temp `PGPASSFILE` (mode 0600 on unix) and `--no-password`, so it
/// never appears in process arguments, the environment, or logs.
async fn dump_postgres(
    connect_options: &DbConnectOptions,
    database: &str,
    path: &str,
    options: &DumpOptions,
) -> Result<u64> {
    let database = database.trim();
    if database.is_empty() {
        return Err(AppError::InvalidInput("database name is empty".into()));
    }

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

    let out_file = std::fs::File::create(path)?;
    cmd.stdout(Stdio::from(out_file));
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::null());

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let _ = std::fs::remove_file(path);
            return Err(AppError::Other(
                "pg_dump command not found. Install the PostgreSQL client tools and \
                 make sure pg_dump is on your PATH."
                    .into(),
            ));
        }
        Err(e) => {
            let _ = std::fs::remove_file(path);
            return Err(AppError::Io(e));
        }
    };

    let output = child.wait_with_output().await?;
    // Hold the pass file until the child has finished authenticating.
    drop(pgpass);

    if !output.status.success() {
        let _ = std::fs::remove_file(path);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = stderr.trim();
        let code = output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".into());
        return Err(AppError::Other(format!(
            "pg_dump failed (exit {}): {}",
            code,
            if msg.is_empty() {
                "no error output"
            } else {
                msg
            }
        )));
    }

    let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    Ok(bytes)
}

/// Generate a `sqlite3 .dump`-style SQL script for the live SQLite connection and
/// write it to `path` (#471). PATH-independent: no external `sqlite3` binary is
/// needed — schema and rows are read through the existing connection.
async fn dump_sqlite(
    conn: &crate::db::Connection,
    path: &str,
    options: &DumpOptions,
) -> Result<u64> {
    let mut out = String::new();
    out.push_str("PRAGMA foreign_keys=OFF;\n");
    out.push_str("BEGIN TRANSACTION;\n");

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
    for row in &tables.rows {
        let (name, create_sql) = match (row.first(), row.get(1)) {
            (Some(Value::String(n)), Some(Value::String(s))) => (n.clone(), s.clone()),
            _ => continue,
        };
        if options.add_drop_table {
            out.push_str(&format!(
                "DROP TABLE IF EXISTS {};\n",
                sqlite_quote_ident(&name)
            ));
        }
        if !options.no_create_info {
            out.push_str(&create_sql);
            out.push_str(";\n");
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
                out.push_str(&format!(
                    "INSERT INTO {} ({}) VALUES ({});\n",
                    sqlite_quote_ident(&name),
                    cols.join(", "),
                    vals.join(", ")
                ));
            }
        }
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
        for row in &objs.rows {
            if let Some(Value::String(sql)) = row.first() {
                out.push_str(sql);
                out.push_str(";\n");
            }
        }
    }

    out.push_str("COMMIT;\n");
    std::fs::write(path, &out)?;
    Ok(out.len() as u64)
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
        // than enough uniqueness for a short-lived per-dump option file, and lets
        // us drop the uuid dependency (#273).
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

/// A temporary PostgreSQL `.pgpass`-format file (#471) holding one line:
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
