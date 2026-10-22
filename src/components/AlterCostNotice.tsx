import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import { MYSQL_ONLINE_CLAUSE, type AlterCostReason, type AlterCostRisk } from "./alterCost";
import { formatRowCount } from "./tableSize";
import { Callout } from "./Callout";
import { Switch } from "./ui";

const REASON_KEY = {
  mysqlCopyType: "alterCostMysqlCopyType",
  mysqlCopyForeignKey: "alterCostMysqlCopyForeignKey",
  mysqlCopyCheck: "alterCostMysqlCopyCheck",
  mysqlRebuildNullability: "alterCostMysqlRebuildNullability",
  pgRewriteType: "alterCostPgRewriteType",
  mysqlCopyAddColumn: "alterCostMysqlCopyAddColumn",
  pgRewriteAddColumn: "alterCostPgRewriteAddColumn",
  pgRewriteVolatileDefault: "alterCostPgRewriteVolatileDefault",
  pgScanSetNotNull: "alterCostPgScanSetNotNull",
  pgScanForeignKey: "alterCostPgScanForeignKey",
  pgScanCheck: "alterCostPgScanCheck",
  pgIndexBuildLock: "alterCostPgIndexBuildLock",
} as const satisfies Record<AlterCostReason, string>;

/**
 * 書き換え / 全件走査 / 長いロックを伴う ALTER の警告 (#1771)。何が起きるか (操作ごと) と概算行数を示す。
 * MySQL では `ALGORITHM=INPLACE, LOCK=NONE` を付ける切り替えも出す (COPY が要る変更は実行時エラーで止まる)。
 * 実行は止めない (行数は概算で、止めるかどうかは利用者の判断)。
 */
export function AlterCostNotice({
  driver,
  risks,
  rows,
  rowsLoading,
  showOnlineToggle,
  onlineEnabled,
  onOnlineChange,
}: {
  driver: string;
  risks: AlterCostRisk[];
  /** 概算行数。`null` は不明。 */
  rows: number | null;
  rowsLoading: boolean;
  showOnlineToggle: boolean;
  onlineEnabled: boolean;
  onOnlineChange: (v: boolean) => void;
}) {
  const t = useT();
  if (risks.length === 0) return null;
  const heavy = risks.some((r) => r.severity !== "rebuild");
  return (
    <Callout
      tone="warning"
      role="status"
      title={t("alterCostTitle", { count: risks.length })}
      data-testid="alter-cost-warning"
    >
      <chakra.div display="flex" flexDirection="column" gap="0.5">
        <span>{driver === "postgres" ? t("alterCostBodyPostgres") : t("alterCostBodyMysql")}</span>
        <chakra.span fontSize="sm" color="app.textSecondary" data-testid="alter-cost-rows">
          {rowsLoading
            ? t("alterCostRowsLoading")
            : rows == null
              ? t("alterCostRowsUnknown")
              : t("alterCostRows", { rows: formatRowCount(rows) })}
        </chakra.span>
        {risks.map((r) => (
          <chakra.span key={r.id} fontSize="sm">
            <chakra.code fontFamily="mono">{r.subject}</chakra.code>: {t(REASON_KEY[r.reason])}
          </chakra.span>
        ))}
        {!heavy && <chakra.span fontSize="sm">{t("alterCostRebuildOnly")}</chakra.span>}
        {showOnlineToggle && (
          <Switch
            checked={onlineEnabled}
            onChange={() => onOnlineChange(!onlineEnabled)}
            label={t("alterCostOnlineToggle", { clause: MYSQL_ONLINE_CLAUSE })}
          />
        )}
        {showOnlineToggle && (
          <chakra.span textStyle="caption" color="app.textMuted">
            {t("alterCostOnlineHint")}
          </chakra.span>
        )}
      </chakra.div>
    </Callout>
  );
}
