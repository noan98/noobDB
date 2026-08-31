# セッション・ストリーミング・SSH トンネル

ストリーミング実行とキャンセル、SSH トンネル (多段含む) のライフタイム、セッション管理と再接続。

## ストリーミングクエリ実行とキャンセル

エディタからのクエリは `run_query_stream` (`commands/query.rs`) で実行され、結果は
イベント (`query-stream:columns` / `:rows` / `:done` / `:error`) として段階的に
フロントへ送られます。`run_query_stream` は Tokio タスクを spawn し、その
`AbortHandle` を `AppState.streams` にクライアント提供の `stream_id` で登録します。
`cancel_stream` がそのハンドルを abort し、ストリーミング future を drop することで
プールへ接続が返ります。`query_timeout_secs` が正のときは `tokio::time::timeout` で
実行全体をレースし、超過時は `AppError::Timeout` を返します。

「ドライラン」プレビュー (`preview_query_stream`) はトランザクション内で SQL を実行
してロールバックし、対象テーブルの before/after スナップショット (PK でペアリング) を
`preview-stream:*` イベントで返します。CSV インポート (`import_csv`) とインラインセル
編集 Apply (`run_query_transaction`) も同じストリーム/トランザクション方式
(all-or-nothing) を踏襲します。新しいストリーミングコマンドを足すときは、この
イベント命名・`register_stream`/`forget_stream`・`stream_id` フィルタの 3 点セットに
合わせてください。

