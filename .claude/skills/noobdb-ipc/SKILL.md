---
name: noobdb-ipc
description: noobDB に IPC コマンドを追加・変更・削除するとき、Rust の generate_handler! 登録と src/api/tauri.ts のラッパー・UI 到達性の 3 点コントラクトを保つとき、AppError の kind を追加するとき、__test_api や Tauri capabilities を扱うときに読む。
---

# noobDB の IPC 表面

IPC コマンドは `lib.rs::run()` の `generate_handler!` に登録されています。
全件は `references/command-list.md`。件数はドキュメントに手書きしません (並列の
PR がどちらも同じ数に書き換えると、git は衝突なしでマージして数字だけがずれるため)。

## コマンドを追加するときの手順 (3 点コントラクト)

この 3 つが揃わないとフロントエンドが暗黙のうちに壊れます。**それぞれ別のテストが
守っています。**

1. **Rust ハンドラを追加する** (`commands/<module>.rs` に `#[tauri::command]`)
2. **`lib.rs` の `generate_handler!` に登録する**
   → 忘れると `commandRegistrationParity.test.ts` が落ちます (死蔵コマンドの検出)
3. **`src/api/commands/<module>.ts` に型付きラッパーを追加する** (Rust の
   `commands/<module>.rs` と 1 対 1。ファイル名は camelCase で `bulk_write.rs` →
   `bulkWrite.ts`)。`src/api/tauri.ts` は各ファイルの `<module>Commands` を
   `api` に束ねるだけで、モジュールを新設したときだけ 1 行足します。型定義と
   ストリーミングの `listen*` ヘルパーは従来どおり `tauri.ts` に置きます
   → ズレると `ipcCommandParity.test.ts` / `ipcArgParity.test.ts` /
   `streamEventParity.test.ts` / `apiModuleLayout.test.ts` (置き場所) が落ちます
4. **UI から実際に呼ぶ**
   → `src/main.tsx` から import でたどれるモジュールのどこからも呼ばれないと
   `apiReachabilityParity.test.ts` が落ちます (#1421。テストや孤立したコンポーネント
   からの参照は数えない)。
   許可リスト `INTENTIONALLY_UNREACHABLE` は**空のまま維持するのが理想**で、
   「まだ UI を作っていない」は理由になりません — UI を足すか、ラッパーと Rust
   コマンドを一緒に消してください。
5. **`references/command-list.md` を更新する**
   → 忘れると `docCommandParity.test.ts` が落ちます

## 並列ブランチで衝突させない書き方

複数の PR が同時に IPC コマンドを足しても衝突しにくいよう、3 か所とも「全員が同じ
場所に追記する」形を避けています。追記するときは次を守ってください。

| 場所 | 書き方 |
|---|---|
| `lib.rs` の `generate_handler!` | 1 行 1 コマンド。**末尾に足さず**、同じ `commands::<module>::` のまとまりの中に入れる (Tauri の制約で受付窓口は 1 つしか持てないため、このリストだけは分割できない) |
| `src/api/commands/<module>.ts` | 対応するモジュールのファイルに足す。`tauri.ts` の `api` に直接書かない |
| `references/command-list.md` | 該当セクションの箇条書きに `- \`command_name\`` を 1 行で足す。`a` / `b` のように 1 行に並べない |

`api` は単一オブジェクト (各モジュールのスプレッド) として export されるため **knip ではプロパティ単位の未使用を
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
| `references/command-list.md` | 全コマンドの一覧 (機能別) |
| `references/parity-and-errors.md` | パリティテストの詳細、`AppError` の kind と `BackendError` への正規化 |
| `references/test-api.md` | `__test_api` の使い方、コマンド層の常時実行カバレッジ (#881)、capabilities |
