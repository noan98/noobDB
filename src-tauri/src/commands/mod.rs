pub mod advisor;
pub mod ai;
pub mod assertions;
pub mod broadcast;
pub mod bulk_write;
pub mod cell_blob;
pub mod connection;
pub mod diff;
pub mod dump;
pub mod dump_tools;
pub mod export;
pub mod export_xlsx;
pub mod file;
pub mod flight_recorder;
pub mod history;
pub mod import;
pub mod import_decode;
pub mod import_templates;
pub mod import_xlsx;
pub mod inspector;
pub mod local;
pub mod logs;
pub mod plan_watch;
pub mod privileges;
pub mod process;
pub mod profile;
pub mod profile_backup;
pub mod profiles;
pub mod progress;
pub mod query;
pub mod result;
pub mod sandbox;
pub mod schema;
pub mod schema_drift;
pub mod schema_tree;
pub mod script;
pub mod search;
pub mod server;
pub mod snippets;
pub mod ssh;
pub mod sync;
pub mod table_open;
pub mod tasks;
pub mod timelapse;
pub mod transfer;
pub mod window;

/// `lib.rs` で `mod commands` に `clippy::unreachable` の allow を掛けている穴 (tauri::command
/// マクロ由来の誤検知回避) を補うメタテスト。commands 配下に手書きの
/// `unreachable!(` / `todo!(` / `unimplemented!(` があれば、直前に対応する
/// `#[allow(clippy::...)]` と `//` の根拠コメントが無い限り失敗させる。
#[cfg(test)]
mod panic_macro_guard {
    const MACROS: [(&str, &str); 3] = [
        ("unreachable!(", "unreachable"),
        ("todo!(", "todo"),
        ("unimplemented!(", "unimplemented"),
    ];

    fn scan(dir: &std::path::Path, bad: &mut Vec<String>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            bad.push(format!("読めないディレクトリ: {}", dir.display()));
            return;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.is_dir() {
                scan(&path, bad);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                bad.push(format!("読めないファイル: {}", path.display()));
                continue;
            };
            let lines: Vec<&str> = text.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                let t = line.trim_start();
                // テストモジュール以降は対象外 (本体コードのみ検査する)。
                if t.starts_with("#[cfg(test)]") {
                    break;
                }
                if t.starts_with("//") {
                    continue;
                }
                for (needle, lint) in MACROS {
                    if !line.contains(needle) {
                        continue;
                    }
                    let allow = format!("clippy::{lint}");
                    let from = i.saturating_sub(4);
                    let prev = &lines[from..i];
                    let has_allow = prev
                        .iter()
                        .any(|l| l.contains("#[allow(") && l.contains(&allow));
                    let has_comment = prev.iter().any(|l| l.trim_start().starts_with("//"));
                    if !(has_allow && has_comment) {
                        bad.push(format!("{}:{}: {}", path.display(), i + 1, line.trim()));
                    }
                }
            }
        }
    }

    #[test]
    fn commands_have_no_unjustified_panic_macros() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands");
        let mut bad = Vec::new();
        scan(&dir, &mut bad);
        assert!(
            bad.is_empty(),
            "commands 配下に根拠なしの unreachable!/todo!/unimplemented! があります。\
             直前に #[allow(clippy::...)] と日本語の根拠コメントを付けてください:\n{}",
            bad.join("\n")
        );
    }
}
