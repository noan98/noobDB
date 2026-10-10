import { useEffect, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import {
  removeTableOpenQueryOverride,
  setTableOpenQueryTemplate,
  useSettings,
} from "../settings";
import {
  TABLE_QUERY_PLACEHOLDERS,
  tableQueryTemplateErrorMessage,
  validateTableQueryTemplate,
} from "../tableQueryTemplate";
import { Icon, ICON_SIZES } from "./Icon";
import { FieldError, FieldLabel, FormSection } from "./modalForm";
import { SettingsInfo, SettingsLabelWithInfo } from "./settingsLayout";
import { Tooltip } from "./Tooltip";
import { Button, Textarea } from "./ui";

/**
 * 設定画面「テーブルを開いたときのデフォルトクエリ」(#1253) の中身。
 *
 * 全体テンプレートは入力のたびに検証し、通ったときだけ保存する (通らなければ
 * `FieldError` で理由を出し、保存済みの値は変えない)。テーブル別の上書きは
 * スキーマツリーの右クリックから設定し、ここでは一覧の確認と削除だけを行う。
 */
export function TableOpenQuerySettings() {
  const t = useT();
  const settings = useSettings();
  const [draft, setDraft] = useState(settings.tableOpenQueryTemplate);
  useEffect(() => setDraft(settings.tableOpenQueryTemplate), [settings.tableOpenQueryTemplate]);
  const error = validateTableQueryTemplate(draft);
  const errorMsg = error ? tableQueryTemplateErrorMessage(error) : null;

  const onChange = (value: string) => {
    setDraft(value);
    setTableOpenQueryTemplate(value);
  };

  const overrides = [...settings.tableOpenQueryOverrides].sort((a, b) =>
    `${a.profileName}\u0000${a.database}\u0000${a.table}`.localeCompare(
      `${b.profileName}\u0000${b.database}\u0000${b.table}`,
    ),
  );

  return (
    <Flex direction="column" gap="3" px="2">
      <FormSection>
        <FieldLabel htmlFor="settings-table-open-query">{t("tableOpenQueryGlobalLabel")}</FieldLabel>
        <Textarea
          id="settings-table-open-query"
          rows={3}
          fontFamily="mono"
          fontSize="sm"
          spellCheck={false}
          value={draft}
          placeholder="SELECT * FROM {table} ORDER BY {pk} DESC LIMIT {limit}"
          aria-invalid={error ? true : undefined}
          aria-describedby="settings-table-open-query-help"
          onChange={(e) => onChange(e.target.value)}
        />
        {errorMsg && <FieldError>{t(errorMsg.key, errorMsg.vars)}</FieldError>}
        <chakra.span id="settings-table-open-query-help" fontSize="sm" color="app.textMuted">
          {t("tableOpenQueryGlobalHelp", {
            placeholders: TABLE_QUERY_PLACEHOLDERS.map((p) => `{${p}}`).join(" / "),
          })}
        </chakra.span>
      </FormSection>

      <FormSection>
        <SettingsLabelWithInfo>
          <FieldLabel as="div">{t("tableOpenQueryOverridesLabel")}</FieldLabel>
          <SettingsInfo>{t("tableOpenQueryOverridesHelp")}</SettingsInfo>
        </SettingsLabelWithInfo>
        {overrides.length === 0 ? (
          <chakra.span fontSize="sm" color="app.textMuted">
            {t("tableOpenQueryOverridesEmpty")}
          </chakra.span>
        ) : (
          <chakra.ul
            listStyleType="none"
            m="0"
            p="0"
            display="flex"
            flexDirection="column"
            gap="1"
            aria-label={t("tableOpenQueryOverridesLabel")}
          >
            {overrides.map((o) => (
              <chakra.li
                key={`${o.profileId}\u0000${o.database}\u0000${o.table}`}
                display="flex"
                alignItems="center"
                gap="2"
                px="2"
                py="1"
                borderRadius="md"
                border="1px solid var(--border-subtle)"
              >
                <Flex direction="column" flex="1" minW="0" gap="0.5">
                  <chakra.span fontSize="sm" color="app.text" truncate>
                    {o.profileName || o.profileId} / {o.database ? `${o.database}.` : ""}
                    {o.table}
                  </chakra.span>
                  <chakra.code fontSize="xs" color="app.textMuted" truncate>
                    {o.template}
                  </chakra.code>
                </Flex>
                <Tooltip label={t("tableOpenQueryOverrideRemove")}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    color="app.textError"
                    _hover={{ color: "app.textError", bg: "app.hover" }}
                    aria-label={t("tableOpenQueryOverrideRemoveAria", { table: o.table })}
                    onClick={() => removeTableOpenQueryOverride(o.profileId, o.database, o.table)}
                  >
                    <Icon name="trash" size={ICON_SIZES.sm} />
                  </Button>
                </Tooltip>
              </chakra.li>
            ))}
          </chakra.ul>
        )}
      </FormSection>
    </Flex>
  );
}
