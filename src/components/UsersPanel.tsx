import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import {
  api,
  type DbUserInfo,
  type PrivilegeChange,
  type DriverKind,
  type TablePrivilegeRow,
} from "../api/tauri";
import { useT } from "../i18n";
import { semanticColorVar } from "../semanticColors";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { errorIllustration, NoResultsIllustration } from "./illustrations";
import { Icon, ICON_SIZES } from "./Icon";
import { CodePreview, FieldLabel, FormSection } from "./modalForm";
import { SkeletonTableRows } from "./Skeleton";
import { Spinner } from "./Spinner";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { Button, Checkbox, Heading, Input, Select } from "./ui";
import { isPlainEnterKey } from "./modalKeys";

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

/**
 * 権限コピー (#1536): 編集後の権限を「コピー元の権限そのもの」に揃えた行集合を返す純関数。
 * コピー元にあるテーブルはその権限へ、コピー先だけが持つテーブルは全権限 OFF (= 剥奪) にする。
 * 結果は `edited` に入れるだけで、実際の GRANT / REVOKE は従来の差分 SQL 生成・確認ダイアログ・
 * 適用の経路に乗る (新しい SQL 生成は無い)。
 */
/**
 * テーブル名をキーにする権限マップ。表名が `constructor` / `toString` / `__proto__` など
 * Object の組み込みプロパティ名と一致しても、プロトタイプチェーンを引かないよう
 * プロトタイプ無しのオブジェクトにする (`name in map` / `map[name]` が安全になる)。
 */
function flagsMap(src: Record<string, Flags> = {}): Record<string, Flags> {
  return Object.assign(Object.create(null) as Record<string, Flags>, src);
}

export function mergeCopiedPrivileges(
  original: Record<string, Flags>,
  source: Record<string, Flags>,
): Record<string, Flags> {
  const out = flagsMap();
  const src = flagsMap(source);
  for (const table of new Set([...Object.keys(original), ...Object.keys(source)])) {
    out[table] = src[table] ? { ...src[table] } : { ...EMPTY_FLAGS };
  }
  return out;
}

const userKey = (u: DbUserInfo) => `${u.name}@@${u.host ?? ""}`;

const thCss: SystemStyleObject = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  background: "var(--bg-muted)",
  borderBottom: "1px solid var(--border)",
  padding: "var(--space-1-5) var(--space-2-5)",
  textAlign: "left",
  textStyle: "overline",
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
};
const tdCss: SystemStyleObject = {
  borderBottom: "1px solid var(--border-subtle, var(--border))",
  padding: "var(--space-1-25) var(--space-2-5)",
  fontSize: "var(--text-sm)",
  color: "var(--text)",
  whiteSpace: "nowrap",
  verticalAlign: "top",
};

const PRIVILEGE_FLAGS = ["select", "insert", "update", "delete", "ddl"] as const;

/**
 * 権限タブの 1 行 (#1321)。1 行あたりチェックボックスが 5 個あるため、`memo` で
 * 切り替えた行 (`flags` の参照が変わる) だけを再レンダーする。
 */
