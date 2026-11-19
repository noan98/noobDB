import { useEffect, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { api } from "../api/tauri";
import { backupDefaultEnabled, backupTableName } from "../backupBeforeDestructive";
import { LARGE_COPY_ROWS } from "../tableClone";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import { Checkbox } from "./ui";
import { formatRowCount } from "./tableSize";

/**
 * 破壊的操作 (DROP / TRUNCATE / WHERE なし DELETE) の確認ダイアログに載せる「実行前に退避コピーを作る」
 * オプション (#2448)。チェックの状態は `onChange` で呼び出し側へ渡し、実際の退避は呼び出し側が
 * 確認ボタンの押下時に `runBackup` で行う (失敗したら本操作を実行しない)。
 * 本番接続では既定オン。推定行数がしきい値を超えると所要時間とディスク使用の警告を出す。
 */
interface Props {
  sessionId: string;
  driver: string;
  database: string;
  tables: readonly string[];
  isProduction: boolean;
  onChange: (enabled: boolean) => void;
}

export function BackupBeforeOption({ sessionId, driver, database, tables, isProduction, onChange }: Props) {
  const t = useT();
  const [enabled, setEnabled] = useState(backupDefaultEnabled(isProduction));
  const [rows, setRows] = useState<number | null>(null);
  const tableKey = tables.join("\u0000");

  // biome-ignore lint/correctness/useExhaustiveDependencies: tables は tableKey で代表させる (毎描画で配列が作り直される)
  useEffect(() => {
    let cancelled = false;
    // 推定が取れなくても退避自体はできる (警告を出さないだけ)。
    Promise.all(tables.map((tb) => api.tableRowEstimate(sessionId, database, tb).catch(() => null)))
      .then((all) => {
        if (cancelled) return;
        const known = all.filter((n): n is number => typeof n === "number");
        setRows(known.length > 0 ? known.reduce((a, b) => a + b, 0) : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId, database, tableKey]);

  const label =
    tables.length === 1
      ? t("backupOptionLabel", { name: backupTableName(driver, tables[0], new Date()) })
      : t("backupOptionLabelMany", { count: tables.length });

  return (
    <chakra.div display="flex" flexDirection="column" gap="1.5" data-testid="backup-before-option">
      <chakra.label display="flex" alignItems="center" gap="2" fontSize="sm" color="app.text">
        <Checkbox
          checked={enabled}
          onChange={() => {
            setEnabled(!enabled);
            onChange(!enabled);
          }}
        />
        <chakra.span fontFamily="mono" wordBreak="break-all">
          {label}
        </chakra.span>
      </chakra.label>
      <chakra.span textStyle="caption">{t("backupOptionHint")}</chakra.span>
      {enabled && rows !== null && (
        <chakra.span textStyle="caption">
          {t("backupRowEstimate", { rows: formatRowCount(rows) })}
        </chakra.span>
      )}
      {enabled && rows !== null && rows >= LARGE_COPY_ROWS && (
        <Callout tone="warning">{t("backupLargeData", { rows: formatRowCount(rows) })}</Callout>
      )}
      {enabled && <Callout tone="info">{t("backupStepsNote")}</Callout>}
      {enabled && <chakra.span textStyle="caption">{t("backupNotCovered")}</chakra.span>}
    </chakra.div>
  );
}
