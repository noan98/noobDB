import { useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api, type DriverKind } from "../api/tauri";
import { useT } from "../i18n";
import { buildCreateTableAsSql, tableNameCollides } from "./resultsToTable";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input, PressableButton } from "./ui";
import { Spinner } from "./Spinner";

/**
 * 実行結果を新規テーブルへ保存 (CREATE TABLE ... AS SELECT、#821)。
 *
 * ソースクエリと対象データベースは呼び出し側 (App) が確定済みで渡し、ここでは
 * 新しいテーブル名だけを入力させる。マウント時に `api.listTables` で既存テーブル名を
 * 取得し、入力中の名前が衝突していれば即時に警告して確定ボタンを無効化する
 * (ベストエフォート — 実際の作成は `onConfirm` が既存の DDL 実行経路へ委ねるので、
 * ここでの判定をすり抜けても DB 側のエラーとして表面化する)。SQL 生成/衝突判定の
 * 純ロジックは `resultsToTable.ts` に分離してテストする。CREATE TABLE ウィザード
 * (`CreateTableModal`) / テーブル名変更 (`RenameTableDialog`) と同じ、確定即クローズ
 * (実行は呼び出し側が非同期で担当) の流儀に揃える。
 */
interface Props {
  sessionId: string;
  driver: DriverKind;
  database: string;
  sourceSql: string;
  onConfirm: (name: string) => void;
  onClose: () => void;
}

export function SaveAsTableModal({ sessionId, driver, database, sourceSql, onConfirm, onClose }: Props) {
  const t = useT();
  const [name, setName] = useState("");
  const [existingTables, setExistingTables] = useState<string[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listTables(sessionId, database)
      .then((tables) => {
        if (!cancelled) setExistingTables(tables);
      })
      .catch((e) => {
        if (!cancelled) {
          // 一覧取得に失敗しても入力自体はブロックしない — 衝突チェックが
          // 効かなくなるだけで、最終的には DB 側のエラーとして表面化する。
          setExistingTables([]);
          setListError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database]);

  const trimmed = name.trim();
  const loading = existingTables === null;
  const collides = existingTables ? tableNameCollides(existingTables, trimmed) : false;
  const valid = trimmed.length > 0 && !loading && !collides;

  const sql = useMemo(
    () => (trimmed ? buildCreateTableAsSql(driver, database, trimmed, sourceSql) : ""),
    [driver, database, trimmed, sourceSql],
  );

  const submit = () => {
    if (valid) onConfirm(trimmed);
  };

  return (
    <Modal width="560px" onClose={onClose} initialFocusEl={() => inputRef.current}>
      <ModalHeader onClose={onClose} closeLabel={t("saveAsTableClose")}>
        {t("saveAsTableTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.div display="flex" flexDirection="column" gap="1.5">
          <chakra.label fontSize="sm" color="app.textSecondary">
            {t("saveAsTableNameLabel")}
          </chakra.label>
          <Flex align="center" gap="2">
            <Input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("saveAsTableNamePlaceholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              flex="1"
            />
            {loading && <Spinner size={14} />}
          </Flex>
          {trimmed.length > 0 && collides && (
            <chakra.span fontSize="xs" color="app.dangerFg">
              {t("saveAsTableNameExists", { table: trimmed })}
            </chakra.span>
          )}
          {listError && (
            <chakra.span fontSize="xs" color="app.textMuted">
              {t("saveAsTableListError", { error: listError })}
            </chakra.span>
          )}
        </chakra.div>

        <chakra.div display="flex" flexDirection="column" gap="1">
          <chakra.span fontSize="xs" color="app.textMuted">
            {t("saveAsTablePreview")}
          </chakra.span>
          <chakra.pre
            fontFamily="mono"
            fontSize="sm"
            bg="app.surface"
            borderWidth="1px"
            borderColor="app.border"
            borderRadius="8px"
            p="2.5"
            overflowX="auto"
            whiteSpace="pre"
            color="app.text"
            minH="60px"
          >
            {sql || t("saveAsTablePreviewEmpty")}
          </chakra.pre>
        </chakra.div>
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("saveAsTableClose")}
        </Button>
        <div style={{ flex: 1 }} />
        <PressableButton type="button" variant="primary" disabled={!valid} onClick={submit}>
          {t("saveAsTableConfirm")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
