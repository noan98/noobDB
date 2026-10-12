import { Box, chakra } from "@chakra-ui/react";
import { Callout } from "./Callout";
import type { DropImpact } from "../dropImpact";
import { useT } from "../i18n";

/** 一覧に出す FK の最大行数。超えた分は「ほか N 件」に畳む。 */
const MAX_LINES = 8;

/**
 * DROP TABLE の確認ダイアログに添える「外部キーで参照されている」警告 (#1536)。
 * 参照元の子テーブル・列を `親.列 ← 子.列` の形で並べる。参照が無ければ何も描かない。
 * `sqlite` は FK 違反でも DROP が通りうる (`PRAGMA foreign_keys` 次第) ので文言を分ける。
 */
export function DropReferencedBy({ impacts, sqlite }: { impacts: DropImpact[]; sqlite: boolean }) {
  const t = useT();
  if (impacts.length === 0) return null;
  const lines = impacts.flatMap((imp) =>
    imp.refs.map((fk) => ({
      key: `${imp.table}\0${fk.table}\0${fk.column}`,
      text: `${imp.table}.${fk.referencedColumn} ← ${fk.table}.${fk.column}`,
    })),
  );
  const shown = lines.slice(0, MAX_LINES);
  return (
    <Callout
      tone="warning"
      role="status"
      mt="3"
      title={t("dropReferencedByTitle", { count: lines.length })}
      data-testid="drop-referenced-by"
    >
      <chakra.p m={0}>{t(sqlite ? "dropReferencedBySqlite" : "dropReferencedByServer")}</chakra.p>
      <Box as="ul" m={0} mt="1" pl="5" fontFamily="mono" fontSize="sm">
        {shown.map((l) => (
          <Box as="li" key={l.key} wordBreak="break-all">
            {l.text}
          </Box>
        ))}
        {lines.length > shown.length && (
          <Box as="li" listStyleType="none" ml="-5">
            {t("dropReferencedByMore", { count: lines.length - shown.length })}
          </Box>
        )}
      </Box>
    </Callout>
  );
}
