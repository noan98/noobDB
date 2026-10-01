//! ダンプ用クライアントツール (`mysqldump` / `pg_dump`) の検出と、ワンクリック導入。
//!
//! ダンプは **noobDB を実行しているこの PC 上で** 外部ツールを起動し、SSH トンネル
//! (使っていれば) 経由で DB に接続する。そのためツールが要るのはこの PC だけで、
//! SSH の踏み台サーバや DB サーバには何もインストールしない。UI はこの前提と
//! インストール先のパスをそのまま表示する (`DumpToolInstallPlan::location`)。
//!
//! - **検出**: まず `PATH` を探し、無ければ既知のインストール先 (Homebrew の keg-only な
//!   `mysql-client`、Windows の `C:\Program Files\MySQL\MySQL Server *\bin` など) を探す。
//!   これらは `PATH` に通らないことが多く、入れたのに「見つからない」になるのを防ぐ。
//! - **導入**: OS 標準のパッケージマネージャ (Windows: winget / macOS: Homebrew) を
//!   起動するだけ。Linux は管理者権限 (sudo) が要るので自動では実行せず、コピー用の
//!   コマンドだけを返す。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

use crate::error::{AppError, Result};

/// パッケージマネージャの実行に許す最大時間。MySQL のパッケージは数百 MB あり、
/// 回線によっては数分かかるため長めに取る。
const INSTALL_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// エラー表示に残す出力の末尾行数。
const OUTPUT_TAIL_LINES: usize = 12;

/// 対応するツール。任意の実行ファイル名を受け付けないよう列挙で絞る。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DumpTool {
    Mysqldump,
    PgDump,
}

impl DumpTool {
    fn parse(name: &str) -> Result<Self> {
        match name {
            "mysqldump" => Ok(Self::Mysqldump),
            "pg_dump" => Ok(Self::PgDump),
            other => Err(AppError::InvalidInput(format!(
                "unknown dump tool: {other}"
            ))),
        }
    }

    fn binary(self) -> &'static str {
        match self {
            Self::Mysqldump => "mysqldump",
            Self::PgDump => "pg_dump",
        }
    }
}

/// ツールの検出結果と、見つからないときの導入方法。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpToolStatus {
    pub tool: String,
    /// 見つかった実行ファイルの絶対パス (`PATH` 上ならそのフルパス)。無ければ `None`。
    pub path: Option<String>,
    /// 導入方法。この OS で案内できる方法が無ければ `None`。
    pub install: Option<DumpToolInstallPlan>,
}

/// 導入方法。UI は `command` と `location` をそのまま見せる。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpToolInstallPlan {
    /// `winget` / `brew` / `manual`。
    pub manager: String,
    /// 実行する (または利用者が実行する) コマンドライン。表示用。
    pub command: String,
    /// インストール先 (この PC 上のディレクトリ)。
    pub location: String,
    /// アプリから実行できるか (パッケージマネージャが見つかったか)。
    pub one_click: bool,
}

/// ツールを探す。`PATH` → 既知のインストール先の順。
pub fn resolve_dump_tool(binary: &str) -> Option<PathBuf> {
    find_in_path(binary).or_else(|| known_locations(binary).into_iter().find(|p| p.is_file()))
}

/// `PATH` から実行ファイルを探す (Windows は `.exe` も試す)。
fn find_in_path(binary: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| executable_in(&dir, binary))
}

fn executable_in(dir: &Path, binary: &str) -> Option<PathBuf> {
    let candidates: Vec<PathBuf> = if cfg!(windows) {
        vec![dir.join(format!("{binary}.exe")), dir.join(binary)]
    } else {
        vec![dir.join(binary)]
    };
    candidates.into_iter().find(|p| p.is_file())
}

