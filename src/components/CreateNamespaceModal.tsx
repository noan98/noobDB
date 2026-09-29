import { useMemo, useState } from "react";
import { Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import type { DriverKind } from "../api/tauri";
import {
  buildCreateNamespaceSql,
  isValidCollationToken,
  isValidNamespaceName,
  supportedNamespaceKinds,
  type NamespaceKind,
} from "./databaseMaintenance";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, FieldError, FieldLabel, FormSection } from "./modalForm";
import { Button, Input, PressableButton, Select } from "./ui";

/**
 * データベース / スキーマの新規作成モーダル (#1190)。SQL 生成の純ロジックは
 * `databaseMaintenance.ts`。MySQL はデータベース (文字セット / 照合順序を任意指定)、
 * PostgreSQL はデータベースとスキーマを選べる。SQLite は非対応のため呼び出し側が
 * このモーダルを開かない。
 *
 * PostgreSQL の CREATE DATABASE はトランザクション内で実行できないので、実行は
 * 呼び出し側が単文 (`api.runQuery`) で行う。read_only セッションでは実行ボタンを
 * 無効化する (バックエンドも write を拒否する)。
 */
interface Props {
  driver: DriverKind;
  readOnly: boolean;
  /** 開いたときの種別 (ツリーのノードに合わせる)。非対応なら先頭の種別。 */
  initialKind?: NamespaceKind | null;
  onRun: (sql: string, kind: NamespaceKind, name: string) => void;
  onSendToEditor: (sql: string) => void;
  onClose: () => void;
}

export function CreateNamespaceModal({ driver, readOnly, initialKind, onRun, onSendToEditor, onClose }: Props) {
  const t = useT();
  const kinds = supportedNamespaceKinds(driver);
  const [kind, setKind] = useState<NamespaceKind>(
    initialKind && kinds.includes(initialKind) ? initialKind : (kinds[0] ?? "database"),
  );
  const [name, setName] = useState("");
  const [charset, setCharset] = useState("");
  const [collation, setCollation] = useState("");

  const showCollation = driver === "mysql";
  const collationValid =
    !showCollation ||
    ((charset.trim() === "" || isValidCollationToken(charset.trim())) &&
      (collation.trim() === "" || isValidCollationToken(collation.trim())));
  const valid = isValidNamespaceName(name) && collationValid;
  const sql = useMemo(
    () => (valid ? (buildCreateNamespaceSql(driver, kind, name, { charset, collation }) ?? "") : ""),
    [valid, driver, kind, name, charset, collation],
  );
  const canRun = sql !== "" && !readOnly;
  const submit = () => onRun(sql, kind, name.trim());

  return (
    <Modal onSubmit={submit} submitDisabled={!canRun} width="520px" onClose={onClose}>
      <ModalHeader onClose={onClose} closeLabel={t("createTableClose")}>
        {t("createNamespaceTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        {kinds.length > 1 && (
          <Flex align="center" gap="2">
            <FieldLabel htmlFor="create-namespace-kind" minW="90px">
              {t("createNamespaceKind")}
            </FieldLabel>
            <Select
              id="create-namespace-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as NamespaceKind)}
              flex="1"
            >
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {t(k === "database" ? "namespaceKindDatabase" : "namespaceKindSchema")}
                </option>
              ))}
            </Select>
          </Flex>
        )}
        <Flex align="center" gap="2">
          <FieldLabel htmlFor="create-namespace-name" minW="90px">
            {t("createNamespaceName")}
          </FieldLabel>
          <Input
            id="create-namespace-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            flex="1"
          />
        </Flex>
        {showCollation && (
          <>
            <Flex align="center" gap="2">
              <FieldLabel htmlFor="create-namespace-charset" minW="90px">
                {t("createNamespaceCharset")}
              </FieldLabel>
              <Input
                id="create-namespace-charset"
                value={charset}
                onChange={(e) => setCharset(e.target.value)}
                placeholder="utf8mb4"
                flex="1"
              />
            </Flex>
            <Flex align="center" gap="2">
              <FieldLabel htmlFor="create-namespace-collation" minW="90px">
                {t("createNamespaceCollation")}
              </FieldLabel>
              <Input
                id="create-namespace-collation"
                value={collation}
                onChange={(e) => setCollation(e.target.value)}
                placeholder="utf8mb4_0900_ai_ci"
                flex="1"
              />
            </Flex>
            {!collationValid && <FieldError>{t("createNamespaceCollationInvalid")}</FieldError>}
          </>
        )}
        {driver === "postgres" && kind === "database" && (
          <FieldLabel as="div" fontWeight={400} color="app.textMuted">
            {t("createNamespacePgDatabaseHint")}
          </FieldLabel>
        )}
        <FormSection>
          <FieldLabel as="div">{t("createTablePreview")}</FieldLabel>
          <CodePreview minH="48px">{sql || t("createNamespacePreviewEmpty")}</CodePreview>
        </FormSection>
        {readOnly && <FieldError>{t("createTableReadOnly")}</FieldError>}
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="secondary" disabled={sql === ""} onClick={() => onSendToEditor(sql)}>
          {t("createTableToEditor")}
        </Button>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("createTableClose")}
        </Button>
        <PressableButton type="button" variant="primary" disabled={!canRun} onClick={submit}>
          {t("createNamespaceRun")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
