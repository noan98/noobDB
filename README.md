# tableX

A lightweight desktop MySQL client written in Rust, with first-class SSH-tunnel
support. Built with [Tauri 2](https://tauri.app/) + React, targeted at Windows.

## Features (initial)

- MySQL connections (`sqlx` + `rustls`)
- **SSH tunnel** via local port forwarding (`russh`)
  - Private key authentication (passphrase supported)
  - Trust-on-first-use known_hosts file (`%APPDATA%/tableX/known_hosts`)
- Connection profiles stored in `%APPDATA%/tableX/profiles.json`
- DB passwords & SSH key passphrases stored in the OS credential store
  (Windows Credential Manager via the `keyring` crate)
- SQL editor (CodeMirror 6) and result grid (TanStack Table)
- Schema browser: databases / tables / columns

The internal driver layer is an `enum Connection` with dispatch in
`src-tauri/src/db/mod.rs` — adding PostgreSQL or SQLite later means adding a
variant and a new module, without touching the SSH or session layers.

## Project layout

```
src/                   React + TypeScript frontend
src-tauri/             Tauri 2 Rust backend
  src/
    db/                Driver enum + MySQL implementation
    ssh/               russh-based tunnel (TOFU host key)
    profiles/          profiles.json + keyring helpers
    commands/          #[tauri::command] IPC entry points
    state.rs           AppState (sessions)
```

## Development

Prereqs: Rust stable (>= 1.77), Node.js >= 20, npm. On Linux, install the
[Tauri 2 system prerequisites](https://tauri.app/start/prerequisites/).

```sh
npm install
npm run tauri dev
```

## Build (Windows)

The Windows installer is produced via GitHub Actions
(`.github/workflows/release.yml`) on a `windows-latest` runner using
[`tauri-action`](https://github.com/tauri-apps/tauri-action). Push a tag like
`v0.1.0`, or trigger `workflow_dispatch` manually.

Locally on Windows:

```pwsh
npm install
npm run tauri build
```

The output is an NSIS installer under `src-tauri/target/release/bundle/nsis/`.

## Tests

```sh
cd src-tauri
cargo test
```

To exercise the live MySQL path, set `TABLEX_TEST_MYSQL_URL`:

```sh
TABLEX_TEST_MYSQL_URL=mysql://root:rootpw@127.0.0.1:3306/testdb \
  cargo test --test mysql_integration
```

## Security notes

- The known_hosts file is created on first connect (TOFU). If the server key
  later changes, the connection is rejected with `russh::Error::UnknownKey`.
  Delete the corresponding entry to re-trust.
- Credentials live in the OS keyring, never in `profiles.json`.
- The Tauri capabilities set is intentionally minimal — see
  `src-tauri/capabilities/default.json`.

## Roadmap

- PostgreSQL / SQLite drivers
- SSH password auth + ssh-agent
- Query history, multiple result tabs
- CSV / JSON export
