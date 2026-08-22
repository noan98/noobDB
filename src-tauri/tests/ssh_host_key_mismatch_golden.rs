//! `AppError::SshHostKeyMismatch` のメッセージ書式ゴールデンテスト — バック側 (#1030)。
//!
//! ホスト鍵不一致からの再信頼フロー (#682) は、バックが `thiserror` の
//! `#[error(...)]` テンプレート (`error.rs`) で**生成**したメッセージを、フロントが
//! `parseHostKeyFingerprints` (`src/components/hostKeyFingerprints.ts`) の 2 本の
//! 正規表現で**パース**して新旧 fingerprint と失敗ホップの `host:port` を復元する、
//! という生成⇔パースの二重実装の上に立つ。両者を繋ぐのは手写しの文字列リテラルだけで、
//! 何も強制していなかった (#880 / errorHint ゴールデンと同型の穴)。
//!
//! ここでは共有ベクタ (`src/__tests__/fixtures/sshHostKeyMismatchVectors.json`) を
//! `include_str!` で読み込み、`{host, port, expected, actual}` から構築した
//! `AppError::SshHostKeyMismatch` の `.to_string()` がフィクスチャの `message`
//! (厳密なレンダリング後メッセージ) と一致することを検証する。フロント側は同じ JSON を
//! `src/__tests__/sshHostKeyMismatchGolden.test.ts` が読み、`parseHostKeyFingerprints`
//! に同じ `message` を通した結果を検証する。片方だけテンプレート/正規表現を変えて
//! ズレると、どちらかのテストが落ちる。

use noobdb_lib::__test_api::AppError;
use serde::Deserialize;

const VECTORS_JSON: &str =
    include_str!("../../src/__tests__/fixtures/sshHostKeyMismatchVectors.json");

#[derive(Deserialize)]
struct Vectors {
    cases: Vec<VectorCase>,
}

#[derive(Deserialize)]
struct VectorCase {
    id: String,
    #[allow(dead_code)] // フロント側テストの説明表示専用。
    note: String,
    host: String,
    port: u16,
    expected: String,
    actual: String,
    message: String,
    // parsedHost / parsedPort はフロント側 (sshHostKeyMismatchGolden.test.ts) が
    // parseHostKeyFingerprints の抽出結果を検証するために使う。バックは
    // レンダリングのみを担当するのでここでは読まない。
}

fn load() -> Vectors {
    serde_json::from_str(VECTORS_JSON)
        .expect("shared ssh host-key mismatch vectors must be valid JSON")
}

#[test]
fn ssh_host_key_mismatch_message_matches_shared_vectors() {
    let vectors = load();

    assert!(
        vectors.cases.len() >= 5,
        "expected at least 5 shared vectors, got {}",
        vectors.cases.len()
    );

    let mut seen_ids = std::collections::HashSet::new();
    let mut failures = Vec::new();

    for case in &vectors.cases {
        assert!(
            seen_ids.insert(case.id.clone()),
            "duplicate case id in shared ssh host-key mismatch vectors: {}",
            case.id
        );

        let err = AppError::SshHostKeyMismatch {
            host: case.host.clone(),
            port: case.port,
            expected: case.expected.clone(),
            actual: case.actual.clone(),
        };
        let actual_message = err.to_string();
        if actual_message != case.message {
            failures.push(format!(
                "  - [{}] AppError::SshHostKeyMismatch のレンダリング結果がズレています:\n      \
                 expected: {:?}\n      got:      {:?}",
                case.id, case.message, actual_message
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "AppError::SshHostKeyMismatch の Display 出力が共有ゴールデンベクタとズレています \
         (フロント parseHostKeyFingerprints の正規表現とズレる可能性があります):\n{}",
        failures.join("\n")
    );
}
