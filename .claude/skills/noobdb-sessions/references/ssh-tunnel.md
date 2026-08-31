# SSH トンネルのライフタイムとホスト鍵検証

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
