import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import { isConstraintPrecheck, precheckRowsSql, type AlterPrecheck } from "./alterPrecheck";
import type { CountPreviewState } from "../useCountPreviews";
import { Callout } from "./Callout";
import { Button } from "./ui";

/**
 * ALTER の事前検査の結果表示 (#1536)。型を縮小した列・NOT NULL を付けた列について、既存行のうち
 * 新しい定義に収まらない件数を警告する。実行は止めない (件数は目安で、判断は利用者に任せる)。
 */
export function AlterPrecheckNotice({
  prechecks,
  counts,
  onOpenRows,
}: {
  prechecks: AlterPrecheck[];
  counts: Record<string, CountPreviewState>;
  /** 収まらない行を SELECT * でエディタ (結果グリッド) へ開く (#1626)。 */
  onOpenRows?: (sql: string) => void;
}) {
  const t = useT();
  if (prechecks.length === 0) return null;
  const failing = prechecks.flatMap((p) => {
    const c = counts[p.id];
    return c?.status === "ok" && c.count > 0 ? [{ check: p, count: c.count }] : [];
  });
  const pending = prechecks.some((p) => (counts[p.id]?.status ?? "loading") === "loading");
  const errors = prechecks.flatMap((p) => {
    const c = counts[p.id];
    return c?.status === "error" ? [{ check: p, error: c.error }] : [];
  });
  const kindKey = {
    length: "alterPrecheckLength",
    range: "alterPrecheckRange",
    decimal: "alterPrecheckDecimal",
    scale: "alterPrecheckScale",
    notNull: "alterPrecheckNotNull",
    orphanFk: "alterPrecheckOrphanFk",
    duplicateUnique: "alterPrecheckDuplicateUnique",
    checkViolation: "alterPrecheckCheckViolation",
  } as const;
  if (failing.length > 0) {
    return (
      <Callout
        tone="warning"
        role="status"
        title={t("alterPrecheckFailTitle", { count: failing.length })}
        data-testid="alter-precheck-warning"
      >
        <chakra.div display="flex" flexDirection="column" gap="0.5">
          <span>{t("alterPrecheckFailBody")}</span>
          {failing.map(({ check, count }) => (
            <chakra.span key={check.id} fontSize="sm">
              <chakra.code fontFamily="mono">{check.column}</chakra.code>
              {check.kind === "notNull" || isConstraintPrecheck(check.kind)
                ? ` (${check.to})`
                : ` (${check.from} → ${check.to})`}
              : {t(kindKey[check.kind], { count })}
              {onOpenRows && precheckRowsSql(check.sql) && (
                <>
                  {" "}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const rowsSql = precheckRowsSql(check.sql);
                      if (rowsSql) onOpenRows(rowsSql);
                    }}
                  >
                    {t("alterPrecheckOpenRows")}
                  </Button>
                </>
              )}
            </chakra.span>
          ))}
        </chakra.div>
      </Callout>
    );
  }
  if (pending) {
    return (
      <chakra.span textStyle="caption" color="app.textMuted" role="status">
        {t("alterPrecheckRunning")}
      </chakra.span>
    );
  }
  if (errors.length > 0) {
    return (
      <chakra.span textStyle="caption" color="app.textMuted" role="status">
        {t("alterPrecheckError", { error: errors[0].error })}
      </chakra.span>
    );
  }
  return (
    <Callout tone="success" role="status" data-testid="alter-precheck-ok">
      {t("alterPrecheckOk")}
    </Callout>
  );
}
