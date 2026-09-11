import { chakra } from "@chakra-ui/react";
import type { ComponentProps } from "react";

/**
 * モーダル / 設定画面 / 各種フォームで共有する Chakra レイアウトプリミティブ群。
 *
 * 元はエクスポート 3 モーダル (`ExportModal` / `DumpModal` / `ImportModal`) の
 * 共通化として始まったが、Epic #1110 Phase 4 (#1114) で **noobDB のフォーム UI
 * 全体の単一ソース**へ広げた。ラベル・バリデーションエラー・コードプレビューを
 * 画面ごとに手書きすると、同じ意味の要素に別々の文字サイズ・色・角丸が付き、
 * 「どこを見ればエラーか」が画面ごとに変わってしまう。
 *
 * ## 使い分け
 * | 要素 | 使うもの |
 * |---|---|
 * | フィールドの縦積みブロック | `FormSection` |
 * | フィールドのラベル | `FieldLabel` (入力に紐づくなら `htmlFor`、見出し用途は `as="div"`) |
 * | 入力 + 参照ボタンの横並び | `PathRow` |
 * | フィールド単位のバリデーションエラー | `FieldError` (`role="alert"` 込み) |
 * | 操作をブロックする持続的エラー | `ErrorNote` |
 * | SQL / エクスポート内容のプレビュー | `CodePreview` |
 */

/** モーダル内のフィールドブロック (縦積み)。 */
export const FormSection = chakra("section", {
  base: { display: "flex", flexDirection: "column", gap: "1.5" },
});

/** 小さい大文字のフィールドラベル。入力に紐づく場合は
 *  `<FieldLabel htmlFor="...">`、ラジオグループ等の見出し用途では
 *  `<FieldLabel as="div">` で使う。 */
export const FieldLabel = chakra("label", {
  base: { textStyle: "overline" },
});

/** 入力欄 + 参照ボタンの横並び。 */
export const PathRow = chakra("div", {
  base: { display: "flex", gap: "2", alignItems: "center" },
});

/**
 * エラー文の枠付き表示。
 *
 * ## エラー/警告表示の使い分け
 * - **Toast** (`Toast.tsx`): コピー完了・接続失敗などの一時的な操作結果。自動で
 *   消えるため、モーダル内の持続的なエラーには使わない。
 * - **ErrorNote** (本コンポーネント): モーダル内のバリデーション/実行エラー。
 *   操作を完了させるまで残り続ける必要があるエラーに使う。
 * - **FieldError**: フィールドに隣接して出す軽量なバリデーションエラー
 *   (例: `SaveAsTableModal` のテーブル名衝突)。`ErrorNote` より控えめに表示したい
 *   場面に使う。
 * - **セル近傍の inline 表示**: グリッドのセル編集エラー。`ErrorNote` ではなく
 *   セル内に直接表示して文脈を保つ。
 */
export const ErrorNote = chakra("div", {
  base: {
    py: "2", px: "2.5",
    border: "1px solid",
    borderColor: "app.border",
    bg: "app.bgError",
    color: "app.textError",
    borderRadius: "md",
    fontSize: "sm",
  },
});

const FieldErrorText = chakra("span", {
  base: { fontSize: "xs" },
  variants: {
    // 面の上に載る意味色の文字トークン。ベタ塗り危険色の上に置く前景色
    // (`app.dangerFg` = 常に白 / `app.warningFg` = 常に濃茶) と取り違えると、
    // ライトテーマで白地に白文字になりエラーが完全に見えなくなる。
    tone: {
      error: { color: "app.textError" },
      warning: { color: "app.textWarning" },
    },
  },
  defaultVariants: { tone: "error" },
});

/**
 * フィールド単位の軽量なバリデーションエラー。
 *
 * `role="alert"` を**既定で**付けるのがこのラッパーの主目的で、スクリーンリーダー
 * 利用者に「入力が拒否された理由」が届くことを画面ごとの書き分けに任せない
 * (#1114 時点で、同じ意味のエラー文が `role` 付き・無しで混在していた)。
 *
 * 入力を拒否するなら既定の `tone="error"`、続行はできるが結果が変わる注意
 * (既存ビューの置換など) は `tone="warning"`。
 */
export function FieldError({ children, ...rest }: ComponentProps<typeof FieldErrorText>) {
  return (
    <FieldErrorText role="alert" {...rest}>
      {children}
    </FieldErrorText>
  );
}

/**
 * SQL / エクスポート内容などの読み取り専用プレビュー。
 *
 * 生成した DDL のプレビュー (`CreateTableModal` 系) と出力内容のプレビュー
 * (`ExportModal` 系) は、#1114 以前は `bg` / 角丸 / 文字サイズが別々の手書き
 * `<chakra.pre>` として 8 箇所に複製されていた。同じ「編集できない値を見せる面」
 * なので、地は入力欄と同じ `app.bgInput`、角丸は `md` (入力欄・カード) に揃える。
 *
 * - `wrap` — 既定は `false` (長い行は横スクロール)。SQL は桁揃えが意味を持つため
 *   折り返さない。折り返してでも全文を見せたい場面 (差分・メッセージ) で `true`。
 * - 高さは画面ごとに要件が違うため `minH` / `maxH` を呼び出し側から渡す。
 */
export const CodePreview = chakra("pre", {
  base: {
    margin: 0,
    padding: "var(--space-2-5)",
    bg: "app.bgInput",
    border: "1px solid",
    borderColor: "app.border",
    borderRadius: "md",
    fontFamily: "mono",
    fontSize: "sm",
    lineHeight: "normal",
    color: "app.text",
    overflow: "auto",
    whiteSpace: "pre",
  },
  variants: {
    wrap: {
      true: { whiteSpace: "pre-wrap", wordBreak: "break-word" },
    },
  },
});
