//! ビルド時に `Cargo.lock` から DB ドライバ関連の依存バージョンを拾い、診断バンドル
//! (#1622) に載せるため `cargo:rustc-env` で埋め込む。読めなければ `unknown`。

/// `Cargo.lock` から `[[package]] name = "<name>"` の version を探す。
fn locked_version(lock: &str, name: &str) -> Option<String> {
    let header = format!("name = \"{name}\"");
    let mut lines = lock.lines();
    while let Some(line) = lines.next() {
        if line.trim() == header {
            let next = lines.next()?;
            let v = next.trim().strip_prefix("version = \"")?;
            return Some(v.trim_end_matches('"').to_string());
        }
    }
    None
}

fn main() {
    println!("cargo:rerun-if-changed=Cargo.lock");
    let lock = std::fs::read_to_string("Cargo.lock").unwrap_or_default();
    for (env, name) in [
        ("NOOBDB_SQLX_VERSION", "sqlx"),
        ("NOOBDB_LIBSQLITE3_VERSION", "libsqlite3-sys"),
    ] {
        let v = locked_version(&lock, name).unwrap_or_else(|| "unknown".to_string());
        println!("cargo:rustc-env={env}={v}");
    }
    tauri_build::build()
}
