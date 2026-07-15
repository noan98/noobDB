//! AppError.kind (#683) のフロント/バック整合ゴールデンテスト — バック側。
//!
//! #683 で `AppError` は `{ kind, message }` の構造化 JSON でシリアライズされる。
//! フロント (`src/errorHints.ts`) は `kind` で確実に分類し、`message` パターンは
//! フォールバックに降格した。`kind` はバリアント由来の安定した判別子だが、フロントと
//! バックで別実装なので綴りや分類がズレるリスクがある。
//!
//! ここでは両者が参照する共有ベクタ (`src/__tests__/fixtures/errorKindVectors.json`)
//! を `include_str!` で読み込み、`backendKind` ごとに次を検証する:
//!
//! - `"native"`: `variant` / `arg` から `AppError` バリアントを構築し、その
//!   `.kind()` がフィクスチャの `kind` と一致することを検証する。
//! - `"sqlxProtocol"`: `AppError::Sqlx(sqlx::Error::Protocol(message))` を運び役に
//!   使い、`is_connection_lost` 判定に基づく `connectionLost` / `db` の振り分けを
//!   検証する (message に "unexpected end"/"connection"/"eof" を含むかで分岐)。
//!
//! フロント側は同じ JSON を `src/__tests__/errorKindGolden.test.ts` が読み、
//! `resolveErrorHint({kind, message})` の結果を検証する。片方だけ変えるとズレる。

use noobdb_lib::__test_api::AppError;
use serde::Deserialize;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/errorKindVectors.json");

#[derive(Deserialize)]
struct Vectors {
    cases: Vec<VectorCase>,
}

#[derive(Deserialize)]
struct VectorCase {
    id: String,
    #[allow(dead_code)] // フロント側テストの説明表示専用。
    note: String,
    #[serde(rename = "backendKind")]
    backend_kind: String,
    variant: Option<String>,
    arg: Option<String>,
    message: String,
    kind: String,
    // hintKey はフロント (errorKindGolden.test.ts) が検証する。バックは kind のみ担当。
}

/// フィクスチャの `variant` / `arg` から対応する `AppError` を構築する。
/// `error.rs` に新しいバリアントを追加してこのゴールデンの対象にする場合は、
/// ここにも分岐を追加すること。
fn build_native(variant: &str, arg: Option<&str>) -> AppError {
    match variant {
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
        // 構造化バリアント。フィクスチャの単一 `arg` には載らないので固定値で構築する
        // (このテストが見るのは `.kind()` の判別子のみ)。
        "SshHostKeyMismatch" => AppError::SshHostKeyMismatch {
            host: "ssh.example.com".into(),
            port: 22,
            expected: "SHA256:old".into(),
            actual: "SHA256:new".into(),
        },
        "ConnectTimeout" => AppError::ConnectTimeout {
            phase: "tunnel_connecting".into(),
            secs: 30,
        },
        other => panic!(
            "error_kind_golden.rs の build_native が未対応の variant: {other} (フィクスチャと \
             このテストファイルの対応表を両方更新してください)"
        ),
    }
}

#[test]
fn error_kind_golden_matches_shared_vectors() {
    let vectors: Vectors =
        serde_json::from_str(VECTORS_JSON).expect("shared error-kind vectors must be valid JSON");

    // id の一意性。
    let mut seen_ids = std::collections::HashSet::new();
    for case in &vectors.cases {
        assert!(
            seen_ids.insert(case.id.clone()),
            "duplicate case id in shared kind vectors: {}",
            case.id
        );
    }

    let mut failures = Vec::new();
    for case in &vectors.cases {
        let err = match case.backend_kind.as_str() {
            "native" => {
                let variant = case
                    .variant
                    .as_deref()
                    .unwrap_or_else(|| panic!("[{}] native ケースには variant が必要", case.id));
                build_native(variant, case.arg.as_deref())
            }
            "sqlxProtocol" => AppError::Sqlx(sqlx::Error::Protocol(case.message.clone())),
            other => {
                failures.push(format!("  - [{}] 未知の backendKind: {other:?}", case.id));
                continue;
            }
        };
        let actual = err.kind();
        if actual != case.kind {
            failures.push(format!(
                "  - [{}] AppError.kind() が期待値とズレています: expected {:?}, got {:?}",
                case.id, case.kind, actual
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "AppError.kind() が共有ゴールデンベクタとズレています (フロント errorHints.ts の \
         kind 分類とズレる可能性があります):\n{}",
        failures.join("\n")
    );
}
