---
name: noobdb-storage
description: noobDB のプロファイル・秘密情報 (keyring) の分離、JSON ストア (profiles/snippets/sandboxes/tasks) の書き込み規約、クエリ履歴、ログシステム、ファイル読み書きコマンドを変更するときに読む。
---

# noobDB のプロファイル・秘密情報・ローカル永続化

## 絶対に守る分離

| 置き場所 | 入れるもの |
|---|---|
| `profiles.json` (data_dir) | **非秘密のみ** — 名前・ホスト・ポート・ユーザ・SSH 設定・TLS 証明書の**パス**・`init_sql` など |
| OS keyring (サービス名 `noobDB`) | **秘密のみ** — `db_password` / `ssh_passphrase` / `ssh_password` (+ 踏み台用の `*_hop0`) |

- **秘密情報を `profiles.json` に入れない。ログにも出さない。**
- `save_profile` の `Option<String>` は 3 状態: `None` = 変更なし、`Some("")` =
  keyring から削除、`Some(v)` = 設定。
- `delete_profile` は孤立資格情報を残さないよう最初に `secrets::delete_all` を呼ぶ。
- 唯一の例外は `reveal_profile_secret` (#938)。**値をどこにも残さない**ことが
  条件で、新しい秘密の種類を足すときは `SecretKind` と フロントの
  `ProfileSecretKind` の**両方**に追加します。

## JSON ストア 4 種 (`profiles` / `snippets` / `sandboxes` / `tasks`) の必須対策

Tauri の `#[tauri::command] async fn` は同一プロセス内で**並行実行される**ため、
次の 2 つが揃っていないと壊れます。

1. `write_atomic` の一時ファイル名に PID **とプロセス内の単調増加カウンタ**を含める
   (PID だけだと 2 本の `save_all` が同じ一時ファイルを truncate し、混ざった内容が
   rename されて**アトミック書き込みの保証自体が壊れます**)。
2. `load_all` → 変更 → `save_all` の read-modify-write 全体をストア単位の `Mutex` で
   直列化する (無いと後勝ちで lost update)。

**新しい read-modify-write を足すときは内部の `*_locked` 版を呼んでください** —
公開関数を呼ぶと同一 Mutex の再取得でデッドロックします。

## 参照

| ファイル | 内容 |
|---|---|
| `references/profiles-and-secrets.md` | 保存先の詳細、keyring のキー形式、`reveal_profile_secret` の設計条件 |
| `references/history-and-snippets.md` | `history.sqlite` の記録方針、スニペットの scope |
| `references/logs-and-files.md` | ログのローテーション、`read_text_file` / `write_binary_file` の上限 |
