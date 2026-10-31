import { useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api, type TablePartitions } from "../api/tauri";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, ErrorNote, FieldError, FieldLabel, FormSection } from "./modalForm";
import { Spinner } from "./Spinner";
import { Button, Input, PressableButton, Switch } from "./ui";
import { ListboxSelect } from "./ListboxSelect";
import {
  type AttachBoundError,
  type AttachBoundKind,
  type AttachBoundSpec,
  attachCandidates,
  buildAttachSql,
  existingHashModulus,
  parseListValues,
  partitionKeyColumns,
  validateAttachBound,
} from "./tablePartitions";

/**
 * 既存のテーブルをパーティション表に付け直すダイアログ (#1929)。PostgreSQL の RANGE / LIST / HASH 専用。
 *
 * 親と同じスキーマの表から付ける表を選び、親の分割方式に合わせたフォーム (RANGE は FROM / TO を
 * キー列ごと、LIST は値の一覧、HASH は MODULUS / REMAINDER) で境界を入力する。RANGE / LIST では
 * 「DEFAULT パーティションとして付ける」も選べる。生成した `ALTER TABLE ... ATTACH PARTITION` を
 * その場でプレビューし、確定すると呼び出し側 (App) が確認ダイアログを挟んで実行する。
 */
interface Props {
  sessionId: string;
  database: string;
  table: string;
  info: TablePartitions;
  kind: AttachBoundKind;
  onConfirm: (child: string, sql: string) => void;
  onClose: () => void;
}

const ERROR_KEYS = {
  rangeEmpty: "attachPartitionErrRange",
  listEmpty: "attachPartitionErrList",
  hashModulus: "attachPartitionErrModulus",
  hashRemainder: "attachPartitionErrRemainder",
} as const satisfies Record<AttachBoundError, string>;

