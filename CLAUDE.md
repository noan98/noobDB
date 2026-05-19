# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Frontend (run from repo root):

```sh
npm install
npm run dev            # vite dev server on http://localhost:1420
npm run build          # tsc type-check + vite build → dist/
npm run tauri dev      # full app (Tauri spawns vite via beforeDevCommand)
npm run tauri build    # production bundle (NSIS installer on Windows)
```

Rust backend (run from `src-tauri/`):

```sh
cargo check --all-targets
cargo test                                   # unit tests
cargo test --test mysql_integration          # single integration test file
cargo test mysql_roundtrip_when_env_set      # single test by name
```

The integration test is a no-op unless `TABLEX_TEST_MYSQL_URL` is set:

```sh
TABLEX_TEST_MYSQL_URL=mysql://root:rootpw@127.0.0.1:3306/testdb cargo test --test mysql_integration
```

CI (`.github/workflows/release.yml`) runs `cargo check --all-targets` and `cargo test` against a MySQL 8 service container on Linux, and produces the Windows NSIS bundle via `tauri-action` on tags `v*` or manual dispatch. Linux CI requires Tauri 2 system packages (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libsoup-3.0-dev`, `librsvg2-dev`, `libxdo-dev`, `libayatana-appindicator3-dev`).

There is no JS linter or test runner configured; only `tsc` (via `npm run build`) type-checks the frontend. `tsconfig.json` enables `strict`, `noUnusedLocals`, and `noUnusedParameters`, so unused imports/parameters break the build.

## Architecture

### Two-process split

- **Frontend** (`src/`): React 18 + TypeScript + Vite. All UI state lives here; backend state is the source of truth for sessions and profiles. UI talks to Rust only via `invoke(...)` — see `src/api/tauri.ts`, the single typed wrapper around every Tauri command. The argument naming convention is camelCase on the JS side (e.g. `sessionId`); Tauri auto-translates to Rust `snake_case`.
- **Backend** (`src-tauri/src/`): Tauri 2 + Tokio. `lib.rs::run()` registers the IPC handlers and installs `AppState` as Tauri-managed state. `main.rs` is a thin shim that calls `tablex_lib::run()`.

### Driver dispatch: `enum Connection`

The DB layer is intentionally a hand-rolled enum, not a trait object. `db::Connection` in `src-tauri/src/db/mod.rs` matches on its variant for every operation (`execute`, `databases`, `tables`, `columns`, `close`). **Adding a new database (Postgres, SQLite) means: add a `DriverKind` variant, add a `db/<name>.rs` module exposing the same method surface, and extend each `match` arm in `db/mod.rs`.** Do not touch the SSH or session layers — they are driver-agnostic.

`db::types::{Value, Column, QueryResult, TableColumnInfo}` is the cross-driver wire format. `Value` is `#[serde(untagged)]`, so JSON sees primitives directly; BLOBs are hex-encoded strings (`Value::Bytes`) to keep JSON safe. The MySQL implementation does explicit type-driven decoding in `mysql::decode_cell` — when adding column types, follow that try-typed-then-fall-back-to-String pattern.

`MySqlConn::execute` decides query-vs-exec by sniffing the SQL prefix (`select`/`show`/`describe`/`desc`/`explain`/`with`); non-matching statements use `.execute()` and return `rows_affected` with empty columns/rows.

### SSH tunnel + session lifetime

`SshTunnel` (`ssh/tunnel.rs`) opens a local TCP listener on an OS-assigned port, dials the SSH server with `russh`, authenticates with a public key, and spawns an accept loop that opens a `direct-tcpip` channel per inbound connection and pipes bytes bidirectionally. The session and the accept-task `JoinHandle` are owned by the struct; **`impl Drop` aborts the task, dropping the `Arc<russh::client::Handle>` closes the SSH session**.

When a connection uses SSH, `commands::connection::build_options` opens the tunnel first, then constructs `DbConnectOptions` pointing at `127.0.0.1:<tunnel.local_port>`. The `SshTunnel` is stored as `Session._tunnel: Option<SshTunnel>` so it lives exactly as long as the DB connection. **Never drop the tunnel before the connection — sqlx will reconnect through nothing.** `disconnect` removes the `Arc<Session>` from the map; the last reference dropping triggers both `conn.close()` and the tunnel's `Drop`.

Host-key verification is **trust-on-first-use** in `ssh/handler.rs::ClientHandler::check_server_key`. The known_hosts file is `<data_dir>/known_hosts` with one `host:port fingerprint` line per entry. A mismatch returns `russh::Error::UnknownKey` and aborts the connection; recovery requires manually deleting the line.

### Sessions

`AppState` (`state.rs`) holds `RwLock<HashMap<SessionId, Arc<Session>>>`. Session IDs are 8-char base32-ish slugs from a custom alphabet (no ambiguous chars like `0`/`o`/`l`/`1`). They're used as keyring target prefixes, so the alphabet matters for cross-platform safety. Always look up sessions via `state.get(&id).await.ok_or(AppError::SessionNotFound(id))` — see `commands::query::run_query` for the pattern; replicate it in any new command that touches a session.

### Profiles vs. secrets — strict split

- `profiles.json` (in `directories::ProjectDirs` data_dir — `%APPDATA%/tableX` on Windows) stores everything **non-secret**: name, host, port, user, database, ssh host/port/user/key path. `profiles/store.rs` is a load/save-all + upsert/delete API.
- The OS keyring (`keyring` crate) stores **secrets only**: DB password and SSH key passphrase, keyed by `<profile_id>/db_password` and `<profile_id>/ssh_passphrase` under service `tableX`. See `profiles/secrets.rs`.
- `save_profile` accepts `db_password`/`ssh_passphrase` as `Option<String>` with empty-string semantics: `None` = no change, `Some("")` = delete from keyring, `Some(v)` = set.
- `delete_profile` calls `secrets::delete_all` first to avoid orphaned credentials.
- **Do not put secrets in `profiles.json`** and do not log them. Connection requests with empty `password`/`passphrase` fall back to the keyring lookup keyed by `profile_id` (see `resolve_password` / `resolve_passphrase` in `commands/connection.rs`).

### IPC surface

Every `#[tauri::command]` is registered in the `invoke_handler!` macro in `lib.rs::run()`. The full list is mirrored in `src/api/tauri.ts` as the `api` object. **When adding a command: add the Rust handler, register it in `lib.rs`, and add the typed wrapper in `tauri.ts` — drift between these will silently break the frontend.** Errors bubble up as `AppError`, which serializes as its `Display` string (see `error.rs::Serialize`); the frontend receives them as `string` in the rejected promise.

### Test-only API

`lib.rs` exposes `pub mod __test_api` (`#[doc(hidden)]`) so integration tests under `src-tauri/tests/` can drive the `db::Connection` path without going through Tauri. If you need a new test entry point, add it there rather than making internal modules public.

### Tauri capabilities

`src-tauri/capabilities/default.json` is intentionally minimal: window/app/event defaults plus `dialog:allow-open`/`dialog:allow-save`. Don't add permissions without a concrete need — the frontend should call backend commands, not direct shell/fs APIs.
