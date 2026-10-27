import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";
import { motion, useReducedMotion } from "motion/react";

import {
  api,
  type DbUserInfo,
  type PrivilegeChange,
  type DriverKind,
  type TablePrivilegeRow,
} from "../api/tauri";
import { useT } from "../i18n";
import { staggerContainer, variants } from "../motion";
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
import { copyToClipboard } from "./clipboard";
import {
  applyPrivilegeTemplate,
  generatePassword,
  parseColumnList,
  parseRoleInput,
  PRIVILEGE_TEMPLATE_IDS,
  type PrivilegeTemplateId,
} from "./privilegeTemplates";
import {
  addedRoles,
  changedPrivilegeCells,
  isStaggerAnimated,
  shouldPlayPrivilegeFlash,
  type ChangedPrivilegeCells,
} from "./usersPanelMotion";

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

// 入場 stagger の motion 要素 (#1890)。variants は親コンテナから伝播する。
const MotionTbody = chakra(motion.tbody, {}, { forwardProps: ["variants", "initial", "animate"] });
const MotionTr = chakra(motion.tr, {}, { forwardProps: ["variants"] });
const MotionUl = chakra(motion.ul, {}, { forwardProps: ["variants", "initial", "animate"] });
const MotionLi = chakra(motion.li, {}, { forwardProps: ["variants"] });

/**
 * 適用直後に光らせるセル。`gen` は適用ごとに増やし、セルの key に混ぜて
 * `apply-flash` を再生し直す。
 */
type PrivilegeFlash = { gen: number; cells: ChangedPrivilegeCells };

