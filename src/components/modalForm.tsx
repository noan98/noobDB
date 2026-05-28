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
  base: { display: "flex", flexDirection: "column", gap: "6px" },
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
  base: { display: "flex", gap: "var(--space-2)", alignItems: "center" },
});

/** エラー文の枠付き表示。`.export-error` 相当。 */
export const ErrorNote = chakra("div", {
  base: {
    padding: "8px 10px",
    border: "1px solid",
    borderColor: "app.border",
    bg: "app.bgError",
    color: "app.textError",
    borderRadius: "md",
    fontSize: "sm",
  },
});
