---
name: noobdb-testing
description: noobDB のテストを実行・追加するとき、統合テストの環境変数 (MySQL/PostgreSQL/MSSQL/SSH/TLS) を調べるとき、ミューテーションテスト・実ブラウザでの画面テスト (Vitest ブラウザモード)・ビジュアル回帰ベースライン・tauri-driver による実 webview E2E を扱うときに読む。
---

# noobDB のテスト

テストは 4 層に分かれています。**どの層を触るかで読むファイルが変わります。**

| 層 | 実行 | 対象 |
|---|---|---|
| Rust 単体 / 統合 | `cargo test` / `cargo nextest run` | 純ロジック + 実 DB (環境変数ゲート) |
| フロント単体 (jsdom) | `pnpm test` | 純ロジック・コンポーネント挙動 |
| 実ブラウザ | `pnpm test:browser` | 本物の CSS 上での描画・シナリオ・ビジュアル回帰 |
| 実 webview E2E | `pnpm test:e2e` | 実 IPC + 実 SQLite (手動トリガのみ) |

## 言語横断のパリティ / ゴールデンテスト

このリポジトリの中核的なテスト文化です。**同じ判定ロジックが Rust とフロントに
二重実装されている箇所は、共有フィクスチャ `src/__tests__/fixtures/*.json` で
固定します。**片方だけ変えるとどちらかのテストが落ちます。

- 判定ロジック (read-only ガード、マスク、auto-limit、SQL 引用、エクスポート書式、
  ホスト鍵不一致メッセージ、`is_query_shape`) を変えるときは、**必ず対応する
  JSON に境界ケースを追記**してください。
- IPC の 3 点コントラクト (`generate_handler!` 登録 ⇔ `tauri.ts` ラッパ ⇔ UI 到達性)
  も `ipcCommandParity` / `apiReachabilityParity` / `commandRegistrationParity` が
  固定しています。詳細は `noobdb-ipc` スキル。
- ドキュメント (`.claude/skills/noobdb-ipc/references/command-list.md`) も
  `docCommandParity.test.ts` が `generate_handler!` と突き合わせます。

## 参照

| ファイル | 内容 |
|---|---|
| `references/commands.md` | 全コマンド、ミューテーションテスト、統合テストの環境変数一覧 |
| `references/browser-tests.md` | Vitest ブラウザモード、フェイク Tauri ランタイム、ビジュアル回帰ベースラインの更新手順 |
| `references/e2e.md` | tauri-driver + WebDriverIO の構成と、CI へ昇格させる基準 |

## 落とし穴

- **ビジュアルベースラインは `main` で生成しない** — 直接 push が禁止されており
  必ず失敗します。作業ブランチで `visual-baseline.yml` を実行してください。
- **統合テストは環境変数が無いと黙ってスキップされます。** SQLite / DuckDB /
  ローカル横断クエリのテストだけが常時実走します。