/** 光らせるセルに足す。疑似要素 (App.css の `.flash-ring::after`) の基準位置になる。 */
const flashCellCss: SystemStyleObject = { position: "relative" };

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
  animated = false,
  flashCols,
  flashGen = 0,
}: {
  table: string;
  flags: Flags;
  originalFlags: Flags;
  readOnly: boolean;
  onToggle: (table: string, flag: keyof Flags) => void;
  /** 入場 stagger に載せるか (#1890)。親の `MotionTbody` の variant が伝播する。 */
  animated?: boolean;
  /** 直前の適用で変わった権限列。該当セルへ `apply-flash` を 1 回再生する (#1890)。 */
  flashCols?: ReadonlySet<string>;
  /** 適用ごとに増える世代。セルの key に混ぜて再生し直す。 */
  flashGen?: number;
}) {
  const rowDirty = !flagsEqual(originalFlags, flags);
  return (
    // 常に motion 要素にして、12/13 件目の境界で要素の型が変わり再マウントされるのを避ける。
    <MotionTr variants={animated ? variants.staggerItem : undefined}>
      <chakra.td css={tdCss} fontFamily="var(--font-mono)" color={rowDirty ? "var(--accent)" : undefined}>
        {table}
      </chakra.td>
      {PRIVILEGE_FLAGS.map((flag) => {
        const flashed = flashCols?.has(flag) === true;
        return (
          <chakra.td css={{ ...tdCss, ...flashCellCss }} key={flag}>
            {flashed && (
              // td と Checkbox は作り直さず、オーバーレイだけを世代 key で作り直して再生する。
              <chakra.span
                key={flashGen}
                className="flash-ring"
                data-privilege-flash=""
                aria-hidden
                position="absolute"
                inset="0"
                pointerEvents="none"
              />
            )}
            <Checkbox
              checked={flags[flag]}
              disabled={readOnly}
              aria-label={`${table} ${flag}`}
              onChange={() => onToggle(table, flag)}
            />
          </chakra.td>
        );
      })}
    </MotionTr>
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
  const reduced = useReducedMotion() ?? false;

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
  // 生成したパスワードは見えないとコピーできないので、生成後は平文表示に切り替える (#1622)。
  const [revealCreatePw, setRevealCreatePw] = useState(false);
  const [revealNewPw, setRevealNewPw] = useState(false);

  // 権限テンプレート (#1622)。
  const [templateId, setTemplateId] = useState<PrivilegeTemplateId | "">("");
  // ロール付与 / 剥奪 (#1622)。
  const [roleInput, setRoleInput] = useState("");
  // 列単位の権限 (#1622)。
  const [showColumns, setShowColumns] = useState(false);
  const [colTable, setColTable] = useState("");
  const [colList, setColList] = useState("");
  const [colFlags, setColFlags] = useState({ select: true, insert: false, update: false });

  // 他ユーザの権限コピー (#1536)。コピー元は `${name}@@${host}` で持つ。
  const [showCopy, setShowCopy] = useState(false);
  const [copySourceKey, setCopySourceKey] = useState("");
  // 直近にコピーした内容 (注意書き用)。別ユーザへ切り替え・変更の破棄・再読込で消す。
  const [copied, setCopied] = useState<{ name: string; sourceRows: number } | null>(null);

  const [busy, setBusy] = useState(false);

  // 適用直後の面内フィードバック (#1890)。権限セルは再取得結果との差分、ロールは新規に加わった
  // ものだけを `apply-flash` で 1 回光らせる。ユーザ切替で消す。
  const [privFlash, setPrivFlash] = useState<PrivilegeFlash | null>(null);
  const [roleFlash, setRoleFlash] = useState<{ gen: number; roles: ReadonlySet<string> } | null>(null);
  const flashGen = useRef(0);
  // loadPrivileges が適用前の権限を参照するための最新値 (依存配列に original を入れて再生成しない)。
  const originalRef = useRef(original);
  originalRef.current = original;

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const list = await api.listDbUsers(sessionId);
      setUsers(list);
      setUsersError(null);
      return list;
    } catch (e) {
      setUsersError(String(e));
      return null;
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
    async (u: DbUserInfo, opts?: { flashChanges?: boolean }) => {
      const seq = ++privSeq.current;
      // 適用後の再取得は表を置き換えずその場で更新する (スケルトンを挟むと光らせるセルが
      // 一度消え、入場 stagger とフラッシュが重なる)。
      const inPlace = opts?.flashChanges === true;
      if (!inPlace) setLoadingPrivs(true);
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
        if (inPlace && shouldPlayPrivilegeFlash()) {
          const cells = changedPrivilegeCells(originalRef.current, rows);
          setPrivFlash(cells.size > 0 ? { gen: ++flashGen.current, cells } : null);
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
      setPrivFlash(null);
      setRoleFlash(null);
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
      setRevealNewPw(false);
      setTemplateId("");
      setRoleInput("");
      setShowColumns(false);
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
    () => rowKeys.some((k) => !flagsEqual(original[k] ?? EMPTY_FLAGS, edited[k] ?? EMPTY_FLAGS)),
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
          <chakra.p margin={0}>{t("usersApplyConfirmMessage", { count: statements.length })}</chakra.p>
          {driver === "mysql" && (
            <Callout tone="warning" role="status" mt="2" data-testid="users-mysql-nonatomic">
              {t("usersApplyMysqlNonAtomic")}
            </Callout>
          )}
          <CodePreview wrap mt="2" maxH="260px">
            {statements.join(";\n")}
          </CodePreview>
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
      if (privSeq.current === seqBefore) await loadPrivileges(selected, { flashChanges: true });
    } catch (e) {
      toast.error(t("usersApplyFailed", { error: String(e) }));
      // MySQL の GRANT / REVOKE は暗黙コミットされ、途中失敗でも先行文が残りうる。
      // 画面を適用前の古い状態のままにせず、サーバの実際の権限を再取得する。
      if (driver === "mysql" && privSeq.current === seqBefore) {
        await loadPrivileges(selected, { flashChanges: true });
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

  // 権限テンプレートを編集中のマトリクスの全行へ反映する (#1622)。SQL は従来の差分経路で作る。
  const applyTemplate = useCallback(() => {
    if (!templateId) return;
    setEdited((cur) =>
      flagsMap(applyPrivilegeTemplate(cur, Object.keys({ ...original, ...cur }), templateId)),
    );
    setCopied(null);
    toast.info(t("usersTemplateApplied", { name: t(`usersTemplate_${templateId}`) }));
  }, [templateId, original, toast, t]);

  // 生成済み SQL を確認ダイアログ → 適用する共通経路 (ロール・列単位で使う, #1622)。
  const confirmAndRun = useCallback(
    async (statements: string[], opts: { title: string; okLabel: string; doneMessage: string }) => {
      if (!selected || statements.length === 0) return false;
      const ok = await confirm({
        title: opts.title,
        message: (
          <>
            <chakra.p margin={0}>{t("usersApplyConfirmMessage", { count: statements.length })}</chakra.p>
            {driver === "mysql" && (
              <Callout tone="warning" role="status">
                {t("usersApplyMysqlNonAtomic")}
              </Callout>
            )}
            <CodePreview wrap mt="2" maxH="260px">
              {statements.join(";\n")}
            </CodePreview>
          </>
        ),
        confirmLabel: opts.okLabel,
        tone: statements.some((s) => s.startsWith("REVOKE")) ? "danger" : "primary",
      });
      if (!ok) return false;
      setBusy(true);
      const seqBefore = privSeq.current;
      try {
        await api.applyPrivilegeSql({ sessionId, database, statements });
        toast.success(opts.doneMessage);
        const list = await loadUsers();
        // 選択中ユーザの表示 (所属ロールなど) を最新の一覧へ差し替える。
        const fresh = list?.find((u) => userKey(u) === userKey(selected)) ?? selected;
        // 待っている間に別ユーザへ切り替わっていたら、旧ユーザの結果を反映しない。
        if (privSeq.current === seqBefore) {
          if (fresh !== selected) setSelected(fresh);
          if (shouldPlayPrivilegeFlash()) {
            const roles = addedRoles(selected.member_of, fresh.member_of);
            if (roles.size > 0) setRoleFlash({ gen: ++flashGen.current, roles });
          }
          await loadPrivileges(fresh, { flashChanges: true });
        }
        return true;
      } catch (e) {
        toast.error(t("usersApplyFailed", { error: String(e) }));
        if (driver === "mysql" && privSeq.current === seqBefore) {
          await loadPrivileges(selected, { flashChanges: true });
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [selected, confirm, t, driver, sessionId, database, toast, loadUsers, loadPrivileges],
  );

  const submitRoleMembership = useCallback(
    async (grant: boolean, role: string, roleHost: string | null) => {
      if (!selected) return;
      const sql = await api.generateRoleMembershipSql({
        driver,
        grant,
        role,
        roleHost,
        user: selected.name,
        host: selected.host,
      });
      const done = await confirmAndRun([sql], {
        title: t(grant ? "usersRoleGrantTitle" : "usersRoleRevokeTitle"),
        okLabel: t(grant ? "usersRoleGrantOk" : "usersRoleRevokeOk"),
        doneMessage: t(grant ? "usersRoleGranted" : "usersRoleRevoked", { role, name: selected.name }),
      });
      if (done && grant) setRoleInput("");
    },
    [selected, driver, confirmAndRun, t],
  );

  const submitColumnPrivilege = useCallback(
    async (grant: boolean) => {
      if (!selected || !database) return;
      const table = colTable.trim();
      const columns = parseColumnList(colList);
      if (!table || columns.length === 0) return;
      const flags = { ...colFlags, delete: false, ddl: false };
      const none = { select: false, insert: false, update: false, delete: false, ddl: false };
      const change: PrivilegeChange = {
        table,
        columns,
        added: grant ? flags : none,
        removed: grant ? none : flags,
      };
      const statements = await api.generatePrivilegeDiffSql(driver, selected.name, selected.host, database, [
        change,
      ]);
      await confirmAndRun(statements, {
        title: t(grant ? "usersColumnGrantTitle" : "usersColumnRevokeTitle"),
        okLabel: t(grant ? "usersColumnGrantOk" : "usersColumnRevokeOk"),
        doneMessage: t("usersColumnDone"),
      });
    },
    [selected, database, colTable, colList, colFlags, driver, confirmAndRun, t],
  );

  const fillGeneratedPassword = useCallback(
    async (setPw: (v: string) => void, reveal: (v: boolean) => void) => {
      const pw = generatePassword();
      setPw(pw);
      reveal(true);
      // クリップボードへは自動でコピーしない (履歴ツールなどへ秘密が残るため)。コピーはボタン操作のみ。
      toast.info(t("usersPasswordGenerated"));
    },
    [toast, t],
  );

  const copyPassword = useCallback(
    async (pw: string) => {
      if (!pw) return;
      if (await copyToClipboard(pw)) toast.info(t("usersPasswordCopied"));
      else toast.error(t("clipboardCopyFailed"));
    },
    [toast, t],
  );

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
          <CodePreview wrap mt="2" maxH="260px">
            {sql}
          </CodePreview>
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
      setRevealCreatePw(false);
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
          <chakra.p margin={0}>{t("usersDropConfirmMessage", { name: selected.name })}</chakra.p>
          <CodePreview wrap mt="2" maxH="260px">
            {sql}
          </CodePreview>
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
    const sql = await api.generateAlterPasswordSql(driver, selected.name, selected.host, newPassword);
    const ok = await confirm({
      title: t("usersPasswordConfirmTitle"),
      message: (
        <>
          <chakra.p margin={0}>{t("usersPasswordConfirmMessage", { name: selected.name })}</chakra.p>
          <CodePreview wrap mt="2" maxH="260px">
            {sql}
          </CodePreview>
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
      setRevealNewPw(false);
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
            <Tooltip
              label={readOnly ? t("usersReadOnlyHint") : t("usersNewUser")}
              focusableWrapper={readOnly}
            >
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
            <FormSection
              css={{
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                padding: "var(--space-2)",
              }}
            >
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
                type={revealCreatePw ? "text" : "password"}
                autoComplete="new-password"
                value={createPassword}
                onChange={(e) => setCreatePassword(e.target.value)}
              />
              <Button
                type="button"
                size="sm"
                onClick={() => void fillGeneratedPassword(setCreatePassword, setRevealCreatePw)}
              >
                {t("usersPasswordGenerate")}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!createPassword}
                onClick={() => void copyPassword(createPassword)}
              >
                {t("usersPasswordCopy")}
              </Button>
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
          ) : users.length === 0 ? (
            // 初回読み込み中。ユーザが揃ってから MotionUl をマウントし、全行が stagger の遅延つきで入る
            // ようにする (空のコンテナが先にマウントされると後から来た li は遅延 0 で同時に出る)。
            <Spinner size={16} />
          ) : (
            <MotionUl
              // 入場は staggerContainer + staggerItem (ServerInfoPanel / ActivityCenter と同じ, #1890)。
              // 先頭 12 件だけ載せ、リフレッシュで一覧が差し替わっても key が同じ項目は再生しない。
              variants={staggerContainer(reduced)}
              initial="initial"
              animate="animate"
              listStyleType="none"
              margin={0}
              padding={0}
              display="flex"
              flexDirection="column"
              gap="1"
            >
              {users.map((u, i) => {
                const isSelected = selected?.name === u.name && selected?.host === u.host;
                return (
                  <MotionLi
                    key={`${u.name}@@${u.host ?? ""}`}
                    variants={isStaggerAnimated(i) ? variants.staggerItem : undefined}
                  >
                    <chakra.button
                      type="button"
                      onClick={() => selectUser(u)}
                      width="100%"
                      textAlign="left"
                      py="1.5"
                      px="2"
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
                  </MotionLi>
                );
              })}
            </MotionUl>
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
                <FormSection
                  css={{
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    padding: "var(--space-2)",
                    maxWidth: "40ch",
                  }}
                >
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
                <FormSection
                  css={{
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    padding: "var(--space-2)",
                    maxWidth: "40ch",
                  }}
                >
                  <FieldLabel htmlFor="users-new-password">{t("usersPasswordLabel")}</FieldLabel>
                  <Input
                    id="users-new-password"
                    type={revealNewPw ? "text" : "password"}
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void fillGeneratedPassword(setNewPassword, setRevealNewPw)}
                  >
                    {t("usersPasswordGenerate")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!newPassword}
                    onClick={() => void copyPassword(newPassword)}
                  >
                    {t("usersPasswordCopy")}
                  </Button>
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

              <FormSection data-testid="users-roles">
                <FieldLabel htmlFor="users-role-input">{t("usersRolesLabel")}</FieldLabel>
                {selected.member_of.length > 0 ? (
                  <Flex gap="2" flexWrap="wrap">
                    {selected.member_of.map((role) => (
                      <Flex
                        key={roleFlash?.roles.has(role) ? `${role}:flash-${roleFlash.gen}` : role}
                        align="center"
                        gap="1"
                        className={roleFlash?.roles.has(role) ? "flash-ring" : undefined}
                        data-role-flash={roleFlash?.roles.has(role) ? "" : undefined}
                        css={roleFlash?.roles.has(role) ? flashCellCss : undefined}
                      >
                        <chakra.span fontFamily="var(--font-mono)" textStyle="caption">
                          {role}
                        </chakra.span>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={readOnly || busy}
                          aria-label={t("usersRoleRevokeAria", { role })}
                          onClick={() => {
                            // MySQL の member_of は `role@host`。剥奪にはホストが要る。
                            const parsed = driver === "mysql" ? parseRoleInput(role) : null;
                            void submitRoleMembership(false, parsed?.role ?? role, parsed?.host ?? null);
                          }}
                        >
                          {t("usersRoleRevoke")}
                        </Button>
                      </Flex>
                    ))}
                  </Flex>
                ) : (
                  <chakra.p margin={0} textStyle="caption">
                    {driver === "mysql" ? t("usersRolesMysqlNote") : t("usersRolesNone")}
                  </chakra.p>
                )}
                <Flex gap="2" align="center">
                  <Input
                    id="users-role-input"
                    value={roleInput}
                    onChange={(e) => setRoleInput(e.target.value)}
                    placeholder={t(
                      driver === "mysql" ? "usersRoleInputPlaceholderMysql" : "usersRoleInputPlaceholder",
                    )}
                    width="240px"
                    disabled={readOnly}
                  />
                  <Tooltip label={readOnly ? t("usersReadOnlyHint") : undefined} focusableWrapper={readOnly}>
                    <Button
                      type="button"
                      disabled={readOnly || busy || !parseRoleInput(roleInput)}
                      onClick={() => {
                        const parsed = parseRoleInput(roleInput);
                        if (parsed) void submitRoleMembership(true, parsed.role, parsed.host);
                      }}
                    >
                      {t("usersRoleGrant")}
                    </Button>
                  </Tooltip>
                </Flex>
              </FormSection>

              {globalRow && (
                <Box borderBottom="1px solid" borderColor="app.border" paddingBottom="2">
                  <chakra.p margin={0} textStyle="caption">
                    {t("usersGlobalRowHint")}
                  </chakra.p>
                  <Flex gap="3" marginTop="1" flexWrap="wrap">
                    {(
                      [
                        ["usersColSelect", globalRow.select],
                        ["usersColInsert", globalRow.insert],
                        ["usersColUpdate", globalRow.update],
                        ["usersColDelete", globalRow.delete],
                        ["usersColDdl", globalRow.ddl],
                      ] as const
                    ).map(([key, granted]) => (
                      <chakra.span
                        key={key}
                        textStyle="caption"
                        color={granted ? "app.textSuccess" : "app.textMuted"}
                      >
                        {t(key)}: {granted ? "✓" : "–"}
                      </chakra.span>
                    ))}
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

                  <Flex gap="2" align="center" flexWrap="wrap">
                    <Select
                      aria-label={t("usersTemplateLabel")}
                      value={templateId}
                      onChange={(e) => setTemplateId(e.target.value as PrivilegeTemplateId | "")}
                      disabled={readOnly}
                      width="240px"
                    >
                      <option value="">{t("usersTemplatePlaceholder")}</option>
                      {PRIVILEGE_TEMPLATE_IDS.map((id) => (
                        <option key={id} value={id}>
                          {t(`usersTemplate_${id}`)}
                        </option>
                      ))}
                    </Select>
                    <Button
                      type="button"
                      disabled={readOnly || !templateId || rowKeys.length === 0}
                      onClick={applyTemplate}
                    >
                      {t("usersTemplateApply")}
                    </Button>
                    <Button type="button" disabled={readOnly} onClick={() => setShowColumns((v) => !v)}>
                      {t("usersColumnPrivileges")}
                    </Button>
                  </Flex>
                  {templateId && (
                    <chakra.p margin={0} textStyle="caption">
                      {t("usersTemplateHint")}
                    </chakra.p>
                  )}

                  {showColumns && (
                    <FormSection
                      data-testid="users-columns"
                      css={{
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-sm)",
                        padding: "var(--space-2)",
                        maxWidth: "56ch",
                      }}
                    >
                      <FieldLabel htmlFor="users-col-table">{t("usersColumnTableLabel")}</FieldLabel>
                      <Input
                        id="users-col-table"
                        list="users-col-table-options"
                        value={colTable}
                        onChange={(e) => setColTable(e.target.value)}
                      />
                      <datalist id="users-col-table-options">
                        {rowKeys.map((k) => (
                          <option key={k} value={k} />
                        ))}
                      </datalist>
                      <FieldLabel htmlFor="users-col-list">{t("usersColumnListLabel")}</FieldLabel>
                      <Input
                        id="users-col-list"
                        value={colList}
                        placeholder="id, name"
                        onChange={(e) => setColList(e.target.value)}
                      />
                      <Flex gap="3">
                        {(["select", "insert", "update"] as const).map((f) => (
                          <chakra.label key={f} display="flex" alignItems="center" gap="1">
                            <Checkbox
                              checked={colFlags[f]}
                              onChange={() => setColFlags((cur) => ({ ...cur, [f]: !cur[f] }))}
                            />
                            <span>
                              {t(
                                f === "select"
                                  ? "usersColSelect"
                                  : f === "insert"
                                    ? "usersColInsert"
                                    : "usersColUpdate",
                              )}
                            </span>
                          </chakra.label>
                        ))}
                      </Flex>
                      <chakra.p margin={0} textStyle="caption">
                        {t("usersColumnHint")}
                      </chakra.p>
                      <Flex gap="2" justifyContent="flex-end">
                        <Button type="button" onClick={() => setShowColumns(false)} disabled={busy}>
                          {t("usersCopyCancel")}
                        </Button>
                        <Button
                          type="button"
                          variant="dangerOutline"
                          disabled={
                            busy ||
                            !colTable.trim() ||
                            parseColumnList(colList).length === 0 ||
                            !(colFlags.select || colFlags.insert || colFlags.update)
                          }
                          onClick={() => void submitColumnPrivilege(false)}
                        >
                          {t("usersColumnRevoke")}
                        </Button>
                        <Button
                          type="button"
                          variant="primary"
                          disabled={
                            busy ||
                            !colTable.trim() ||
                            parseColumnList(colList).length === 0 ||
                            !(colFlags.select || colFlags.insert || colFlags.update)
                          }
                          onClick={() => void submitColumnPrivilege(true)}
                        >
                          {t("usersColumnGrant")}
                        </Button>
                      </Flex>
                    </FormSection>
                  )}

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
                      <MotionTbody
                        // ユーザ切替・読み込み完了で作り直して入場 stagger を再生する (#1890)。
                        key={loadingPrivs ? "loading" : userKey(selected)}
                        variants={staggerContainer(reduced)}
                        initial="initial"
                        animate="animate"
                      >
                        {loadingPrivs ? (
                          <SkeletonTableRows columns={6} />
                        ) : rowKeys.length === 0 ? (
                          <tr>
                            {/* tdCss は nowrap なので、長い案内文だけ折り返す。 */}
                            <chakra.td css={{ ...tdCss, whiteSpace: "normal" }} colSpan={6}>
                              {t("usersPrivilegesEmpty")}
                            </chakra.td>
                          </tr>
                        ) : (
                          rowKeys.map((table, i) => (
                            <PrivilegeRow
                              key={table}
                              animated={isStaggerAnimated(i)}
                              flashCols={privFlash?.cells.get(table)}
                              flashGen={privFlash?.cells.has(table) ? privFlash.gen : undefined}
                              table={table}
                              flags={edited[table] ?? EMPTY_FLAGS}
                              originalFlags={original[table] ?? EMPTY_FLAGS}
                              readOnly={readOnly || busy}
                              onToggle={toggleFlag}
                            />
                          ))
                        )}
                      </MotionTbody>
                    </chakra.table>
                  </Box>

                  <Flex gap="2" justifyContent="flex-end">
                    {dirty && (
                      <Button type="button" variant="dangerOutline" onClick={discardChanges} disabled={busy}>
                        {t("usersDiscardChanges")}
                      </Button>
                    )}
                    <Tooltip
                      label={readOnly ? t("usersReadOnlyHint") : undefined}
                      focusableWrapper={readOnly}
                    >
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
