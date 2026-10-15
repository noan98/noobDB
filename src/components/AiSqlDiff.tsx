import { chakra } from "@chakra-ui/react";
import type { DiffLine } from "../ai/sqlAssist";
import { useT } from "../i18n";
import { semanticColorToken } from "../semanticColors";

// 行単位 diff の表示 (SQL アシストのリライトと、エラー解説の修正案で共有)。

const DIFF_BG: Record<DiffLine["type"], string | undefined> = {
  same: undefined,
  add: semanticColorToken("success", "subtle"),
  del: semanticColorToken("danger", "subtle"),
};
const DIFF_MARK: Record<DiffLine["type"], string> = { same: " ", add: "+", del: "-" };

/** 行単位 diff の表示。追加 / 削除は success / danger の subtle 地 + 先頭記号で示す (色だけに頼らない)。 */
export function DiffView({ lines }: { lines: readonly DiffLine[] }) {
  const t = useT();
  return (
    <chakra.div
      role="group"
      aria-label={t("aiSqlDiff")}
      data-testid="ai-sql-diff"
      border="1px solid"
      borderColor="app.border"
      borderRadius="md"
      bg="app.bgInput"
      fontFamily="mono"
      fontSize="sm"
      lineHeight="normal"
      maxH="240px"
      overflow="auto"
    >
      {lines.map((l, i) => (
        <chakra.div key={i} display="flex" gap="2" px="2.5" bg={DIFF_BG[l.type]} data-diff={l.type}>
          <chakra.span
            aria-label={
              l.type === "add" ? t("aiSqlDiffAdded") : l.type === "del" ? t("aiSqlDiffRemoved") : undefined
            }
            color="app.textMuted"
            userSelect="none"
          >
            {DIFF_MARK[l.type]}
          </chakra.span>
          <chakra.span whiteSpace="pre-wrap" wordBreak="break-word" minW="0">
            {l.text}
          </chakra.span>
        </chakra.div>
      ))}
    </chakra.div>
  );
}
