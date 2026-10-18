import { Box, chakra } from "@chakra-ui/react";
import { Callout } from "./Callout";
import { Button } from "./ui";
import { useT } from "../i18n";
import { blocksDelete, type RefImpact } from "../refImpact";

/** 一覧に出す子テーブルの最大行数。超えた分は「ほか N 件」に畳む。 */
const MAX_LINES = 8;

/**
 * 行削除 / TRUNCATE の確認ダイアログに添える「子テーブルの参照行数」(#1506)。
 * `子.列 ← 親.列  N 行 · ON DELETE …` を並べ、各行に「子行を開く」を付ける。
 * 参照が無ければ何も描かない。`mode` で文言を分ける:
 * - rows: 選択した行の削除。ON DELETE ごとの結果 (ブロック / 連鎖削除 / NULL 化) を示す。
 * - truncate: テーブル全体の TRUNCATE。MySQL / PostgreSQL は参照されたままだと失敗する。
 * `partial` は削除行が多く一部の値だけで数えたとき (件数は下限)。`sqlite` は FK の強制が
 * `PRAGMA foreign_keys` 次第である旨を足す。
 */
export function RefImpactList({
  impacts,
  mode,
  sqlite,
  partial,
  onOpen,
}: {
  impacts: RefImpact[];
  mode: "rows" | "truncate";
  sqlite: boolean;
  partial?: boolean;
  onOpen?: (impact: RefImpact) => void;
}) {
  const t = useT();
  if (impacts.length === 0) return null;
  const total = impacts.reduce((sum, i) => sum + i.count, 0);
  const shown = impacts.slice(0, MAX_LINES);
  const blocked = impacts.some((i) => blocksDelete(i.onDelete));
  const cascading = impacts.some((i) => i.onDelete === "CASCADE");
  return (
    <Callout
      tone="warning"
      role="status"
      title={t(partial ? "refImpactTitlePartial" : "refImpactTitle", {
        count: total,
        tables: impacts.length,
      })}
      data-testid="ref-impact-list"
    >
      <chakra.p m={0}>
        {mode === "truncate" ? t("refImpactIntroTruncate") : t("refImpactIntroRows")}
        {blocked && ` ${t(mode === "truncate" ? "refImpactBlockedTruncate" : "refImpactBlockedRows")}`}
        {cascading && mode === "rows" && ` ${t("refImpactCascading")}`}
        {sqlite && ` ${t("refImpactSqlite")}`}
      </chakra.p>
      <Box as="ul" m={0} mt="2" p={0} listStyleType="none" display="flex" flexDirection="column" gap="1">
        {shown.map((imp) => (
          <Box
            as="li"
            key={`${imp.parentTable ?? ""}\0${imp.table}\0${imp.column}`}
            display="flex"
            alignItems="center"
            gap="2"
            data-testid="ref-impact-row"
          >
            <Box flex="1" minW="0" fontFamily="mono" fontSize="sm" wordBreak="break-all">
              {`${imp.table}.${imp.column} ← ${imp.parentTable ? `${imp.parentTable}.` : ""}${imp.referencedColumn}`}
              <chakra.span display="block" fontFamily="body" color="app.textMuted">
                {t("refImpactRowCount", { count: imp.count })} · ON DELETE {imp.onDelete}
              </chakra.span>
            </Box>
            {onOpen && (
              <Button type="button" variant="secondary" size="sm" onClick={() => onOpen(imp)}>
                {t("refImpactOpen")}
              </Button>
            )}
          </Box>
        ))}
        {impacts.length > shown.length && (
          <Box as="li">{t("refImpactMore", { count: impacts.length - shown.length })}</Box>
        )}
      </Box>
    </Callout>
  );
}
