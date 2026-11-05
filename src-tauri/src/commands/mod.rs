pub mod advisor;
pub mod ai;
pub mod assertions;
pub mod broadcast;
pub mod bulk_write;
pub mod cell_blob;
pub mod connection;
pub mod diff;
pub mod dump;
pub mod dump_native;
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
/// マクロ由来の誤検知回避) を補うメタテスト。commands 配下の本体に手書きの
/// `unreachable!` / `todo!` / `unimplemented!` (括弧は () [] {} のいずれも) があれば、
/// 直前の連続するアトリビュート行に対応する `#[allow(clippy::...)]` があり、その
/// すぐ上に `//` の根拠コメントが無い限り失敗させる。`#[cfg(test)] mod ... { }` は飛ばす。
#[cfg(test)]
mod panic_macro_guard {
    const NAMES: [&str; 3] = ["unreachable", "todo", "unimplemented"];

    fn is_ident(c: char) -> bool {
        c.is_alphanumeric() || c == '_'
    }

    /// 行内にマクロ呼び出し `name!` + 空白 + 開き括弧があれば、その name を返す。
    fn macro_in(line: &str) -> Option<&'static str> {
        for name in NAMES {
            for (pos, _) in line.match_indices(name) {
                let before_ok = line[..pos]
                    .chars()
                    .next_back()
                    .map_or(true, |c| !is_ident(c));
                let rest = &line[pos + name.len()..];
                let Some(rest) = rest.strip_prefix('!') else {
                    continue;
                };
                if before_ok && rest.trim_start().starts_with(['(', '[', '{']) {
                    return Some(name);
                }
            }
        }
        None
    }

    fn justified(lines: &[&str], i: usize, name: &str) -> bool {
        let allow = format!("clippy::{name}");
        let mut j = i;
        let mut has_allow = false;
        while j > 0 && lines[j - 1].trim_start().starts_with("#[") {
            has_allow |= lines[j - 1].contains("allow(") && lines[j - 1].contains(&allow);
            j -= 1;
        }
        has_allow && j > 0 && lines[j - 1].trim_start().starts_with("//")
    }

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
            let mut skip_depth: Option<i64> = None;
            let mut pending_test_mod = false;
            for (i, line) in lines.iter().enumerate() {
                let t = line.trim_start();
                if let Some(depth) = skip_depth.as_mut() {
                    *depth += line.matches('{').count() as i64 - line.matches('}').count() as i64;
                    if *depth <= 0 {
                        skip_depth = None;
                    }
                    continue;
                }
                if t.starts_with("#[cfg(test)]") {
                    pending_test_mod = true;
                    continue;
                }
                if pending_test_mod && t.starts_with("#[") {
                    continue;
                }
                if std::mem::take(&mut pending_test_mod)
                    && (t.starts_with("mod ") || t.starts_with("pub mod "))
                {
                    // `#[cfg(test)] mod ... {` のブロックを波括弧の深さで飛ばす。
                    let depth = line.matches('{').count() as i64 - line.matches('}').count() as i64;
                    if depth > 0 {
                        skip_depth = Some(depth);
                    }
                    continue;
                }
                if t.starts_with("//") {
                    continue;
                }
                if let Some(name) = macro_in(line) {
                    if !justified(&lines, i, name) {
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
