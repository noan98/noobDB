---
name: noobdb-ci
description: noobDB の CI が落ちたとき、GitHub Actions ワークフローを変更するとき、必須チェック名・キャッシュ戦略・依存関係の自動更新 (Dependabot / cargo-deny / pnpm audit)・Codex レビューゲートと automerge・Rust ビルドの高速化設定 (mold / sccache / LTO) を調べるときに読む。
---

# noobDB の CI / リリース / ビルド設定

ワークフローは `.github/workflows/` にあります。作業内容に応じて、下の参照
ファイルのうち必要なものだけを読んでください。

## 必須チェック名 (よく間違える箇所)

必須チェックを設定・確認するときは、**ジョブ分割・統合でチェック名が変わっている**
点に注意してください。現行の名前は次のとおりです。

| 現行のチェック名 | 備考 |
|---|---|
| `frontend (build + browser tests)` | 旧 `frontend (typecheck + build)` / `frontend (browser render + visual)` を #908 で統合 |
| `crosslang parity` | 言語横断のパリティ/ゴールデンテスト。rust 専用差分の穴埋め用 |
| `rust (clippy)` / `rust (test)` | 旧 `rust (check + clippy + test)` から分割 |
| `rust (deny)` | 依存ライセンス + RustSec 脆弱性チェック |
| `rust (windows clippy)` / `rust (windows test)` | 旧 `rust (windows)` から分割 |

## 参照

| ファイル | 内容 |
|---|---|
| `references/ci-workflow.md` | `ci.yml` — paths-filter によるジョブ出し分け、frontend / crosslang parity / rust 系 6 ジョブ、カバレッジ閾値 |
| `references/release-workflow.md` | `release.yml` — タグビルド、キャッシュ温めの paths ゲート、`releaseDraft: false` の理由 |
| `references/dependencies.md` | Dependabot / cargo-deny / pnpm audit の役割分担 |
| `references/codex.md` | `automerge.yml` の Codex レビューゲート — 完了信号の取り方、CodeRabbit からの移行 (#1109)、`CODEX_PAT` |
| `references/build-performance.md` | `mold` / `lld-link` / sccache / LTO 設定。**Linux では `clang` と `mold` が必須** |

## 落とし穴

- **`lto = "fat"` に戻さない** — リリースビルドが 30 分超になります
  (`references/build-performance.md`)。
- **`releaseDraft: true` に戻さない** — 成果物が不可視のドラフトへ迷子になります
  (`references/release-workflow.md`)。
- **`automerge.yml` の Codex 完了信号 (レビュー提出 / 👍 リアクション) を減らさない**
  — 指摘ゼロの PR が永久にマージされなくなる、または指摘が届く前にマージされる
  (`references/codex.md`)。
- **push 観測時刻に git の committer date を使わない** — 👍 判定と待ち時間の
  2 つの防御が同時に破られます (`references/codex.md`)。
