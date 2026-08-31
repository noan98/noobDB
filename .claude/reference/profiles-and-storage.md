# プロファイル・秘密情報・ローカル永続化

`profiles.json` / keyring の厳密な分離、クエリ履歴、スニペット、ログ、ファイル読み書き。

## プロファイルと秘密情報 — 厳密な分離

- `profiles.json` (`directories::ProjectDirs` の data_dir — Windows では
  `%APPDATA%/noobDB`) には**秘密でない情報**をすべて保存します: 名前、ドライバ、
  ホスト、ポート、ユーザ、データベース、SSH ホスト / ポート / ユーザ / 認証方式 /
  鍵パス、`group`・`color`・`is_production`・`read_only`・`skip_history`、SQLite の
  `file_path`、TLS 設定 (`ssl_mode`・`ssl_root_cert`・`ssl_client_cert`・
  `ssl_client_key` の各**パス**。#520)、セッション初期化 SQL (`init_sql`。#522) など。
  証明書はパスのみが非秘密で、ファイルの中身は接続時に読み込むだけで保存しません。
  `profiles/store.rs` は load/save-all と upsert/delete の API を提供します。
  **JSON ストア 4 種 (`profiles` / `snippets` / `sandboxes` / `tasks`) は同じ 2 つの
  対策を必ず持ちます**: (1) `write_atomic` の一時ファイル名に PID **とプロセス内の
  単調増加カウンタ**を含める — Tauri の `#[tauri::command] async fn` は同一プロセス
  内で並行実行されるため、PID だけだと 2 本の `save_all` が同じ一時ファイルを
  `create`(truncate) して書き、混ざった内容が `rename` されて**アトミック書き込みの
  保証自体が壊れます**。(2) `load_all` → 変更 → `save_all` の read-modify-write 全体を
  ストア単位の `Mutex` で直列化する (`ssh/known_hosts.rs` の `KNOWN_HOSTS_LOCK` と
  同じパターン。poisoning は `into_inner` で回復) — 無いと後勝ちで他方の変更が消える
  lost update が起きます。ロックを持つ公開関数から内部の `*_locked` 版を呼ぶ構成に
  してあるので、**新しい read-modify-write を足すときは `*_locked` 側を使ってくださ
  い** (公開関数を呼ぶと同一 Mutex の再取得でデッドロックします)。
- OS の keyring (`keyring` クレート) には**秘密情報のみ**を保存します:
  `<profile_id>/db_password`・`<profile_id>/ssh_passphrase`・`<profile_id>/ssh_password`
  の 3 種を、サービス名 `noobDB` のもとに格納します。詳細は `profiles/secrets.rs`
  を参照してください。
- `save_profile` は秘密情報を `Option<String>` として受け取り、空文字列に意味を
  持たせます: `None` は変更なし、`Some("")` は keyring から削除、`Some(v)` は値を設定。
- `delete_profile` は孤立した資格情報を残さないよう、最初に `secrets::delete_all`
  を呼びます。
- **秘密情報を `profiles.json` に入れてはいけません**。また、ログにも出力しないで
  ください (`commands/connection.rs` の `log_attempt` はエンドポイントのメタ情報
  のみを記録します)。`password` / `passphrase` が空の接続要求は、`profile_id` をキー
  にした keyring の参照にフォールバックします (`resolve_password` /
  `resolve_passphrase` / `resolve_ssh_password` を参照)。
- **保存済み秘密の表示 (`reveal_profile_secret`、#938) はこの分離ポリシーの唯一かつ
  意図的な例外です。** 通常 `list_profiles` が返すのは `has_db_password` などの
  真偽値だけで値は含まれませんが、「自分で保存したパスワードを確認したい」ために
  資格情報マネージャ / Keychain / `secret-tool` を叩かせるのは体験が悪いため、
  接続フォームの目アイコンから明示的に呼ぶ読み出し口を用意しています。前提は
  「keyring を読めるのは OS ユーザ自身であり、そのユーザは同じ値を OS 標準ツール
  でも読める」こと — **アプリは新しい権限を得ておらず、既にあるアクセスへの導線を
  短くしているだけ**です。したがって守るべき性質は「値をどこにも残さない」ことに
  尽き、実装は次を満たします: 値をログに出さず**表示した事実だけ**を `warn` で
  監査記録する / 履歴・`profiles.json`・localStorage に一切書かない / フロントは
  `PasswordInput` の state にのみ保持し、再マスク・アンマウント・30 秒
  (`REVEAL_TIMEOUT_MS`) の経過で破棄する。**新しい秘密の種類を追加するときは
  `SecretKind` と `ProfileSecretKind` (フロント) の両方に足してください。**

## クエリ履歴

`history/store.rs` は data_dir 内の `history.sqlite` に SQLite (`sqlx`) で履歴を
記録します。プールは初回利用時に遅延オープンされ、`query_history` テーブルとインデックス
を `CREATE TABLE IF NOT EXISTS` で用意するため、新規インストールでもマイグレーション
手順は不要です。記録はストリーミング実行パスと書き込みパス (`run_query_transaction`・
`import_csv`) のみが行い、ページングや編集用の内部クエリは履歴を汚しません。記録は
ベストエフォートで、失敗してもログに残すだけで呼び出し元には伝播しません。`skip_history`
フラグが立ったセッションは一切記録しません。検索は SQL 本文への大小無視部分一致で、
LIKE ワイルドカードはエスケープされます。

## スニペット

`snippets/store.rs` は保存済み SQL を JSON ファイルに永続化します。`Snippet` は
`folder`・`tags`・対象 `driver` (任意)・`scope` (`SnippetScope`: `Any` / `Profile` /
`Group`) を持ち、scope で「どの接続のときに表示するか」を絞り込めます。プロファイルと
同じ 8 文字スラッグを ID に使います。

## ログシステム

`logs.rs` が `tracing` のイベントを `<data_dir>/noobdb.log` に書き込む**ファイルバックド
ログシンク** (`LogStore` + `MakeWriter` 実装の `LogWriter`) です。総容量 ~1 MiB を
active + backup の 2 セグメントで回し、active が半分に達したら rename してローテートします。
`lib.rs` 起動時に `logs::init()` を呼び、data_dir が取れない環境では stdout のみへ graceful
fallback します。`commands/logs.rs` の `read_logs` / `clear_logs` が設定画面のログビューア
向けに内容 (両セグメント連結) とファイルパスを返し、クリアします。

## ファイル読み込み

`commands/file.rs` の `read_text_file` は、エディタへドラッグ&ドロップされた `.sql` /
`.txt` ファイルをバックエンド経由で読み込むコマンドです。フロントから fs プラグインを
直接叩かず capabilities を最小に保つのが目的で、サイズ上限 8 MiB (`MAX_TEXT_FILE_BYTES`)、
不正 UTF-8 はロッシーデコード、空パス/不存在は拒否します。同ファイルの
`write_binary_file` は逆方向で、フロントが生成したバイト列 (チャート/ER 図の PNG・SVG
など。#643) を保存ダイアログ (`dialog:allow-save`) で選んだパスへ書き出します。同じく
fs プラグインを使わず capabilities を増やさないための経路で、サイズ上限 32 MiB
(`MAX_WRITE_FILE_BYTES`)・空パスを拒否します。チャート (`ChartView`) と ER 図
(`ERDiagramView`) の画像エクスポートは `components/imageExport.ts` (`html-to-image`
で計算済みスタイルを焼き込み、テーマ色をライト/ダーク両対応で反映) と
`components/ImageExportButton.tsx` (PNG 保存 / SVG 保存 / クリップボードコピーの
メニュー) が担い、ER 図は `getNodesBounds` で全景を `scale(1)` で書き出すため現在の
ズーム/パンに依存しません。