/// `PATH` に通らないことが多い既知のインストール先 (新しい版を先に)。
fn known_locations(binary: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if cfg!(target_os = "macos") {
        // Homebrew の mysql-client / libpq は keg-only で PATH にリンクされない。
        let keg = if binary == "pg_dump" {
            "libpq"
        } else {
            "mysql-client"
        };
        for prefix in ["/opt/homebrew", "/usr/local"] {
            out.push(
                Path::new(prefix)
                    .join("opt")
                    .join(keg)
                    .join("bin")
                    .join(binary),
            );
            out.push(Path::new(prefix).join("bin").join(binary));
        }
        if binary == "mysqldump" {
            out.push(PathBuf::from("/usr/local/mysql/bin/mysqldump"));
        }
    } else if cfg!(windows) {
        let program_files = std::env::var_os("ProgramFiles")
            .map_or_else(|| PathBuf::from(r"C:\Program Files"), PathBuf::from);
        // MySQL: `MySQL\MySQL Server 8.4\bin`、PostgreSQL: `PostgreSQL\17\bin`。
        let (vendor, prefix) = if binary == "pg_dump" {
            ("PostgreSQL", "")
        } else {
            ("MySQL", "MySQL Server")
        };
        let base = program_files.join(vendor);
        let mut dirs: Vec<PathBuf> = std::fs::read_dir(&base)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter(|e| e.file_name().to_string_lossy().starts_with(prefix))
                    .map(|e| e.path())
                    .collect()
            })
            .unwrap_or_default();
        // 名前の降順 = おおむね新しい版が先 (8.4 > 8.0)。
        dirs.sort();
        dirs.reverse();
        for d in dirs {
            out.push(d.join("bin").join(format!("{binary}.exe")));
        }
    }
    out
}

/// Homebrew の実行ファイル (PATH → 既定のプレフィックス)。
fn find_brew() -> Option<PathBuf> {
    find_in_path("brew").or_else(|| {
        ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
            .into_iter()
            .map(PathBuf::from)
            .find(|p| p.is_file())
    })
}

/// この OS で案内する導入方法。`brew` / `winget` は検出結果を引数で受け取る (テスト用)。
fn install_plan(
    tool: DumpTool,
    os: &str,
    brew: Option<&Path>,
    winget_found: bool,
    program_files: &Path,
) -> Option<DumpToolInstallPlan> {
    match (tool, os) {
        (DumpTool::Mysqldump, "windows") => Some(DumpToolInstallPlan {
            manager: "winget".into(),
            command: "winget install --id Oracle.MySQL --exact --silent \
                      --accept-package-agreements --accept-source-agreements"
                .into(),
            location: program_files
                .join("MySQL")
                .join("MySQL Server <version>")
                .join("bin")
                .display()
                .to_string(),
            one_click: winget_found,
        }),
        (DumpTool::Mysqldump, "macos") => {
            // brew のプレフィックス (= brew 本体の 2 つ上)。未導入なら Apple Silicon の既定。
            let prefix = brew
                .and_then(|b| b.parent()?.parent().map(Path::to_path_buf))
                .unwrap_or_else(|| PathBuf::from("/opt/homebrew"));
            Some(DumpToolInstallPlan {
                manager: "brew".into(),
                command: "brew install mysql-client".into(),
                location: prefix
                    .join("opt")
                    .join("mysql-client")
                    .join("bin")
                    .display()
                    .to_string(),
                one_click: brew.is_some(),
            })
        }
        (DumpTool::Mysqldump, "linux") => Some(DumpToolInstallPlan {
            manager: "manual".into(),
            command: "sudo apt install default-mysql-client".into(),
            location: "/usr/bin".into(),
            one_click: false,
        }),
        (DumpTool::PgDump, "macos") => {
            let prefix = brew
                .and_then(|b| b.parent()?.parent().map(Path::to_path_buf))
                .unwrap_or_else(|| PathBuf::from("/opt/homebrew"));
            Some(DumpToolInstallPlan {
                manager: "brew".into(),
                command: "brew install libpq".into(),
                location: prefix
                    .join("opt")
                    .join("libpq")
                    .join("bin")
                    .display()
                    .to_string(),
                one_click: brew.is_some(),
            })
        }
        (DumpTool::PgDump, "linux") => Some(DumpToolInstallPlan {
            manager: "manual".into(),
            command: "sudo apt install postgresql-client".into(),
            location: "/usr/bin".into(),
            one_click: false,
        }),
        _ => None,
    }
}

