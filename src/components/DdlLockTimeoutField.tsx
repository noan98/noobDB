import { useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import {
  DEFAULT_DDL_LOCK_TIMEOUT_SECS,
  ddlLockTimeoutSecsFor,
  MAX_DDL_LOCK_TIMEOUT_SECS,
  setDdlLockTimeoutSecs,
  setDdlLockWaitTimeoutSecsMysql,
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
  const settings = useSettings();
  const secs = ddlLockTimeoutSecsFor(settings, driver);
  const setSecs = driver === "mysql" ? setDdlLockWaitTimeoutSecsMysql : setDdlLockTimeoutSecs;
  // オフにしたあと、オンへ戻したときに直前の秒数へ戻すための記憶。
  const [lastOn, setLastOn] = useState(secs > 0 ? secs : DEFAULT_DDL_LOCK_TIMEOUT_SECS);
  // 入力中の下書き。空にしても打ち直せるよう、確定 (blur) まで設定へ反映しない。
  const [draft, setDraft] = useState<string | null>(null);
  if (!supportsLockTimeout(driver)) return null;
  const enabled = secs > 0;
  const commit = () => {
    if (draft === null) return;
    const n = Number.parseInt(draft, 10);
    if (Number.isFinite(n) && n >= 1) setSecs(n);
    setDraft(null);
  };
  return (
    <chakra.div display="flex" flexDirection="column" gap="1" data-testid="ddl-lock-timeout">
      <Flex align="center" gap="3" wrap="wrap">
        <Switch
          checked={enabled}
          onChange={() => {
            setDraft(null);
            if (enabled) {
              setLastOn(secs);
              setSecs(0);
            } else {
              setSecs(lastOn);
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
          value={draft ?? (enabled ? String(secs) : "")}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
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
