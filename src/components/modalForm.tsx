import { chakra } from "@chakra-ui/react";

/**
 * エクスポート / ダンプ / インポートの各モーダルで共有する Chakra
 * レイアウトプリミティブ群。
 *
 * 元々は `App.css` の `.export-section` / `.export-label` / `.export-path-row` /
 * `.export-error` クラスで描画していたものを style props を持つ Chakra
 * コンポーネントへ移植したもの。3 モーダル (`ExportModal` / `DumpModal` /
 * `ImportModal`) が同じフォーム構造 (ラベル付きセクション + パス入力行 +
 * エラー表示) を共有するため共通化している。
 */

/** モーダル内のフィールドブロック (縦積み)。`.export-section` 相当。 */
export const FormSection = chakra("section", {
  base: { display: "flex", flexDirection: "column", gap: "1.5" },
});

/** 小さい大文字のフィールドラベル。`.export-label` 相当。入力に紐づく場合は
 *  `<FieldLabel htmlFor="...">`、ラジオグループ等の見出し用途では
 *  `<FieldLabel as="div">` で使う。 */
export const FieldLabel = chakra("label", {
  base: {
    fontSize: "xs",
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: "app.textMuted",
  },
});

/** 入力欄 + 参照ボタンの横並び。`.export-path-row` 相当。 */
export const PathRow = chakra("div", {
  base: { display: "flex", gap: "2", alignItems: "center" },
});

/**
 * エラー文の枠付き表示。`.export-error` 相当。
 *
 * ## エラー/警告表示の使い分け
 * - **Toast** (`Toast.tsx`): コピー完了・接続失敗などの一時的な操作結果。自動で
 *   消えるため、モーダル内の持続的なエラーには使わない。
 * - **ErrorNote** (本コンポーネント): モーダル内のバリデーション/実行エラー。
 *   操作を完了させるまで残り続ける必要があるエラーに使う。
 * - **role="alert" のインライン span**: フィールド単位の軽量なバリデーションエラー
 *   (例: ParameterInputModal の数値型チェック)。`ErrorNote` より控えめに表示したい
 *   場面や、フィールドに隣接して表示したい場合。
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
