# セッションと再接続

## セッション

`AppState` (`state.rs`) は `RwLock<HashMap<SessionId, Arc<Session>>>` と、進行中の
ストリームタスク用の `RwLock<HashMap<StreamId, AbortHandle>>` を保持します。`Session`
は `conn`・`profile_id`・`connect_options` (`mysqldump` など外部クライアント再構築用)・
`read_only` / `skip_history` フラグ・`reconnect_ssh` (再接続用の非秘密 SSH 設定。#712)・
`_tunnel` を持ちます。セッション ID は独自
アルファベット (`0`/`o`/`l`/`1` のような紛らわしい文字を含まない) から生成される、
8 文字の base32 風スラッグです。これらは keyring のターゲットプレフィックスとしても
使われるため、クロスプラットフォーム上で安全であるようアルファベットの選定が重要です。
セッションは常に `state.get(&id).await.ok_or(AppError::SessionNotFound(id))` で
参照してください。パターンは `commands::query::run_query` を参照し、セッションを扱う
新しいコマンドでも同じ方式を踏襲してください。

**切断からの再接続 (#712)**: `reconnect(session_id)` は、切れたセッションの接続を
**同じ `SessionId` のまま**その場で張り直します。`commands::connection::reconnect_inner`
が旧セッションの `connect_options` と `reconnect_ssh` (接続時に退避した非秘密 SSH 設定)
から、SSH トンネルを開き直し → 新しい `db::Connection` を確立し、**成功してから**
`AppState::replace` で `Arc<Session>` を差し替えます (差し替え後に旧 `conn.close()`、旧
トンネルは Arc drop で連動)。順序の不変条件は「新接続を先に確立、失敗したら旧セッションを
壊さずエラー」で、`reopen_transport` が失敗すれば旧セッションは無傷のまま `Err` を返します。
id が変わらないため、フロントのタブ・グリッド状態 (session id 紐付け) は退避/復元の往復なしで
生き続けます。秘密情報は `connect` と同方針 — DB パスワードは `connect_options` の保持値を
再利用し、SSH の passphrase / password は keyring から再解決するため**平文の保持を新たに
増やしません** (`reconnect_ssh` は非秘密フィールドのみ)。`read_only` / `skip_history`
フラグは保存されます。フロント (`App.tsx` の `runReconnectLoop`) は自動リトライ (指数
バックオフ) と手動フォールバックからこの `api.reconnect` を呼び、**本番プロファイル
(`is_production`) は自動リトライせず必ず手動**にします。再接続の常時実行テストは
`tests/sqlite_integration.rs::sqlite_reconnect_reestablishes_same_session` (接続を落として
→ 再接続 → 同じ id でクエリ成功、read_only 維持を検証。外部サーバ不要)。
