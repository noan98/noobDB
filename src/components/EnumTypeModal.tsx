import { useEffect, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api } from "../api/tauri";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { SqlPreview } from "./SqlPreview";
import { ErrorNote, FieldError, FieldLabel, FormSection } from "./modalForm";
import { Spinner } from "./Spinner";
import { Button, Input, PressableButton } from "./ui";
import { ListboxSelect } from "./ListboxSelect";
import { EnumValueChips } from "./EnumValueChips";
import {
  buildAddEnumValueSql,
  buildRenameEnumValueSql,
  ghostInsertIndex,
  parseEnumLabels,
  validateEnumValue,
  type EnumValueError,
  type EnumValuePosition,
} from "./enumTypeSql";

/**
 * PostgreSQL の ENUM 型に値を足す / 値の名前を変えるダイアログ (#2127)。
 * 型の定義を読んで今の値の並びを出し、`ALTER TYPE ... ADD VALUE (BEFORE / AFTER)` または
 * `RENAME VALUE` をその場でプレビューする。確定すると呼び出し側 (App) が通常のクエリ経路で
 * 実行する (read_only の拒否はバックエンドが行う。ここでは先回りして押せないようにする)。
 */
interface Props {
  sessionId: string;
  database: string;
  name: string;
  mode: "add" | "rename";
  readOnly: boolean;
  onConfirm: (sql: string) => void | Promise<void>;
  onClose: () => void;
}

const ERROR_KEYS = {
  empty: "enumTypeErrEmpty",
  duplicate: "enumTypeErrDuplicate",
  tooLong: "enumTypeErrTooLong",
} as const satisfies Record<EnumValueError, string>;

type PositionKind = "end" | "before" | "after";

