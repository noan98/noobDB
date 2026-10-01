# 描画性能ベンチマーク (`pnpm bench:ui`)

Epic #1306 (120Hz 環境でタブ切替・スクロールを 120fps にする) の改善を、**PR ごとに
同じ条件で前後比較する**ための計測。#1307 で導入した。

App 全体を実 Chromium (Vitest ブラウザモード) にモック接続で描画し、Epic で問題に
なった 4 つの操作の処理コストを測る。Tauri 実機・Windows・DevTools は不要で、
クラウド実行環境でもそのまま動く。

## 実行

```sh
pnpm bench:ui
```

- 設定は `vitest.perf.config.ts`、本体は `src/__tests__/perf/ui.perf.tsx`。
- 所要時間は 5 分前後 (App の起動と 1,000 テーブルのツリー展開を含む。現状は
  タブ切替 1 回に十数秒かかるため、改善が進むほど短くなる)。
- 結果は `src/__tests__/perf/__perf__/latest.md` (Markdown の表) と `latest.json`
  に出る (gitignore 済み)。
- **CI では走らない** (`pnpm test:browser` とは include が別)。処理時間はマシン負荷で
  揺れるため、合否判定には使わない。

## 計測するシナリオ

| シナリオ | 操作 | 主に効く Issue |
|---|---|---|
| タブ切替 | 5,000 行 × 20 列の結果を持つテーブルタブ 4 つを順に `click()` | #1308 #1309 #1313 #1318 |
| ツリーのスクロール | 1,000 テーブルを展開したスキーマツリーを 40px ずつスクロール | #1314 #1315 |
| エディタ入力 | 表示中の CodeMirror に 1 文字ずつ挿入 (`view.dispatch`) | #1316 #1318 |
| サイドバー幅のドラッグ | リサイズハンドルに `pointermove` を送り続ける | #1312 #1314 |

## 指標の意味

| 列 | 意味 |
|---|---|
| 処理時間 p50 / p95 / 最大 | 1 回の操作を起こしてから、React の描画とレイアウトが終わるまでの時間。`MessageChannel` で 2 タスク譲ってから `offsetHeight` でレイアウトを強制して止める (vsync 待ちを含まない) |
| React commit / 回 | 1 回の操作で起きた React の commit 数 (`<Profiler>` の `onRender`)。1 回の操作で何度も描き直していないかを見る |
| React 描画 (ms/回) | `onRender` の `actualDuration` の合計 |
| メインスレッド (ms/回) | CDP の `Performance.getMetrics` (`TaskDuration` / `ScriptDuration` / `LayoutDuration` / `RecalcStyleDuration`) の、シナリオ前後の差分を回数で割ったもの。操作の後の非同期処理 (IPC の再取得やタイマー) も含む |
| LongTask 件数 (最大 ms) | 50ms を超えたタスクの数 (`PerformanceObserver` の `longtask`) |
| フレーム間隔 (スクロールのみ) | rAF ごとにスクロールしたときのフレーム間隔。headless の Chromium は 60Hz で回るので、16.7ms の 1.5 倍を超えたものをフレーム落ちとして数える |

## 読み方の注意

- **絶対値は実機と一致しない。** React は開発ビルド (Vitest ブラウザモードの `act` が
  開発ビルドを要求する) で、描画はソフトウェアラスタ。実機 (WebView2 + 本番ビルド)
  より数倍〜10 倍程度遅く出る。**同じマシンで改善前後を測った差**だけを見る。
- 1 回の実行でも揺れがあるので、効果を主張するときは前後それぞれ 2 回以上測り、
  p50 と メインスレッド (ms/回) の両方が同じ方向に動いていることを確認する。
- 120Hz で描画されているか (WebView2 のリフレッシュレート) はこのベンチでは分からない。
  実機の確認が必要になったら #1307 の手順を参照する。

## 性能改善 PR での使い方

1. 変更前のブランチ (通常は `main`) で `pnpm bench:ui` を実行し、`latest.md` を控える。
2. 変更後に同じコマンドを実行する。
3. PR 本文に、前後の表と、どの列がどれだけ動いたかを書く。

## ホットスポットの探し方

数値が悪い原因を探すときは、`ui.perf.tsx` の対象シナリオの前後で CDP の CPU
プロファイラを一時的に使うと、関数ごとの自己時間が分かる。

```ts
await cdp().send("Profiler.enable");
await cdp().send("Profiler.start");
// ... 操作 ...
const { profile } = await cdp().send("Profiler.stop");
```

プロファイルの `callFrame.lineNumber` は **Vite が変換した後のコード**の行番号なので、
ソースの行番号とはずれる。`fetch(callFrame.url)` で変換後のコードを取得して該当行を
表示すると、どの関数かを特定できる。調査用のコードはコミットしない。
