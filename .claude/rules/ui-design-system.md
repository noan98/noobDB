# UI Design System 運用ルール

noobDB の UI を変更するときに守るルール。Epic #1110 (UI/UX Refresh) の Phase 1
(#1111) で整理したもので、**Phase 2 以降の UI 刷新はすべてこのルールの上に積む**。

CI で強制しているものには「ガード」を明記した。ガードのあるルールを破ると
`pnpm test` (= CI の frontend ジョブ) が落ちる。

---

## 0. 大原則: 値の単一ソースは `App.css`

```
App.css (CSS 変数)  ←── 唯一の値の出所
   ↓ var() ブリッジ
theme.ts (Chakra トークン)
   ↓ トークン名で参照
コンポーネント (*.tsx)   ←── 値を書かない
```

- 色・余白・角丸・文字サイズ・影・z-index の**実数値は `App.css` にしか置かない**。
- `theme.ts` は `var(--x)` を指すだけで、値を持たない (例外は後述)。
- コンポーネントは**トークン名だけ**を書く (`gap="2"` / `color="app.textMuted"`)。

この形にしている理由は、ダークモードと 10 種のテーマプリセット、フォント拡大設定、
表示密度がすべて「CSS 変数の差し替え」で成立しているため。値をコンポーネントに
書いた瞬間、その要素だけがテーマ切替・フォント拡大から取り残される。

> **ガード**: `__tests__/designTokens.test.ts`
> — `theme.ts` が参照する `var(--x)` が `App.css` に実在することも検証する。

---

## 1. 余白 (spacing)

`gap` / `p*` / `m*` は **spacing トークンのみ**。px 直値は禁止。

| トークン | 実寸 | 主な用途 |
|---|---|---|
| `0.25` | 1px | アイコンと極小ラベルの隙間 |
| `0.5` | 2px | バッジの縦パディング |
| `0.75` | 3px | ツリー行・チップの微小な間 |
| `1` | 4px | 基本の最小ステップ |
| `1.25` | 5px | グリッドセルの縦パディング |
| `1.5` | 6px | コントロール内の標準ギャップ |
| `1.75` | 7px | 密なツールバーの横パディング |
| `2` / `2.5` / `3` / `3.5` | 8/10/12/14px | フォーム・パネルの標準余白 |
| `4` / `4.5` / `5` / `5.5` / `6` | 16/18/20/22/24px | セクション間・カード内側 |
| `7` / `8` | 28/32px | アイコン幅ぶんのインデント・空状態の内側 |
| `10` / `12` | 40/48px | 大きな空白 (オーバーレイ・ヒーロー領域) |

**新しい余白はこの表から選ぶ。** 表に無い値が必要になったと感じたら、まず既存の
値へ寄せられないか検討し、それでも必要なら `App.css` の `--space-*` にステップを
追加してから使う (コンポーネントに px を書かない)。

`--space-*` はすべて `calc(N * var(--font-scale))`。px 直値を書くと**フォント拡大
設定 (#818) に追従せず、文字だけ大きくなって余白が相対的に潰れる**。

> **対象外**: `w` / `h` / `minW` / `maxH` / `top` / `left` などのサイズ・位置は
> 「レイアウトの実寸」であってリズムではないため、px 指定してよい。
> `borderWidth` も同様 (ヘアラインは 1px 固定)。

### 書き方の 2 形態

| 文脈 | 書き方 |
|---|---|
| Chakra のスタイル props | `gap="2"` / `py={compact ? "0.25" : "0.5"}` (トークン名) |
| `style={{}}` / `css={{}}` / recipe の `base` / `SystemStyleObject` | `padding: "var(--space-0-75) var(--space-1-5)"` (CSS 変数) |

スタイルオブジェクト側で CSS 変数を使うのは、Chakra のトークン名が解決されない
文脈 (素の `style`) が混ざるため。**どちらの形でも px 直値は書かない。**

> **ガード**: `designTokens.test.ts` の「余白 (spacing)」— props / JSX 式 /
> スタイルオブジェクトの 3 形態すべてを検査する

---

## 2. タイポグラフィ

| 軸 | トークン | 値 |
|---|---|---|
| `fontSize` | `3xs` / `2xs` / `xs` / `sm` / `md` / `base` / `lg` / `xl` | 9 / 10 / 11 / 12 / 13 / 14 / 16 / 20px |
| `lineHeight` | `tight` / `snug` / `normal` / `relaxed` | 1.25 / 1.4 / 1.55 / 1.6 |
| `letterSpacing` | `tight` / `normal` / `wide` / `wider` | -0.01 / 0 / 0.02 / 0.05em |

- `fontSize="11px"` のような px 直値は禁止 (`--text-*` も `--font-scale` を内包する)。
- 上付きの小見出し (セクションラベル) は `textStyle="overline"` を使う。

> **ガード**: `designTokens.test.ts` の「タイポグラフィ」

---

## 3. 角丸 (radius)

| トークン | 値 | 用途 |
|---|---|---|
| `xs` | 2px | スウォッチ・ミニバー・インジケータ |
| `sm` | 4px | チップ・小ボタン・吹き出し |
| `md` | 6px | 入力欄・カード |
| `lg` | 8px | モーダル・パネル |
| `xl` | 16px | 全画面オーバーレイのカード |
| `pill` | 999px | バッジ・トグル・細いマーカー |

> **ガード**: `designTokens.test.ts` の「角丸 (radius)」

---

## 4. 色

**コンポーネントに色リテラル (hex / rgb / hsl) を書かない。**

### 使い分け

| 目的 | 使うもの |
|---|---|
| 面・文字・境界 | `app.bg` / `app.surface` / `app.text` / `app.textMuted` / `app.border` … |
| 状態 (成功/警告/危険/情報) | `semanticColors.ts` の `semanticColorToken(role, tier)` |
| ベタ塗りの**上**の文字/アイコン | **`app.onSolid`** |
| 接続状態 | `app.status.*` |
| お気に入り (★) | `app.favorite` |
| DB オブジェクト種別 | `app.dbAccent` (データベース) / `app.keyAccent` (主キー) |
| サンドボックス | `app.sandbox.{subtle,border,solid}` |
| データを色で符号化 | `colorScale.ts` |

### `app.onSolid` が必要な理由 (#1111 で最も多かった不具合)

`*-solid` と `--status-*` は**ライト系テーマでは濃色、ダーク系テーマでは明色**。
そのため `bg="app.status.error" color="#fff"` と書くと、ダーク系プリセットでは
明るい赤の上に白文字が載って読めなくなる (dracula の警告色は `#f1fa8c`)。
`app.onSolid` はテーマごとに白/暗色へ反転するので、どのテーマでも AA を満たす。

> **ガード**: `designTokens.test.ts` の「色」(リテラル禁止) と
> `themeContrast.test.ts` の `--on-solid` 検査 (全 11 テーマ × 8 塗り面で AA 4.5:1)

### 色リテラルを置いてよい場所 (単一ソース側)

`designTokens.test.ts` の `COLOR_SOURCE_MODULES` に列挙したモジュールだけ。
新しく追加したくなったら、それは本当に「テーマから独立したデータ値」かを疑う。

- `themePresetPreview.ts` — 設定画面のテーマ見本スウォッチ
- `theme.ts` — Chakra のカラー付きボタン (CSS 変数を介さない例外)
- `brand.tsx` — ブランドカラー定数 (App.css / favicon と parity 固定)
- `colorScale.ts` / `accent.ts` — 色の演算とプリセット
- `settings.ts` — SQL シンタックスハイライト配色 (ユーザが上書きできるデータ)
- `profileIdentity.ts` — ドライバ色・プロファイル識別色 (`profiles.json` に保存)
- `sandbox.ts` — サンドボックス帯色 (brand violet と parity 固定)
- `components/imageExport.ts` — 非 DOM 環境のフォールバック

**`<input type="color">` に渡す値は CSS 変数を受け付けない**ため具体的な hex が要る。
その場合も UI に直書きせず、上記モジュールの名前付き定数
(`COLOR_INPUT_FALLBACK` / `ACCENT_INPUT_FALLBACK`) を使う。

---

## 5. 共通コンポーネントを迂回しない

| やること | 使うもの | 使ってはいけないもの |
|---|---|---|
| アイコン | `components/Icon.tsx` の `<Icon name=... size={ICON_SIZES.md} />` | `@tabler/icons-react` の直接 import |
| ツールチップ | `components/Tooltip.tsx` / `useDelegatedTooltip()` | native `title=` |
| 右クリックメニュー | `components/ContextMenu.tsx` | 独自のメニュー実装 |
| 確認ダイアログ | `ConfirmDialog.tsx` / `useConfirm()` | `window.confirm()` |
| ショートカット | `shortcuts.ts` (単一ソース) | 個別のキーハンドラ定義 |
| 空状態 | `EmptyState.tsx` | 独自の「データがありません」表示 |

アイコンのサイズ・ストロークは `ICON_SIZES` / `ICON_STROKE` のトークンのみ
(ピクセル直値は使わない)。詳細は `.claude/skills/noobdb-frontend/references/ui-foundation.md`。

> **ガード**: `designTokens.test.ts` (tabler 直 import) /
> `windowConfirmGuard.test.ts` (`window.confirm`) / `icon.test.tsx` / `tooltip.test.tsx`

---

## 6. UI ロジックと純ロジックを分ける

画面ごとに `XxxView.tsx` (副作用・描画) と `xxx.ts` (テスト可能な純関数) を対にする
(`ChartView.tsx` / `chartData.ts`、`ResultGrid.tsx` / `gridStats.ts` など)。
**判定・整形ロジックをコンポーネントに埋めない。** 位置決めのような算術も
`tooltipPosition.ts` / `menuPosition.ts` のように純モジュールへ出す。

---

## 7. フォーム・モーダル・パネル (Phase 4 / #1114)

### 7.1 Modal / Panel / 全画面サーフェスの責務

App Shell は `Sidebar / Main Workspace / Bottom Panel` の 3 領域 (#1112)。
新しい画面を足すときは、まずこの表でどこに置くかを決める。

| 性質 | 置き場所 | 実体 |
|---|---|---|
| 一時的な操作 (作成・変更・確認・エクスポート設定) | **Modal** | `Modal.tsx` |
| SQL を書きながら参照する情報 (アドバイザ・インスペクタ・プロセス監視) | **Bottom Panel** | `BottomPanel.tsx` + `bottomPanelTabs.ts` |
| それ自体が作業対象で広い面積が要るもの (ER 図・スキーマ比較・ユーザ管理・結果比較) | **全画面サーフェス** | `App.tsx` の三項チェーン + `workspaceView.ts` |

Modal は「開いて、決めて、閉じる」ものに限る。**閉じるまで作業が進まない**性質が
あるため、見ながら SQL を書くような情報を Modal に置かない。

全画面サーフェスは `<main>` を丸ごと置き換えるので、**開くと SQL エディタと結果が
消える**。これは「その画面自体が作業対象」のときだけ許される。参照しながら手を動かす
情報は必ず Bottom Panel へ置く (#1112 でアドバイザ・インスペクタ・プロセス監視の
3 つを全画面から移したのがこの線引きの由来)。

Bottom Panel に足すときは:

1. `bottomPanelTabs.ts` の `BOTTOM_PANEL_TABS` にタブを追加する
2. 開ける条件があれば `availableBottomPanelTabs` に足す (未接続・対象 DB 無しなど)
3. `App.tsx` の `WorkspaceSplit` 内の分岐に中身を足す
4. **中身のコンポーネントに見出しと閉じるボタンを持たせない** — タブバーが名前を、
   シェルの × が閉じる操作を持つ (二重ヘッダを作らない)

上下の配分は `WorkspaceSplit` が既存の `Splitter direction="column"` へ委ねる。
リサイズ・キーボード操作・永続化・クランプを個別に実装しない。

> **ガード**: `bottomPanelTabs.test.ts` (解決規則 + `App.tsx` への結線) /
> `bottomPanelShell.test.tsx` (タブの WAI-ARIA 構造・閉じる導線) /
> `workspaceView.test.ts` (全画面サーフェスの排他集合)

### 7.2 フォームの共通プリミティブ (`components/modalForm.tsx`)

モーダル・フォーム内の要素は**必ず**このモジュールから取る。手書きすると同じ役割の
要素がモーダルごとに別の文字サイズ・色・角丸で出る。

| 用途 | 使うもの |
|---|---|
| フィールドの縦積みブロック | `FormSection` |
| 入力欄の見出しラベル | `FieldLabel` (入力に紐づくなら `htmlFor`、見出し用途は `as="div"`) |
| 入力欄 + 参照ボタンの横並び | `PathRow` |
| フィールド単位のバリデーションエラー | `FieldError` (`role="alert"` 込み) |
| 操作をブロックする持続的エラー | `ErrorNote` |
| SQL / エクスポート内容のプレビュー | `CodePreview` (`wrap` で折り返し、高さは `minH` / `maxH`) |

例外はチェックボックス / ラジオを包む `<label>` (コントロールの一部であって
フィールドラベルではないので本文サイズのまま) と、設定画面の行
(`SettingsView` の `SettingsNumberRow` 等が `& label` でまとめてスタイルを持つ)。

> **ガード**: `designTokens.test.ts` の「フォーム / モーダルの共通プリミティブ」
> — `*Modal.tsx` / `*Dialog.tsx` 内の手書き `<pre>` と、
> `color="app.textSecondary"` を持つ手書き `<label>` を禁止する

### 7.3 意味色は「面の上」と「ベタ塗りの上」を取り違えない

| 置く場所 | 使うトークン |
|---|---|
| 面 (`app.surface` / `app.bg`) の上のエラー文・警告文・危険アイコン | `app.textError` / `app.textWarning` / `app.textSuccess` |
| ベタ塗り (`app.dangerBg` / `app.warningBg` …) の**上** | 同名の `app.dangerFg` / `app.warningFg` … |
| `*-solid` や `--status-*` のベタ塗りの上 | `app.onSolid` (§4 参照) |

`app.dangerFg` は**テーマに関係なく常に白**、`app.warningFg` は**常に濃茶**。
面の上のテキストに使うと、ライトテーマで白地に白文字 (完全に不可視)、ダークテーマで
暗地に暗文字になる。#1114 時点で 10 箇所がこの取り違えをしていた。

> **ガード**: `designTokens.test.ts` の「ベタ塗り専用の前景色」
> — `app.*Fg` の近傍に対応する `app.*Bg` が無ければ fail

### 7.4 モーダルのフッター配置

`Modal.tsx` の `ModalFooter` の JSDoc にある 2 パターン (通常 / 破壊的) のどちらかに
必ず従う。破壊的操作では実行を左に非強調で置き、右端のキャンセルを primary +
初期フォーカスにする。

---

## 8. 変更するときの手順

1. 触るコンポーネントの近くに**同じことをしている共通実装がないか探す**
   (`components/` は 158 ファイルある。新規作成の前に必ず検索する)。
2. 必要な値がトークンにあるか確認する。無ければ **`App.css` → `theme.ts` の順で**
   追加してから使う。
3. 変更後に `pnpm run build` (tsc + vite) → `pnpm test` → 関連する
   `pnpm test:browser` を通す。
4. 密度 (`data-density`)・フォント拡大 (`--font-scale`)・ダークテーマ・
   `prefers-reduced-motion` のいずれかを壊していないか確認する。
