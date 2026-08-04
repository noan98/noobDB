import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import {
  api,
  type DbUserInfo,
  type DriverKind,
  type TablePrivilegeRow,
} from "../api/tauri";
import { useT } from "../i18n";
import { useConfirm } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { errorIllustration, NoResultsIllustration } from "./illustrations";
import { Icon, ICON_SIZES } from "./Icon";
import { ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { SkeletonTableRows } from "./Skeleton";
import { Spinner } from "./Spinner";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { Button, Checkbox, Heading, Input } from "./ui";

/**
 * ユーザ / 権限管理パネル (#732)。MySQL ユーザ (`mysql.user`) / PostgreSQL
 * ロール (`pg_roles`) の一覧と、選択したユーザ/ロールのテーブル単位権限マトリクス
 * (SELECT/INSERT/UPDATE/DELETE/DDL) を表示する。編集はすべて Diff/Sync
 * (`SchemaCompareView`) と同じ「SQL を生成 → プレビュー → 確認 → 適用」の
 * フローを通り、`generate*Sql` (純粋・副作用なし) → `useConfirm` の確認
 * ダイアログで SQL 全文を表示 → `applyPrivilegeSql` (read_only セッションは
 * バックエンドが拒否) の順で進む。SQLite はユーザ概念を持たないため、この
 * パネル自体を `App.tsx` 側で導線ごと出さない (`ProcessListPanel` と同方針)。
 *
 * **グローバル (`*`) 行は表示専用**: MySQL の `mysql.user` が持つグローバル権限
 * (サーバ全体 `*.*`) は、このパネルが編集対象とする「選択中データベースのテーブル
 * 単位権限」とスコープが異なる (`GRANT ... ON db.table` では書き換えられない) ため、
 * 誤って db 単位の変更のつもりでサーバ全体の権限を触ってしまう事故を避けるべく
 * あえて編集不可にしている。
 */

type Flags = {
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  ddl: boolean;
};

const EMPTY_FLAGS: Flags = {
  select: false,
  insert: false,
  update: false,
  delete: false,
  ddl: false,
};

function flagsFromRow(row: TablePrivilegeRow): Flags {
  return {
    select: row.select,
    insert: row.insert,
    update: row.update,
    delete: row.delete,
    ddl: row.ddl,
  };
}

function flagsEqual(a: Flags, b: Flags): boolean {
  return (
    a.select === b.select &&
    a.insert === b.insert &&
    a.update === b.update &&
    a.delete === b.delete &&
    a.ddl === b.ddl
  );
}

function flagsAny(f: Flags): boolean {
  return f.select || f.insert || f.update || f.delete || f.ddl;
}

function diffFlags(original: Flags, edited: Flags, want: boolean): Flags {
  return {
    select: edited.select === want && original.select !== want,
    insert: edited.insert === want && original.insert !== want,
    update: edited.update === want && original.update !== want,
    delete: edited.delete === want && original.delete !== want,
    ddl: edited.ddl === want && original.ddl !== want,
  };
}

const thCss: SystemStyleObject = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  background: "var(--bg-muted)",
  borderBottom: "1px solid var(--border)",
  padding: "6px 10px",
  textAlign: "left",
  textStyle: "overline",
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
};
const tdCss: SystemStyleObject = {
  borderBottom: "1px solid var(--border-subtle, var(--border))",
  padding: "5px 10px",
  fontSize: "var(--text-sm)",
  color: "var(--text)",
  whiteSpace: "nowrap",
  verticalAlign: "top",
};
const preCss: SystemStyleObject = {
  margin: 0,
  marginTop: "2",
  padding: "2.5",
  maxHeight: "260px",
  overflow: "auto",
  fontSize: "var(--text-xs)",
  fontFamily: "var(--font-mono)",
  background: "var(--bg-muted)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

export function UsersPanel({
  sessionId,
  driver,
  database,
  readOnly,
  onClose,
}: {
  sessionId: string;
  driver: DriverKind;
  database: string | null;
  readOnly: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();

  const [users, setUsers] = useState<DbUserInfo[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DbUserInfo | null>(null);

  const [globalRow, setGlobalRow] = useState<TablePrivilegeRow | null>(null);
  const [original, setOriginal] = useState<Record<string, Flags>>({});
  const [edited, setEdited] = useState<Record<string, Flags>>({});
  const [loadingPrivs, setLoadingPrivs] = useState(false);
  const [privsError, setPrivsError] = useState<string | null>(null);
  const [newTable, setNewTable] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createHost, setCreateHost] = useState("%");
  const [createPassword, setCreatePassword] = useState("");

  const [showPassword, setShowPassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");

  const [busy, setBusy] = useState(false);

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const list = await api.listDbUsers(sessionId);
      setUsers(list);
      setUsersError(null);
    } catch (e) {
      setUsersError(String(e));
    } finally {
      setLoadingUsers(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const loadPrivileges = useCallback(
    async (u: DbUserInfo) => {
      setLoadingPrivs(true);
      setPrivsError(null);
      try {
        const p = await api.listUserPrivileges(sessionId, u.name, u.host);
        setGlobalRow(p.global);
        const prefix = database ? `${database}.` : null;
        const rows: Record<string, Flags> = {};
        for (const row of p.tables) {
          if (!prefix || !row.table.startsWith(prefix)) continue;
          rows[row.table.slice(prefix.length)] = flagsFromRow(row);
        }
        setOriginal(rows);
        setEdited({ ...rows });
      } catch (e) {
        setPrivsError(String(e));
        setOriginal({});
        setEdited({});
        setGlobalRow(null);
      } finally {
        setLoadingPrivs(false);
      }
    },
    [sessionId, database],
  );

  const selectUser = useCallback(
    (u: DbUserInfo) => {
      setSelected(u);
      setNewTable("");
      void loadPrivileges(u);
    },
    [loadPrivileges],
  );

  const toggleFlag = useCallback((table: string, flag: keyof Flags) => {
    setEdited((cur) => {
      const row = cur[table] ?? EMPTY_FLAGS;
      return { ...cur, [table]: { ...row, [flag]: !row[flag] } };
    });
  }, []);

  const addTableRow = useCallback(() => {
    const name = newTable.trim();
    if (!name || name in edited) return;
    setEdited((cur) => ({ ...cur, [name]: { ...EMPTY_FLAGS } }));
    setNewTable("");
  }, [newTable, edited]);

  const rowKeys = useMemo(
    () => Array.from(new Set([...Object.keys(original), ...Object.keys(edited)])).sort(),
    [original, edited],
  );

  const dirty = useMemo(
    () =>
      rowKeys.some(
        (k) => !flagsEqual(original[k] ?? EMPTY_FLAGS, edited[k] ?? EMPTY_FLAGS),
      ),
    [rowKeys, original, edited],
  );

  const discardChanges = useCallback(() => {
    setEdited({ ...original });
    setNewTable("");
  }, [original]);

  const applyPrivilegeChanges = useCallback(async () => {
    if (!selected || !database) return;
    const statements: string[] = [];
    for (const table of rowKeys) {
      const o = original[table] ?? EMPTY_FLAGS;
      const e = edited[table] ?? EMPTY_FLAGS;
      const added = diffFlags(o, e, true);
      const removed = diffFlags(o, e, false);
      if (flagsAny(added)) {
        const sql = await api.generateGrantSql(driver, {
          user: selected.name,
          host: selected.host,
          database,
          table,
          flags: added,
        });
        if (sql) statements.push(sql);
      }
      if (flagsAny(removed)) {
        const sql = await api.generateRevokeSql(driver, {
          user: selected.name,
          host: selected.host,
          database,
          table,
          flags: removed,
        });
        if (sql) statements.push(sql);
      }
    }
    if (statements.length === 0) {
      toast.info(t("usersNoChanges"));
      return;
    }
    const ok = await confirm({
      title: t("usersApplyConfirmTitle"),
      message: (
        <>
          <chakra.p margin={0}>
            {t("usersApplyConfirmMessage", { count: statements.length })}
          </chakra.p>
          <chakra.pre css={preCss}>{statements.join(";\n")}</chakra.pre>
        </>
      ),
      confirmLabel: t("usersApplyConfirmOk"),
      // REVOKE (権限剥奪) が 1 件でも含まれる変更は破壊的寄りとして danger 扱いにする。
      tone: statements.some((s) => s.startsWith("REVOKE")) ? "danger" : "primary",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.applyPrivilegeSql({ sessionId, database, statements });
      toast.success(t("usersApplyDone"));
      await loadPrivileges(selected);
    } catch (e) {
      toast.error(t("usersApplyFailed", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  }, [selected, database, rowKeys, original, edited, driver, confirm, t, sessionId, toast, loadPrivileges]);

  const submitCreateUser = useCallback(async () => {
    const name = createName.trim();
    if (!name) return;
    const sql = await api.generateCreateUserSql(driver, {
      name,
      host: driver === "mysql" ? createHost.trim() || "%" : null,
      password: createPassword || null,
    });
    const ok = await confirm({
      title: t("usersCreateConfirmTitle"),
      message: (
        <>
          <chakra.p margin={0}>{t("usersCreateConfirmMessage")}</chakra.p>
          <chakra.pre css={preCss}>{sql}</chakra.pre>
        </>
      ),
      confirmLabel: t("usersCreateConfirmOk"),
      tone: "primary",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.applyPrivilegeSql({ sessionId, database, statements: [sql] });
      toast.success(t("usersCreateDone", { name }));
      setShowCreate(false);
      setCreateName("");
      setCreateHost("%");
      setCreatePassword("");
      await loadUsers();
    } catch (e) {
      toast.error(t("usersCreateFailed", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  }, [createName, createHost, createPassword, driver, confirm, t, sessionId, database, toast, loadUsers]);

  const submitDropUser = useCallback(async () => {
    if (!selected) return;
    const sql = await api.generateDropUserSql(driver, selected.name, selected.host);
    const ok = await confirm({
      title: t("usersDropConfirmTitle"),
      message: (
        <>
          <chakra.p margin={0}>
            {t("usersDropConfirmMessage", { name: selected.name })}
          </chakra.p>
          <chakra.pre css={preCss}>{sql}</chakra.pre>
        </>
      ),
      confirmLabel: t("usersDropConfirmOk"),
      tone: "danger",
      typedConfirmation: selected.name,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.applyPrivilegeSql({ sessionId, database, statements: [sql] });
      toast.success(t("usersDropDone", { name: selected.name }));
      setSelected(null);
      setOriginal({});
      setEdited({});
      setGlobalRow(null);
      await loadUsers();
    } catch (e) {
      toast.error(t("usersDropFailed", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  }, [selected, driver, confirm, t, sessionId, database, toast, loadUsers]);

  const submitPasswordChange = useCallback(async () => {
    if (!selected || !newPassword) return;
    const sql = await api.generateAlterPasswordSql(
      driver,
      selected.name,
      selected.host,
      newPassword,
    );
    const ok = await confirm({
      title: t("usersPasswordConfirmTitle"),
      message: (
        <>
          <chakra.p margin={0}>
            {t("usersPasswordConfirmMessage", { name: selected.name })}
          </chakra.p>
          <chakra.pre css={preCss}>{sql}</chakra.pre>
        </>
      ),
      confirmLabel: t("usersPasswordConfirmOk"),
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.applyPrivilegeSql({ sessionId, database, statements: [sql] });
      toast.success(t("usersPasswordDone"));
      setShowPassword(false);
      setNewPassword("");
    } catch (e) {
      toast.error(t("usersPasswordFailed", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  }, [selected, newPassword, driver, confirm, t, sessionId, database, toast]);

  return (
    <Box flex="1" overflowY="auto" py="5" px="6" display="flex" flexDirection="column" gap="14px">
      <chakra.header
        display="flex"
        alignItems="center"
        justifyContent="space-between"
        gap="3"
        borderBottom="1px solid"
        borderColor="app.border"
        paddingBottom="2.5"
      >
        <Heading>{t("usersTitle")}</Heading>
        <Tooltip label={t("usersClose")}>
          <Button
            minWidth="28px"
            px="2"
            py="1"
            fontSize="base"
            lineHeight={1}
            onClick={onClose}
            aria-label={t("usersClose")}
          >
            <Icon name="close" size={ICON_SIZES.sm} />
          </Button>
        </Tooltip>
      </chakra.header>

      <chakra.p margin={0} fontSize="sm" color="app.textMuted">
        {t("usersDesc")}
      </chakra.p>

      {readOnly && (
        <ErrorNote role="status">{t("usersReadOnlyHint")}</ErrorNote>
      )}

      <Flex gap="4" flex="1" minHeight={0} alignItems="stretch">
        {/* --- ユーザ / ロール一覧 -------------------------------------- */}
        <Box
          width="280px"
          flex="none"
          display="flex"
          flexDirection="column"
          gap="2.5"
          borderRight="1px solid"
          borderColor="app.border"
          paddingRight="4"
          overflowY="auto"
        >
          <Flex align="center" justifyContent="space-between" gap="2">
            <Button type="button" onClick={() => void loadUsers()} disabled={loadingUsers}>
              <Icon name="refresh" size={ICON_SIZES.sm} /> {t("usersRefresh")}
            </Button>
            {loadingUsers && <Spinner size={14} />}
          </Flex>
          <Tooltip label={readOnly ? t("usersReadOnlyHint") : undefined} focusableWrapper={readOnly}>
            <Button type="button" disabled={readOnly} onClick={() => setShowCreate((v) => !v)}>
              <Icon name="plus" size={ICON_SIZES.sm} /> {t("usersNewUser")}
            </Button>
          </Tooltip>

          {showCreate && (
            <FormSection css={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "8px" }}>
              <FieldLabel htmlFor="users-create-name">{t("usersCreateNameLabel")}</FieldLabel>
              <Input
                id="users-create-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
              />
              {driver === "mysql" && (
                <>
                  <FieldLabel htmlFor="users-create-host">{t("usersCreateHostLabel")}</FieldLabel>
                  <Input
                    id="users-create-host"
                    value={createHost}
                    onChange={(e) => setCreateHost(e.target.value)}
                  />
                </>
              )}
              <FieldLabel htmlFor="users-create-password">{t("usersCreatePasswordLabel")}</FieldLabel>
              <Input
                id="users-create-password"
                type="password"
                autoComplete="new-password"
                value={createPassword}
                onChange={(e) => setCreatePassword(e.target.value)}
              />
              <Flex gap="2" justifyContent="flex-end">
                <Button type="button" onClick={() => setShowCreate(false)} disabled={busy}>
                  {t("usersCreateCancel")}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => void submitCreateUser()}
                  disabled={busy || !createName.trim()}
                >
                  {t("usersCreateSubmit")}
                </Button>
              </Flex>
            </FormSection>
          )}

          {usersError ? (
            <EmptyState
              compact
              illustration={errorIllustration(usersError)}
              icon="warning"
              title={t("usersLoadError", { error: usersError })}
              action={{ label: t("usersRetry"), onClick: () => void loadUsers() }}
            />
          ) : users.length === 0 && !loadingUsers ? (
            <EmptyState compact illustration={<NoResultsIllustration />} icon="key" title={t("usersEmpty")} />
          ) : (
            <chakra.ul listStyleType="none" margin={0} padding={0} display="flex" flexDirection="column" gap="1">
              {loadingUsers && users.length === 0 ? (
                <Spinner size={16} />
              ) : (
                users.map((u) => {
                  const isSelected = selected?.name === u.name && selected?.host === u.host;
                  return (
                    <chakra.li key={`${u.name}@@${u.host ?? ""}`}>
                      <chakra.button
                        type="button"
                        onClick={() => selectUser(u)}
                        width="100%"
                        textAlign="left"
                        padding="6px 8px"
                        borderRadius="var(--radius-sm)"
                        background={isSelected ? "var(--bg-selected, var(--bg-muted))" : "transparent"}
                        border="1px solid"
                        borderColor={isSelected ? "var(--accent)" : "transparent"}
                        cursor="pointer"
                      >
                        <chakra.div fontSize="sm" fontWeight={600} color="app.text">
                          {u.name}
                          {u.is_superuser && (
                            <chakra.span
                              marginLeft="1.5"
                              px="1.5"
                              fontSize="var(--text-xs)"
                              color="var(--status-error)"
                              border="1px solid var(--status-error)"
                              borderRadius="var(--radius-sm)"
                            >
                              {t("usersSuperuserBadge")}
                            </chakra.span>
                          )}
                        </chakra.div>
                        {u.host && (
                          <chakra.div fontSize="xs" color="app.textMuted" fontFamily="var(--font-mono)">
                            @{u.host}
                          </chakra.div>
                        )}
                      </chakra.button>
                    </chakra.li>
                  );
                })
              )}
            </chakra.ul>
          )}
        </Box>

        {/* --- 選択中ユーザの権限マトリクス ------------------------------ */}
        <Box flex="1" minWidth={0} display="flex" flexDirection="column" gap="3" overflowY="auto">
          {!selected ? (
            <EmptyState compact icon="key" title={t("usersSelectUserHint")} />
          ) : (
            <>
              <Flex align="center" justifyContent="space-between" gap="2" flexWrap="wrap">
                <Heading as="h3" fontSize="md">
                  {selected.name}
                  {selected.host ? `@${selected.host}` : ""}
                </Heading>
                <Flex gap="2">
                  <Tooltip label={readOnly ? t("usersReadOnlyHint") : undefined} focusableWrapper={readOnly}>
                    <Button type="button" disabled={readOnly} onClick={() => setShowPassword((v) => !v)}>
                      {t("usersChangePassword")}
                    </Button>
                  </Tooltip>
                  <Tooltip label={readOnly ? t("usersReadOnlyHint") : undefined} focusableWrapper={readOnly}>
                    <Button
                      type="button"
                      variant="danger"
                      disabled={readOnly}
                      onClick={() => void submitDropUser()}
                    >
                      {t("usersDropUser")}
                    </Button>
                  </Tooltip>
                </Flex>
              </Flex>

              {showPassword && (
                <FormSection css={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "8px", maxWidth: "360px" }}>
                  <FieldLabel htmlFor="users-new-password">{t("usersPasswordLabel")}</FieldLabel>
                  <Input
                    id="users-new-password"
                    type="password"
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                  <Flex gap="2" justifyContent="flex-end">
                    <Button type="button" onClick={() => setShowPassword(false)} disabled={busy}>
                      {t("usersPasswordCancel")}
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      disabled={busy || !newPassword}
                      onClick={() => void submitPasswordChange()}
                    >
                      {t("usersPasswordSubmit")}
                    </Button>
                  </Flex>
                </FormSection>
              )}

              {globalRow && (
                <Box borderBottom="1px solid" borderColor="app.border" paddingBottom="2">
                  <chakra.p margin={0} fontSize="xs" color="app.textMuted">
                    {t("usersGlobalRowHint")}
                  </chakra.p>
                  <Flex gap="3" marginTop="1" fontSize="sm">
                    <span>SELECT: {globalRow.select ? "✓" : "–"}</span>
                    <span>INSERT: {globalRow.insert ? "✓" : "–"}</span>
                    <span>UPDATE: {globalRow.update ? "✓" : "–"}</span>
                    <span>DELETE: {globalRow.delete ? "✓" : "–"}</span>
                    <span>DDL: {globalRow.ddl ? "✓" : "–"}</span>
                  </Flex>
                </Box>
              )}

              {!database ? (
                <EmptyState compact icon="database" title={t("usersNeedDatabaseHint")} />
              ) : privsError ? (
                <EmptyState
                  compact
                  illustration={errorIllustration(privsError)}
                  icon="warning"
                  title={t("usersPrivilegesLoadError", { error: privsError })}
                  action={{ label: t("usersRetry"), onClick: () => void loadPrivileges(selected) }}
                />
              ) : (
                <>
                  <Flex gap="2" align="center">
                    <Input
                      value={newTable}
                      onChange={(e) => setNewTable(e.target.value)}
                      placeholder={t("usersAddTablePlaceholder")}
                      width="240px"
                      disabled={readOnly}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addTableRow();
                      }}
                    />
                    <Button type="button" disabled={readOnly || !newTable.trim()} onClick={addTableRow}>
                      {t("usersAddTableButton")}
                    </Button>
                  </Flex>

                  <Box overflowX="auto" overflowY="auto" flex="1">
                    <chakra.table width="100%" borderCollapse="collapse">
                      <thead>
                        <tr>
                          <chakra.th css={thCss}>{t("usersColTable")}</chakra.th>
                          <chakra.th css={thCss}>{t("usersColSelect")}</chakra.th>
                          <chakra.th css={thCss}>{t("usersColInsert")}</chakra.th>
                          <chakra.th css={thCss}>{t("usersColUpdate")}</chakra.th>
                          <chakra.th css={thCss}>{t("usersColDelete")}</chakra.th>
                          <chakra.th css={thCss}>
                            <Tooltip label={t("usersColDdlHint")}>
                              <span>{t("usersColDdl")}</span>
                            </Tooltip>
                          </chakra.th>
                        </tr>
                      </thead>
                      <tbody>
                        {loadingPrivs ? (
                          <SkeletonTableRows columns={6} />
                        ) : rowKeys.length === 0 ? (
                          <tr>
                            <chakra.td css={tdCss} colSpan={6}>
                              {t("usersPrivilegesEmpty")}
                            </chakra.td>
                          </tr>
                        ) : (
                          rowKeys.map((table) => {
                            const flags = edited[table] ?? EMPTY_FLAGS;
                            const rowDirty = !flagsEqual(
                              original[table] ?? EMPTY_FLAGS,
                              flags,
                            );
                            return (
                              <tr key={table}>
                                <chakra.td
                                  css={tdCss}
                                  fontFamily="var(--font-mono)"
                                  color={rowDirty ? "var(--accent)" : undefined}
                                >
                                  {table}
                                </chakra.td>
                                {(["select", "insert", "update", "delete", "ddl"] as const).map(
                                  (flag) => (
                                    <chakra.td css={tdCss} key={flag}>
                                      <Checkbox
                                        checked={flags[flag]}
                                        disabled={readOnly}
                                        aria-label={`${table} ${flag}`}
                                        onChange={() => toggleFlag(table, flag)}
                                      />
                                    </chakra.td>
                                  ),
                                )}
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </chakra.table>
                  </Box>

                  <Flex gap="2" justifyContent="flex-end">
                    {dirty && (
                      <Button type="button" onClick={discardChanges} disabled={busy}>
                        {t("usersDiscardChanges")}
                      </Button>
                    )}
                    <Tooltip label={readOnly ? t("usersReadOnlyHint") : undefined} focusableWrapper={readOnly}>
                      <Button
                        type="button"
                        variant="primary"
                        disabled={readOnly || busy || !dirty}
                        onClick={() => void applyPrivilegeChanges()}
                      >
                        {t("usersApplyChanges")}
                      </Button>
                    </Tooltip>
                  </Flex>
                </>
              )}
            </>
          )}
        </Box>
      </Flex>

      {dialog}
    </Box>
  );
}
