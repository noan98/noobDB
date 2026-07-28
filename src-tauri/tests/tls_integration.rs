//! Integration tests against **real TLS-enabled** MySQL / PostgreSQL servers
//! (#520 の既知ギャップ、#795 で追加)。
//!
//! `db/mysql.rs` / `db/postgres.rs` の単体テストは `apply_tls` のモード
//! マッピングとパス正規化を network 不要でカバーしているが、実 TLS ハンドシェイク
//! (CA 検証成功・失敗の両方) は実サーバが要るためここでしか検証できない。
//!
//! 以下の環境変数がいずれか欠けている対応するテストはスキップされる:
//!   - `NOOBDB_TEST_MYSQL_TLS_URL`    (例: mysql://root:rootpw@127.0.0.1:3307/testdb)
//!   - `NOOBDB_TEST_POSTGRES_TLS_URL` (例: postgres://postgres:postgres@127.0.0.1:5433/testdb)
//!   - `NOOBDB_TEST_TLS_CA`           (両サーバの自己署名証明書を発行した CA の PEM パス)
//!
//! ローカルでは `scripts/ci-setup-tls-db.sh` が上記 3 つを用意する
//! (CI では `rust (test)` ジョブが `$GITHUB_ENV` へ書き出す)。いずれも未設定なら
//! 全テストがスキップ経路を通り green になる (コンパイルは常に検証される)。

use noobdb_lib::__test_api as t;

fn mysql_tls_env() -> Option<(String, Option<String>)> {
    let url = std::env::var("NOOBDB_TEST_MYSQL_TLS_URL").ok()?;
    let ca = std::env::var("NOOBDB_TEST_TLS_CA").ok();
    Some((url, ca))
}

fn postgres_tls_env() -> Option<(String, Option<String>)> {
    let url = std::env::var("NOOBDB_TEST_POSTGRES_TLS_URL").ok()?;
    let ca = std::env::var("NOOBDB_TEST_TLS_CA").ok();
    Some((url, ca))
}

/// `ssl_mode=require` だけで (CA 検証なしに) TLS ハンドシェイクが成立し、通常どおり
/// クエリが実行できること。
#[tokio::test]
async fn mysql_tls_require_connects() {
    let Some((url, _)) = mysql_tls_env() else {
        eprintln!("skip: NOOBDB_TEST_MYSQL_TLS_URL not set");
        return;
    };
    let mut opts = t::parse_mysql_url(&url).expect("valid url");
    opts.ssl_mode = Some(t::SslMode::Require);

    let conn = t::connect(&opts).await.expect("connect over TLS (require)");
    let res = conn.execute("SELECT 1 AS n", None).await.expect("query");
    assert_eq!(res.rows.len(), 1);
    conn.close().await;
}

/// `verify_ca` + 正しい CA を渡すと、証明書チェーン検証込みで接続が成立すること。
#[tokio::test]
async fn mysql_tls_verify_ca_with_correct_ca_connects() {
    let Some((url, Some(ca))) = mysql_tls_env() else {
        eprintln!("skip: NOOBDB_TEST_MYSQL_TLS_URL / NOOBDB_TEST_TLS_CA not set");
        return;
    };
    let mut opts = t::parse_mysql_url(&url).expect("valid url");
    opts.ssl_mode = Some(t::SslMode::VerifyCa);
    opts.ssl_root_cert = Some(ca);

    let conn = t::connect(&opts)
        .await
        .expect("connect over TLS (verify_ca, correct CA)");
    conn.close().await;
}

/// `verify_full` + 正しい CA では、CA 検証に加えホスト名 (SAN) 検証も通って接続が
/// 成立すること (テスト用証明書は `127.0.0.1` を SAN に含む。
/// `scripts/ci-setup-tls-db.sh` 参照)。
#[tokio::test]
async fn mysql_tls_verify_full_with_correct_ca_connects() {
    let Some((url, Some(ca))) = mysql_tls_env() else {
        eprintln!("skip: NOOBDB_TEST_MYSQL_TLS_URL / NOOBDB_TEST_TLS_CA not set");
        return;
    };
    let mut opts = t::parse_mysql_url(&url).expect("valid url");
    opts.ssl_mode = Some(t::SslMode::VerifyFull);
    opts.ssl_root_cert = Some(ca);

    let conn = t::connect(&opts)
        .await
        .expect("connect over TLS (verify_full, correct CA)");
    conn.close().await;
}

