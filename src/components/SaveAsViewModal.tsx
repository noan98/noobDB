import { useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api, type DriverKind } from "../api/tauri";
import { useT } from "../i18n";
import { tableNameCollides } from "./resultsToTable";
import { buildCreateViewSql, buildReplaceViewSql } from "./viewMaintenance";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input, PressableButton } from "./ui";
import { Spinner } from "./Spinner";

/**
 * 現在のクエリをビューとして保存する (#851)。
 *
 * `SaveAsTableModal` (#821) と同じ「確定即クローズ、実行は呼び出し側が非同期で
 * 担当」の流儀だが、名前衝突の扱いが異なる: テーブルは衝突すると確定を
 * ブロックするのに対し、ビューは**既存ビューと同名なら「置換」として扱う**
 * (`CREATE OR REPLACE VIEW` / SQLite は DROP+CREATE、`viewMaintenance.ts`)。
 * これにより「新規保存」と「ビュー定義を編集して同名で保存」の 2 導線
 * (Issue のスコープの両方) を 1 つのモーダルで賄える — `initialName` を渡すと
 * 「ツリーのビューを選んで定義を編集」から開いたときに名前欄が編集対象の
 * ビュー名で初期化され、そのまま確定すれば置換になる。
 *
 * 衝突判定は `api.listSchemaObjects` で取得した既存ビュー名一覧を
 * `resultsToTable.ts` の `tableNameCollides` (テーブル/ビューで判定ロジックは
 * 同一なので二重実装しない) に通す。一覧取得に失敗しても入力自体はブロックせず、
 * 最終的には DB 側のエラーとして表面化する (`SaveAsTableModal` と同じ方針)。
 */
interface Props {
  sessionId: string;
  driver: DriverKind;
  database: string;
  sourceSql: string;
  /** 既存ビューの定義を編集中に開いたときの初期名 (未指定なら空欄から開始)。 */
  initialName?: string;
  onConfirm: (name: string, replace: boolean) => void;
  onClose: () => void;
}

export function SaveAsViewModal({
  sessionId,
  driver,
  database,
  sourceSql,
  initialName,
  onConfirm,
  onClose,
}: Props) {
  const t = useT();
  const [name, setName] = useState(initialName ?? "");
  const [existingViews, setExistingViews] = useState<string[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listSchemaObjects(sessionId, database)
      .then((objs) => {
        if (!cancelled) setExistingViews(objs.filter((o) => o.kind === "view").map((o) => o.name));
      })
      .catch((e) => {
        if (!cancelled) {
          // 一覧取得に失敗しても入力自体はブロックしない — 衝突チェック (置換の
          // 判定) が効かなくなるだけで、最終的には DB 側のエラーとして表面化する。
          setExistingViews([]);
          setListError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database]);

  const trimmed = name.trim();
  const loading = existingViews === null;
  const replace = existingViews ? tableNameCollides(existingViews, trimmed) : false;
  const valid = trimmed.length > 0 && !loading;

  const sql = useMemo(() => {
    if (!trimmed) return "";
    return replace
      ? buildReplaceViewSql(driver, database, trimmed, sourceSql).join("\n")
      : buildCreateViewSql(driver, database, trimmed, sourceSql);
  }, [driver, database, trimmed, sourceSql, replace]);

  const submit = () => {
    if (valid) onConfirm(trimmed, replace);
  };

  return (
    <Modal width="560px" onClose={onClose} initialFocusEl={() => inputRef.current}>
      <ModalHeader onClose={onClose} closeLabel={t("saveAsViewClose")}>
        {t("saveAsViewTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.div display="flex" flexDirection="column" gap="1.5">
          <chakra.label fontSize="sm" color="app.textSecondary">
            {t("saveAsViewNameLabel")}
          </chakra.label>
          <Flex align="center" gap="2">
            <Input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("saveAsViewNamePlaceholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              flex="1"
            />
            {loading && <Spinner size={14} />}
          </Flex>
          {trimmed.length > 0 && replace && (
            <chakra.span fontSize="xs" color="app.textWarning">
              {t("saveAsViewNameReplaceNote", { view: trimmed })}
            </chakra.span>
          )}
          {listError && (
            <chakra.span fontSize="xs" color="app.textMuted">
              {t("saveAsViewListError", { error: listError })}
            </chakra.span>
          )}
        </chakra.div>

        <chakra.div display="flex" flexDirection="column" gap="1">
          <chakra.span fontSize="xs" color="app.textMuted">
            {t("saveAsViewPreview")}
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
            {sql || t("saveAsViewPreviewEmpty")}
          </chakra.pre>
        </chakra.div>
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("saveAsViewClose")}
        </Button>
        <div style={{ flex: 1 }} />
        <PressableButton type="button" variant="primary" disabled={!valid} onClick={submit}>
          {replace ? t("saveAsViewReplaceConfirm") : t("saveAsViewConfirm")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