export function AttachPartitionModal({ sessionId, database, table, info, kind, onConfirm, onClose }: Props) {
  const t = useT();
  const columns = useMemo(() => partitionKeyColumns(info.key), [info.key]);
  const [tables, setTables] = useState<string[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [child, setChild] = useState("");
  const [asDefault, setAsDefault] = useState(false);
  const [from, setFrom] = useState<string[]>(() => columns.map(() => ""));
  const [to, setTo] = useState<string[]>(() => columns.map(() => ""));
  const [listRaw, setListRaw] = useState("");
  const [modulus, setModulus] = useState(() => existingHashModulus(info) ?? "");
  const [remainder, setRemainder] = useState("");
  const selectRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listTables(sessionId, database)
      .then((list) => {
        if (!cancelled) setTables(list);
      })
      .catch((e) => {
        if (!cancelled) {
          setTables([]);
          setListError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database]);

  // listTables にはビュー / マテビューが混ざり得るが、ATTACH できるのはテーブルだけ (ヘルプ文で案内する)。
  const candidates = useMemo(
    () => (tables ? attachCandidates(tables, table, info) : []),
    [tables, table, info],
  );
  // 選択が候補から消えた (一覧の読み込み直後など) ら先頭に寄せる。
  const selected = candidates.includes(child) ? child : (candidates[0] ?? "");
  const hasDefault = info.partitions.some((p) => p.depth === 0 && p.is_default);
  const canDefault = kind !== "hash" && !hasDefault;

  const spec: AttachBoundSpec =
    kind !== "hash" && asDefault && canDefault
      ? { kind: "default" }
      : kind === "range"
        ? { kind: "range", from, to }
        : kind === "list"
          ? { kind: "list", values: parseListValues(listRaw) }
          : { kind: "hash", modulus, remainder };
  const boundError = validateAttachBound(spec);
  const sql = selected && !boundError ? buildAttachSql("postgres", database, table, selected, spec) : "";
  const loading = tables === null;
  const valid = !loading && sql !== "";

  const submit = () => {
    if (valid) onConfirm(selected, sql);
  };
  const setAt = (set: (f: (cur: string[]) => string[]) => void, i: number, v: string) =>
    set((cur) => cur.map((x, j) => (j === i ? v : x)));

  return (
    <Modal
      onSubmit={submit}
      submitDisabled={!valid}
      width="600px"
      onClose={onClose}
      initialFocusEl={() => selectRef.current}
    >
      <ModalHeader onClose={onClose} closeLabel={t("attachPartitionCancel")}>
        {t("attachPartitionTitle", { table })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <FormSection>
          <FieldLabel htmlFor="attach-partition-child">{t("attachPartitionChild")}</FieldLabel>
          <Flex align="center" gap="2">
            <ListboxSelect
              id="attach-partition-child"
              triggerRef={selectRef}
              value={selected}
              disabled={candidates.length === 0}
              options={candidates.map((n) => ({ value: n }))}
              onChange={setChild}
              css={{ flex: 1, minWidth: 0 }}
            />
            {loading && <Spinner size={14} />}
          </Flex>
          {!loading && candidates.length === 0 && (
            <FieldError>{t("attachPartitionNoCandidates", { schema: database })}</FieldError>
          )}
          {listError && <ErrorNote>{t("attachPartitionListError", { error: listError })}</ErrorNote>}
          <chakra.span textStyle="caption">{t("attachPartitionChildHelp", { schema: database })}</chakra.span>
        </FormSection>

        {kind !== "hash" && (
          <Switch
            checked={asDefault && canDefault}
            onChange={setAsDefault}
            disabled={!canDefault}
            label={hasDefault ? t("attachPartitionDefaultExists") : t("attachPartitionAsDefault")}
          />
        )}

        {!(kind !== "hash" && asDefault && canDefault) && (
          <FormSection>
            <FieldLabel as="div">
              {t("attachPartitionBound", { method: info.method, key: info.key })}
            </FieldLabel>
            {kind === "range" &&
              columns.map((col, i) => (
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
                    value={from[i] ?? ""}
                    onChange={(e) => setAt(setFrom, i, e.target.value)}
                    flex="1"
                  />
                  <chakra.span aria-hidden="true">→</chakra.span>
                  <Input
                    aria-label={t("attachPartitionTo", { column: col })}
                    placeholder={t("attachPartitionToPlaceholder")}
                    value={to[i] ?? ""}
                    onChange={(e) => setAt(setTo, i, e.target.value)}
                    flex="1"
                  />
                </Flex>
              ))}
            {kind === "list" && (
              <Input
                aria-label={t("attachPartitionValues")}
                placeholder={t("attachPartitionValuesPlaceholder")}
                value={listRaw}
                onChange={(e) => setListRaw(e.target.value)}
              />
            )}
            {kind === "hash" && (
              <Flex align="center" gap="2">
                <Input
                  aria-label="MODULUS"
                  placeholder="MODULUS"
                  inputMode="numeric"
                  value={modulus}
                  onChange={(e) => setModulus(e.target.value)}
                  flex="1"
                />
                <Input
                  aria-label="REMAINDER"
                  placeholder="REMAINDER"
                  inputMode="numeric"
                  value={remainder}
                  onChange={(e) => setRemainder(e.target.value)}
                  flex="1"
                />
              </Flex>
            )}
            <chakra.span textStyle="caption">{t("attachPartitionValueHelp")}</chakra.span>
            {boundError && <FieldError>{t(ERROR_KEYS[boundError])}</FieldError>}
          </FormSection>
        )}

        <Callout tone="warning">{t("attachPartitionWarning")}</Callout>

        <FormSection>
          <FieldLabel as="div">{t("attachPartitionPreview")}</FieldLabel>
          <CodePreview minH="64px" wrap>
            {sql || t("attachPartitionPreviewEmpty")}
          </CodePreview>
        </FormSection>
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("attachPartitionCancel")}
        </Button>
        <PressableButton type="button" variant="primary" disabled={!valid} onClick={submit}>
          {t("attachPartitionConfirm")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
