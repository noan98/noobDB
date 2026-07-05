//! AppError の Display 出力と errorHints.ts のヒント/イラスト判定のフロント/バック
//! 整合性ゴールデンテスト — バック側 (#667)。
//!
//! バックの `AppError` (`src-tauri/src/error.rs`) は `Display` 文字列としてフロント
//! へシリアライズされ (`error.rs::Serialize`)、フロントの `src/errorHints.ts` が
//! その文字列を人間向けのヒント/イラストへ独立に対応付けている。両者は別実装なので
//! `AppError` の文言を変えると `errorHints.ts` のマッチが静かに外れるドリフトが
//! 起こり得る (#444 の読み取り専用二重実装と同じ問題構造)。
//!
//! ここでは両者が参照する共有ベクタ (`src/__tests__/fixtures/errorHintVectors.json`)
//! を `include_str!` で読み込み、`backendKind` ごとに次を検証する:
//!
//! - `"native"`: フィクスチャの `variant` / `arg` から実際に `AppError` バリアント
//!   を構築し、その `Display` 出力 (`.to_string()`) がフィクスチャの `message` と
//!   **厳密一致**することを検証する。`error.rs` の `#[error(...)]` 文言を変えると
//!   ここが即座に落ちる。
//! - `"sqlxProtocol"`: MySQL/PostgreSQL/SQLite 固有の `Box<dyn DatabaseError>` を
//!   汎用テストコードで組み立てるのは実用的でないため、任意の文字列を運べる
//!   `sqlx::Error::Protocol` を運び役 (carrier) として使い、
//!   `AppError::Sqlx(sqlx::Error::Protocol(message))` の `Display` 出力が
//!   `message` を欠落・改変せずに包んでいることを contains 検証する。これは
//!   `AppError::Sqlx` の `#[error("sqlx error: {0}")]` フォーマットから `{0}` が
//!   消える (= 内部エラーメッセージがユーザに届かなくなる) ような変更を検知する。
//!
//! フロント側は同じ JSON を `src/__tests__/errorHintGolden.test.ts` が import し、
//! `matchErrorHint` / `illustrationForError` の判定を対になる形で検証する。
//! 片方の実装だけ変えてズレが生じると、どちらかのテストが落ちる。

use noobdb_lib::__test_api::AppError;
use serde::Deserialize;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/errorHintVectors.json");

#[derive(Deserialize)]
struct Vectors {
    cases: Vec<VectorCase>,
}

#[derive(Deserialize)]
struct VectorCase {
    id: String,
    #[allow(dead_code)] // フロント側テストの説明表示専用。バックでは使わない。
    note: String,
    #[serde(rename = "backendKind")]
    backend_kind: String,
    variant: Option<String>,
    arg: Option<String>,
    message: String,
    // hintKey / illustration はフロント (errorHintGolden.test.ts) が検証する。
    // バック側はここでの Display 出力の整合性のみを担当する。
}

/// フィクスチャの `variant` / `arg` から対応する `AppError` を構築する。
/// `error.rs` に新しいバリアントを追加してこのゴールデンの対象にする場合は、
/// ここにも分岐を追加すること。
fn build_native(variant: &str, arg: Option<&str>) -> AppError {
    match variant {
        "SessionNotFound" => {
            AppError::SessionNotFound(arg.expect("SessionNotFound requires arg").to_string())
        }
        "ProfileNotFound" => {
            AppError::ProfileNotFound(arg.expect("ProfileNotFound requires arg").to_string())
        }
        "InvalidInput" => {
            AppError::InvalidInput(arg.expect("InvalidInput requires arg").to_string())
        }
        "ReadOnly" => AppError::ReadOnly(arg.expect("ReadOnly requires arg").to_string()),
        "Timeout" => {
            let secs: u64 = arg
                .expect("Timeout requires arg")
                .parse()
                .expect("Timeout arg must be a valid u64");
            AppError::Timeout(secs)
        }
        "Ssh" => AppError::Ssh(arg.expect("Ssh requires arg").to_string()),
        "SshKey" => AppError::SshKey(arg.expect("SshKey requires arg").to_string()),
        "Io" => AppError::Io(std::io::Error::other(
            arg.expect("Io requires arg").to_string(),
        )),
        "Keyring" => AppError::Keyring(arg.expect("Keyring requires arg").to_string()),
        "ConfigDir" => AppError::ConfigDir,
        "Other" => AppError::Other(arg.expect("Other requires arg").to_string()),
        other => panic!(
            "error_hint_golden.rs の build_native が未対応の variant: {other} (フィクスチャと \
             このテストファイルの対応表を両方更新してください)"
        ),
    }
}

#[test]
fn error_hint_golden_matches_shared_vectors() {
    let vectors: Vectors =
        serde_json::from_str(VECTORS_JSON).expect("shared error-hint vectors must be valid JSON");

    // 取りこぼし防止: フロント側 (errorHintGolden.test.ts) と同じ下限を要求する。
    assert!(
        vectors.cases.len() >= 30,
        "expected at least 30 shared vectors, got {}",
        vectors.cases.len()
    );

    // id の一意性 (フロント側と同じ観点を後で追いやすくするため)。
    let mut seen_ids = std::collections::HashSet::new();
    for case in &vectors.cases {
        assert!(
            seen_ids.insert(case.id.clone()),
            "duplicate case id in shared vectors: {}",
            case.id
        );
    }

    let mut failures = Vec::new();
    for case in &vectors.cases {
        match case.backend_kind.as_str() {
            "native" => {
                let variant = case
                    .variant
                    .as_deref()
                    .unwrap_or_else(|| panic!("[{}] native ケースには variant が必要", case.id));
                let err = build_native(variant, case.arg.as_deref());
                let actual = err.to_string();
                if actual != case.message {
                    failures.push(format!(
                        "  - [{}] native AppError::{variant} の Display が期待値とズレています: \
                         expected {:?}, got {:?}",
                        case.id, case.message, actual
                    ));
                }
            }
            "sqlxProtocol" => {
                // 実際の DB ドライバは `sqlx::Error::Database` (Box<dyn DatabaseError>) で
                // 届くが、汎用テストコードから任意のドライバ固有エラー型を安全に構築する
                // 手段がないため、同じく AppError::Sqlx でラップされる `Protocol` variant を
                // 運び役として使う。ここで検証したいのは「AppError::Sqlx のフォーマット
                // 文字列が内側のメッセージを欠落・改変せずに包んでいるか」であり、
                // Protocol でも Database でも AppError::Sqlx の `#[error("sqlx error: {0}")]`
                // という外側のフォーマットは共通なので、この代替は妥当。
                let err = AppError::Sqlx(sqlx::Error::Protocol(case.message.clone()));
                let actual = err.to_string();
                if !actual.contains(&case.message) {
                    failures.push(format!(
                        "  - [{}] AppError::Sqlx でラップすると message が失われています: \
                         message={:?}, wrapped={:?}",
                        case.id, case.message, actual
                    ));
                }
            }
            other => failures.push(format!(
                "  - [{}] 未知の backendKind: {other:?} (\"native\" か \"sqlxProtocol\" のみ対応)",
                case.id
            )),
        }
    }

    assert!(
        failures.is_empty(),
        "AppError の Display 出力が共有ゴールデンベクタとズレています (フロント errorHints.ts \
         とズレる可能性があります):\n{}",
        failures.join("\n")
    );
}
