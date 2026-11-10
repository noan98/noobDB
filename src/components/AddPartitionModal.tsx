import { useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import type { TablePartitions } from "../api/tauri";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { SqlPreview } from "./SqlPreview";
import { FieldError, FieldLabel, FormSection } from "./modalForm";
import { Button, Input, PressableButton } from "./ui";
import {
  type AddPartitionErrorCode,
  type AddPartitionForm,
  type AddPartitionKind,
  hasDefaultPartition,
  initialAddForm,
  MAX_ADD_COUNT,
  planAddPartitions,
  reorganizesMaxvalue,
} from "./partitionAdd";
import { partitionKeyColumns } from "./tablePartitions";

/**
 * パーティション表に次のパーティションを追加するダイアログ (#2211)。
 *
 * 初期値は既存の最後の RANGE 境界と同じ幅の次の期間。件数を増やすと同じ幅で N 件まとめて作る。
 * PostgreSQL は子ごとの `CREATE TABLE ... PARTITION OF`、MySQL は `ADD PARTITION` (MAXVALUE があれば
 * `REORGANIZE PARTITION`)。既存の境界と重なる入力は、実行前にここでエラーにする。確定すると呼び出し側
 * (App) が確認ダイアログと DDL ゲートを通して実行する。
 */
interface Props {
  database: string;
  table: string;
  driver: string;
  info: TablePartitions;
  kind: AddPartitionKind;
  onConfirm: (statements: string[], count: number) => void;
  onClose: () => void;
}

const ERROR_KEYS = {
  nameEmpty: "addPartitionErrName",
  nameDuplicate: "addPartitionErrNameDup",
  rangeEmpty: "addPartitionErrRange",
  rangeOrder: "addPartitionErrOrder",
  rangeOverlap: "addPartitionErrOverlap",
  rangeNotAscending: "addPartitionErrAscending",
  listEmpty: "attachPartitionErrList",
  listOverlap: "addPartitionErrListOverlap",
  hashModulus: "attachPartitionErrModulus",
  hashRemainder: "attachPartitionErrRemainder",
  hashDuplicate: "addPartitionErrHashDup",
  count: "addPartitionErrCount",
  countUnsupported: "addPartitionErrCountUnsupported",
} as const satisfies Record<AddPartitionErrorCode, string>;

export function AddPartitionModal({ database, table, driver, info, kind, onConfirm, onClose }: Props) {
  const t = useT();
  const [form, setForm] = useState<AddPartitionForm>(() => initialAddForm(driver, table, info, kind));
  const nameRef = useRef<HTMLInputElement>(null);
  const countRef = useRef<HTMLInputElement>(null);
  const columns = useMemo(() => partitionKeyColumns(info.key), [info.key]);
  const plan = useMemo(
    () => planAddPartitions(driver, database, table, info, kind, form),
    [driver, database, table, info, kind, form],
  );
  const maxPartition = reorganizesMaxvalue(driver, kind, info);
  const valid = plan.errors.length === 0 && plan.statements.length > 0;
  const mysql = driver === "mysql";
  const set = (patch: Partial<AddPartitionForm>) => setForm((f) => ({ ...f, ...patch }));
  const setAt = (key: "from" | "to", i: number, v: string) =>
    setForm((f) => ({ ...f, [key]: f[key].map((x, j) => (j === i ? v : x)) }));
  const count = plan.items.length > 0 ? plan.items.length : plan.statements.length;

  const submit = () => {
    if (valid) onConfirm(plan.statements, kind === "hashCount" ? Number(form.count) : Math.max(1, count));
  };

  return (
    <Modal
      onSubmit={submit}
      submitDisabled={!valid}
      width="600px"
      onClose={onClose}
      initialFocusEl={() => (kind === "hashCount" ? countRef.current : nameRef.current)}
    >
      <ModalHeader onClose={onClose} closeLabel={t("attachPartitionCancel")}>
        {t("addPartitionTitle", { table })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        {kind !== "hashCount" && (
          <FormSection>
            <FieldLabel htmlFor="add-partition-name">{t("addPartitionName")}</FieldLabel>
            <Input
              id="add-partition-name"
              ref={nameRef}
              fontFamily="var(--font-mono)"
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </FormSection>
        )}

        {kind === "range" && (
          <FormSection>
            <FieldLabel as="div">{t("addPartitionBound", { method: info.method, key: info.key })}</FieldLabel>
            {form.to.map((_, i) => {
              const col = columns[i] ?? `#${i + 1}`;
              return (
                <Flex key={col} align="center" gap="2">
                  <chakra.span
                    fontFamily="var(--font-mono)"
                    minW="24"
                    overflow="hidden"
                    textOverflow="ellipsis"
                  >
                    {col}
                  </chakra.span>
                  <Input
                    aria-label={t("attachPartitionFrom", { column: col })}
                    placeholder={t("attachPartitionFromPlaceholder")}
                    value={mysql ? (plan.items[0]?.from[i] ?? form.from[i] ?? "") : (form.from[i] ?? "")}
                    disabled={mysql}
                    onChange={(e) => setAt("from", i, e.target.value)}
                    flex="1"
                  />
                  <chakra.span aria-hidden="true">→</chakra.span>
                  <Input
                    aria-label={t("attachPartitionTo", { column: col })}
                    placeholder={t("attachPartitionToPlaceholder")}
                    value={form.to[i] ?? ""}
                    onChange={(e) => setAt("to", i, e.target.value)}
                    flex="1"
                  />
                </Flex>
              );
            })}
            <chakra.span textStyle="caption">
              {t("addPartitionSuggest")} {mysql && t("addPartitionFromFixed")}
            </chakra.span>
          </FormSection>
        )}

        {kind === "list" && (
          <FormSection>
            <FieldLabel htmlFor="add-partition-values">
              {t("addPartitionBound", { method: info.method, key: info.key })}
            </FieldLabel>
            <Input
              id="add-partition-values"
              aria-label={t("attachPartitionValues")}
              placeholder={t("attachPartitionValuesPlaceholder")}
              value={form.values}
              onChange={(e) => set({ values: e.target.value })}
            />
            <chakra.span textStyle="caption">{t("addPartitionValueHelp")}</chakra.span>
          </FormSection>
        )}

        {kind === "hash" && (
          <FormSection>
            <FieldLabel as="div">{t("addPartitionBound", { method: info.method, key: info.key })}</FieldLabel>
            <Flex align="center" gap="2">
              <Input
                aria-label="MODULUS"
                placeholder="MODULUS"
                inputMode="numeric"
                value={form.modulus}
                onChange={(e) => set({ modulus: e.target.value })}
                flex="1"
              />
              <Input
                aria-label="REMAINDER"
                placeholder="REMAINDER"
                inputMode="numeric"
                value={form.remainder}
                onChange={(e) => set({ remainder: e.target.value })}
                flex="1"
              />
            </Flex>
          </FormSection>
        )}

        {(kind === "range" || kind === "hashCount") && (
          <FormSection>
            <FieldLabel htmlFor="add-partition-count">{t("addPartitionCount")}</FieldLabel>
            <Input
              id="add-partition-count"
              ref={countRef}
              inputMode="numeric"
              maxW="32"
              value={form.count}
              onChange={(e) => set({ count: e.target.value })}
            />
            {kind === "range" && <chakra.span textStyle="caption">{t("addPartitionCountHelp")}</chakra.span>}
          </FormSection>
        )}

        {plan.errors.map((e) => (
          <FieldError key={`${e.code}:${e.detail ?? ""}`}>
            {t(ERROR_KEYS[e.code], { detail: e.detail ?? "", max: MAX_ADD_COUNT })}
          </FieldError>
        ))}

        {maxPartition && (
          <Callout tone="warning">{t("addPartitionReorganize", { partition: maxPartition })}</Callout>
        )}
        {driver === "postgres" && hasDefaultPartition(info) && (
          <Callout tone="warning">{t("addPartitionDefaultWarning")}</Callout>
        )}
        {kind === "hashCount" && <Callout tone="warning">{t("addPartitionHashNote")}</Callout>}

        <FormSection>
          <FieldLabel as="div">{t("attachPartitionPreview")}</FieldLabel>
          <SqlPreview sql={plan.sql} driver={driver} empty={t("addPartitionPreviewEmpty")} minH="64px" wrap />
        </FormSection>
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("attachPartitionCancel")}
        </Button>
        <PressableButton type="button" variant="primary" disabled={!valid} onClick={submit}>
          {t("addPartitionConfirm")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
