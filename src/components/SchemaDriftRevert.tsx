import { useEffect, useState } from "react";
import { Box, Flex, chakra } from "@chakra-ui/react";

import { api, type SchemaDriftRevertSql } from "../api/tauri";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import { CopyButton } from "./CopyButton";
import { Icon, ICON_SIZES } from "./Icon";
import { CodePreview, ErrorNote } from "./modalForm";
import { Spinner } from "./Spinner";
import { Button, Switch } from "./ui";
import { useCopyFeedback } from "./useCopyFeedback";

/**
 * スキーマ世代の差分から「巻き戻し DDL」を作って見せる (#1621)。`fromId` = 戻したい世代、
 * `toId` = 現在側の世代。生成のみで実行はしない — 内容を確認してからエディタへ挿入し、
 * 通常の実行経路 (安全網つき) で流す。DROP を含む文は既定では出さず、スイッチで許可する。
 */
export function SchemaDriftRevert({
  profileId,
  fromId,
  toId,
  onInsertSql,
  onClose,
}: {
  profileId: string;
  fromId: string;
  toId: string;
  /** 指定されると「エディタに挿入」を出す。 */
  onInsertSql?: (sql: string) => void;
  /** 挿入したあとにパネルを閉じて作業画面へ戻す。 */
  onClose: () => void;
}) {
  const t = useT();
  const { copied, copy } = useCopyFeedback();
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [result, setResult] = useState<SchemaDriftRevertSql | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(null);
    api
      .schemaDriftRevertSql(profileId, fromId, toId, allowDestructive)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, fromId, toId, allowDestructive]);

  const sql = result
    ? result.plan.statements.map((s) => (s.sql.trimEnd().endsWith(";") ? s.sql : `${s.sql};`)).join("\n")
    : "";

  return (
    <Flex
      direction="column"
      gap="2"
      border="1px solid"
      borderColor="app.border"
      borderRadius="md"
      px="3"
      py="2"
      data-testid="schema-drift-revert"
    >
      <Flex align="center" gap="3" wrap="wrap">
        <chakra.strong fontSize="sm">{t("schemaDriftRevertTitle")}</chakra.strong>
        <Box flex="1" />
        <chakra.label display="flex" alignItems="center" gap="2" fontSize="sm" color="app.textSecondary">
          <Switch
            size="sm"
            checked={allowDestructive}
            onChange={setAllowDestructive}
            aria-label={t("schemaDriftRevertAllowDestructive")}
          />
          {t("schemaDriftRevertAllowDestructive")}
        </chakra.label>
      </Flex>
      {error && <ErrorNote role="alert">{error}</ErrorNote>}
      {!result && !error && (
        <Flex align="center" gap="2" role="status">
          <Spinner size={12} decorative />
          <chakra.span fontSize="xs" color="app.textMuted">
            {t("schemaDriftRevertLoading")}
          </chakra.span>
        </Flex>
      )}
      {result && (
        <>
          {result.omitted_destructive > 0 && (
            <Callout tone="warning" role="status">
              {t("schemaDriftRevertOmitted", { count: result.omitted_destructive })}
            </Callout>
          )}
          {result.plan.warnings.map((w) => (
            <Callout key={w} tone="info" role="status">
              {w}
            </Callout>
          ))}
          {result.plan.statements.length === 0 ? (
            <chakra.p m={0} textStyle="body" color="app.textMuted">
              {t("schemaDriftRevertEmpty")}
            </chakra.p>
          ) : (
            <>
              {allowDestructive && result.plan.statements.some((s) => s.destructive) && (
                <Callout tone="danger" role="status">
                  {t("schemaDriftRevertDestructiveNote")}
                </Callout>
              )}
              <CodePreview maxH="220px" data-testid="schema-drift-revert-sql">
                {sql}
              </CodePreview>
              <Flex gap="2" justify="flex-end">
                <CopyButton
                  copied={copied}
                  onClick={() => void copy(sql)}
                  label={t("schemaDriftRevertCopy")}
                  copiedLabel={t("gridCopied")}
                  showLabel
                  display="inline-flex"
                />
                {onInsertSql && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      onInsertSql(sql);
                      onClose();
                    }}
                  >
                    <Icon name="pencil" size={ICON_SIZES.sm} /> {t("schemaDriftRevertInsert")}
                  </Button>
                )}
              </Flex>
            </>
          )}
        </>
      )}
    </Flex>
  );
}
