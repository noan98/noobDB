import { useMemo } from "react";
import { chakra } from "@chakra-ui/react";
import type { DiffLine } from "../ai/sqlAssist";
import { useT } from "../i18n";
import { semanticColorToken } from "../semanticColors";
import { SQL_TOKEN_STYLE, sqlHighlightLines, type SqlHighlightSegment } from "./sqlHighlight";

// 行単位 diff の表示 (SQL アシストのリライトと、エラー解説の修正案で共有)。

const DIFF_BG: Record<DiffLine["type"], string | undefined> = {
  same: undefined,
  add: semanticColorToken("success", "subtle"),
  del: semanticColorToken("danger", "subtle"),
};
const DIFF_MARK: Record<DiffLine["type"], string> = { same: " ", add: "+", del: "-" };

/**
 * 行単位 diff の表示。追加 / 削除は success / danger の subtle 地 + 先頭記号で示す (色だけに頼らない)。
 * 文字色はエディタと同じ `--syntax-*` 配色で SQL として色分けし、行の背景色に重ねる (#2178)。
 * 大きすぎる SQL (`shouldHighlightSql`) は単色。`driver` を省略すると MySQL 方言で解析する。
 */
export function DiffView({ lines, driver }: { lines: readonly DiffLine[]; driver?: string }) {
  const t = useT();
  // 旧側 (same + del) と新側 (same + add) を別々に解析し、各行を元の位置へ戻す。1 本につなげて解析すると、
  // 削除行の閉じていない引用符やコメントが後ろの追加行へ流れ込んで色が崩れる。
  const highlighted = useMemo(() => {
    const oldSide = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.type !== "add");
    const newSide = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.type !== "del");
    const perLine: (SqlHighlightSegment[] | null)[] = lines.map(() => null);
    let any = false;
    // 旧側 → 新側の順に埋める。same 行は新側の解析が優先され、新側が単色なら旧側の色を使う。
    for (const side of [oldSide, newSide]) {
      const segs = sqlHighlightLines(
        side.map(({ l }) => l.text),
        driver ?? "",
      );
      if (!segs) continue;
      any = true;
      side.forEach(({ i }, k) => {
        perLine[i] = segs[k] ?? null;
      });
    }
    return any ? perLine : null;
  }, [lines, driver]);
  return (
    <chakra.div
      role="group"
      aria-label={t("aiSqlDiff")}
      data-testid="ai-sql-diff"
      data-sql-highlight={highlighted ? "on" : "off"}
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
            {highlighted?.[i]
              ? (highlighted[i] ?? []).map((seg, j) =>
                  seg.kind ? (
                    <span key={j} style={SQL_TOKEN_STYLE[seg.kind]}>
                      {seg.text}
                    </span>
                  ) : (
                    seg.text
                  ),
                )
              : l.text}
          </chakra.span>
        </chakra.div>
      ))}
    </chakra.div>
  );
}
