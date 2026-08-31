# release.yml (タグビルドとキャッシュ温め)

- `.github/workflows/release.yml` — `v*` タグまたは `workflow_dispatch` を
  トリガに、`windows-latest` 上で `tauri-action` 経由の NSIS バンドルを生成します。
  成果物 (インストーラ + `.sig` + `latest.json`) は**タグと同名の公開済みリリース**へ
  添付されます (`releaseDraft: false`。GitHub UI で先にリリースを公開してタグを
  生成する運用に対応。リリースが存在しないタグ push では公開リリースを新規作成
  するため、リリースノートは後から編集します)。`releaseDraft: true` に戻しては
  いけません — tauri-action は true だと未公開ドラフトしかタグ名で探さないため、
  公開済みリリースがあると成果物が誰にも見えない別ドラフトへ迷子になります
  (v0.8.2 で発生)。`main` への push でもキャッシュ温め目的でビルドが走ります。
  ビルド後の `Report bundle artifact sizes` ステップが、出荷バイナリ (NSIS
  インストーラ・`.exe`、将来の `.dmg` / `.AppImage` / `.deb`) のサイズを Job
  Summary に出力します (#549)。これは JS/CSS を測るバンドルサイズ可視化 (#443) の
  **アプリ本体版**で、方針も同じく**当面は閾値で fail させず可視化のみ**
  (カバレッジ #482 と同じ漸進方針)。追加ツールは増やさず `stat` + `awk` の
  シェル標準機能だけで集計し、cache-warm / リリースの両ビルド経路の後に
  `if: always()` で 1 回測ります。macOS/Linux バンドルを追加したら (本 Epic の
  別 Issue) `.dmg` / `.AppImage` / `.deb` のグロブが自動的に対象へ含まれます。
  起動時間の監視は計測の安定性が難しいため本 Issue のスコープ外 (任意/将来拡張)
  としています。
  **キャッシュ温めビルドはパス変更でゲートされます (#919)。** `ci.yml` と同型の
  `changes` ジョブ (`dorny/paths-filter`) を追加し、`rust` (`src-tauri/**`) /
  `frontend` (`src/**` など、`ci.yml` の `frontend` フィルタと同じ集合) の
  いずれも変更されていない**タグ以外の main push** では `build` ジョブ自体を
  skip します — README / CLAUDE.md / 無関係な workflow ファイルのみの push で
  90 分タイムアウトの Windows ランナーが浪費されるのを防ぎます。`changes`
  ジョブは push イベントでは git 履歴比較を行うため checkout してから filter を
  実行します (`ci.yml` の `changes` ジョブと同じ配慮、`fetch-depth: 2`)。
  **ゲート対象はキャッシュ温めビルドのみ**で、キャッシュ温めの本来の目的
  (タグビルドの初回コールド回避) を壊さないよう、以下の 3 経路はゲートを完全に
  迂回して常に `build` ジョブを実行します:
  - **タグ push** (`refs/tags/v*`): リリースビルドそのものであり、`changes`
    ジョブは比較対象コミットが無く意味を持たないため、`changes` 自体をこの
    条件で実行しません (`changes` の `if:` で除外)。
  - **`workflow_dispatch`** (手動実行): 明示的な手動トリガの意図を尊重し、
    変更内容に関わらず常にビルドします。
  - **`schedule`** (毎週月曜 03:00 UTC の定期温め): main push の温めビルドは
    paths ゲートのスキップや連続 push の concurrency キャンセルで長期間完走
    しないことがあり、GitHub Actions のキャッシュは 7 日間未アクセスで削除
    されるため、main スコープの rust-cache が失効した状態でタグビルドが毎回
    コールドスタートする退行が実際に起きました (DuckDB #709 の bundled C++
    ビルドが乗った v0.9.x でリリースビルドが 27〜35 分に悪化)。週次の定期
    実行でキャッシュを常に新鮮に保つのが目的なので、変更有無に関わらず
    ビルドします (`changes` は push 限定の `if:` により skip)。
  `build` ジョブの `if:` は `always() && (tag push || workflow_dispatch ||
  schedule || changes.outputs.rust == 'true' || changes.outputs.frontend ==
  'true')` で、`always()` は「`changes` が (タグ/手動実行/schedule で) skip
  されたときに `needs:` の既定動作 (`success()` 相当) で `build` まで連鎖 skip
  されてしまう」のを防ぐためのものです — 実際の実行可否は続く OR 条件が判定
  します。`changes` ジョブが何らかの理由で失敗した場合は outputs が空になり
  OR 条件が偽になるため、main push では安全側 (skip) に倒れます。
  **タグビルドでは rust-cache を保存しません (`save-if`)** — タグ ref スコープに
  保存されたキャッシュは main や他のタグの実行から参照できず、同じタグが再実行
  されることも無いため、保存 (~1 分) が純粋な無駄になるからです。タグビルドは
  main スコープのキャッシュを復元のみで利用します。

Linux CI では Tauri 2 のシステムパッケージ (`libwebkit2gtk-4.1-dev`,
`libgtk-3-dev`, `libsoup-3.0-dev`, `librsvg2-dev`, `libxdo-dev`,
`libayatana-appindicator3-dev`) が必要です。
