import { useState } from "react";
import { useT } from "../i18n";
import { classifyLockError } from "./deadlock";
import { Icon, ICON_SIZES } from "./Icon";
import { Button } from "./ui";

/**
 * エラー表示の下に出す「デッドロックを解析」ボタン (#2328)。エラー文がデッドロック
 * (MySQL 1213 / PostgreSQL 40P01) か SQLite のロック競合 (`SQLITE_BUSY`) のときだけ出る。
 * 押すと診断グループの「デッドロック解析」タブをエラー文つきで開く。
 */
export function DeadlockAnalyzeButton({
  driver,
  message,
  onOpen,
}: {
  driver: string;
  message: string;
  /** `shownAtMs` はこのエラーが表示された時刻 (最新の報告が今回のものかの判定に使う)。 */
  onOpen: (shownAtMs: number) => void;
}) {
  const t = useT();
  // エラーごとに作り直される (呼び出し側が key を付ける) ので、表示された時刻を覚えておける。
  const [shownAt] = useState(() => Date.now());
  const kind = classifyLockError(driver, message);
  if (!kind) return null;
  return (
    <div data-testid="deadlock-analyze">
      <Button type="button" size="sm" variant="secondary" onClick={() => onOpen(shownAt)}>
        <Icon name="lock" size={ICON_SIZES.sm} />
        {kind === "busy" ? t("deadlockBusyButton") : t("deadlockAnalyzeButton")}
      </Button>
    </div>
  );
}
