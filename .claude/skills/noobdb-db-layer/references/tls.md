# TLS / SSL 設定 (#520)

build_options` が SQLite を最初に短絡処理します)。

## TLS / SSL 設定 (#520)

MySQL / PostgreSQL の接続は TLS をファーストクラスでサポートします。
`DbConnectOptions` の `ssl_mode` (`SslMode` enum: `disable` / `prefer` / `require` /
`verify_ca` / `verify_full`) と証明書パス 3 種 (`ssl_root_cert` = CA、
`ssl_client_cert` / `ssl_client_key` = mTLS) がドライバ非依存の共通表現で、各ドライバの
`connect` 内の `apply_tls` がそれぞれの sqlx enum へマッピングします (PostgreSQL は
`PgSslMode`、MySQL は `MySqlSslMode`。`verify_full` は MySQL の `VerifyIdentity` に対応)。
`ssl_mode = None` は sqlx 既定 (`prefer`/`preferred`) を維持するため、TLS 設定が無い
旧プロファイルは**後方互換**で従来どおり接続できます。空の証明書パス (`Some("")`) は
`non_empty` で「未設定」として扱います。SQLite は TLS 非対象で常に `None`。**証明書はパス
のみが非秘密フィールドとして `profiles.json` に保存され、ファイルの中身は接続時に読み込む
だけで保存しません (keyring も不要)**。UI は `ConnectionForm` の TLS セクション。SSH
トンネル併用時はドライバが 127.0.0.1 に接続するため `verify_full` のホスト名検証が失敗
しうる点をヘルプ (`formTlsSshHint`) に明記しています。

**TLS 統合テスト方針 (#520 の既知ギャップ、#795 で実装)**: `apply_tls` のモード
マッピングとパス正規化 (`non_empty`) は `db/mysql.rs` / `db/postgres.rs` の単体
テストが network 不要でカバーしていますが、実 TLS ハンドシェイク (CA 検証の成功/
失敗) は実サーバが要るため、既存の MySQL/PostgreSQL 統合テストと同じ環境変数ゲート
方式で `src-tauri/tests/tls_integration.rs` に追加しました。ゲートする環境変数は
`NOOBDB_TEST_MYSQL_TLS_URL` / `NOOBDB_TEST_POSTGRES_TLS_URL` (TLS 必須サーバの
接続 URL) と `NOOBDB_TEST_TLS_CA` (両サーバの証明書を発行した CA の PEM パス、
共通) の 3 つで、いずれか欠けている対応するテストはスキップされます。カバーする
観点は各ドライバにつき: `ssl_mode=require` での接続成立、`verify_ca`/`verify_full` +
正しい CA での接続成立、`verify_full` + CA 未指定 (システムのトラストストアには
自己署名 CA が入っていないため検証失敗) で `AppError` がエラーとして表面化する
こと (`connect` の戻り値は常に `Result<Connection, AppError>` なので `Err` である
こと自体が確認になる)。

**CI 配備 (`ci.yml` の `rust (test)` ジョブ) — 既存サービスコンテナとは別に TLS
必須の DB を独立して立てる方式を採用**: `scripts/ci-setup-tls-db.sh` が openssl で
自己署名 CA + サーバ証明書 (SAN に `127.0.0.1`/`localhost`) を生成し、
mysql-server/postgresql (ubuntu-latest ランナーに既定でプリインストール済み) を
**別ポート (3307/5433)** に TLS 必須 (`require_secure_transport=ON` /
`hostssl ... scram-sha-256` のみ許可) で起動して、上記 3 環境変数を `$GITHUB_ENV`
へ書き出します。既存の MySQL 8 / PostgreSQL 16 サービスコンテナ (3306/5432、平文)
はそのまま維持し、TLS インスタンスは完全に独立した並存構成です。

この方式を選んだ理由 (サービスコンテナの `services:` ブロックへ直接 TLS を組み込む
案との比較): GitHub Actions のサービスコンテナは**ジョブの他のどのステップよりも
前に起動する**ため、証明書をジョブ内で生成してからコンテナへ渡す手段が無く (ボリューム
マウントで後から流し込んでも mysqld/postgres は起動時にしか TLS 設定を読まない)、
かつ `services:` の workflow 構文には `command:` (エントリポイント引数の上書き) が
無いため、公式 postgres イメージへ `-c ssl=on -c ssl_cert_file=...` のような起動
引数を渡す手段も存在しません。対して「サービスコンテナに頼らず apt パッケージを
直接構成する」方式は、SSH トンネル統合テスト (#331、`scripts/ci-setup-sshd.sh`) で
既に実績のある同じパターンをそのまま踏襲でき、ローカルでも同一スクリプトで再現・
検証できます。CI ワークフロー本体の変更は「sshd と並列の background ステップ +
`wait:` への合流」1 箇所の追加のみで、既存のサービスコンテナ定義・カバレッジ計装・
ジョブ分割方針には一切手を入れていません (最小侵襲)。MySQL 側は Ubuntu の
AppArmor プロファイルがカスタム datadir/証明書パスを塞ぐことがあるため
`aa-complain` で complain モードに倒しています (プロファイルが存在しない環境では
