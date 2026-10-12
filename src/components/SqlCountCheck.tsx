import { useEffect, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api } from "../api/tauri";
import { buildSuggestionCountSql, checkSuggestionSql, type SuggestionCheckResult } from "../ai/suggestionCheck";
import { useT } from "../i18n";
import { COUNT_PREVIEW_TIMEOUT_SECS } from "../useCountPreviews";
import { Button } from "./ui";

/** MySQL の 1060 (Duplicate column name)。`SELECT COUNT(*) FROM (…) q` は派生表の列名が重複できない。 */
function isDuplicateColumnError(error: string): boolean {
  return /\b1060\b|Duplicate column name/i.test(error);
}

/**
 * AI が出した SQL の「件数で検証」ボタンと結果表示 (#1536)。押したときだけ、
 * `SELECT COUNT(*) FROM (<SQL>) q` を読み取り専用 (`run_lookup_query`。read_only 接続でも通り、
 * 履歴・結果キャッシュに載らない) で 1 回実行する。自動では撃たない — 大きな表への全件集計を
 * 利用者の意思なしに走らせないため。SQL が編集されたら古い結果は捨てる。
 *
 * - `violations`: データ品質アサーション向け。件数は「違反件数」で、0 件なら合格と表示する。
 * - `rows`: 通常の SELECT 向け。件数は「結果の行数」。
 */
export function SqlCountCheck({
  sessionId,
  database,
  driver,
  sql,
  mode,
  disabled,
}: {
  sessionId: string;
  database: string | null;
  driver: string;
  sql: string;
  mode: "violations" | "rows";
  disabled?: boolean;
}) {
  const t = useT();
  const [state, setState] = useState<{ sql: string; result: SuggestionCheckResult | "running" } | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 検証できない形 (SELECT / WITH 以外・空) ではボタンを出さない。
  if (buildSuggestionCountSql(sql, driver) === null) return null;

  const run = async () => {
    const target = sql;
    setState({ sql: target, result: "running" });
    const result = await checkSuggestionSql(
      (countSql) =>
        api.runLookupQuery({
          sessionId,
          sql: countSql,
          database,
          queryTimeoutSecs: COUNT_PREVIEW_TIMEOUT_SECS,
          rowCap: 1,
        }),
      target,
      driver,
    );
    if (aliveRef.current) setState({ sql: target, result });
  };

  // 実行後に SQL を編集した場合、その結果は今の SQL のものではない。
  const current = state && state.sql === sql ? state.result : null;
  const running = current === "running";
  return (
    <Flex align="center" gap="2" wrap="wrap" data-testid="sql-count-check">
      <Button type="button" variant="secondary" size="sm" disabled={disabled || running} onClick={() => void run()}>
        {t(mode === "violations" ? "sqlCheckViolationsButton" : "sqlCheckRowsButton")}
      </Button>
      <chakra.span role="status" fontSize="sm" color={current && current !== "running" && current.status === "error" ? "app.textError" : "app.textMuted"}>
        {running
          ? t("sqlCheckRunning")
          : current && current.status === "ok"
            ? mode === "violations"
              ? current.count === 0
                ? t("sqlCheckViolationsZero")
                : t("sqlCheckViolations", { count: current.count.toLocaleString() })
              : t("sqlCheckRows", { count: current.count.toLocaleString() })
            : current && current.status === "error"
              ? t("sqlCheckError", { error: current.error }) +
                (isDuplicateColumnError(current.error) ? ` ${t("sqlCheckDuplicateColumn")}` : "")
              : t("sqlCheckHint")}
      </chakra.span>
    </Flex>
  );
}
