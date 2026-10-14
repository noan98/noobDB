---
name: noobdb-storage
description: noobDB のプロファイル・秘密情報 (keyring) の分離、JSON ストア (profiles/snippets/sandboxes/tasks) の書き込み規約、クエリ履歴、ログシステム、ファイル読み書きコマンドを変更するときに読む。
---

# noobDB のプロファイル・秘密情報・ローカル永続化

## 絶対に守る分離

| 置き場所 | 入れるもの |
|---|---|
| `profiles.json` (data_dir) | **非秘密のみ** — 名前・ホスト・ポート・ユーザ・SSH 設定・TLS 証明書の**パス**・`init_sql` など |
| OS keyring (サービス名 `noobDB`) | **秘密のみ** — `db_password` / `ssh_passphrase` / `ssh_password` (+ 踏み台用の `*_hop0`)、および AI 基盤 (#690) の Anthropic API キー `ai/anthropic_api_key` (プロファイルに属さない名前空間 `ai`。暗号化バックアップ (#710) の対象外で、エクスポートにも含まれない) |

- **秘密情報を `profiles.json` に入れない。ログにも出さない。**
- `save_profile` の `Option<String>` は 3 状態: `None` = 変更なし、`Some("")` =
  keyring から削除、`Some(v)` = 設定。
- `delete_profile` は孤立資格情報を残さないよう最初に `secrets::delete_all` を呼ぶ。
- 唯一の例外は `reveal_profile_secret` (#938)。**値をどこにも残さない**ことが
  条件で、新しい秘密の種類を足すときは `SecretKind` と フロントの
  `ProfileSecretKind` の**両方**に追加します。

## JSON ストア (`profiles` / `snippets` / `sandboxes` / `tasks` / `ai_usage`) の必須対策

Tauri の `#[tauri::command] async fn` は同一プロセス内で**並行実行される**ため、
次の 2 つが揃っていないと壊れます。

1. `write_atomic` の一時ファイル名に PID **とプロセス内の単調増加カウンタ**を含める
   (PID だけだと 2 本の `save_all` が同じ一時ファイルを truncate し、混ざった内容が
   rename されて**アトミック書き込みの保証自体が壊れます**)。
2. `load_all` → 変更 → `save_all` の read-modify-write 全体をストア単位の `Mutex` で
   直列化する (無いと後勝ちで lost update)。

**新しい read-modify-write を足すときは内部の `*_locked` 版を呼んでください** —
公開関数を呼ぶと同一 Mutex の再取得でデッドロックします。

### 書き込み・破損対策の使い分け (#1593)

- ユーザが選んだパスへ書き出すファイル (SQL 保存・バイナリ保存・プロファイル書き出し) は `atomic_write::write_atomic` (一時ファイル → `rename`。既存のパーミッションと symlink を維持)。アプリのデータディレクトリ内の JSON ストアは各ストアの `write_atomic`。
- `{ "<key>": [...] }` 形式のストア (snippets / sandboxes) は `json_tolerant::parse_items` / `unparsable_raw` / `build_with_raw` で 1 件の不正を読み飛ばして書き戻す。トップレベルの形が違うときは `quarantine_if_unexpected_shape`、JSON 破損は `corrupt_backup_path` で `.corrupt-*` へ退避して空から再開する (assertions / tasks も同じ)。

## AI 使用量台帳 (`ai_usage.json`, #1540)

- `ai/usage.rs` が持つ JSON ストア (data_dir)。日 (JST) × タスク種別 × モデルの**トークン数と回数だけ**を
  積む。API キー・送信内容・応答は入れない。400 日を超えた日は書き込み時に捨てる。
- 上記 2 つの必須対策 (一時ファイル名に PID + カウンタ、ストア単位 `Mutex` で read-modify-write を直列化)
  を満たす。同期 I/O なので `tauri::async_runtime::spawn_blocking` で実行する (記録は fire-and-forget、
  失敗は `warn` ログのみ)。壊れたファイルは `ai_usage.json.bak` へ退避して空から始める。
- 概算コストは保存せず、フロント `aiModels.ts` の単価表で表示時に掛ける。

## 参照

| ファイル | 内容 |
|---|---|
| `references/profiles-and-secrets.md` | 保存先の詳細、keyring のキー形式、`reveal_profile_secret` の設計条件 |
| `references/history-and-snippets.md` | `history.sqlite` の記録方針、スニペットの scope |
| `references/logs-and-files.md` | ログのローテーション、`read_text_file` / `write_binary_file` の上限 |
