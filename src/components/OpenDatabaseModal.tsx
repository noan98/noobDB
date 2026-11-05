import { chakra, Flex } from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/tauri";
import { useT } from "../i18n";
import { filterDatabases } from "../openDatabase";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { Button, Input } from "./ui";

interface Props {
  sessionId: string;
  /** 現在接続中のデータベース名 (一覧で「接続中」と示し、選べないようにする)。 */
  currentDatabase: string | null;
  /** 選んだデータベースを新しい接続として開く。 */
  onOpen: (database: string) => void;
  onClose: () => void;
}

/**
 * 同じサーバの別データベースを開くモーダル (#2018, PostgreSQL)。`pg_database` の一覧から
 * 選ぶと、現プロファイルの接続設定・認証情報を使って別の接続を張る (呼び出し側が担当)。
 */
export function OpenDatabaseModal({ sessionId, currentDatabase, onOpen, onClose }: Props) {
  const t = useT();
  const [names, setNames] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    api
      .listServerDatabases(sessionId)
      .then((r) => {
        if (alive) setNames(r);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const shown = useMemo(() => filterDatabases(names ?? [], query), [names, query]);
  // Enter で開けるのは、絞り込み結果が現在の DB を除いて 1 件に定まるときだけ。
  const candidates = shown.filter((n) => n !== currentDatabase);
  const submit = () => {
    if (candidates.length === 1) onOpen(candidates[0]);
  };

  return (
    <Modal onSubmit={submit} submitDisabled={candidates.length !== 1} width="480px" onClose={onClose}>
      <ModalHeader onClose={onClose} closeLabel={t("openDatabaseCancel")}>
        {t("openDatabaseTitle")}
      </ModalHeader>
      <ModalBody>
        <FormSection>
          <chakra.p fontSize="sm" color="app.textMuted" margin={0}>
            {t("openDatabaseHint")}
          </chakra.p>
          <FieldLabel htmlFor="open-database-filter">{t("openDatabaseFilterLabel")}</FieldLabel>
          <Input
            id="open-database-filter"
            value={query}
            autoFocus
            placeholder={t("openDatabaseFilterPlaceholder")}
            onChange={(e) => setQuery(e.target.value)}
          />
          {error && <ErrorNote>{error}</ErrorNote>}
          {!error && names === null && (
            <chakra.p fontSize="sm" color="app.textMuted" margin={0}>
              {t("openDatabaseLoading")}
            </chakra.p>
          )}
          {names !== null && shown.length === 0 && (
            <chakra.p fontSize="sm" color="app.textMuted" margin={0}>
              {t("openDatabaseEmpty")}
            </chakra.p>
          )}
          <Flex direction="column" gap="1" maxH="320px" overflowY="auto" data-testid="open-database-list">
            {shown.map((name) => {
              const current = name === currentDatabase;
              return (
                <Button
                  key={name}
                  type="button"
                  variant="secondary"
                  disabled={current}
                  justifyContent="space-between"
                  onClick={() => onOpen(name)}
                >
                  <chakra.span overflow="hidden" textOverflow="ellipsis">
                    {name}
                  </chakra.span>
                  {current && <chakra.span textStyle="caption">{t("openDatabaseCurrent")}</chakra.span>}
                </Button>
              );
            })}
          </Flex>
        </FormSection>
      </ModalBody>
      <ModalFooter>
        <Flex flex="1" />
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("openDatabaseCancel")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
