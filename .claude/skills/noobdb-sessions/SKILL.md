---
name: noobdb-sessions
description: noobDB のセッション管理・ストリーミングクエリ実行とキャンセル・SSH トンネル (多段/ProxyJump 含む)・ホスト鍵検証 (TOFU)・再接続を変更するとき、または新しいストリーミングコマンドを追加するときに読む。
---

# noobDB のセッション・ストリーミング・SSH トンネル

## 新しいストリーミングコマンドを足すときの 3 点セット

既存の `run_query_stream` / `preview_query_stream` / `import_csv` /
`export_query_stream` / `dump_database` はすべてこの形に揃っています。

1. **イベント命名** — `<name>-stream:columns` / `:rows` / `:done` / `:error`
2. **`register_stream` / `forget_stream`** — 登録ごとに発行される**世代トークン**を
   `forget_stream(stream_id, token)` へ渡す。`stream_id` はクライアント指定値なので、
   トークンが無いと「id を再利用した新タスクの登録を、先に終わった旧タスクの
   後始末が消す」競合が起き、**キャンセル不能なストリーム**が DB 接続や SSH
   トンネルを掴んだまま残ります。
3. **`stream_id` フィルタ** — フロント側 (`tauri.ts` の `listen*` ヘルパー) で絞る。

## 守るべきライフタイム不変条件

- **SSH トンネルを DB 接続より先に drop しない。** 先に落とすと sqlx が存在しない
  経路へ再接続します。`Session._tunnel` が接続と同じ期間生存する形を崩さないこと。
- **多段トンネルは構造体フィールドの宣言順で drop 順が決まります。**
  `_upstream` は**必ず構造体の最後のフィールド**に置く (DB → 末段 → 踏み台の順)。
- **再接続は「新接続を先に確立、成功してから差し替え」。** 失敗しても旧セッションを
  壊さずに `Err` を返します。`SessionId` は変わらないのでフロントのタブ状態が生き残ります。

## 参照

| ファイル | 内容 |
|---|---|
| `references/streaming.md` | ストリーミング実行、キャンセル、ドライランプレビュー、タイムアウト |
| `references/ssh-tunnel.md` | トンネルの構造、接続タイムアウト/フェーズ進捗/キャンセル、TOFU ホスト鍵検証とアプリ内復旧 |
| `references/ssh-multihop.md` | 踏み台 1 段の多段構成、`~/.ssh/config` の読み込み |
| `references/sessions.md` | `AppState` / `Session` の構造、切断からの再接続 (#712) |