fn current_plan(tool: DumpTool) -> Option<DumpToolInstallPlan> {
    let program_files = std::env::var_os("ProgramFiles")
        .map_or_else(|| PathBuf::from(r"C:\Program Files"), PathBuf::from);
    let brew = if cfg!(target_os = "macos") {
        find_brew()
    } else {
        None
    };
    let winget_found = cfg!(windows) && find_in_path("winget").is_some();
    install_plan(
        tool,
        std::env::consts::OS,
        brew.as_deref(),
        winget_found,
        &program_files,
    )
}

fn status_of(tool: DumpTool) -> DumpToolStatus {
    let path = resolve_dump_tool(tool.binary());
    DumpToolStatus {
        tool: tool.binary().to_string(),
        path: path.map(|p| p.display().to_string()),
        install: current_plan(tool),
    }
}

/// ダンプ用ツールがこの PC にあるかを調べ、無ければ導入方法を返す。
#[tauri::command]
pub async fn dump_tool_status(tool: String) -> Result<DumpToolStatus> {
    let tool = DumpTool::parse(&tool)?;
    tauri::async_runtime::spawn_blocking(move || status_of(tool))
        .await
        .map_err(|e| AppError::Other(format!("dump tool probe failed: {e}")))
}

/// ダンプ用ツールを OS のパッケージマネージャでこの PC に導入する。完了後に
/// 検出し直した結果を返す (インストール先が PATH に無くても `path` に出る)。
#[tauri::command]
pub async fn install_dump_tool(tool: String) -> Result<DumpToolStatus> {
    let tool = DumpTool::parse(&tool)?;
    let plan = current_plan(tool).filter(|p| p.one_click).ok_or_else(|| {
        AppError::InvalidInput(format!(
            "{} cannot be installed automatically on this system",
            tool.binary()
        ))
    })?;

    let mut cmd = match plan.manager.as_str() {
        "winget" => {
            let mut c = Command::new("winget");
            c.args([
                "install",
                "--id",
                "Oracle.MySQL",
                "--exact",
                "--silent",
                "--accept-package-agreements",
                "--accept-source-agreements",
            ]);
            c
        }
        "brew" => {
            let brew = find_brew().unwrap_or_else(|| PathBuf::from("brew"));
            let mut c = Command::new(brew);
            c.arg("install").arg(if tool == DumpTool::PgDump {
                "libpq"
            } else {
                "mysql-client"
            });
            // 対話プロンプトや自動アップデートで止まらないようにする。
            c.env("HOMEBREW_NO_AUTO_UPDATE", "1");
            c.env("NONINTERACTIVE", "1");
            c
        }
        _ => {
            return Err(AppError::InvalidInput(
                "this install method must be run manually".into(),
            ))
        }
    };
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    {
        // GUI アプリから起動したときにコンソール窓を出さない (CREATE_NO_WINDOW)。
        cmd.creation_flags(0x0800_0000);
    }

    let output = tokio::time::timeout(INSTALL_TIMEOUT, cmd.output())
        .await
        .map_err(|_| AppError::Other(format!("{} timed out", plan.manager)))?
        .map_err(AppError::Io)?;

    if !output.status.success() {
        let code = output
            .status
            .code()
            .map_or_else(|| "signal".to_string(), |c| c.to_string());
        return Err(AppError::Other(format!(
            "{} failed (exit {code}): {}",
            plan.manager,
            output_tail(&output.stdout, &output.stderr)
        )));
    }

    let status = tauri::async_runtime::spawn_blocking(move || status_of(tool))
        .await
        .map_err(|e| AppError::Other(format!("dump tool probe failed: {e}")))?;
    if status.path.is_none() {
        return Err(AppError::Other(format!(
            "{} finished, but {} was not found. Expected location: {}",
            plan.manager,
            tool.binary(),
            plan.location
        )));
    }
    Ok(status)
}

