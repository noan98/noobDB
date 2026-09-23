import { useEffect, useId, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import type { Column, TableColumnInfo } from "../api/tauri";
import type { PendingInsertRow } from "./cellEdit";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input, PressableButton } from "./ui";
import { Tooltip } from "./Tooltip";
import { useValuePicker, ValueDatalist, type ValueLookup } from "./useValuePicker";
import { FK_CANDIDATE_LIMIT, type PickerKind } from "./valuePicker";

/**
 * 結果グリッドからの行追加で、新規行の各カラム値を入力するモーダル。確定すると
 * 入力済みカラムだけを持つ PendingInsertRow を返す (空欄は INSERT に含めず DB 既定値)。
 * 値の SQL リテラル化は Apply 時に cellEdit の literalFromInput が行う。
 *
 * スマート値ピッカー (#1067): `tableColumns` と `lookup` が渡されると、FK 列には
 * 参照先の既存値、ENUM / SET / CHECK 列には許可値を `<datalist>` の候補として
 * 出す。候補は入力補助にすぎず (自由入力可)、確定値は従来どおりこのフォームの
 * 文字列として PendingInsertRow に載るだけ。候補が取れない列はテキスト入力のまま。
 */
interface Props {
  table: string;
  columns: Column[];
  /**
   * 既存行の値を種にフォームを開くときの初期値 (行の複製、#820)。
   * 列インデックスをキーにした文字列値で、`onConfirm` が返す形式と同じ
   * `PendingInsertRow`。未指定 (通常の「行を追加」) なら従来どおり空欄で開く。
   */
  initialValues?: PendingInsertRow;
  onConfirm: (row: PendingInsertRow) => void;
  onCancel: () => void;
  /** 値ピッカー用: ドライバ ("mysql" | "postgres" | ...)。 */
  driver?: string;
  /** 値ピッカー用: テーブルのデータベース (PostgreSQL / DuckDB ではスキーマ)。 */
  database?: string | null;
  /** 値ピッカー用: `describe_table` の列メタ (FK 参照先・型定義)。 */
  tableColumns?: TableColumnInfo[] | null;
  /** 値ピッカー用: 読み取り専用の候補取得。未指定ならピッカー無効。 */
  lookup?: ValueLookup;
}

export function RowInsertModal({
  table,
  columns,
  initialValues,
  onConfirm,
  onCancel,
  driver = "mysql",
  database = null,
  tableColumns = null,
  lookup,
}: Props) {
  const t = useT();
  const [values, setValues] = useState<Record<number, string>>(initialValues ?? {});
  const firstRef = useRef<HTMLInputElement>(null);
  const listIdBase = useId();
  const picker = useValuePicker({ driver, database, table, columns: tableColumns, lookup });
  // フォーカス中の列の候補を (再) 取得する。FK は入力に応じて前方一致で絞る。
  const [focused, setFocused] = useState<number | null>(null);
  const focusedName = focused === null ? null : (columns[focused]?.name ?? null);
  // 複製 (#820) の種の値のままなら絞り込まずに候補を出し、打ち替え始めたら前方一致で絞る。
  const focusedRaw = focused === null ? "" : (values[focused] ?? "");
  const focusedValue =
    focused !== null && focusedRaw === (initialValues?.[focused] ?? "") ? "" : focusedRaw;
  useEffect(() => {
    if (focusedName !== null) picker.request(focusedName, focusedValue);
  }, [picker, focusedName, focusedValue]);

  const badgeLabel = (kind: PickerKind, name: string): string => {
    if (kind === "fk") {
      const meta = tableColumns?.find((m) => m.name === name);
      return t("valuePickerFk", {
        target: `${meta?.referenced_table ?? ""}.${meta?.referenced_column ?? ""}`,
      });
    }
    return kind === "enum"
      ? t("valuePickerEnum")
      : kind === "set"
        ? t("valuePickerSet")
        : t("valuePickerCheck");
  };
  const badgeTitle = (kind: PickerKind, name: string): string => {
    if (kind === "fk") {
      const meta = tableColumns?.find((m) => m.name === name);
      return t("valuePickerTitleFk", {
        target: `${meta?.referenced_table ?? ""}.${meta?.referenced_column ?? ""}`,
        limit: FK_CANDIDATE_LIMIT,
      });
    }
    return t("valuePickerTitleAllowed");
  };

  const submit = () => {
    const row: PendingInsertRow = {};
    for (const [k, v] of Object.entries(values)) {
      if (v !== "") row[Number(k)] = v;
    }
    onConfirm(row);
  };

  return (
    <Modal onSubmit={submit} width="560px" onClose={onCancel} initialFocusEl={() => firstRef.current}>
      <ModalHeader onClose={onCancel} closeLabel={t("createTableClose")}>
        {t("rowOpsInsertTitle", { table })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="2">
        <chakra.p fontSize="xs" color="app.textMuted">
          {t("rowOpsInsertHint")}
        </chakra.p>
        {columns.map((c, i) => {
          const pickerKind = picker.kindOf(c.name);
          const pickerValues = picker.candidates(c.name);
          const listId = `${listIdBase}-${i}`;
          return (
          <Flex key={c.name} align="center" gap="2.5">
            <Tooltip label={`${c.name} (${c.type_name})`}>
              <chakra.label
                minW="160px"
                fontSize="sm"
                fontFamily="mono"
                color="app.text"
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
              >
                {c.name}
                <chakra.span color="app.textMuted" ml="1.5" fontSize="2xs">
                  {c.type_name}
                </chakra.span>
              </chakra.label>
            </Tooltip>
            <Input
              ref={i === 0 ? firstRef : undefined}
              value={values[i] ?? ""}
              list={pickerValues.length > 0 ? listId : undefined}
              onFocus={() => setFocused(i)}
              onChange={(e) => setValues((prev) => ({ ...prev, [i]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              flex="1"
            />
            <ValueDatalist id={listId} values={pickerValues} />
            {pickerKind && (
              <Tooltip label={badgeTitle(pickerKind, c.name)}>
                <chakra.span
                  flexShrink={0}
                  maxW="140px"
                  overflow="hidden"
                  textOverflow="ellipsis"
                  whiteSpace="nowrap"
                  fontSize="2xs"
                  fontFamily="mono"
                  color="app.textMuted"
                  borderWidth="1px"
                  borderColor="app.border"
                  borderRadius="sm"
                  px="1"
                  data-testid={`value-picker-badge-${c.name}`}
                >
                  {badgeLabel(pickerKind, c.name)}
                </chakra.span>
              </Tooltip>
            )}
          </Flex>
          );
        })}
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t("createTableClose")}
        </Button>
        <PressableButton type="button" variant="primary" onClick={submit}>
          {t("rowOpsInsertAdd")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
