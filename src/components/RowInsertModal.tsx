import { useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import type { Column } from "../api/tauri";
import type { PendingInsertRow } from "./cellEdit";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input, PressableButton } from "./ui";
import { Tooltip } from "./Tooltip";

/**
 * 結果グリッドからの行追加で、新規行の各カラム値を入力するモーダル。確定すると
 * 入力済みカラムだけを持つ PendingInsertRow を返す (空欄は INSERT に含めず DB 既定値)。
 * 値の SQL リテラル化は Apply 時に cellEdit の literalFromInput が行う。
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
}

export function RowInsertModal({ table, columns, initialValues, onConfirm, onCancel }: Props) {
  const t = useT();
  const [values, setValues] = useState<Record<number, string>>(initialValues ?? {});
  const firstRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const row: PendingInsertRow = {};
    for (const [k, v] of Object.entries(values)) {
      if (v !== "") row[Number(k)] = v;
    }
    onConfirm(row);
  };

  return (
    <Modal width="560px" onClose={onCancel} initialFocusEl={() => firstRef.current}>
      <ModalHeader onClose={onCancel} closeLabel={t("createTableClose")}>
        {t("rowOpsInsertTitle", { table })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="2">
        <chakra.p fontSize="xs" color="app.textMuted">
          {t("rowOpsInsertHint")}
        </chakra.p>
        {columns.map((c, i) => (
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
              onChange={(e) => setValues((prev) => ({ ...prev, [i]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              flex="1"
            />
          </Flex>
        ))}
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
