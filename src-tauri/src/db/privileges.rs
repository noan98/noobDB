//! Users & permissions — pure `CREATE USER` / `DROP USER` / `ALTER PASSWORD`
//! / `GRANT` / `REVOKE` SQL generation (#732).
//!
//! Mirrors the `db::sync` pattern: this module never touches a connection —
//! it turns a driver-neutral spec into dialect-specific SQL text. The command
//! layer (`commands::privileges`) hands the generated SQL to the frontend for
//! preview, and only applies it (via `Connection::execute_transaction`, same
//! primitive `apply_sync_sql` uses) after the user explicitly confirms.
//! Identifier quoting is shared with [`super::sync::quote_ident`].
//!
//! **Passwords passed in here end up embedded as SQL literals** — none of
//! the supported dialects have parameterized DDL. Callers must never log or
//! persist the generated SQL text; see `commands::privileges` for how the
//! apply path keeps it out of query history and logs.
//!
//! Only MySQL and PostgreSQL are implemented. SQLite has no user/permission
//! model at all, and MSSQL support is not yet implemented (could read/write
//! `sys.server_principals` / `sys.database_permissions`, out of scope for
//! this PR — see `db::mssql`'s `list_db_users`/`user_privileges`), so every
//! generator returns an empty string for [`super::DriverKind::Sqlite`] /
//! [`super::DriverKind::Mssql`]; the frontend hides the users panel entirely
//! for both, so this is an unreachable-in-practice fallback rather than a
//! real code path.

use serde::{Deserialize, Serialize};

use super::sync::quote_ident;
use super::DriverKind;

/// Selectable CRUD + DDL privilege flags for one GRANT/REVOKE. See
/// [`super::types::TablePrivilegeRow::ddl`] for the per-driver keyword set
/// `ddl` expands to.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrivilegeFlags {
    pub select: bool,
    pub insert: bool,
    pub update: bool,
    pub delete: bool,
    pub ddl: bool,
}

impl PrivilegeFlags {
    /// True when no flag is set — nothing to grant/revoke.
    pub fn is_empty(&self) -> bool {
        !(self.select || self.insert || self.update || self.delete || self.ddl)
    }
}

const MYSQL_DDL_KEYWORDS: [&str; 5] = ["CREATE", "ALTER", "DROP", "INDEX", "REFERENCES"];
const POSTGRES_DDL_KEYWORDS: [&str; 3] = ["TRUNCATE", "REFERENCES", "TRIGGER"];

/// Renders `flags` into the driver's GRANT/REVOKE privilege keyword list, in a
/// fixed, stable order (so generated SQL is deterministic and diff-friendly).
fn privilege_keywords(driver: DriverKind, flags: PrivilegeFlags) -> Vec<&'static str> {
    let mut out = Vec::new();
    if flags.select {
        out.push("SELECT");
    }
    if flags.insert {
        out.push("INSERT");
    }
    if flags.update {
        out.push("UPDATE");
    }
    if flags.delete {
        out.push("DELETE");
    }
    if flags.ddl {
        match driver {
            DriverKind::Mysql => out.extend(MYSQL_DDL_KEYWORDS),
            DriverKind::Postgres => out.extend(POSTGRES_DDL_KEYWORDS),
            // See the module doc: users & permissions is not yet implemented
            // for these drivers, so no generator is reachable from the UI.
            DriverKind::Sqlite | DriverKind::Mssql => {}
        }
    }
    out
}

/// A user/role to create, drop, or re-password. `host` is the MySQL account
/// host pattern (defaults to `%` — "any host" — when omitted); ignored by
/// other drivers. `password` is plaintext, used only to build SQL text.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSpec {
    pub name: String,
    pub host: Option<String>,
    pub password: Option<String>,
}

