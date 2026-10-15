import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import { Button, Checkbox, Input, Select } from "./ui";
import { DraftNumberInput } from "./DraftNumberInput";
import { FieldLabel, FormSection } from "./modalForm";
import { Icon, ICON_SIZES } from "./Icon";
import { Tooltip } from "./Tooltip";
import {
  defaultMaskRule,
  effectiveMaskRule,
  EXPORT_MASK_RULE_KINDS,
  type ExportMaskOverrides,
  type ExportMaskPreset,
  type ExportMaskRule,
  type ExportMaskRuleKind,
  presetRuleFor,
  sameMaskRule,
  sanitizeMaskRule,
  uniqueColumnNames,
} from "./exportMasking";

/**
 * ExportModal の「データマスキング」セクション (#733)。列ごとのルール選択と、
 * 列名プリセットへの保存を担う。状態 (有効/無効・列単位の上書き) は親が持ち、
 * ここは描画と入力の正規化だけ (判定は `exportMasking.ts` の純関数)。
 */
interface Props {
  columnNames: readonly string[];
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  presets: readonly ExportMaskPreset[];
  overrides: ExportMaskOverrides;
  onOverridesChange: (next: ExportMaskOverrides) => void;
  onSavePreset: (column: string, rule: ExportMaskRule) => void;
  /** プリセットの JSON 書き出し / 読み込み (#1623)。省略するとボタンを出さない。 */
  onExportPresets?: () => void;
  onImportPresets?: () => void;
  disabled?: boolean;
}

type Choice = ExportMaskRuleKind | "none";

function ruleLabelKey(kind: Choice) {
  switch (kind) {
    case "fixed":
      return "exportMaskRuleFixed" as const;
    case "partial":
      return "exportMaskRulePartial" as const;
    case "hash":
      return "exportMaskRuleHash" as const;
    case "null":
      return "exportMaskRuleNull" as const;
    case "email":
      return "exportMaskRuleEmail" as const;
    case "date":
      return "exportMaskRuleDate" as const;
    default:
      return "exportMaskRuleNone" as const;
  }
}

