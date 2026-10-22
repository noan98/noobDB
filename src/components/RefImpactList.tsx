import { Box, chakra } from "@chakra-ui/react";
import { Callout } from "./Callout";
import { Button } from "./ui";
import { useT } from "../i18n";
import { incomingFkTableName } from "../fkNavigation";
import { blocksDelete, type RefImpact } from "../refImpact";

/** 一覧に出す子テーブルの最大行数。超えた分は「ほか N 件」に畳む。 */
const MAX_LINES = 8;

/**
 * 行削除 / TRUNCATE の確認ダイアログに添える「子テーブルの参照行数」(#1506)。
 * `子.列 ← 親.列  N 行 · ON DELETE …` を並べ、各行に「子行を開く」を付ける。
 * 参照が無ければ何も描かない。`mode` で文言を分ける:
 * - rows: 選択した行の削除。ON DELETE ごとの結果 (ブロック / 連鎖削除 / NULL 化) を示す。
 * - truncate: テーブル全体の TRUNCATE。MySQL / PostgreSQL は参照されたままだと失敗する。
 * truncate はドライバで挙動が違う: MySQL / PostgreSQL は ON DELETE に関係なく、参照されたままだと
 * 失敗する。SQLite の TRUNCATE は `DELETE FROM` なので rows と同じく ON DELETE ごとの結果になる。
 * `partial` は一部の値だけで数えた / 上限で打ち切ったとき (件数は下限)。SQLite は FK の強制が
 * `PRAGMA foreign_keys` 次第である旨を足す。`unverified` は子テーブルがあるのに数えられなかった
 * 親テーブル名 (参照行数を確認できなかった旨を出す)。
 */
export function RefImpactList({
  impacts,
  mode,
  driver,
  partial: partialProp,
  unverified,
  onOpen,
}: {
  impacts: RefImpact[];
  mode: "rows" | "truncate";
  driver: string;
  partial?: boolean;
  unverified?: string[];
  onOpen?: (impact: RefImpact) => void;
}) {
  const t = useT();
  const sqlite = driver === "sqlite";
  const unverifiedNote =
    unverified && unverified.length > 0 ? (
      <Callout tone="warning" role="status" data-testid="ref-impact-unverified">
        {t("refImpactUnverified", { tables: unverified.join(", ") })}
      </Callout>
    ) : null;
  if (impacts.length === 0) return unverifiedNote;
  const partial = partialProp || impacts.some((i) => i.capped);
  const total = impacts.reduce((sum, i) => sum + i.count, 0);
  const shown = impacts.slice(0, MAX_LINES);
  // MySQL / PostgreSQL の TRUNCATE は ON DELETE に関係なく、参照されていれば失敗する。
  const truncateRefuses = mode === "truncate" && !sqlite;
  const blocked = !truncateRefuses && impacts.some((i) => blocksDelete(i.onDelete));
  const cascading = !truncateRefuses && impacts.some((i) => i.onDelete === "CASCADE");
  return (
    <>
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
          {truncateRefuses &&
            ` ${t(driver === "postgres" ? "refImpactTruncateRefusesPg" : "refImpactTruncateRefusesMysql")}`}
          {blocked && ` ${t(mode === "truncate" ? "refImpactBlockedTruncate" : "refImpactBlockedRows")}`}
          {cascading && ` ${t("refImpactCascading")}`}
          {sqlite && ` ${t("refImpactSqlite")}`}
        </chakra.p>
        <Box as="ul" m={0} mt="2" p={0} listStyleType="none" display="flex" flexDirection="column" gap="1">
          {shown.map((imp) => (
            <Box
              as="li"
              key={`${imp.parentTable ?? ""}\0${incomingFkTableName(imp)}\0${imp.column}`}
              display="flex"
              alignItems="center"
              gap="2"
              data-testid="ref-impact-row"
            >
              <Box flex="1" minW="0" fontFamily="mono" fontSize="sm" wordBreak="break-all">
                {`${incomingFkTableName(imp)}.${imp.column} ← ${imp.parentTable ? `${imp.parentTable}.` : ""}${imp.referencedColumn}`}
                <chakra.span display="block" fontFamily="body" color="app.textMuted">
                  {t(imp.capped ? "refImpactRowCountCapped" : "refImpactRowCount", { count: imp.count })} · ON
                  DELETE {imp.onDelete}
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
      {unverifiedNote}
    </>
  );
}