export function EnumTypeModal({ sessionId, database, name, mode, readOnly, onConfirm, onClose }: Props) {
  const t = useT();
  const [labels, setLabels] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [positionKind, setPositionKind] = useState<PositionKind>("end");
  const [reference, setReference] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .getObjectDefinition(sessionId, database, "type", name, null)
      .then((ddl) => {
        if (cancelled) return;
        const parsed = parseEnumLabels(ddl);
        if (parsed === null) setLoadError(t("enumTypeNotEnum"));
        setLabels(parsed ?? []);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(t("enumTypeLoadError", { error: String(e) }));
        setLabels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database, name, t]);

  const loading = labels === null;
  const existing = labels ?? [];
  const ref = existing.includes(reference) ? reference : (existing[0] ?? "");
  const renameFrom = existing.includes(target) ? target : (existing[0] ?? "");

  const error = value === "" ? null : validateEnumValue(value, existing);
  const position: EnumValuePosition =
    positionKind === "end" ? { kind: "end" } : { kind: positionKind, reference: ref };
  const ready = !loading && !loadError && value !== "" && error === null && !readOnly;
  const needsRef = mode === "add" && positionKind !== "end";
  let sql = "";
  if (ready) {
    if (mode === "add") {
      if (!needsRef || ref !== "") sql = buildAddEnumValueSql(database, name, value, position);
    } else if (renameFrom !== "") {
      sql = buildRenameEnumValueSql(database, name, renameFrom, value);
    }
  }

  // 追加では差し込み位置にゴーストチップを出す。位置は SQL と同じ `position` から計算するので、
  // プレビューの BEFORE / AFTER と常に一致する (#2158)。
  const ghost =
    mode === "add" && !loading && !loadError
      ? {
          index: ghostInsertIndex(existing, position),
          label: value !== "" ? value : t("enumTypeGhostPlaceholder"),
        }
      : null;
  // チップのクリック / 矢印キーで基準値を選ぶ (Select と双方向に同期)。追加で「末尾」のときは、
  // 選んだ値の後ろに置く指定へ切り替える。
  const selectChip = (v: string) => {
    if (mode === "rename") {
      setTarget(v);
      return;
    }
    if (positionKind === "end") setPositionKind("after");
    setReference(v);
  };

  const submit = () => {
    if (sql === "" || busy) return;
    // 実行中は確定できない (二重送信で同じ ALTER TYPE が 2 回走るのを防ぐ)。完了・失敗で解除する。
    setBusy(true);
    void Promise.resolve()
      .then(() => onConfirm(sql))
      .catch(() => {})
      .finally(() => {
        if (mountedRef.current) setBusy(false);
      });
  };

  const positionOptions: { value: PositionKind; label: string }[] = [
    { value: "end", label: t("enumTypePosEnd") },
    { value: "before", label: t("enumTypePosBefore") },
    { value: "after", label: t("enumTypePosAfter") },
  ];
  const valueOptions = existing.map((v) => ({ value: v }));
  const title = mode === "add" ? t("enumTypeAddTitle", { name }) : t("enumTypeRenameTitle", { name });

  return (
    <Modal
      onSubmit={submit}
      submitDisabled={sql === "" || busy}
      width="560px"
      onClose={onClose}
      initialFocusEl={() => inputRef.current}
    >
      <ModalHeader onClose={onClose} closeLabel={t("enumTypeCancel")}>
        {title}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        {readOnly && <Callout tone="warning">{t("enumTypeReadOnly")}</Callout>}
        {loadError && <ErrorNote>{loadError}</ErrorNote>}

        <FormSection>
          <FieldLabel as="div">{t("enumTypeCurrentValues")}</FieldLabel>
          {loading ? (
            <Spinner size={14} />
          ) : existing.length > 0 || ghost ? (
            <>
              <EnumValueChips
                ariaLabel={t("enumTypeCurrentValues")}
                values={existing}
                ghost={ghost}
                renamed={mode === "rename" && renameFrom !== "" ? { from: renameFrom, to: value } : null}
                selected={mode === "rename" ? renameFrom : positionKind === "end" ? null : ref}
                onSelect={selectChip}
                disabled={readOnly}
              />
              {!readOnly && (
                <chakra.span textStyle="caption">
                  {t(mode === "add" ? "enumTypeChipsHintAdd" : "enumTypeChipsHintRename")}
                </chakra.span>
              )}
            </>
          ) : (
            <chakra.code textStyle="caption" wordBreak="break-word">
              {t("enumTypeNoValues")}
            </chakra.code>
          )}
        </FormSection>

        {mode === "rename" && (
          <FormSection>
            <FieldLabel htmlFor="enum-type-old">{t("enumTypeOldValue")}</FieldLabel>
            <ListboxSelect
              id="enum-type-old"
              value={renameFrom}
              disabled={existing.length === 0}
              options={valueOptions}
              onChange={setTarget}
              css={{ width: "100%" }}
            />
          </FormSection>
        )}

        <FormSection>
          <FieldLabel htmlFor="enum-type-value">
            {mode === "add" ? t("enumTypeNewValue") : t("enumTypeRenameTo")}
          </FieldLabel>
          <Input
            id="enum-type-value"
            ref={inputRef}
            fontFamily="mono"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={error ? true : undefined}
            disabled={readOnly}
          />
          {error && <FieldError>{t(ERROR_KEYS[error])}</FieldError>}
        </FormSection>

        {mode === "add" && (
          <FormSection>
            <FieldLabel as="div">{t("enumTypePosition")}</FieldLabel>
            <Flex align="center" gap="2">
              <ListboxSelect
                ariaLabel={t("enumTypePosition")}
                value={positionKind}
                options={positionOptions}
                onChange={(v) => setPositionKind(v as PositionKind)}
                css={{ flex: 1, minWidth: 0 }}
              />
              {positionKind !== "end" && (
                <ListboxSelect
                  ariaLabel={t("enumTypeRefValue")}
                  value={ref}
                  disabled={existing.length === 0}
                  options={valueOptions}
                  onChange={setReference}
                  css={{ flex: 1, minWidth: 0 }}
                />
              )}
            </Flex>
          </FormSection>
        )}

        {mode === "add" && <Callout tone="info">{t("enumTypeAddNote")}</Callout>}

        <FormSection>
          <FieldLabel as="div">{t("enumTypePreview")}</FieldLabel>
          <SqlPreview sql={sql} driver="postgres" empty={t("enumTypePreviewEmpty")} minH="48px" wrap />
        </FormSection>
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("enumTypeCancel")}
        </Button>
        <PressableButton type="button" variant="primary" disabled={sql === "" || busy} onClick={submit}>
          {mode === "add" ? t("enumTypeConfirmAdd") : t("enumTypeConfirmRename")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
