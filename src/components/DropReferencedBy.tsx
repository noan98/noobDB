import { chakra } from "@chakra-ui/react";
import { Callout } from "./Callout";
import { ImpactTree, type ImpactGroup } from "./ImpactTree";
import type { DropImpact } from "../dropImpact";
import { incomingFkTableName } from "../fkNavigation";
import { useT } from "../i18n";

/** 一覧に出す FK の最大行数。超えた分は「ほか N 件」に畳み、押すと展開する。 */
const MAX_LINES = 8;

/**
 * DROP TABLE の確認ダイアログに添える「外部キーで参照されている」警告 (#1536)。
 * 起点 (DROP するテーブル) のチップから、参照元の子テーブル・列を影響ツリーで並べる (#2295)。
 * 参照が無ければ何も描かない。
 * `sqlite` は FK 違反でも DROP が通りうる (`PRAGMA foreign_keys` 次第) ので文言を分け、結果バッジも出さない。
 */
export function DropReferencedBy({ impacts, sqlite }: { impacts: DropImpact[]; sqlite: boolean }) {
  const t = useT();
  if (impacts.length === 0) return null;
  const groups: ImpactGroup[] = impacts.map((imp) => ({
    key: imp.table,
    origin: { kind: "table", name: imp.table },
    nodes: imp.refs.map((fk) => ({
      key: `${incomingFkTableName(fk)}\0${fk.column}`,
      kind: "table",
      name: `${incomingFkTableName(fk)}.${fk.column}`,
      meta: `→ ${imp.table}.${fk.referencedColumn}`,
      outcome: sqlite ? undefined : "block",
    })),
  }));
  const count = groups.reduce((n, g) => n + g.nodes.length, 0);
  return (
    <Callout
      tone="warning"
      role="status"
      mt="3"
      title={t("dropReferencedByTitle", { count })}
      data-testid="drop-referenced-by"
    >
      <chakra.p m={0}>{t(sqlite ? "dropReferencedBySqlite" : "dropReferencedByServer")}</chakra.p>
      <ImpactTree groups={groups} maxVisible={MAX_LINES} />
    </Callout>
  );
}