export const PrivilegeRow = memo(function PrivilegeRow({
  table,
  flags,
  originalFlags,
  readOnly,
  onToggle,
}: {
  table: string;
  flags: Flags;
  originalFlags: Flags;
  readOnly: boolean;
  onToggle: (table: string, flag: keyof Flags) => void;
}) {
  const rowDirty = !flagsEqual(originalFlags, flags);
  return (
    <tr>
      <chakra.td
        css={tdCss}
        fontFamily="var(--font-mono)"
        color={rowDirty ? "var(--accent)" : undefined}
      >
        {table}
      </chakra.td>
      {PRIVILEGE_FLAGS.map((flag) => (
        <chakra.td css={tdCss} key={flag}>
          <Checkbox
            checked={flags[flag]}
            disabled={readOnly}
            aria-label={`${table} ${flag}`}
            onChange={() => onToggle(table, flag)}
          />
        </chakra.td>
      ))}
    </tr>
  );
});

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
  const [original, setOriginal] = useState<Record<string, Flags>>(flagsMap);
  const [edited, setEdited] = useState<Record<string, Flags>>(flagsMap);
  const [loadingPrivs, setLoadingPrivs] = useState(false);
  const [privsError, setPrivsError] = useState<string | null>(null);
  const [newTable, setNewTable] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createHost, setCreateHost] = useState("%");
  const [createPassword, setCreatePassword] = useState("");

  const [showPassword, setShowPassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");

  // 他ユーザの権限コピー (#1536)。コピー元は `${name}@@${host}` で持つ。
  const [showCopy, setShowCopy] = useState(false);
  const [copySourceKey, setCopySourceKey] = useState("");
  // 直近にコピーした内容 (注意書き用)。別ユーザへ切り替え・変更の破棄・再読込で消す。
  const [copied, setCopied] = useState<{ name: string; sourceRows: number } | null>(null);

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

  // 権限取得の世代番号。ユーザ切替・削除後に遅れて返った旧応答を捨てる。
  const privSeq = useRef(0);

  const loadPrivileges = useCallback(
    async (u: DbUserInfo) => {
      const seq = ++privSeq.current;
      setLoadingPrivs(true);
      setPrivsError(null);
      try {
        const p = await api.listUserPrivileges(sessionId, u.name, u.host, database);
        if (seq !== privSeq.current) return;
        setGlobalRow(p.global);
        const prefix = database ? `${database}.` : null;
        const rows = flagsMap();
        for (const row of p.tables) {
          // DB での絞り込みはサーバ側 (WHERE) で済んでいる。プレフィックスは表示名用。
          if (!prefix || !row.table.startsWith(prefix)) continue;
          rows[row.table.slice(prefix.length)] = flagsFromRow(row);
        }
        setOriginal(rows);
        setEdited(flagsMap(rows));
        setCopied(null);
      } catch (e) {
        if (seq !== privSeq.current) return;
        setPrivsError(String(e));
        setOriginal(flagsMap());
        setEdited(flagsMap());
        setGlobalRow(null);
      } finally {
        if (seq === privSeq.current) setLoadingPrivs(false);
      }
    },
    [sessionId, database],
  );

  const selectUser = useCallback(
    (u: DbUserInfo) => {
      setSelected(u);
      setNewTable("");
      // 前ユーザの未適用の編集を持ち越さない (読み込み中に別ユーザ宛の GRANT/REVOKE が出るのを防ぐ)。
      setOriginal(flagsMap());
      setEdited(flagsMap());
      setCopied(null);
      setGlobalRow(null);
      // コピー元の選択・パスワード入力欄も前ユーザのものを持ち越さない。
      setShowCopy(false);
      setCopySourceKey("");
      setShowPassword(false);
      setNewPassword("");
      void loadPrivileges(u);
    },
    [loadPrivileges],
  );

  const toggleFlag = useCallback((table: string, flag: keyof Flags) => {
    setEdited((cur) => {
      const row = cur[table] ?? EMPTY_FLAGS;
      return flagsMap({ ...cur, [table]: { ...row, [flag]: !row[flag] } });
    });
  }, []);

  const addTableRow = useCallback(() => {
    const name = newTable.trim();
    if (!name || name in edited) return;
    setEdited((cur) => flagsMap({ ...cur, [name]: { ...EMPTY_FLAGS } }));
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

  // コピー後の注意 (#1536): コピー元に権限が 0 件、または適用すると既存の権限を REVOKE する行がある。
  const copyRevokeCount = useMemo(
    () =>
      rowKeys.filter((k) => {
        const before = original[k] ?? EMPTY_FLAGS;
        const after = edited[k] ?? EMPTY_FLAGS;
        return (Object.keys(EMPTY_FLAGS) as (keyof Flags)[]).some((f) => before[f] && !after[f]);
      }).length,
    [rowKeys, original, edited],
  );

  const discardChanges = useCallback(() => {
    setEdited(flagsMap(original));
    setCopied(null);
    setNewTable("");
  }, [original]);

  const applyPrivilegeChanges = useCallback(async () => {
    if (!selected || !database) return;
    // 差分があるテーブルだけを 1 回の IPC でまとめて SQL 化する (#1259)。
    const changes: PrivilegeChange[] = [];
    for (const table of rowKeys) {
      const o = original[table] ?? EMPTY_FLAGS;
      const e = edited[table] ?? EMPTY_FLAGS;
      const added = diffFlags(o, e, true);
      const removed = diffFlags(o, e, false);
      if (flagsAny(added) || flagsAny(removed)) changes.push({ table, added, removed });
    }
    const statements =
      changes.length === 0
        ? []
        : await api.generatePrivilegeDiffSql(driver, selected.name, selected.host, database, changes);
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
          {driver === "mysql" && (
            <Callout tone="warning" role="status" mt="2" data-testid="users-mysql-nonatomic">
              {t("usersApplyMysqlNonAtomic")}
            </Callout>
          )}
          <CodePreview wrap mt="2" maxH="260px">{statements.join(";\n")}</CodePreview>
        </>
      ),
      confirmLabel: t("usersApplyConfirmOk"),
      // REVOKE (権限剥奪) が 1 件でも含まれる変更は破壊的寄りとして danger 扱いにする。
      tone: statements.some((s) => s.startsWith("REVOKE")) ? "danger" : "primary",
    });
    if (!ok) return;
    setBusy(true);
    // 適用待ちの間に別ユーザが選ばれたら、そのユーザの読み込み結果を A の権限で上書きしない。
    const seqBefore = privSeq.current;
    try {
      await api.applyPrivilegeSql({ sessionId, database, statements });
      toast.success(t("usersApplyDone"));
      if (privSeq.current === seqBefore) await loadPrivileges(selected);
    } catch (e) {
      toast.error(t("usersApplyFailed", { error: String(e) }));
      // MySQL の GRANT / REVOKE は暗黙コミットされ、途中失敗でも先行文が残りうる。
      // 画面を適用前の古い状態のままにせず、サーバの実際の権限を再取得する。
      if (privSeq.current === seqBefore) {
        await loadPrivileges(selected);
      }
    } finally {
      setBusy(false);
    }
  }, [selected, database, rowKeys, original, edited, driver, confirm, t, sessionId, toast, loadPrivileges]);

  // 他ユーザの権限をコピー (#1536): コピー元の権限を読み、編集中のマトリクスへ反映する。
  // 反映後は通常の編集と同じく「変更を適用」→ SQL 全文プレビュー → 適用の経路に乗る。
  const copyPrivilegesFromSource = useCallback(async () => {
    if (!selected || !database) return;
    const source = users.find((u) => userKey(u) === copySourceKey);
    if (!source) return;
    const seqBefore = privSeq.current;
    setBusy(true);
    try {
      const p = await api.listUserPrivileges(sessionId, source.name, source.host, database);
      // 読み込み中に別ユーザへ切り替わっていたら反映しない。
      if (privSeq.current !== seqBefore) return;
      const prefix = `${database}.`;
      const rows = flagsMap();
      for (const row of p.tables) {
        if (!row.table.startsWith(prefix)) continue;
        rows[row.table.slice(prefix.length)] = flagsFromRow(row);
      }
      setEdited(mergeCopiedPrivileges(original, rows));
      setCopied({ name: source.name, sourceRows: Object.keys(rows).length });
      setShowCopy(false);
      toast.info(t("usersCopyLoaded", { name: source.name }));
    } catch (e) {
      toast.error(t("usersCopyFailed", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  }, [selected, database, users, copySourceKey, sessionId, original, toast, t]);

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
          <CodePreview wrap mt="2" maxH="260px">{sql}</CodePreview>
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
          <CodePreview wrap mt="2" maxH="260px">{sql}</CodePreview>
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
      privSeq.current++;
      setLoadingPrivs(false);
      setSelected(null);
      setOriginal(flagsMap());
      setEdited(flagsMap());
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
          <CodePreview wrap mt="2" maxH="260px">{sql}</CodePreview>
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
    <Box flex="1" overflowY="auto" py="5" px="6" display="flex" flexDirection="column" gap="3.5">
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

      <chakra.p margin={0} textStyle="body" color="app.textMuted">
        {t("usersDesc")}
      </chakra.p>

      {readOnly && (
        // 読み取り専用はエラーではなく「この画面では変更できない」という案内 (#1145)。
        <Callout tone="info" icon="lock" role="status">
          {t("usersReadOnlyHint")}
        </Callout>
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
          <Flex align="center" gap="1">
            <Tooltip label={t("usersRefresh")} focusableWrapper={loadingUsers}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t("usersRefresh")}
                onClick={() => void loadUsers()}
                disabled={loadingUsers}
              >
                <Icon name="refresh" size={ICON_SIZES.md} />
              </Button>
            </Tooltip>
            <Tooltip label={readOnly ? t("usersReadOnlyHint") : t("usersNewUser")} focusableWrapper={readOnly}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t("usersNewUser")}
                disabled={readOnly}
                onClick={() => setShowCreate((v) => !v)}
              >
                <Icon name="plus" size={ICON_SIZES.md} />
              </Button>
            </Tooltip>
            {loadingUsers && <Spinner size={14} />}
          </Flex>

          {showCreate && (
            <FormSection css={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "var(--space-2)" }}>
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
                        py="1.5" px="2"
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
                              color={semanticColorVar("danger", "text")}
                              border={`1px solid ${semanticColorVar("danger", "text")}`}
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
                    <Button
                      type="button"
                      disabled={readOnly || !database || users.length < 2}
                      onClick={() => {
                        setCopySourceKey("");
                        setShowCopy((v) => !v);
                      }}
                    >
                      {t("usersCopyPrivileges")}
                    </Button>
                  </Tooltip>
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

              {showCopy && (
                <FormSection css={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "var(--space-2)", maxWidth: "40ch" }}>
                  <FieldLabel htmlFor="users-copy-source">{t("usersCopySourceLabel")}</FieldLabel>
                  <Select
                    id="users-copy-source"
                    value={copySourceKey}
                    onChange={(e) => setCopySourceKey(e.target.value)}
                  >
                    <option value="">{t("usersCopySourcePlaceholder")}</option>
                    {users
                      .filter((u) => userKey(u) !== userKey(selected))
                      .map((u) => (
                        <option key={userKey(u)} value={userKey(u)}>
                          {u.name}
                          {u.host ? `@${u.host}` : ""}
                        </option>
                      ))}
                  </Select>
                  <chakra.p margin={0} textStyle="caption">
                    {t("usersCopyHint", { database: database ?? "" })}
                  </chakra.p>
                  {driver === "mysql" && (
                    <chakra.p margin={0} textStyle="caption">
                      {t("usersCopyMysqlNote")}
                    </chakra.p>
                  )}
                  <Flex gap="2" justifyContent="flex-end">
                    <Button type="button" onClick={() => setShowCopy(false)} disabled={busy}>
                      {t("usersCopyCancel")}
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      disabled={busy || !copySourceKey}
                      onClick={() => void copyPrivilegesFromSource()}
                    >
                      {t("usersCopySubmit")}
                    </Button>
                  </Flex>
                </FormSection>
              )}

              {copied && (copied.sourceRows === 0 || copyRevokeCount > 0) && (
                <Callout tone="warning" role="status" data-testid="users-copy-warning">
                  {copied.sourceRows === 0
                    ? t("usersCopyEmptySource", { name: copied.name, database: database ?? "" })
                    : t("usersCopyRevokes", { count: copyRevokeCount })}
                </Callout>
              )}

              {showPassword && (
                <FormSection css={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "var(--space-2)", maxWidth: "40ch" }}>
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
                  <chakra.p margin={0} textStyle="caption">
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
                        if (isPlainEnterKey(e)) addTableRow();
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
                          rowKeys.map((table) => (
                            <PrivilegeRow
                              key={table}
                              table={table}
                              flags={edited[table] ?? EMPTY_FLAGS}
                              originalFlags={original[table] ?? EMPTY_FLAGS}
                              readOnly={readOnly}
                              onToggle={toggleFlag}
                            />
                          ))
                        )}
                      </tbody>
                    </chakra.table>
                  </Box>

                  <Flex gap="2" justifyContent="flex-end">
                    {dirty && (
                      <Button type="button" variant="dangerOutline" onClick={discardChanges} disabled={busy}>
                        {t("usersDiscardChanges")}
                      </Button>
                    )}
                    <Tooltip label={readOnly ? t("usersReadOnlyHint") : undefined} focusableWrapper={readOnly}>
                      <Button
                        type="button"
                        variant="primary"
                        disabled={readOnly || busy || loadingPrivs || !dirty}
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