**`stream_id` はクライアントが指定する値なので、登録は世代トークンで守ります。**
`register_stream` は登録ごとにトークンを発行して返し、`forget_stream(stream_id, token)`
はトークンが一致する登録だけを消します。これが無いと「同じ id を再利用した新しい
タスクの登録を、先に終わった古いタスクの後始末が消す」競合が起き、`cancel_stream` が
`{cancelled: false}` を返す**キャンセル不能なストリーム**が DB 接続や SSH トンネルを
掴んだまま残ります (接続試行側の `register_connect`/`forget_connect` (#684) と同じ
方式です)。

`preview_query_stream` も `run_query_stream` と同じく `query_timeout_secs` を受け取り
`tokio::time::timeout` でレースします。ドライランは読み取り専用セッションからも呼べる
ため、タイムアウトが無いとロック待ちする `UPDATE` のプレビューで接続と行ロックを無期限に
握れてしまいます。

なお、プレビューの before/after スナップショットを組み立てる純粋ロジック
(ユーザの `WHERE` の抽出、BEFORE で捕まえた PK による AFTER の取り直し) は
**`db/preview.rs`** に集約し、MySQL と PostgreSQL が共有します。ここを共有していな
かった頃は PostgreSQL 側だけ「PK 昇順の先頭 N 件」を撮るだけの実装で、対象行が窓の外に
あると diff が「変更なし」に見える取りこぼしがありました。方言差 (ドル引用、
`RETURNING` の切り落とし、`UPDATE ... FROM` / `DELETE ... USING` の失格判定) は
`SqlFlavor` で分岐します。

## SSH トンネルとセッションのライフタイム

`SshTunnel` (`ssh/tunnel.rs`) は OS が割り当てるポートでローカル TCP リスナを開き、
`russh` で SSH サーバへ接続し、認証し、インバウンド接続ごとに `direct-tcpip`
チャネルを開いて双方向にバイト列をパイプする accept ループを spawn します。認証方式は
`SshAuthMethod` の 3 種 — `Key` (秘密鍵 + 任意のパスフレーズ)、`Agent` (ssh-agent に
署名を委譲)、`Password` (パスワード認証) — で、`ssh/auth.rs` が振り分けます。セッションと
accept タスクの `JoinHandle` は構造体が所有しています。**`impl Drop` がタスクを abort し、
`Arc<russh::client::Handle>` の drop によって SSH セッションがクローズします。**

接続が SSH を使う場合、`commands::connection::build_options` はまずトンネルを開き、
その後 `127.0.0.1:<tunnel.local_port>` を指す `DbConnectOptions` を構築します。
`SshTunnel` は `Session._tunnel: Option<SshTunnel>` として保持され、DB 接続と
ぴったり同じ期間生存します。**接続より先にトンネルを drop してはいけません —
そうしないと sqlx は存在しない経路に再接続してしまいます。** `disconnect` は
マップから `Arc<Session>` を取り除き、最後の参照が drop されたタイミングで
`conn.close()` とトンネルの `Drop` の両方がトリガーされます。

**接続の全体タイムアウト・フェーズ進捗・キャンセル (#684)**: `connect` /
`test_connection` は `attempt_id` と `timeout_secs` を受け取り、`open_connection`
全体を `tokio::time::timeout` で包みます (既定 30s、5〜300s にクランプ。設定
`connectTimeoutSecs`)。超過時は詰まっていたフェーズを含む
`AppError::ConnectTimeout { phase, secs }` (kind `connectTimeout`) を返します。
接続中は `connect-progress:phase` イベントでフェーズ (`tunnel_connecting` /
`tunnel_authenticating` / `db_connecting`) を通知し (`SshTunnel::open_with_progress`
が SSH の接続/認証フェーズを報告)、フロントはフッターにフェーズ表示とキャンセルボタンを
出します。接続タスクは spawn して `AppState.connects` に `AbortHandle` を登録し、
`cancel_connect(attempt_id)` で中断できます (到達不能ホストで数分固まる問題の解消)。
`register_connect` は登録ごとにトークンを発行し、`forget_connect(attempt_id, token)` は
トークンが一致する登録のみ削除します — 同じ `attempt_id` を再利用した新しい試行の
ハンドルを、先に終わった旧タスクが誤って消してキャンセル不能にするのを防ぎます
(#684 レビュー対応)。

ホスト鍵検証は `ssh/handler.rs::ClientHandler::check_server_key` における
**初回信頼方式 (TOFU)** です。known_hosts ファイルは `<data_dir>/known_hosts` で、
1 行 1 エントリの `host:port fingerprint` 形式です。不一致の場合は
`russh::Error::UnknownKey` を返して接続を中断します。

**アプリ内での復旧 (#682)**: 不一致時、`ClientHandler` は新旧フィンガープリントを
共有スロットに記録し、`tunnel.rs` がそれを読んで
`AppError::SshHostKeyMismatch { host, port, expected, actual }` (kind
`sshHostKeyMismatch`。#683 の構造化エラー) を返します。known_hosts の読み書きは
`ssh/known_hosts.rs` に集約し (`list_known_hosts` / `forget_host_key` /
`set_host_key` / `parse` / アトミック書き込み `write_atomic`)、IPC
`list_known_hosts` / `forget_host_key` / `trust_host_key` で公開します。フロントは
接続失敗が `sshHostKeyMismatch` のとき `HostKeyMismatchDialog` (新旧 fingerprint
併記 + MITM 警告 + 「旧鍵を破棄して再接続」) を出し、設定画面の
`KnownHostsPanel` で一覧・個別破棄もできます。サーバ鍵ローテーション時に手編集は不要です
(旧来の手動削除も引き続き有効)。**再信頼はダイアログで承認した fingerprint を
`trust_host_key` で known_hosts に固定してから再接続します** (単なる forget + TOFU
では再接続時に提示された別の鍵まで信頼してしまうため。承認鍵をピン留めすることで、
再接続で別の鍵 = MITM が提示されたら再び不一致として拒否されます。#682 レビュー対応。
メッセージから fingerprint を取れない場合のみ従来の forget + TOFU にフォールバック)。

**`SshHostKeyMismatch` のメッセージ書式も #880 / #988 と同じ方式で固定します
(#1030)。** バック (`error.rs` の `#[error(...)]` テンプレート) がメッセージを
**生成**し、フロント (`parseHostKeyFingerprints`、
`src/components/hostKeyFingerprints.ts`) がそれを 2 本の正規表現で**パース**して
新旧 fingerprint と失敗ホップの `host:port` を復元する、という生成⇔パースの
二重実装が手写しの文字列リテラルだけで繋がっていた穴を埋めます。共有ベクタ
`src/__tests__/fixtures/sshHostKeyMismatchVectors.json` (`{host, port, expected,
actual}` の入力と厳密なレンダリング後メッセージ) を `sshHostKeyMismatchGolden.test.ts`
と `tests/ssh_host_key_mismatch_golden.rs` の双方へ通し、前者は
`parseHostKeyFingerprints` の抽出結果、後者は `AppError::SshHostKeyMismatch{..}.
to_string()` を固定します。IPv4/非標準ポート (多段トンネルの踏み台)/FQDN/レガシー
形式 fingerprint (SHA256 未移行)/**IPv6 ホスト (`:` を含む)** を含みます。

**IPv6 ホストの host/port 抽出 (#1053)。** endpoint 抽出用正規表現は元々
`([^\s:]+):(\d+):` で、ホストに `:` を許さないため IPv6 (`2001:db8::1` のような
バックエンドが実際に生成する非角括弧形式) では host/port が `undefined` になる
既知の境界でした (fingerprint 自体は別の正規表現で取れるため
`parseHostKeyFingerprints` 全体は `null` にならず、host/port だけが欠損する部分的な
情報欠損)。#708 の多段トンネルでは踏み台側で鍵が変わった場合に実際に失敗した段の
`host:port` へピン留めする精度に関わるため、`parseHostKeyFingerprints`
(`src/components/hostKeyFingerprints.ts`) 側で解消しました。ホストに `:` を禁止する
代わりに、このメッセージ書式で常にポートの直後に来るリテラル `": stored
fingerprint"` へアンカーし、ホストのキャプチャを非貪欲 (`+?`) にすることで、
ホストが何個 `:` を含んでいても文字列中の**最後**の `<port>: stored fingerprint`
境界へ自然に収束させています (バックエンドは非角括弧形式しか生成しませんが、
`[2001:db8::1]:2222` の角括弧形式も曖昧さの無い表記として明示的に先に試します)。
バックエンド (`error.rs` のテンプレート) は変更していません — フロント側のパース
強化のみで解消できたため、生成⇔パースの書式そのものは #1030 のゴールデンが
引き続き固定します。known_hosts の `host:port` エンコード
(`ssh/known_hosts.rs::parse_known_hosts`) はもともと最後の `:` で区切る
`rsplit_once` を使っており、IPv6 ホストでも曖昧にならないため無改修です。

## 多段 SSH トンネル (ProxyJump 相当) と ~/.ssh/config の読み込み (#708)

`SshTunnel` は踏み台 (bastion/jump ホスト) を 1 段だけ経由する多段構成に対応します
(ローカル → 踏み台 → 最終 SSH ホスト → DB、計 2 ホップまで)。プロトコルレベルで
`direct-tcpip` を入れ子にする実装ではなく、**既存のローカルポートフォワード
プリミティブをそのままチェーンする**設計です: 踏み台の `SshTunnel` を先に開いて
ローカルポートを得た後、最終ホップの SSH セッションは (踏み台の実アドレスではなく)
`127.0.0.1:<踏み台の local_port>` へダイヤルして張ります。ホスト鍵の検証/記録は
**ダイヤル先ではなく各ホップ自身の実 `host:port`** を使うため (`ClientHandler::new`
に渡す識別子と実際に接続するソケットアドレスを分離)、known_hosts には従来どおり
段ごとの実サーバが `host:port fingerprint` で記録されます。

- **型**: `SshConfig` (`ssh/tunnel.rs`) に `jump: Option<Box<SshJumpConfig>>` を
  追加。`SshJumpConfig` は `SshConfig` から `remote_host`/`remote_port` と自身の
  `jump` を除いた同形の構造体 (踏み台は常に「次のホップの実アドレス」へ転送する
  ため `remote_*` は暗黙)。プロファイル側も対称に `SshProfile.jump:
  Option<SshJumpProfile>` を持ちます。
- **ライフタイム/Drop 順序**: `SshTunnel` は自身の `_upstream: Option<Box<SshTunnel>>`
  を**構造体の最後のフィールド**として保持します。Rust の構造体フィールドは
  **宣言順に drop される**ため、`impl Drop` 本体 (accept タスク/転送タスクの
  abort) が走った後、`_session` (この段の SSH セッション) → `_upstream`
  (踏み台。再帰的に同じ Drop を辿る) の順で閉じます。これにより「DB 接続 → 末段
  (target) → 先頭段 (bastion)」の順序が保証され、既存の「トンネルは DB 接続より
  先に drop しない」不変条件がチェーン全体へ自然に拡張されます。
- **エラーの段別属性化**: `ssh::tunnel::tag_hop_error` (非公開) が `AppError::Ssh`
  / `AppError::SshKey` のメッセージへ `[jump host <host>:<port>]` /
  `[ssh host <host>:<port>]` のプレフィックスを付けます。`kind()` は変えない
  (フロントの分類は従来どおり `ssh`) — メッセージだけがどちらの段の失敗かを示す
  手がかりを増やします。`AppError::SshHostKeyMismatch` は元々 `host`/`port` を
  持つため追加のタグ付けは不要で、その `host`/`port` は常に**実際に不一致が
  起きた段**の識別子です (フロントの `parseHostKeyFingerprints` がメッセージから
  これを抽出し、`App.tsx` の再信頼フローはプロファイルの主 SSH ホストではなく
  こちらを使います — 踏み台側で鍵が変わった場合に正しいエンドポイントを
  pin できるようにするため)。
- **秘密情報**: 踏み台の passphrase / password は既存の `ssh_passphrase` /
  `ssh_password` (最終ホップ用、後方互換のため名前は据え置き) とは別の keyring
  kind (`ssh_passphrase_hop0` / `ssh_password_hop0`、`profiles/secrets.rs`) に
  保存します。`profiles::secrets::delete_all` も両方を消します。
- **reconnect (#712) との整合**: `Session.reconnect_ssh: Option<SshConfig>` は
  `jump` を含めたまま非秘密フィールドのみを保持し (`reconnect_ssh_from` が両
  ホップの secrets を空文字にする)、`reopen_transport` が再接続時に**踏み台側も**
  keyring から再解決します。
- **`~/.ssh/config` の読み込み**: `ssh::config_parser` (パス非依存の純粋パーサ、
  副作用なし) が `Host` ブロックから `HostName` / `Port` / `User` /
  `IdentityFile` / `ProxyJump` を解決します。ワイルドカードパターン・`Include`・
  `Match` は非対応、"first obtained value wins" という OpenSSH 本来の規則には
  従います。IPC `resolve_ssh_config_host(alias)` (`commands/ssh.rs`) が
  `~/.ssh/config` (`%USERPROFILE%\.ssh\config`) を読んで解決し、`ProxyJump` は
  `config_parser::parse_proxy_jump` で最初の 1 ホップのみ `host`/`port`/`user` に
  分解します (本アプリのトンネルが 2 ホップまでのため)。**読み取り専用・保存時
  一度きりのコピー**であり、接続時に設定ファイルを再参照することはありません。
  `ConnectionForm` の「SSH ホスト」欄にエイリアスを入力して
  「~/.ssh/config から読み込む」を押すと、解決された値 (と `ProxyJump` があれば
  踏み台欄) がフォームへ展開されます。

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