export function ExportMaskingSection({
  columnNames,
  enabled,
  onEnabledChange,
  presets,
  overrides,
  onOverridesChange,
  onSavePreset,
  onExportPresets,
  onImportPresets,
  disabled,
}: Props) {
  const t = useT();
  const names = uniqueColumnNames(columnNames);

  const setRule = (column: string, rule: ExportMaskRule | null) => {
    // 入力途中の値もバックエンドと同じ上限・既定値へ正規化してから持つ。
    const next = rule ? sanitizeMaskRule(rule) : null;
    const updated = { ...overrides };
    // プリセットと同じ結果になる上書きは保存しない (プリセットの変更に追従させる)。
    if (sameMaskRule(next, presetRuleFor(column, presets))) delete updated[column];
    else updated[column] = next;
    onOverridesChange(updated);
  };

  return (
    <FormSection>
      <FieldLabel as="div">{t("exportMasking")}</FieldLabel>
      <chakra.label
        display="inline-flex"
        alignItems="center"
        gap="2"
        cursor="pointer"
        userSelect="none"
        fontSize="md"
      >
        <Checkbox checked={enabled} onChange={(e) => onEnabledChange(e.target.checked)} disabled={disabled} />
        <span>{t("exportMaskingEnable")}</span>
      </chakra.label>
      {enabled && (
        <>
          <chakra.div fontSize="xs" color="app.textMuted">
            {t("exportMaskingHint")}
          </chakra.div>
          <chakra.div
            display="flex"
            flexDirection="column"
            gap="1.5"
            maxH="220px"
            overflowY="auto"
            border="1px solid"
            borderColor="app.border"
            borderRadius="md"
            p="2"
          >
            {names.map((column) => {
              const rule = effectiveMaskRule(column, presets, overrides);
              const fromPreset = rule !== null && !Object.prototype.hasOwnProperty.call(overrides, column);
              const choice: Choice = rule ? rule.kind : "none";
              return (
                <chakra.div
                  key={column}
                  data-testid="export-mask-row"
                  display="flex"
                  alignItems="center"
                  gap="2"
                  flexWrap="wrap"
                >
                  <chakra.span
                    flex="1"
                    minW="120px"
                    fontFamily="mono"
                    fontSize="sm"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                  >
                    {column}
                    {fromPreset && (
                      <chakra.span ml="1.5" fontFamily="body" fontSize="2xs" color="app.textMuted">
                        {t("exportMaskingFromPreset")}
                      </chakra.span>
                    )}
                  </chakra.span>
                  <Select
                    w="170px"
                    value={choice}
                    aria-label={t("exportMaskingRuleFor", { column })}
                    disabled={disabled}
                    onChange={(e) => {
                      const v = e.target.value as Choice;
                      setRule(column, v === "none" ? null : defaultMaskRule(v));
                    }}
                  >
                    <option value="none">{t("exportMaskRuleNone")}</option>
                    {EXPORT_MASK_RULE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {t(ruleLabelKey(k))}
                      </option>
                    ))}
                  </Select>
                  {rule?.kind === "fixed" && (
                    <Input
                      w="110px"
                      value={rule.value}
                      aria-label={t("exportMaskingFixedValueFor", { column })}
                      disabled={disabled}
                      onChange={(e) => setRule(column, { kind: "fixed", value: e.target.value })}
                    />
                  )}
                  {rule?.kind === "partial" && (
                    <chakra.span
                      display="inline-flex"
                      alignItems="center"
                      gap="1"
                      fontSize="xs"
                      color="app.textMuted"
                    >
                      {t("exportMaskingKeepStart")}
                      <DraftNumberInput
                        min={0}
                        w="56px"
                        value={rule.keepStart}
                        aria-label={t("exportMaskingKeepStartFor", { column })}
                        disabled={disabled}
                        onCommit={(n) => setRule(column, { ...rule, keepStart: n })}
                      />
                      {t("exportMaskingKeepEnd")}
                      <DraftNumberInput
                        min={0}
                        w="56px"
                        value={rule.keepEnd}
                        aria-label={t("exportMaskingKeepEndFor", { column })}
                        disabled={disabled}
                        onCommit={(n) => setRule(column, { ...rule, keepEnd: n })}
                      />
                    </chakra.span>
                  )}
                  {rule?.kind === "email" && (
                    <chakra.span
                      display="inline-flex"
                      alignItems="center"
                      gap="1"
                      textStyle="caption"
                      color="app.textMuted"
                    >
                      {t("exportMaskingKeepStart")}
                      <DraftNumberInput
                        min={0}
                        w="56px"
                        value={rule.keepStart}
                        aria-label={t("exportMaskingEmailKeepStartFor", { column })}
                        disabled={disabled}
                        onCommit={(n) => setRule(column, { kind: "email", keepStart: n })}
                      />
                    </chakra.span>
                  )}
                  {rule?.kind === "date" && (
                    <Select
                      w="110px"
                      value={rule.precision}
                      aria-label={t("exportMaskingDatePrecisionFor", { column })}
                      disabled={disabled}
                      onChange={(e) =>
                        setRule(column, {
                          kind: "date",
                          precision: e.target.value === "month" ? "month" : "year",
                        })
                      }
                    >
                      <option value="year">{t("exportMaskingDateYear")}</option>
                      <option value="month">{t("exportMaskingDateMonth")}</option>
                    </Select>
                  )}
                  {rule?.kind === "hash" && (
                    <chakra.span
                      display="inline-flex"
                      alignItems="center"
                      gap="1"
                      fontSize="xs"
                      color="app.textMuted"
                    >
                      {t("exportMaskingHashLength")}
                      <DraftNumberInput
                        min={4}
                        max={64}
                        w="56px"
                        value={rule.length}
                        aria-label={t("exportMaskingHashLengthFor", { column })}
                        disabled={disabled}
                        onCommit={(n) => setRule(column, { kind: "hash", length: n })}
                      />
                    </chakra.span>
                  )}
                  <Tooltip label={t("exportMaskingSavePreset")} focusableWrapper={!rule || fromPreset}>
                    <chakra.button
                      type="button"
                      aria-label={t("exportMaskingSavePreset")}
                      disabled={disabled || !rule || fromPreset}
                      onClick={() => rule && onSavePreset(column, rule)}
                      display="inline-flex"
                      alignItems="center"
                      justifyContent="center"
                      w="28px"
                      h="28px"
                      color="app.textMuted"
                      bg="app.bgInput"
                      border="1px solid"
                      borderColor="app.border"
                      borderRadius="md"
                      cursor="pointer"
                      _hover={{ color: "app.text", bg: "app.hover" }}
                      _disabled={{ opacity: 0.35, cursor: "not-allowed" }}
                    >
                      <Icon name="snippet" size={ICON_SIZES.md} />
                    </chakra.button>
                  </Tooltip>
                </chakra.div>
              );
            })}
          </chakra.div>
          <chakra.div fontSize="xs" color="app.textMuted">
            {t("exportMaskingHashNote")}
          </chakra.div>
          {(onExportPresets || onImportPresets) && (
            <chakra.div display="flex" gap="2" flexWrap="wrap">
              {onImportPresets && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={disabled}
                  onClick={onImportPresets}
                >
                  {t("exportMaskingPresetsImport")}
                </Button>
              )}
              {onExportPresets && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={disabled}
                  onClick={onExportPresets}
                >
                  {t("exportMaskingPresetsExport")}
                </Button>
              )}
            </chakra.div>
          )}
        </>
      )}
    </FormSection>
  );
}
