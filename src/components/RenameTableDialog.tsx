import { useRef, useState } from "react";
import { useT } from "../i18n";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, FieldError, FieldLabel, FormSection } from "./modalForm";
import { isPlainEnterKey } from "./modalKeys";
import { tableNameCollides } from "./resultsToTable";
import { Button, Input, PressableButton } from "./ui";

/**
 * テーブル名変更ダイアログ。新しい名前を入力して確定すると
 * `ALTER TABLE ... RENAME TO ...` を実行する (実行は呼び出し側 App が担当)。
 */
interface Props {
  table: string;
  /** 同じスキーマにある既存テーブル名 (衝突検出用。未取得の間は空)。 */
  existingTables: string[];
  /** 大小の扱いが方言で違うため衝突判定に使う。 */
  driver: string;
  /** 新しい名前から実際に流れる `ALTER TABLE ... RENAME TO ...` を組み立てる。 */
  buildSql: (newName: string) => string;
  onConfirm: (newName: string) => void;
  onCancel: () => void;
}

export function RenameTableDialog({ table, existingTables, driver, buildSql, onConfirm, onCancel }: Props) {
  const t = useT();
  const [name, setName] = useState(table);
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = name.trim();
  // 旧名自身を除いた既存名と照合する。完全一致は常に確定不可。大小違いだけの一致は、
  // SQLite では同名扱いなので確定不可、MySQL (Linux) / PostgreSQL は引用符付き識別子で
  // 大小を区別するため警告にとどめて確定は許可する (大小を区別しない環境では DB が拒否する)。
  const others = existingTables.filter((n) => n !== table);
  const exactCollides = trimmed !== table && others.includes(trimmed);
  const caseOnlyCollides = !exactCollides && trimmed !== table && tableNameCollides(others, trimmed);
  const blockedByCase = caseOnlyCollides && driver === "sqlite";
  const collides = exactCollides || blockedByCase;
  const valid = trimmed.length > 0 && trimmed !== table && !collides;
  const submit = () => {
    if (valid) onConfirm(trimmed);
  };

  return (
    <Modal
      onSubmit={submit}
      submitDisabled={!valid}
      width="440px"
      onClose={onCancel}
      initialFocusEl={() => inputRef.current}
    >
      <ModalHeader onClose={onCancel} closeLabel={t("createTableClose")}>
        {t("renameTableTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="3">
        <FormSection>
          <FieldLabel htmlFor="rename-table-name">{t("renameTableLabel", { table })}</FieldLabel>
          <Input
            id="rename-table-name"
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (isPlainEnterKey(e)) submit();
            }}
          />
          {collides && <FieldError>{t("renameTableExists", { table: trimmed })}</FieldError>}
          {caseOnlyCollides && !blockedByCase && (
            <FieldError tone="warning">{t("renameTableCaseOnlyExists", { table: trimmed })}</FieldError>
          )}
        </FormSection>
        {valid && <CodePreview aria-label={t("renameTableSqlPreview")}>{buildSql(trimmed)}</CodePreview>}
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t("createTableClose")}
        </Button>
        <PressableButton type="button" variant="primary" disabled={!valid} onClick={submit}>
          {t("renameTableConfirm")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
