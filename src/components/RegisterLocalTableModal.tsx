import { useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import { tableNameCollides } from "./resultsToTable";
import { MAX_LOCAL_TABLE_ROWS, suggestLocalTableName } from "./localQuery";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input, PressableButton } from "./ui";

/**
 * 結果セットを「ローカルテーブルとして登録」する確認モーダル (#740)。
 *
 * 対象は在メモリの取得済み行 (呼び出し側が確定させた `rowCount`) のみで、
 * 上限行数超過・件数・「外部送信なし/完全ローカル」・「ここでの更新は接続先に
 * 反映されない」を確認前に明示する。既存ローカルテーブル名との衝突は
 * `SaveAsTableModal` と同じ流儀 (大小無視の即時警告、ただし上書きなので確定
 * ボタンは無効化しない — 意図した上書きもあり得るため)。
 */
interface Props {
  rowCount: number;
  existingTables: string[];
  onConfirm: (name: string) => void;
  onClose: () => void;
}

export function RegisterLocalTableModal({ rowCount, existingTables, onConfirm, onClose }: Props) {
  const t = useT();
  const [name, setName] = useState(() => suggestLocalTableName(existingTables));
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = name.trim();
  const overCap = rowCount > MAX_LOCAL_TABLE_ROWS;
  const collides = useMemo(
    () => tableNameCollides(existingTables, trimmed),
    [existingTables, trimmed],
  );
  const valid = trimmed.length > 0 && !overCap;

  const submit = () => {
    if (valid) onConfirm(trimmed);
  };

  return (
    <Modal width="520px" onClose={onClose} initialFocusEl={() => inputRef.current}>
      <ModalHeader onClose={onClose} closeLabel={t("localRegisterClose")}>
        {t("localRegisterTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.div display="flex" flexDirection="column" gap="1.5">
          <chakra.label fontSize="sm" color="app.textSecondary">
            {t("localRegisterNameLabel")}
          </chakra.label>
          <Input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("localRegisterNamePlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          {trimmed.length > 0 && collides && (
            <chakra.span fontSize="xs" color="app.warningFg">
              {t("localRegisterNameExists", { table: trimmed })}
            </chakra.span>
          )}
        </chakra.div>

        <Flex direction="column" gap="1.5" fontSize="sm" color="app.text">
          <chakra.span fontWeight={600} color={overCap ? "app.dangerFg" : "app.text"}>
            {t("localRegisterRowCount", { rows: rowCount })}
          </chakra.span>
          {overCap && (
            <chakra.span fontSize="xs" color="app.dangerFg">
              {t("localRegisterRowCapExceeded", { max: MAX_LOCAL_TABLE_ROWS })}
            </chakra.span>
          )}
          <chakra.span fontSize="xs" color="app.textMuted">
            {t("localRegisterScopeNote")}
          </chakra.span>
        </Flex>

        <Flex
          direction="column"
          gap="1"
          fontSize="xs"
          color="app.textMuted"
          bg="app.surface"
          borderWidth="1px"
          borderColor="app.borderSubtle"
          borderRadius="8px"
          p="2.5"
        >
          <chakra.span>{t("localRegisterPrivacyNote")}</chakra.span>
          <chakra.span>{t("localRegisterWriteWarning")}</chakra.span>
        </Flex>
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("localRegisterClose")}
        </Button>
        <div style={{ flex: 1 }} />
        <PressableButton type="button" variant="primary" disabled={!valid} onClick={submit}>
          {t("localRegisterConfirm")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