/// A GRANT/REVOKE target: a user/role on one table, or on the whole
/// database/schema (`table: None`) when the driver supports that scope
/// (MySQL `db.*`; PostgreSQL `ALL TABLES IN SCHEMA`). `database` follows the
/// app-wide convention of meaning "schema" for PostgreSQL.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrantSpec {
    pub user: String,
    pub host: Option<String>,
    pub database: String,
    pub table: Option<String>,
    pub flags: PrivilegeFlags,
}

/// Quotes a MySQL account (`'user'@'host'`), doubling embedded single quotes
/// and backslashes (MySQL's default escape rules, matching
/// `db::data_diff::sql_literal`'s MySQL branch and `db::sync`'s default-value
/// quoting).
fn mysql_account(user: &str, host: Option<&str>) -> String {
    format!(
        "'{}'@'{}'",
        mysql_escape(user),
        mysql_escape(host.unwrap_or("%"))
    )
}

fn mysql_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "''")
}

/// Quotes a PostgreSQL string literal, doubling embedded single quotes.
fn pg_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// `db.table` / `db.*` for MySQL's `GRANT ... ON` target.
fn mysql_target(database: &str, table: Option<&str>) -> String {
    let db = quote_ident(DriverKind::Mysql, database);
    match table {
        Some(t) => format!("{db}.{}", quote_ident(DriverKind::Mysql, t)),
        None => format!("{db}.*"),
    }
}

/// Renders `CREATE USER '<name>'@'<host>' [IDENTIFIED BY '<password>']` /
/// `CREATE ROLE "<name>" LOGIN [PASSWORD '<password>']`. An empty/absent
/// password omits the clause (MySQL accounts can use other auth plugins;
/// PostgreSQL roles can rely on other authentication methods).
pub fn generate_create_user_sql(driver: DriverKind, spec: &UserSpec) -> String {
    let password = spec.password.as_deref().filter(|p| !p.is_empty());
    match driver {
        DriverKind::Mysql => {
            let account = mysql_account(&spec.name, spec.host.as_deref());
            match password {
                Some(pw) => format!("CREATE USER {account} IDENTIFIED BY '{}'", mysql_escape(pw)),
                None => format!("CREATE USER {account}"),
            }
        }
        DriverKind::Postgres => {
            let ident = quote_ident(DriverKind::Postgres, &spec.name);
            match password {
                Some(pw) => format!("CREATE ROLE {ident} LOGIN PASSWORD {}", pg_literal(pw)),
                None => format!("CREATE ROLE {ident} LOGIN"),
            }
        }
        DriverKind::Sqlite | DriverKind::Mssql => String::new(),
    }
}

/// Renders `DROP USER '<name>'@'<host>'` / `DROP ROLE "<name>"`.
pub fn generate_drop_user_sql(driver: DriverKind, name: &str, host: Option<&str>) -> String {
    match driver {
        DriverKind::Mysql => format!("DROP USER {}", mysql_account(name, host)),
        DriverKind::Postgres => format!("DROP ROLE {}", quote_ident(DriverKind::Postgres, name)),
        DriverKind::Sqlite | DriverKind::Mssql => String::new(),
    }
}

/// Renders `ALTER USER '<name>'@'<host>' IDENTIFIED BY '<password>'` /
/// `ALTER ROLE "<name>" PASSWORD '<password>'`.
pub fn generate_alter_password_sql(
    driver: DriverKind,
    name: &str,
    host: Option<&str>,
    password: &str,
) -> String {
    match driver {
        DriverKind::Mysql => format!(
            "ALTER USER {} IDENTIFIED BY '{}'",
            mysql_account(name, host),
            mysql_escape(password)
        ),
        DriverKind::Postgres => format!(
            "ALTER ROLE {} PASSWORD {}",
            quote_ident(DriverKind::Postgres, name),
            pg_literal(password)
        ),
        DriverKind::Sqlite | DriverKind::Mssql => String::new(),
    }
}

