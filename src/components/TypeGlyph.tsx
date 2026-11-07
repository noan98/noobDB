import { memo } from "react";
import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import { CELL_KIND_META, classifyTypeName, normalizeTypeForClassify, type CellKind } from "./cellTypeMeta";
import { Icon, ICON_SIZES } from "./Icon";
import { Tooltip } from "./Tooltip";

/**
 * 型グリフ (#2125)。結果グリッドのヘッダ・ER 図と同じ分類関数 (`classifyTypeName`) と
 * アイコン (`CELL_KIND_META`)、既存の `--cell-*` トークンだけで型ファミリーを示す。
 * 色だけに頼らないよう、`role="img"` + `aria-label` で型ファミリー名を公開する。
 */

/** 型ファミリー → 色トークン。新しい色は足さず、既存の意味トークンを再利用する。 */
const KIND_COLOR: Record<CellKind, string> = {
  number: "app.cell.number",
  decimal: "app.cell.decimal",
  bool: "app.cell.boolTrue",
  date: "app.cell.date",
  time: "app.cell.date",
  json: "app.cell.json",
  enum: "app.textSecondary",
  binary: "app.cell.binary",
  string: "app.textMuted",
};

/** DB カタログの型名 (`varchar(255)` / `timestamp with time zone` など) を型ファミリーへ分類する。 */
export function kindOfDataType(dataType: string): CellKind {
  return classifyTypeName(normalizeTypeForClassify(dataType));
}

export const TypeGlyph = memo(function TypeGlyph({
  kind,
  tooltip = false,
}: {
  kind: CellKind;
  /** true なら Tooltip を付ける (行数の多いツリーでは行側の既存ツールチップに任せて false)。 */
  tooltip?: boolean;
}) {
  const t = useT();
  const label = t(CELL_KIND_META[kind].labelKey);
  const glyph = (
    <chakra.span
      role="img"
      aria-label={label}
      display="inline-flex"
      alignItems="center"
      justifyContent="center"
      flexShrink={0}
      color={KIND_COLOR[kind]}
    >
      <Icon name={CELL_KIND_META[kind].icon} size={ICON_SIZES.sm} />
    </chakra.span>
  );
  return tooltip ? <Tooltip label={label}>{glyph}</Tooltip> : glyph;
});
