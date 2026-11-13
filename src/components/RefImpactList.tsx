import { chakra } from "@chakra-ui/react";
import { Callout } from "./Callout";
import { ImpactTree, type ImpactGroup, type ImpactOutcome } from "./ImpactTree";
import { Button } from "./ui";
import { useT } from "../i18n";
import { incomingFkTableName } from "../fkNavigation";
import { blocksDelete, type RefImpact } from "../refImpact";

/** 一覧に出す子テーブルの最大行数。超えた分は「ほか N 件」に畳み、押すと展開する。 */
const MAX_LINES = 8;

/**
 * 行削除 / TRUNCATE の確認ダイアログに添える「子テーブルの参照行数」(#1506)。
 * 起点 (参照される親.列) のチップから、子テーブル.列を結果バッジ (連鎖削除 / ブロック / NULL 化) つきの
 * 影響ツリーで並べ (#2295)、各行に「子行を開く」を付ける。行数・ON DELETE は補足行に出す。
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
  moreCascade,
  onOpen,
}: {
  impacts: RefImpact[];
  mode: "rows" | "truncate";
  driver: string;
  partial?: boolean;
  unverified?: string[];
  /** 深さ / FK 数の上限で連鎖を辿りきれなかった (さらに連鎖がありうる、#1767)。 */
  moreCascade?: boolean;
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
  const moreCascadeNote = moreCascade ? (
    <Callout tone="warning" role="status" data-testid="ref-impact-more-cascade">
      {t("refImpactMoreCascade")}
    </Callout>
  ) : null;
  if (impacts.length === 0)
    return (
      <>
        {moreCascadeNote}
        {unverifiedNote}
      </>
    );
  const partial = partialProp || impacts.some((i) => i.capped);
  const total = impacts.reduce((sum, i) => sum + i.count, 0);
  // MySQL / PostgreSQL の TRUNCATE は ON DELETE に関係なく、参照されていれば失敗する。
  const truncateRefuses = mode === "truncate" && !sqlite;
  const blocked = !truncateRefuses && impacts.some((i) => blocksDelete(i.onDelete));
  const cascading = !truncateRefuses && impacts.some((i) => i.onDelete === "CASCADE");
  const groups = groupByParent(impacts, { mode, truncateRefuses, onOpen, t });
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
        <ImpactTree groups={groups} maxVisible={MAX_LINES} />
      </Callout>
      {moreCascadeNote}
      {unverifiedNote}
    </>
  );
}

/** 行削除での ON DELETE ごとの結果文言 (連鎖削除 / 失敗する見込み / 変更、#1767)。 */
function actionKey(rule: RefImpact["onDelete"]) {
  switch (rule) {
    case "CASCADE":
      return "refImpactActCascade";
    case "SET NULL":
      return "refImpactActSetNull";
    case "SET DEFAULT":
      return "refImpactActSetDefault";
    default:
      return "refImpactActBlock";
  }
}

/** 親.列ごとの塊にする (起点チップ = 参照される側)。連鎖の 2 段目以降は、その子テーブルが親の塊になる。 */
function groupByParent(
  impacts: RefImpact[],
  opts: {
    mode: "rows" | "truncate";
    truncateRefuses: boolean;
    onOpen?: (impact: RefImpact) => void;
    t: ReturnType<typeof useT>;
  },
): ImpactGroup[] {
  const { mode, truncateRefuses, onOpen, t } = opts;
  const groups = new Map<string, ImpactGroup>();
  for (const imp of impacts) {
    const origin = `${imp.parentTable ? `${imp.parentTable}.` : ""}${imp.referencedColumn}`;
    let g = groups.get(origin);
    if (!g) {
      g = { key: origin, origin: { kind: "column", name: origin }, nodes: [] };
      groups.set(origin, g);
    }
    const count =
      mode === "rows"
        ? t(actionKey(imp.onDelete), { count: imp.count })
        : t(imp.capped ? "refImpactRowCountCapped" : "refImpactRowCount", { count: imp.count });
    const depth = imp.depth ?? 1;
    g.nodes.push({
      key: `${imp.parentTable ?? ""}\0${incomingFkTableName(imp)}\0${imp.column}`,
      kind: "table",
      name: `${incomingFkTableName(imp)}.${imp.column}`,
      outcome: truncateRefuses ? "block" : outcomeOf(imp.onDelete),
      meta: `${count}${depth > 1 ? ` · ${t("refImpactDepth", { depth })}` : ""} · ON DELETE ${imp.onDelete}`,
      action:
        onOpen && depth === 1 ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => onOpen(imp)}>
            {t("refImpactOpen")}
          </Button>
        ) : undefined,
      testId: "ref-impact-row",
    });
  }
  return [...groups.values()];
}

/** ON DELETE → 結果バッジ。CASCADE / SET NULL / SET DEFAULT 以外 (RESTRICT / NO ACTION) は DELETE を止める。 */
function outcomeOf(rule: RefImpact["onDelete"]): ImpactOutcome {
  switch (rule) {
    case "CASCADE":
      return "cascade";
    case "SET NULL":
      return "setNull";
    case "SET DEFAULT":
      return "setDefault";
    default:
      return "block";
  }
}
