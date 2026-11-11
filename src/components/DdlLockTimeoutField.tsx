import { useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import {
  DEFAULT_DDL_LOCK_TIMEOUT_SECS,
  MAX_DDL_LOCK_TIMEOUT_SECS,
  setDdlLockTimeoutSecs,
  useSettings,
} from "../settings";
import { supportsLockTimeout } from "./onlineDdl";
import { Input, Switch } from "./ui";

/**
 * DDL 適用時の「ロック待ちの上限」(#2240)。値は設定ストアの `ddlLockTimeoutSecs` (0 = 付けない) で、
 * DDL を適用するモーダル (テーブル変更・インデックス作成) が共有する。PostgreSQL / MySQL 以外では何も出さない。
 */
export function DdlLockTimeoutField({ driver }: { driver: string }) {
  const t = useT();
  const { ddlLockTimeoutSecs: secs } = useSettings();
  // オフにしたあと、オンへ戻したときに直前の秒数へ戻すための記憶。
  const [lastOn, setLastOn] = useState(secs > 0 ? secs : DEFAULT_DDL_LOCK_TIMEOUT_SECS);
  if (!supportsLockTimeout(driver)) return null;
  const enabled = secs > 0;
  return (
    <chakra.div display="flex" flexDirection="column" gap="1" data-testid="ddl-lock-timeout">
      <Flex align="center" gap="3" wrap="wrap">
        <Switch
          checked={enabled}
          onChange={() => {
            if (enabled) {
              setLastOn(secs);
              setDdlLockTimeoutSecs(0);
            } else {
              setDdlLockTimeoutSecs(lastOn);
            }
          }}
          label={t("ddlLockTimeoutLabel")}
        />
        <Input
          type="number"
          min={1}
          max={MAX_DDL_LOCK_TIMEOUT_SECS}
          aria-label={t("ddlLockTimeoutLabel")}
          disabled={!enabled}
          value={enabled ? String(secs) : ""}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n >= 1) setDdlLockTimeoutSecs(n);
          }}
          width="20"
        />
        <chakra.span textStyle="caption">{t("ddlLockTimeoutSecs")}</chakra.span>
      </Flex>
      <chakra.span textStyle="caption">
        {enabled
          ? t(driver === "postgres" ? "ddlLockTimeoutHintPostgres" : "ddlLockTimeoutHintMysql", {
              secs: String(secs),
            })
          : t("ddlLockTimeoutOff")}
      </chakra.span>
    </chakra.div>
  );
}
