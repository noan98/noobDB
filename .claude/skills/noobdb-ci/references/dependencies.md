# 依存関係の自動更新と脆弱性監査 (#605)

Cargo (`src-tauri/`) / pnpm (フロント) / GitHub Actions の 3 エコシステムで、更新
PR の自動生成と脆弱性の可視化を次のように役割分担しています。追加サービス
(Renovate 等) は導入せず、GitHub ネイティブな Dependabot と既存の cargo-deny /
新設の pnpm audit で完結させています。

- **Dependabot (`.github/dependabot.yml`) — 更新 PR の自動生成**。`cargo`
  (`/src-tauri`)・`npm` (pnpm、`/`)・`github-actions` (`/`) の 3 エコシステムを
  それぞれ `schedule.interval: weekly` で監視します。`groups` は各 `updates` エントリ
  配下に置く構文 (`updates[].groups`) で、`minor`/`patch` 更新を 1 本の PR へまとめ
  (`cargo-minor-and-patch` / `npm-minor-and-patch`) PR ノイズを抑えます (major は
  グルーピング対象外で個別 PR になります)。`cooldown` (`semver-patch-days: 3` /
  `semver-minor-days: 7` / `semver-major-days: 30`) でリリース直後の不安定な
  バージョンを一定期間避けます。`open-pull-requests-limit: 5` で同時オープン数を
  抑制。**自動マージ**は本設定固有の仕組みではなく、`.github/workflows/automerge.yml`
  (CI 成功 + 未解決レビュースレッド 0 件を条件にする汎用の自動マージ) が Dependabot
  PR を含むすべての適格な PR に対して既に機能しており、実績として多数の Dependabot
  PR (`dependabot/cargo/...` 等) がこの経路でマージされています。
- **cargo-deny (`ci.yml` の `rust (deny)` ジョブ) — Rust 依存のライセンス +
  脆弱性ゲート**。依存ライセンスの許可リスト検査に加え、RustSec Advisory DB による
  既知脆弱性チェックを **PR ごとに強制**します (fail する)。設定は
  `src-tauri/deny.toml`。詳細は上記 CI セクションを参照。
- **pnpm audit (`.github/workflows/audit.yml`) — フロント依存の脆弱性可視化**。
  cargo-deny に対になるフロント側の仕組みが無かったため新設しました。
  `schedule: cron` (毎週月曜) + `workflow_dispatch` で定期実行し、`pnpm audit` の
  結果を Job Summary に出力します。pnpm は既存 CI と同じく `corepack enable` で
  用意します。バンドルサイズ (#443) ・カバレッジ (#482) と同じ漸進方針で、
  **当面 fail させず可視化のみ**とし (`|| true` で吸収)、PR ごとではなく週次
  スケジュールにしているのは、依存を変更しない PR でも毎回外部の npm advisory DB
  に問い合わせるコストを避けるためです。
