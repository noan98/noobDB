import { useId, type ReactNode } from "react";
import { chakra } from "@chakra-ui/react";
import type { DumpOptions, DumpToolStatus } from "../api/tauri";
import { useT } from "../i18n";
import { SelectableCard, Input, Switch } from "./ui";
import { FieldLabel, FormSection } from "./modalForm";
import { Tooltip } from "./Tooltip";
import type { DumpBoolOptionKey, DumpOptionLock } from "../dumpOptionLocks";
import { OPTION_GROUPS, type OptionRow } from "../dumpOptionForm";

/**
 * ダンプのオプション部品。DumpModal とタスクスケジューラのダンプ設定 (#2131) が同じ部品を使い、
 * 見た目と有効 / 無効の規則を二重実装しない。状態 (options など) は呼び出し側が持つ。
 */

type EngineBadgeTone = "accent" | "success" | "warning" | "muted";

/** エンジンカード / ロック行に付ける小さなラベル。 */
function EngineBadge({ tone, children }: { tone: EngineBadgeTone; children: ReactNode }) {
  const color =
    tone === "accent"
      ? "app.accent"
      : tone === "success"
        ? "app.textSuccess"
        : tone === "warning"
          ? "app.textWarning"
          : "app.textMuted";
  return (
    <chakra.span
      display="inline-flex"
      alignItems="center"
      px="1.5"
      border="1px solid"
      borderColor="currentColor"
      borderRadius="full"
      fontSize="xs"
      fontWeight={500}
      lineHeight={1.5}
      color={color}
      whiteSpace="nowrap"
    >
      {children}
    </chakra.span>
  );
}

/** 生成エンジンの選択カード (#2094)。利点と制約をカード内に出し、選べないときは理由を表示する。 */
function EngineCard({
  testId,
  selected,
  disabled,
  title,
  badge,
  desc,
  limits,
  disabledReason,
  onSelect,
}: {
  testId: string;
  selected: boolean;
  disabled: boolean;
  title: string;
  badge: ReactNode;
  desc: string;
  limits: string;
  disabledReason?: string | null;
  onSelect: () => void;
}) {
  const descId = `${testId}-desc`;
  const limitsId = `${testId}-limits`;
  const reasonId = `${testId}-reason`;
  return (
    <SelectableCard
      type="button"
      size="compact"
      flex="1 1 240px"
      aria-pressed={selected}
      aria-describedby={[descId, limitsId, disabledReason ? reasonId : null].filter(Boolean).join(" ")}
      disabled={disabled}
      data-testid={testId}
      onClick={onSelect}
    >
      <chakra.span display="flex" alignItems="center" gap="1.5" flexWrap="wrap">
        <chakra.span fontSize="md" fontWeight={600} color="app.text">
          {title}
        </chakra.span>
        {badge}
      </chakra.span>
      <chakra.span id={descId} textStyle="caption" textAlign="left">
        {desc}
      </chakra.span>
      <chakra.span id={limitsId} textStyle="caption" textAlign="left">
        {limits}
      </chakra.span>
      {disabledReason && (
        <chakra.span id={reasonId} fontSize="xs" color="app.textWarning" lineHeight={1.4} textAlign="left">
          {disabledReason}
        </chakra.span>
      )}
    </SelectableCard>
  );
}

/** 生成エンジンのカード選択 (#2094)。外部ツールの導入状況はバッジで示す。 */
export function DumpEngineSelector({
  toolName,
  useNative,
  disabled,
  toolStatus,
  toolAbsent,
  onSelect,
}: {
  toolName: string;
  useNative: boolean;
  disabled: boolean;
  toolStatus: DumpToolStatus | null;
  /** 外部ツールのカードを無効にするか (タスクでは常に false: 設定を妨げず、実行時の結果で分かる)。 */
  toolAbsent: boolean;
  onSelect: (native: boolean) => void;
}) {
  const t = useT();
  return (
    <FormSection>
      <FieldLabel as="div">{t("dumpEngineLabel")}</FieldLabel>
      <chakra.div display="flex" flexWrap="wrap" gap="2" role="group" aria-label={t("dumpEngineLabel")}>
        <EngineCard
          testId="dump-engine-native"
          selected={useNative}
          disabled={disabled}
          title={t("dumpEngineNativeTitle")}
          badge={null}
          desc={t("dumpEngineNativeDesc")}
          limits={t("dumpEngineNativeLimits")}
          onSelect={() => onSelect(true)}
        />
        <EngineCard
          testId="dump-engine-external"
          selected={!useNative}
          disabled={disabled || toolAbsent}
          title={t("dumpEngineExternalTitle", { tool: toolName })}
          badge={
            toolStatus ? (
              <EngineBadge tone={toolStatus.path ? "success" : "warning"}>
                {toolStatus.path ? t("dumpEngineToolFound") : t("dumpEngineToolMissing")}
              </EngineBadge>
            ) : null
          }
          desc={t("dumpEngineExternalDesc", { tool: toolName })}
          limits={t("dumpEngineExternalLimits", { tool: toolName })}
          disabledReason={toolAbsent ? t("dumpEngineExternalDisabled", { tool: toolName }) : null}
          onSelect={() => onSelect(false)}
        />
      </chakra.div>
    </FormSection>
  );
}