/// 失敗時に見せる出力の末尾 (stderr 優先、空なら stdout)。
fn output_tail(stdout: &[u8], stderr: &[u8]) -> String {
    let pick = if stderr.iter().any(|b| !b.is_ascii_whitespace()) {
        stderr
    } else {
        stdout
    };
    let text = String::from_utf8_lossy(pick);
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty())
        .collect();
    let start = lines.len().saturating_sub(OUTPUT_TAIL_LINES);
    lines[start..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_only_known_tools() {
        assert_eq!(DumpTool::parse("mysqldump").unwrap(), DumpTool::Mysqldump);
        assert_eq!(DumpTool::parse("pg_dump").unwrap(), DumpTool::PgDump);
        assert!(DumpTool::parse("rm").is_err());
        assert!(DumpTool::parse("mysqldump; rm -rf /").is_err());
    }

    #[test]
    fn windows_plan_uses_winget_and_points_at_program_files() {
        let plan = install_plan(
            DumpTool::Mysqldump,
            "windows",
            None,
            true,
            Path::new(r"C:\Program Files"),
        )
        .unwrap();
        assert_eq!(plan.manager, "winget");
        assert!(plan.one_click);
        assert!(plan.command.contains("Oracle.MySQL"));
        assert!(plan.location.contains("MySQL Server"));
        let no_winget = install_plan(
            DumpTool::Mysqldump,
            "windows",
            None,
            false,
            Path::new("C:/PF"),
        )
        .unwrap();
        assert!(!no_winget.one_click);
    }

    #[test]
    fn macos_plan_derives_keg_path_from_brew_prefix() {
        let plan = install_plan(
            DumpTool::Mysqldump,
            "macos",
            Some(Path::new("/usr/local/bin/brew")),
            false,
            Path::new("/"),
        )
        .unwrap();
        assert_eq!(plan.command, "brew install mysql-client");
        // Path::join は実行 OS の区切り文字を使うので、期待値も同じ組み立て方で作る
        // (Windows の CI では `\` になる)。
        let keg = |prefix: &str| {
            Path::new(prefix)
                .join("opt")
                .join("mysql-client")
                .join("bin")
                .display()
                .to_string()
        };
        assert_eq!(plan.location, keg("/usr/local"));
        assert!(plan.one_click);
        let no_brew =
            install_plan(DumpTool::Mysqldump, "macos", None, false, Path::new("/")).unwrap();
        assert!(!no_brew.one_click);
        assert_eq!(no_brew.location, keg("/opt/homebrew"));
    }

    #[test]
    fn linux_plan_is_manual_only() {
        let plan = install_plan(DumpTool::Mysqldump, "linux", None, false, Path::new("/")).unwrap();
        assert_eq!(plan.manager, "manual");
        assert!(!plan.one_click);
        assert!(install_plan(DumpTool::PgDump, "windows", None, true, Path::new("/")).is_none());
    }

    #[test]
    fn output_tail_prefers_stderr_and_keeps_last_lines() {
        let stderr: String = (0..20).map(|i| format!("line {i}\n")).collect();
        let tail = output_tail(b"ignored", stderr.as_bytes());
        assert!(tail.starts_with("line 8"));
        assert!(tail.ends_with("line 19"));
        assert_eq!(output_tail(b"only stdout\n", b"  \n"), "only stdout");
    }

    #[test]
    fn executable_in_finds_files_only() {
        let dir = std::env::temp_dir().join(format!("noobdb-dump-tools-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(executable_in(&dir, "mysqldump").is_none());
        let name = if cfg!(windows) {
            "mysqldump.exe"
        } else {
            "mysqldump"
        };
        std::fs::write(dir.join(name), b"").unwrap();
        assert_eq!(executable_in(&dir, "mysqldump"), Some(dir.join(name)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