/// `verify_full` で CA を指定しない (システムのトラストストアには自己署名 CA は
/// 入っていない) 場合、証明書検証に失敗して `AppError` としてエラーが表面化する
/// こと。`connect` の戻り値は常に `Result<Connection, AppError>` なので、Err である
/// こと自体が「AppError として表面化した」ことの確認になる。
#[tokio::test]
async fn mysql_tls_verify_full_without_ca_fails() {
    let Some((url, _)) = mysql_tls_env() else {
        eprintln!("skip: NOOBDB_TEST_MYSQL_TLS_URL not set");
        return;
    };
    let mut opts = t::parse_mysql_url(&url).expect("valid url");
    opts.ssl_mode = Some(t::SslMode::VerifyFull);
    opts.ssl_root_cert = None;

    match t::connect(&opts).await {
        Err(_) => {}
        Ok(_) => panic!(
            "verify_full without a trusted CA must fail certificate verification, but connect succeeded"
        ),
    }
}

/// `ssl_mode=require` だけで (CA 検証なしに) TLS ハンドシェイクが成立し、通常どおり
/// クエリが実行できること。
#[tokio::test]
async fn postgres_tls_require_connects() {
    let Some((url, _)) = postgres_tls_env() else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_TLS_URL not set");
        return;
    };
    let mut opts = t::parse_postgres_url(&url).expect("valid url");
    opts.ssl_mode = Some(t::SslMode::Require);

    let conn = t::connect(&opts).await.expect("connect over TLS (require)");
    let res = conn.execute("SELECT 1 AS n", None).await.expect("query");
    assert_eq!(res.rows.len(), 1);
    conn.close().await;
}

/// `verify_ca` + 正しい CA を渡すと、証明書チェーン検証込みで接続が成立すること。
#[tokio::test]
async fn postgres_tls_verify_ca_with_correct_ca_connects() {
    let Some((url, Some(ca))) = postgres_tls_env() else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_TLS_URL / NOOBDB_TEST_TLS_CA not set");
        return;
    };
    let mut opts = t::parse_postgres_url(&url).expect("valid url");
    opts.ssl_mode = Some(t::SslMode::VerifyCa);
    opts.ssl_root_cert = Some(ca);

    let conn = t::connect(&opts)
        .await
        .expect("connect over TLS (verify_ca, correct CA)");
    conn.close().await;
}

/// `verify_full` + 正しい CA では、CA 検証に加えホスト名 (SAN) 検証も通って接続が
/// 成立すること (テスト用証明書は `127.0.0.1` を SAN に含む。
/// `scripts/ci-setup-tls-db.sh` 参照)。
#[tokio::test]
async fn postgres_tls_verify_full_with_correct_ca_connects() {
    let Some((url, Some(ca))) = postgres_tls_env() else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_TLS_URL / NOOBDB_TEST_TLS_CA not set");
        return;
    };
    let mut opts = t::parse_postgres_url(&url).expect("valid url");
    opts.ssl_mode = Some(t::SslMode::VerifyFull);
    opts.ssl_root_cert = Some(ca);

    let conn = t::connect(&opts)
        .await
        .expect("connect over TLS (verify_full, correct CA)");
    conn.close().await;
}

/// `verify_full` で CA を指定しない場合、証明書検証に失敗して `AppError` として
/// エラーが表面化すること。
#[tokio::test]
async fn postgres_tls_verify_full_without_ca_fails() {
    let Some((url, _)) = postgres_tls_env() else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_TLS_URL not set");
        return;
    };
    let mut opts = t::parse_postgres_url(&url).expect("valid url");
    opts.ssl_mode = Some(t::SslMode::VerifyFull);
    opts.ssl_root_cert = None;

    match t::connect(&opts).await {
        Err(_) => {}
        Ok(_) => panic!(
            "verify_full without a trusted CA must fail certificate verification, but connect succeeded"
        ),
    }
}