/** 「構造 / データ / 出力 / 互換」のグループに分けたスイッチ群 (#2094)。 */
export function DumpOptionGroups({
  rows,
  options,
  lockOf,
  disabled,
  onToggle,
}: {
  /** 表示するスイッチ (ドライバ・スコープで絞り込み済み)。 */
  rows: OptionRow[];
  options: DumpOptions;
  lockOf: (key: DumpBoolOptionKey) => DumpOptionLock | null;
  disabled: boolean;
  onToggle: (key: DumpBoolOptionKey) => void;
}) {
  const t = useT();
  const optionsIdBase = `dump-opt-${useId().replace(/:/g, "")}`;
  const rowByKey = new Map(rows.map((row) => [row.key, row]));
  return (
    <>
      {OPTION_GROUPS.map((group) => {
        const groupRows = group.keys.map((k) => rowByKey.get(k)).filter((r): r is OptionRow => !!r);
        if (groupRows.length === 0) return null;
        return (
          <FormSection key={group.id} data-testid={`dump-group-${group.id}`}>
            <FieldLabel as="div">{t(group.label)}</FieldLabel>
            <chakra.div
              display="grid"
              gridTemplateColumns="repeat(auto-fill, minmax(240px, 1fr))"
              rowGap="1.5"
              columnGap="4"
            >
              {groupRows.map((row) => {
                const lock = lockOf(row.key);
                const reason = lock ? t(lock.reason) : null;
                return (
                  <Tooltip key={row.key} label={reason ?? t(row.hint)}>
                    <chakra.div
                      display="flex"
                      alignItems="flex-start"
                      gap="2"
                      py="1"
                      cursor={disabled || lock ? "not-allowed" : "pointer"}
                      userSelect="none"
                      data-locked={lock ? "true" : undefined}
                      onClick={(e) => {
                        if (disabled || lock) return;
                        // Switch 自身のクリックはコンポーネント側で処理されるので、
                        // ラッパーは text 部分のクリックだけを引き受ける。
                        if (e.target instanceof HTMLElement && e.target.closest("button[role=switch]")) {
                          return;
                        }
                        onToggle(row.key);
                      }}
                    >
                      <chakra.span mt="0.5" flex="none">
                        <Switch
                          checked={lock ? lock.forced : !!options[row.key]}
                          onChange={() => onToggle(row.key)}
                          disabled={disabled || !!lock}
                          size="sm"
                          aria-labelledby={`${optionsIdBase}-${row.key}-label`}
                          aria-describedby={`${optionsIdBase}-${row.key}-hint`}
                        />
                      </chakra.span>
                      <chakra.span display="flex" flexDirection="column" gap="0.5" minW={0}>
                        <chakra.span display="flex" alignItems="center" gap="1.5" flexWrap="wrap">
                          <chakra.span
                            id={`${optionsIdBase}-${row.key}-label`}
                            fontSize="md"
                            color={lock ? "app.textMuted" : "app.text"}
                          >
                            {t(row.label)}
                          </chakra.span>
                          {lock && <EngineBadge tone="muted">{t("dumpLockBadge")}</EngineBadge>}
                        </chakra.span>
                        <chakra.span
                          id={`${optionsIdBase}-${row.key}-hint`}
                          fontSize="xs"
                          color={lock ? "app.textWarning" : "app.textMuted"}
                          lineHeight={1.4}
                        >
                          {reason ?? t(row.hint)}
                        </chakra.span>
                      </chakra.span>
                    </chakra.div>
                  </Tooltip>
                );
              })}
            </chakra.div>
          </FormSection>
        );
      })}
    </>
  );
}

/** PostgreSQL のスキーマ入力 (`pg_dump -n` / ネイティブ生成の対象スキーマ)。 */
export function DumpPgSchemaField({
  value,
  disabled,
  onChange,
}: {
  value: string | null | undefined;
  disabled: boolean;
  onChange: (next: string | null) => void;
}) {
  const t = useT();
  return (
    <FormSection>
      <chakra.div display="flex" flexDirection="column" gap="1">
        <FieldLabel htmlFor="dump-pg-schema">{t("dumpOptPgSchema")}</FieldLabel>
        <Input
          id="dump-pg-schema"
          type="text"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          placeholder={t("dumpOptPgSchemaPlaceholder")}
          disabled={disabled}
        />
        <chakra.span textStyle="caption">{t("dumpOptPgSchemaHint")}</chakra.span>
      </chakra.div>
    </FormSection>
  );
}
