---
name: noobdb-ipc
description: noobDB に IPC コマンドを追加・変更・削除するとき、Rust の generate_handler! 登録と src/api/tauri.ts のラッパー・UI 到達性の 3 点コントラクトを保つとき、AppError の kind を追加するとき、__test_api や Tauri capabilities を扱うときに読む。
---

# noobDB の IPC 表面

現在 **98 コマンド**が `lib.rs::run()` の `generate_handler!` に登録されています。
全件は `references/command-list.md`。

## コマンドを追加するときの手順 (3 点コントラクト)

この 3 つが揃わないとフロントエンドが暗黙のうちに壊れます。**それぞれ別のテストが
守っています。**

1. **Rust ハンドラを追加する** (`commands/<module>.rs` に `#[tauri::command]`)
2. **`lib.rs` の `generate_handler!` に登録する**
   → 忘れると `commandRegistrationParity.test.ts` が落ちます (死蔵コマンドの検出)
3. **`src/api/tauri.ts` に型付きラッパーを追加する** (ストリーミングなら対応する
   `listen*` ヘルパーも)
   → ズレると `ipcCommandParity.test.ts` / `ipcArgParity.test.ts` /
   `streamEventParity.test.ts` が落ちます
4. **UI から実際に呼ぶ**
   → どこからも呼ばれないと `apiReachabilityParity.test.ts` が落ちます。
   許可リスト `INTENTIONALLY_UNREACHABLE` は**空のまま維持するのが理想**で、
   「まだ UI を作っていない」は理由になりません — UI を足すか、ラッパーと Rust
   コマンドを一緒に消してください。
5. **`references/command-list.md` を更新する**
   → 忘れると `docCommandParity.test.ts` が落ちます

`api` は単一オブジェクトとして export されるため **knip ではプロパティ単位の未使用を
原理的に検出できません。**上記のパリティテスト群がその穴を塞いでいます。

## エラー

エラーは `AppError` として伝搬し、`{ kind, message }` の**構造化 JSON** として
シリアライズされます。**`error.rs` にバリアントを追加するときは `kind()` の分岐も
更新してください。**`kind` → ヒントの対応は共有ゴールデン
(`errorKindVectors.json`) が固定しています。

## capabilities は増やさない

`src-tauri/capabilities/default.json` は意図的に最小 (window / app / event の
デフォルト + `dialog:allow-open` / `dialog:allow-save` + updater 関連のみ)。
**フロントはシェルや fs の API を直接叩かず、必ず Rust コマンドを経由します。**
`read_text_file` / `write_binary_file` はまさにそのための経路です。

## 参照

| ファイル | 内容 |
|---|---|
| `references/command-list.md` | 98 コマンドの全件一覧 (機能別) |
| `references/parity-and-errors.md` | パリティテストの詳細、`AppError` の kind と `BackendError` への正規化 |
| `references/test-api.md` | `__test_api` の使い方、コマンド層の常時実行カバレッジ (#881)、capabilities |