/// Renders `GRANT <privs> ON <target> TO <user>`. Returns `None` when `flags`
/// selects nothing (nothing to grant) so the caller can skip an empty
/// statement rather than emit invalid SQL.
pub fn generate_grant_sql(driver: DriverKind, spec: &GrantSpec) -> Option<String> {
    render_grant_or_revoke(driver, spec, "GRANT", "TO")
}

/// Renders `REVOKE <privs> ON <target> FROM <user>`. `None` when `flags` is
/// empty.
pub fn generate_revoke_sql(driver: DriverKind, spec: &GrantSpec) -> Option<String> {
    render_grant_or_revoke(driver, spec, "REVOKE", "FROM")
}

fn render_grant_or_revoke(
    driver: DriverKind,
    spec: &GrantSpec,
    verb: &str,
    preposition: &str,
) -> Option<String> {
    let privs = privilege_keywords(driver, spec.flags);
    if privs.is_empty() {
        return None;
    }
    let priv_list = privs.join(", ");
    Some(match driver {
        DriverKind::Mysql => format!(
            "{verb} {priv_list} ON {} {preposition} {}",
            mysql_target(&spec.database, spec.table.as_deref()),
            mysql_account(&spec.user, spec.host.as_deref())
        ),
        DriverKind::Postgres => {
            let user_ident = quote_ident(DriverKind::Postgres, &spec.user);
            let db_ident = quote_ident(DriverKind::Postgres, &spec.database);
            match &spec.table {
                Some(t) => format!(
                    "{verb} {priv_list} ON {db_ident}.{} {preposition} {user_ident}",
                    quote_ident(DriverKind::Postgres, t)
                ),
                None => format!(
                    "{verb} {priv_list} ON ALL TABLES IN SCHEMA {db_ident} {preposition} {user_ident}"
                ),
            }
        }
        DriverKind::Sqlite | DriverKind::Mssql => String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flags(select: bool, insert: bool, update: bool, delete: bool, ddl: bool) -> PrivilegeFlags {
        PrivilegeFlags {
            select,
            insert,
            update,
            delete,
            ddl,
        }
    }

    // --- CREATE / DROP / ALTER USER -----------------------------------

    #[test]
    fn mysql_create_user_with_password() {
        let spec = UserSpec {
            name: "alice".into(),
            host: Some("%".into()),
            password: Some("s3cret".into()),
        };
        assert_eq!(
            generate_create_user_sql(DriverKind::Mysql, &spec),
            "CREATE USER 'alice'@'%' IDENTIFIED BY 's3cret'"
        );
    }

    #[test]
    fn mysql_create_user_without_password_omits_clause() {
        let spec = UserSpec {
            name: "alice".into(),
            host: None,
            password: None,
        };
        assert_eq!(
            generate_create_user_sql(DriverKind::Mysql, &spec),
            "CREATE USER 'alice'@'%'"
        );
    }

    #[test]
    fn mysql_create_user_empty_password_omits_clause() {
        let spec = UserSpec {
            name: "alice".into(),
            host: Some("localhost".into()),
            password: Some(String::new()),
        };
        assert_eq!(
            generate_create_user_sql(DriverKind::Mysql, &spec),
            "CREATE USER 'alice'@'localhost'"
        );
    }

    #[test]
    fn mysql_create_user_escapes_quotes_and_backslashes() {
        let spec = UserSpec {
            name: "o'brien".into(),
            host: Some("%".into()),
            password: Some(r"p\'ss".into()),
        };
        assert_eq!(
            generate_create_user_sql(DriverKind::Mysql, &spec),
            r"CREATE USER 'o''brien'@'%' IDENTIFIED BY 'p\\''ss'"
        );
    }

    #[test]
    fn postgres_create_user_with_and_without_password() {
        let with_pw = UserSpec {
            name: "alice".into(),
            host: None,
            password: Some("s3cret".into()),
        };
        assert_eq!(
            generate_create_user_sql(DriverKind::Postgres, &with_pw),
            "CREATE ROLE \"alice\" LOGIN PASSWORD 's3cret'"
        );
        let without_pw = UserSpec {
            name: "alice".into(),
            host: None,
            password: None,
        };
        assert_eq!(
            generate_create_user_sql(DriverKind::Postgres, &without_pw),
            "CREATE ROLE \"alice\" LOGIN"
        );
    }

    #[test]
    fn postgres_create_user_escapes_quotes() {
        let spec = UserSpec {
            name: "o'brien".into(),
            host: None,
            password: Some("it's-a-secret".into()),
        };
        assert_eq!(
            generate_create_user_sql(DriverKind::Postgres, &spec),
            "CREATE ROLE \"o'brien\" LOGIN PASSWORD 'it''s-a-secret'"
        );
    }

    #[test]
    fn mysql_drop_user_defaults_host_to_percent() {
        assert_eq!(
            generate_drop_user_sql(DriverKind::Mysql, "alice", None),
            "DROP USER 'alice'@'%'"
        );
        assert_eq!(
            generate_drop_user_sql(DriverKind::Mysql, "alice", Some("localhost")),
            "DROP USER 'alice'@'localhost'"
        );
    }

    #[test]
    fn postgres_drop_user_ignores_host() {
        assert_eq!(
            generate_drop_user_sql(DriverKind::Postgres, "alice", Some("ignored")),
            "DROP ROLE \"alice\""
        );
    }

    #[test]
    fn mysql_alter_password() {
        assert_eq!(
            generate_alter_password_sql(DriverKind::Mysql, "alice", Some("%"), "n3w-pw"),
            "ALTER USER 'alice'@'%' IDENTIFIED BY 'n3w-pw'"
        );
    }

    #[test]
    fn postgres_alter_password() {
        assert_eq!(
            generate_alter_password_sql(DriverKind::Postgres, "alice", None, "n3w-pw"),
            "ALTER ROLE \"alice\" PASSWORD 'n3w-pw'"
        );
    }

    // --- GRANT / REVOKE --------------------------------------------------

    #[test]
    fn mysql_grant_on_single_table() {
        let spec = GrantSpec {
            user: "alice".into(),
            host: Some("%".into()),
            database: "shop".into(),
            table: Some("orders".into()),
            flags: flags(true, true, false, false, false),
        };
        assert_eq!(
            generate_grant_sql(DriverKind::Mysql, &spec).as_deref(),
            Some("GRANT SELECT, INSERT ON `shop`.`orders` TO 'alice'@'%'")
        );
    }

    #[test]
    fn mysql_grant_whole_database_when_table_is_none() {
        let spec = GrantSpec {
            user: "alice".into(),
            host: None,
            database: "shop".into(),
            table: None,
            flags: flags(true, false, false, false, false),
        };
        assert_eq!(
            generate_grant_sql(DriverKind::Mysql, &spec).as_deref(),
            Some("GRANT SELECT ON `shop`.* TO 'alice'@'%'")
        );
    }

    #[test]
    fn mysql_grant_ddl_bundles_schema_keywords() {
        let spec = GrantSpec {
            user: "alice".into(),
            host: Some("%".into()),
            database: "shop".into(),
            table: Some("orders".into()),
            flags: flags(false, false, false, false, true),
        };
        assert_eq!(
            generate_grant_sql(DriverKind::Mysql, &spec).as_deref(),
            Some("GRANT CREATE, ALTER, DROP, INDEX, REFERENCES ON `shop`.`orders` TO 'alice'@'%'")
        );
    }

    #[test]
    fn mysql_revoke_mirrors_grant() {
        let spec = GrantSpec {
            user: "alice".into(),
            host: Some("%".into()),
            database: "shop".into(),
            table: Some("orders".into()),
            flags: flags(true, false, false, true, false),
        };
        assert_eq!(
            generate_revoke_sql(DriverKind::Mysql, &spec).as_deref(),
            Some("REVOKE SELECT, DELETE ON `shop`.`orders` FROM 'alice'@'%'")
        );
    }

    #[test]
    fn postgres_grant_on_single_table() {
        let spec = GrantSpec {
            user: "alice".into(),
            host: None,
            database: "public".into(),
            table: Some("orders".into()),
            flags: flags(true, true, true, true, false),
        };
        assert_eq!(
            generate_grant_sql(DriverKind::Postgres, &spec).as_deref(),
            Some("GRANT SELECT, INSERT, UPDATE, DELETE ON \"public\".\"orders\" TO \"alice\"")
        );
    }

    #[test]
    fn postgres_grant_whole_schema_when_table_is_none() {
        let spec = GrantSpec {
            user: "alice".into(),
            host: None,
            database: "public".into(),
            table: None,
            flags: flags(true, false, false, false, false),
        };
        assert_eq!(
            generate_grant_sql(DriverKind::Postgres, &spec).as_deref(),
            Some("GRANT SELECT ON ALL TABLES IN SCHEMA \"public\" TO \"alice\"")
        );
    }

    #[test]
    fn postgres_grant_ddl_bundles_structural_keywords() {
        let spec = GrantSpec {
            user: "alice".into(),
            host: None,
            database: "public".into(),
            table: Some("orders".into()),
            flags: flags(false, false, false, false, true),
        };
        assert_eq!(
            generate_grant_sql(DriverKind::Postgres, &spec).as_deref(),
            Some("GRANT TRUNCATE, REFERENCES, TRIGGER ON \"public\".\"orders\" TO \"alice\"")
        );
    }

    #[test]
    fn postgres_revoke_mirrors_grant() {
        let spec = GrantSpec {
            user: "alice".into(),
            host: None,
            database: "public".into(),
            table: Some("orders".into()),
            flags: flags(false, true, true, false, false),
        };
        assert_eq!(
            generate_revoke_sql(DriverKind::Postgres, &spec).as_deref(),
            Some("REVOKE INSERT, UPDATE ON \"public\".\"orders\" FROM \"alice\"")
        );
    }

    #[test]
    fn grant_and_revoke_return_none_when_no_privileges_selected() {
        let spec = GrantSpec {
            user: "alice".into(),
            host: Some("%".into()),
            database: "shop".into(),
            table: Some("orders".into()),
            flags: flags(false, false, false, false, false),
        };
        assert_eq!(generate_grant_sql(DriverKind::Mysql, &spec), None);
        assert_eq!(generate_revoke_sql(DriverKind::Mysql, &spec), None);
        assert_eq!(generate_grant_sql(DriverKind::Postgres, &spec), None);
        assert_eq!(generate_revoke_sql(DriverKind::Postgres, &spec), None);
    }

    #[test]
    fn privilege_flags_is_empty() {
        assert!(flags(false, false, false, false, false).is_empty());
        assert!(!flags(true, false, false, false, false).is_empty());
        assert!(!flags(false, false, false, false, true).is_empty());
    }

    #[test]
    fn unsupported_driver_generators_return_empty_string_not_used_by_ui() {
        // SQLite has no user model and MSSQL isn't implemented yet; the UI
        // never reaches these for either driver, but the generators must not
        // panic — they degrade to an empty string.
        for driver in [DriverKind::Sqlite, DriverKind::Mssql] {
            let user = UserSpec {
                name: "x".into(),
                host: None,
                password: None,
            };
            assert_eq!(generate_create_user_sql(driver, &user), "");
            assert_eq!(generate_drop_user_sql(driver, "x", None), "");
            assert_eq!(generate_alter_password_sql(driver, "x", None, "pw"), "");
            let grant = GrantSpec {
                user: "x".into(),
                host: None,
                database: "main".into(),
                table: None,
                flags: flags(true, false, false, false, false),
            };
            assert_eq!(generate_grant_sql(driver, &grant).as_deref(), Some(""));
        }
    }
}
