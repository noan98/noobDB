---
name: noobdb-frontend
description: noobDB のフロントエンド (src/) を変更するとき — React 19 + Chakra UI のコンポーネント構成、結果グリッドとセル編集の純ロジック、アイコン/ツールチップ/コンテキストメニューの共通実装、配色スケール、設定ストア、エディタの SQL 構文チェックを扱うときに読む。
---

# noobDB のフロントエンド (`src/`)

React 19 + TypeScript + Vite + Chakra UI。ルートは `App.tsx`、Chakra システム設定は
`theme.ts`、実行時アクセント色は `accent.ts`、アニメーションは `motion.ts`。

## 一貫している設計方針

- **副作用層と純ロジック層を分ける。** 画面ごとに `XxxView.tsx` / `XxxPanel.tsx` と、
  テスト可能な純関数の `xxx.ts` が対になっています (`chartData.ts` /
  `gridStats.ts` / `planDiff.ts` / `sandbox.ts` / `advisor.ts` など)。**新しい判定・
  整形ロジックはコンポーネントに埋めず純モジュールへ出してください。**
- **共通実装を迂回しない。** 同じ意味の UI が複数実装になると崩れます。

  | やること | 使うもの | 直接使ってはいけないもの |
  |---|---|---|
  | アイコン | `components/Icon.tsx` の `<Icon name=... />` | `@tabler/icons-react` の直接 import |
  | ツールチップ | `components/Tooltip.tsx` / `useDelegatedTooltip()` | native `title=` 属性 |
  | 右クリックメニュー | `components/ContextMenu.tsx` | 独自のメニュー実装 |
  | データを色で符号化 | `colorScale.ts` | 色のベタ書き |
  | 状態色 | `semanticColors.ts` の `SemanticRole` | 個別の色定義 |
  | ショートカット | `shortcuts.ts` (単一ソース) | 個別のキーハンドラ定義 |

- **サイズ・ストロークはトークンのみ** (`ICON_SIZES` / `ICON_STROKE`)。ピクセル直値は
  使いません。
- **DB への新しい書き込み経路を増やさない。** クイックセット・貼り付け一括編集などは
  既存のインラインセル編集バッファに載るだけで、確定は従来どおり Apply です。

## 参照

| ファイル | 内容 |
|---|---|
| `references/components.md` | `App.tsx` / `api/tauri.ts` / 接続・クエリ系と発展機能のコンポーネント一覧 |
| `references/grid-and-cells.md` | セル整形、クイックフィルタ/セット、貼り付け一括編集、選択サマリ、集計フッター、NULL 率ミニバー、アクティビティセンター |
| `references/ui-foundation.md` | アイコン、ツールチップ、コンテキストメニュー、配色スケール、基盤モジュール |
| `references/settings-and-editor.md` | `settings.ts` の設定項目、`dangerousSql.ts`、`sqlLint.ts`、`i18n.ts` |

安全網の判定ロジック (`dangerousSql.ts` の `isReadOnlySql` / `maskLiterals`) は
Rust 側と共有ゴールデンで固定されています — `noobdb-sql-safety` スキルを参照。
