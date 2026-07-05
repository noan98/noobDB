import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, chakra, type SystemStyleObject } from "@chakra-ui/react";

import {
  api,
  type ColumnDiff,
  type ConnectionProfile,
  type DataDiff,
  type DiffStatus,
  type DriverKind,
  type SchemaDiff,
  type SyncKind,
  type SyncPlan,
  type SyncStatement,
  type TableColumnInfo,
  type TableDiff,
} from "../api/tauri";
import { useT } from "../i18n";
import { useSettings } from "../settings";
import { useConfirm } from "./ConfirmDialog";
import { Icon } from "./Icon";
import { Button, Checkbox, Input, PressableButton, Select } from "./ui";

/**
 * スキーマ比較ビューの本体スタイル。各要素へ直接 `css` を適用する。
 * ステータス (DiffStatus) や
 * 種別 (SyncKind) で色が変わる箇所はヘルパ関数で分岐する。フォーム部品を内包する
 * ラッパ (`& select` / `& input`) だけはタグセレクタ (className ではなく要素スコープ)
 * で残す。
 */
const sidesCss: SystemStyleObject = {
  display: "flex",
  alignItems: "flex-end",
  gap: "3",
  margin: "16px 0",
  flexWrap: "wrap",
};
const sideCss: SystemStyleObject = {
  display: "flex",
  flexDirection: "column",
  gap: "1.5",
  flex: "1 1 240px",
  minWidth: "200px",
  "& select": { width: "100%" },
};
const sideLabelCss: SystemStyleObject = {
  fontSize: "var(--text-sm)",
  fontWeight: 600,
  color: "var(--text-secondary)",
};
const sideErrorCss: SystemStyleObject = {
  fontSize: "var(--text-xs)",
  color: "var(--status-error)",
};
const actionsCss: SystemStyleObject = { margin: "12px 0" };
const warningCss: SystemStyleObject = {
  color: "var(--status-error)",
  fontSize: "var(--text-sm)",
  margin: "8px 0",
};
const emptyCss: SystemStyleObject = {
  color: "var(--text-muted)",
  fontSize: "var(--text-sm)",
  margin: "16px 0",
};
const summaryCss: SystemStyleObject = {
  display: "flex",
  alignItems: "center",
  gap: "2",
  flexWrap: "wrap",
  margin: "16px 0 10px",
};
const hideSameCss: SystemStyleObject = {
  display: "inline-flex",
  alignItems: "center",
  gap: "1.5",
  fontSize: "var(--text-sm)",
  color: "var(--text-secondary)",
  marginLeft: "auto",
  cursor: "pointer",
};
const tablesCss: SystemStyleObject = {
  display: "flex",
  flexDirection: "column",
  gap: "1",
};
// `<details>` 本体。`<summary>` はタグセレクタ (要素スコープ) で括る。
const tableCss: SystemStyleObject = {
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  background: "var(--bg-elevated)",
  overflow: "hidden",
  "& > summary": {
    display: "flex",
    alignItems: "center",
    gap: "2.5",
    py: "2", px: "3",
    cursor: "pointer",
    listStyle: "none",
    userSelect: "none",
  },
  "& > summary::-webkit-details-marker": { display: "none" },
};
const tableNameCss: SystemStyleObject = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  color: "var(--text)",
};
const colcountCss: SystemStyleObject = {
  fontSize: "var(--text-xs)",
  color: "var(--text-muted)",
  marginLeft: "auto",
};
const columnsCss: SystemStyleObject = {
  listStyle: "none",
  margin: 0,
  padding: "0 12px 10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: "1",
};
const columnCss: SystemStyleObject = {
  display: "flex",
  alignItems: "baseline",
  gap: "2",
  fontSize: "var(--text-sm)",
  padding: "3px 0",
  borderTop: "1px solid var(--border-subtle)",
};
const columnNameCss: SystemStyleObject = {
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
};
const coltypeCss: SystemStyleObject = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--text-muted)",
};
const changesCss: SystemStyleObject = {
  display: "flex",
  flexWrap: "wrap",
  gap: "1 3",
};
const changeCss: SystemStyleObject = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--text-secondary)",
};
const syncCss: SystemStyleObject = {
  marginTop: "6",
  paddingTop: "4",
  borderTop: "1px solid var(--border)",
};
const syncTitleCss: SystemStyleObject = { margin: "0 0 4px", fontSize: "var(--text-md)" };
const syncControlsCss: SystemStyleObject = {
  display: "flex",
  alignItems: "center",
  gap: "3",
  flexWrap: "wrap",
  margin: "10px 0",
};
const destructiveCss: SystemStyleObject = {
  display: "inline-flex",
  alignItems: "center",
  gap: "1.5",
  fontSize: "var(--text-sm)",
  color: "var(--status-error)",
  cursor: "pointer",
};
const successCss: SystemStyleObject = {
  color: "var(--status-success)",
  fontSize: "var(--text-sm)",
  margin: "8px 0",
};
const statementsCss: SystemStyleObject = {
  listStyle: "none",
  margin: "8px 0",
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "1.5",
};
const statementHeadCss: SystemStyleObject = {
  display: "flex",
  alignItems: "center",
  gap: "2",
  cursor: "pointer",
  marginBottom: "1.5",
};
const destructiveFlagCss: SystemStyleObject = {
  fontSize: "var(--text-xs)",
  fontWeight: 600,
  color: "var(--status-error)",
};
const sqlCss: SystemStyleObject = {
  display: "block",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--text)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};
const backupCss: SystemStyleObject = {
  fontSize: "var(--text-sm)",
  color: "var(--status-connecting)",
  margin: "10px 0",
};
const planWarningsCss: SystemStyleObject = {
  margin: "10px 0 0",
  paddingLeft: "18px",
  fontSize: "var(--text-sm)",
  color: "var(--text-muted)",
};
// 入力 (`<input>`) はタグセレクタ (要素スコープ) で幅を固定する。
const limitCss: SystemStyleObject = {
  display: "inline-flex",
  alignItems: "center",
  gap: "1.5",
  fontSize: "var(--text-sm)",
  color: "var(--text-secondary)",
  "& input": { width: "80px" },
};

/** DiffStatus に対応する文字色/枠色 (chip / badge 共通)。 */
function statusColors(status: DiffStatus): { color: string; borderColor: string } {
  switch (status) {
    case "source_only":
      return { color: "var(--status-success)", borderColor: "var(--status-success)" };
    case "target_only":
      return { color: "var(--status-error)", borderColor: "var(--status-error)" };
    case "different":
      return { color: "var(--status-connecting)", borderColor: "var(--status-connecting)" };
    case "same":
      return { color: "var(--text-muted)", borderColor: "var(--border)" };
  }
}

/** サマリ等のステータスチップ。 */
function chipCss(status: DiffStatus): SystemStyleObject {
  return {
    fontSize: "var(--text-xs)",
    fontWeight: 600,
    padding: "3px 10px",
    borderRadius: "var(--radius-pill)",
    border: "1px solid var(--border)",
    background: "var(--bg-muted)",
    ...statusColors(status),
  };
}

/** テーブル/カラム行のステータスバッジ。 */
function badgeCss(status: DiffStatus): SystemStyleObject {
  return {
    fontSize: "var(--text-xs)",
    fontWeight: 600,
    padding: "1px 8px",
    borderRadius: "var(--radius-pill)",
    whiteSpace: "nowrap",
    border: "1px solid transparent",
    ...statusColors(status),
  };
}

/** SyncKind に対応する文字色/枠色。 */
function kindColors(kind: SyncKind): { color: string; borderColor: string } {
  switch (kind) {
    case "create_table":
    case "add_column":
    case "insert_row":
      return { color: "var(--status-success)", borderColor: "var(--status-success)" };
    case "alter_column":
    case "update_row":
      return { color: "var(--status-connecting)", borderColor: "var(--status-connecting)" };
    case "drop_column":
    case "drop_table":
    case "delete_row":
      return { color: "var(--status-error)", borderColor: "var(--status-error)" };
  }
}

/** 同期文の種別バッジ。 */
function kindCss(kind: SyncKind): SystemStyleObject {
  return {
    fontSize: "var(--text-xs)",
    fontWeight: 600,
    padding: "1px 8px",
    borderRadius: "var(--radius-pill)",
    border: "1px solid var(--border)",
    ...kindColors(kind),
  };
}

/** 同期文 1 件の枠。 */
function statementCss(destructive: boolean): SystemStyleObject {
  const base: SystemStyleObject = {
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--bg-elevated)",
    py: "2", px: "2.5",
  };
  return destructive ? { ...base, borderColor: "var(--status-error)" } : base;
}

type Side = "source" | "target";

function coerceDriver(driver: string): DriverKind {
  return driver === "postgres" || driver === "sqlite" ? driver : "mysql";
}

/**
 * Default checklist selection for a generated plan: every non-destructive
 * statement is checked, destructive ones (DROP / DELETE) stay opt-in so an
 * "apply" can never silently destroy data even when they were generated.
 */
function defaultSelection(plan: SyncPlan): Set<number> {
  const next = new Set<number>();
  plan.statements.forEach((s, i) => {
    if (!s.destructive) next.add(i);
  });
  return next;
}

interface SideState {
  profileId: string | null;
  sessionId: string | null;
  databases: string[] | null;
  database: string | null;
  connecting: boolean;
  error: string | null;
}

const EMPTY_SIDE: SideState = {
  profileId: null,
  sessionId: null,
  databases: null,
  database: null,
  connecting: false,
  error: null,
};

/**
 * Schema comparison + sync: pick a source and a
 * target connection + database, view how their schemas differ, then optionally
 * generate the reconciling DDL and apply it to the target. Comparison runs over
 * short-lived read-only sessions this view opens on demand (one per distinct
 * profile) and tears down on close, so it never disturbs the main workspace
 * connection. Applying a sync plan opens a separate, writable session to the
 * target profile just for the transaction (rejected if that profile is
 * read-only) and disconnects it immediately after.
 */
export function SchemaCompareView({
  profiles,
  onClose,
}: {
  profiles: ConnectionProfile[];
  onClose: () => void;
}) {
  const t = useT();
  const settings = useSettings();
  const { confirm, dialog: confirmDialog } = useConfirm();
  // 不可逆 (破壊的ステートメントを含む同期適用) × 本番接続の強確認ゲート
  // (対象接続名のタイプ入力。#675) に使う専用ダイアログ。破壊的 × 本番の
  // ケースだけこちらへ差し替え、それ以外は上の confirm (テーマ追従ダイアログ。#674) を使う。
  const { confirm: confirmTyped, dialog: typedConfirmDialog } = useConfirm();

  const [source, setSource] = useState<SideState>(EMPTY_SIDE);
  const [target, setTarget] = useState<SideState>(EMPTY_SIDE);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [diff, setDiff] = useState<SchemaDiff | null>(null);
  const [hideSame, setHideSame] = useState(true);

  // Sync state. A single plan / selection / apply path is shared
  // by the schema (DDL) and data (DML) generators; `planKind` records which one
  // produced the current plan so apply can refresh the right view afterwards.
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [planKind, setPlanKind] = useState<"schema" | "data" | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);

  // Data sync state.
  const [dataTable, setDataTable] = useState<string>("");
  const [dataLimit, setDataLimit] = useState(1000);
  const [dataDiff, setDataDiff] = useState<DataDiff | null>(null);
  const [dataComparing, setDataComparing] = useState(false);
  const [allowDelete, setAllowDelete] = useState(false);

  // Any change to the schema diff invalidates a previously generated plan and
  // any in-flight data comparison (the connections / databases changed).
  useEffect(() => {
    setPlan(null);
    setPlanKind(null);
    setSelected(new Set());
    setSyncError(null);
    setApplyResult(null);
    setDataDiff(null);
    setDataTable("");
  }, [diff]);

  // Sessions this view opened, keyed by profile id so the same profile chosen
  // on both sides reuses one connection. Disconnected on unmount.
  const ownedRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const owned = ownedRef.current;
    return () => {
      for (const sessionId of owned.values()) {
        api.disconnect(sessionId).catch(() => {});
      }
      owned.clear();
    };
  }, []);

  const ensureSession = useCallback(
    async (profile: ConnectionProfile): Promise<string> => {
      const existing = ownedRef.current.get(profile.id);
      if (existing) return existing;
      const res = await api.connect({
        profile_id: profile.id,
        driver: coerceDriver(profile.driver),
        host: profile.host,
        port: profile.port,
        user: profile.user,
        password: "",
        database: profile.database,
        ssh: profile.ssh ? { ...profile.ssh, passphrase: "" } : null,
        file_path: profile.file_path,
        // Comparison only introspects; force read-only and keep it out of history.
        read_only: true,
        skip_history: true,
      });
      ownedRef.current.set(profile.id, res.session_id);
      return res.session_id;
    },
    [],
  );

  const selectProfile = useCallback(
    async (side: Side, profileId: string) => {
      const setSide = side === "source" ? setSource : setTarget;
      setDiff(null);
      setCompareError(null);
      if (!profileId) {
        setSide(EMPTY_SIDE);
        return;
      }
      setSide({ ...EMPTY_SIDE, profileId, connecting: true });
      const profile = profiles.find((p) => p.id === profileId);
      if (!profile) {
        setSide({ ...EMPTY_SIDE, profileId, error: "profile not found" });
        return;
      }
      try {
        const sessionId = await ensureSession(profile);
        const databases = await api.listDatabases(sessionId);
        const preferred =
          profile.database && databases.includes(profile.database)
            ? profile.database
            : (databases[0] ?? null);
        setSide({
          profileId,
          sessionId,
          databases,
          database: preferred,
          connecting: false,
          error: null,
        });
      } catch (e) {
        setSide({ ...EMPTY_SIDE, profileId, error: String(e) });
      }
    },
    [profiles, ensureSession],
  );

  const setDatabase = useCallback((side: Side, database: string) => {
    const setSide = side === "source" ? setSource : setTarget;
    setSide((prev) => ({ ...prev, database }));
    setDiff(null);
    setCompareError(null);
  }, []);

  const swap = useCallback(() => {
    setSource(target);
    setTarget(source);
    setDiff(null);
    setCompareError(null);
  }, [source, target]);

  const sourceDriver = useMemo(
    () => profiles.find((p) => p.id === source.profileId)?.driver ?? null,
    [profiles, source.profileId],
  );
  const targetDriver = useMemo(
    () => profiles.find((p) => p.id === target.profileId)?.driver ?? null,
    [profiles, target.profileId],
  );
  const driverMismatch =
    sourceDriver !== null && targetDriver !== null && sourceDriver !== targetDriver;

  const canCompare =
    !!source.sessionId &&
    !!source.database &&
    !!target.sessionId &&
    !!target.database &&
    !driverMismatch &&
    !comparing;

  const runCompare = useCallback(async () => {
    if (
      !source.sessionId ||
      !source.database ||
      !target.sessionId ||
      !target.database ||
      driverMismatch
    ) {
      return;
    }
    setComparing(true);
    setCompareError(null);
    setDiff(null);
    try {
      const result = await api.compareSchema({
        sourceSessionId: source.sessionId,
        sourceDatabase: source.database,
        targetSessionId: target.sessionId,
        targetDatabase: target.database,
      });
      setDiff(result);
    } catch (e) {
      setCompareError(String(e));
    } finally {
      setComparing(false);
    }
  }, [source, target, driverMismatch]);

  const counts = useMemo(() => {
    const c = { source_only: 0, target_only: 0, different: 0, same: 0 };
    if (diff) for (const tbl of diff.tables) c[tbl.status] += 1;
    return c;
  }, [diff]);

  const visibleTables = useMemo(
    () => (diff ? diff.tables.filter((tbl) => !(hideSame && tbl.status === "same")) : []),
    [diff, hideSame],
  );

  const hasDifferences =
    counts.different + counts.source_only + counts.target_only > 0;

  const generatePlan = useCallback(async () => {
    if (!diff) return;
    setGenerating(true);
    setSyncError(null);
    setApplyResult(null);
    try {
      const result = await api.generateSyncSql(diff, allowDestructive);
      setPlan(result);
      setPlanKind("schema");
      setSelected(defaultSelection(result));
    } catch (e) {
      setSyncError(String(e));
    } finally {
      setGenerating(false);
    }
  }, [diff, allowDestructive]);

  // Tables present on both sides — the only ones whose rows can be compared and
  // synced (a one-sided table would need its schema created/dropped first).
  const comparableTables = useMemo(
    () =>
      diff
        ? diff.tables
            .filter((tbl) => tbl.status === "same" || tbl.status === "different")
            .map((tbl) => tbl.name)
        : [],
    [diff],
  );

  const compareData = useCallback(async () => {
    if (
      !source.sessionId ||
      !source.database ||
      !target.sessionId ||
      !target.database ||
      !dataTable
    ) {
      return;
    }
    setDataComparing(true);
    setSyncError(null);
    setApplyResult(null);
    setPlan(null);
    setPlanKind(null);
    setSelected(new Set());
    try {
      const result = await api.compareTableData({
        sourceSessionId: source.sessionId,
        sourceDatabase: source.database,
        targetSessionId: target.sessionId,
        targetDatabase: target.database,
        table: dataTable,
        limit: dataLimit,
      });
      setDataDiff(result);
    } catch (e) {
      setSyncError(String(e));
      setDataDiff(null);
    } finally {
      setDataComparing(false);
    }
  }, [source, target, dataTable, dataLimit]);

  const generateDataPlan = useCallback(async () => {
    if (!dataDiff) return;
    setGenerating(true);
    setSyncError(null);
    setApplyResult(null);
    try {
      const result = await api.generateDataSyncSql(dataDiff, allowDelete);
      setPlan(result);
      setPlanKind("data");
      setSelected(defaultSelection(result));
    } catch (e) {
      setSyncError(String(e));
    } finally {
      setGenerating(false);
    }
  }, [dataDiff, allowDelete]);

  const dataCounts = useMemo(() => {
    const c = { source_only: 0, target_only: 0, different: 0 };
    if (dataDiff) for (const r of dataDiff.rows) c[r.status] += 1;
    return c;
  }, [dataDiff]);

  const toggleStatement = useCallback((index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const targetProfile = useMemo(
    () => profiles.find((p) => p.id === target.profileId) ?? null,
    [profiles, target.profileId],
  );

  const applyPlan = useCallback(async () => {
    if (!plan || !targetProfile || !target.database) return;
    const statements = plan.statements
      .filter((_, i) => selected.has(i))
      .map((s) => s.sql);
    if (statements.length === 0) return;

    const destructiveCount = plan.statements.filter(
      (s, i) => selected.has(i) && s.destructive,
    ).length;
    const confirmMsg = t("schemaCompareApplyConfirm", {
      count: statements.length,
      name: targetProfile.name,
      destructive: destructiveCount,
    });
    const applyOk = await confirm({
      title: t("schemaCompareApply", { count: statements.length }),
      message: confirmMsg,
      tone: destructiveCount > 0 ? "danger" : "warning",
    });
    if (!applyOk) return;
    if (targetProfile.is_production) {
      if (destructiveCount > 0) {
        // 不可逆 (破壊的ステートメントを含む適用) × 本番接続: 対象接続名の
        // タイプ入力を要求する強確認ゲート (#675)。`confirmProductionConnect`
        // 設定に関わらず常に要求する — 通常の本番接続警告より強い安全網。
        const ok = await confirmTyped({
          title: t("schemaCompareApplyTypedConfirmTitle"),
          message: t("schemaCompareApplyTypedConfirmBody", {
            name: targetProfile.name,
            destructive: destructiveCount,
          }),
          confirmLabel: t("schemaCompareApplyTypedConfirmOk"),
          tone: "danger",
          typedConfirmation: targetProfile.name,
        });
        if (!ok) return;
      } else if (settings.confirmProductionConnect) {
        const prodOk = await confirm({
          title: t("productionConfirmTitle"),
          message: t("schemaCompareApplyProductionConfirm", { name: targetProfile.name }),
          tone: "warning",
        });
        if (!prodOk) return;
      }
    }

    setApplying(true);
    setSyncError(null);
    setApplyResult(null);
    let writableSession: string | null = null;
    try {
      // Open a dedicated writable session to the target profile. read_only is
      // taken from the profile, so a read-only profile makes the backend reject
      // the apply (acceptance criterion).
      const res = await api.connect({
        profile_id: targetProfile.id,
        driver: coerceDriver(targetProfile.driver),
        host: targetProfile.host,
        port: targetProfile.port,
        user: targetProfile.user,
        password: "",
        database: targetProfile.database,
        ssh: targetProfile.ssh ? { ...targetProfile.ssh, passphrase: "" } : null,
        file_path: targetProfile.file_path,
        read_only: targetProfile.read_only,
        skip_history: false,
      });
      writableSession = res.session_id;
      await api.applySyncSql({
        sessionId: res.session_id,
        database: target.database,
        statements,
      });
      setApplyResult(t("schemaCompareApplyDone", { count: statements.length }));
      // Refresh whichever comparison produced this plan so the view reflects
      // the post-apply state.
      if (planKind === "data") {
        await compareData();
      } else {
        await runCompare();
      }
    } catch (e) {
      setSyncError(String(e));
    } finally {
      if (writableSession) {
        api.disconnect(writableSession).catch(() => {});
      }
      setApplying(false);
    }
  }, [
    plan,
    planKind,
    selected,
    targetProfile,
    target.database,
    settings.confirmProductionConnect,
    confirmTyped,
    t,
    confirm,
    runCompare,
    compareData,
  ]);

  const selectedCount = selected.size;

  return (
    <Box
      flex="1"
      overflowY="auto"
      py="5" px="6"
      display="flex"
      flexDirection="column"
      gap="18px"
    >
      <chakra.header
        display="flex"
        alignItems="center"
        justifyContent="space-between"
        gap="3"
        borderBottom="1px solid"
        borderColor="app.border"
        paddingBottom="2.5"
      >
        <chakra.h2 margin={0} fontSize="lg" fontWeight={600} color="app.text">
          {t("schemaCompareTitle")}
        </chakra.h2>
        <Button
          minWidth="28px"
          px="2"
          py="1"
          fontSize="base"
          lineHeight={1}
          onClick={onClose}
          aria-label={t("schemaCompareClose")}
          title={t("schemaCompareClose")}
        >
          <Icon name="close" size={13} />
        </Button>
      </chakra.header>

      <chakra.p margin={0} fontSize="sm" color="app.textMuted">{t("schemaCompareDesc")}</chakra.p>

      {profiles.length === 0 ? (
        <chakra.p css={emptyCss}>{t("schemaCompareNoProfiles")}</chakra.p>
      ) : (
        <>
          <Box css={sidesCss}>
            <SidePicker
              label={t("schemaCompareSource")}
              side="source"
              state={source}
              profiles={profiles}
              onSelectProfile={selectProfile}
              onSelectDatabase={setDatabase}
              t={t}
            />
            <Button
              type="button"
              minWidth="28px"
              px="2"
              py="1"
              fontSize="base"
              lineHeight={1}
              marginBottom="1"
              onClick={swap}
              title={t("schemaCompareSwap")}
              aria-label={t("schemaCompareSwap")}
            >
              <Icon name="refresh" size={14} />
            </Button>
            <SidePicker
              label={t("schemaCompareTarget")}
              side="target"
              state={target}
              profiles={profiles}
              onSelectProfile={selectProfile}
              onSelectDatabase={setDatabase}
              t={t}
            />
          </Box>

          {driverMismatch && (
            <chakra.p css={warningCss}>{t("schemaCompareDriverMismatch")}</chakra.p>
          )}

          <Box css={actionsCss}>
            <PressableButton variant="primary" onClick={runCompare} disabled={!canCompare}>
              {comparing ? t("schemaCompareComparing") : t("schemaCompareCompare")}
            </PressableButton>
          </Box>

          {compareError && <chakra.p css={warningCss}>{compareError}</chakra.p>}

          {diff && (
            <Box>
              <Box css={summaryCss}>
                <StatusChip status="different" count={counts.different} t={t} />
                <StatusChip status="source_only" count={counts.source_only} t={t} />
                <StatusChip status="target_only" count={counts.target_only} t={t} />
                <StatusChip status="same" count={counts.same} t={t} />
                <chakra.label css={hideSameCss}>
                  <Checkbox
                    checked={hideSame}
                    onChange={(e) => setHideSame(e.target.checked)}
                  />
                  {t("schemaCompareHideSame")}
                </chakra.label>
              </Box>

              {visibleTables.length === 0 ? (
                <chakra.p css={emptyCss}>
                  {counts.different + counts.source_only + counts.target_only === 0
                    ? t("schemaCompareIdentical")
                    : t("schemaCompareAllHidden")}
                </chakra.p>
              ) : (
                <Box css={tablesCss}>
                  {visibleTables.map((tbl) => (
                    <TableDiffRow key={tbl.name} table={tbl} t={t} />
                  ))}
                </Box>
              )}

              {hasDifferences && (
                <Box css={syncCss}>
                  <chakra.h3 css={syncTitleCss}>{t("schemaCompareSyncTitle")}</chakra.h3>
                  <chakra.p margin={0} fontSize="sm" color="app.textMuted">{t("schemaCompareSyncDesc")}</chakra.p>
                  <Box css={syncControlsCss}>
                    <chakra.label css={destructiveCss}>
                      <Checkbox
                        checked={allowDestructive}
                        onChange={(e) => setAllowDestructive(e.target.checked)}
                      />
                      {t("schemaCompareAllowDestructive")}
                    </chakra.label>
                    <Button onClick={generatePlan} disabled={generating}>
                      {generating ? t("schemaCompareGenerating") : t("schemaCompareGenerate")}
                    </Button>
                  </Box>
                </Box>
              )}

              {comparableTables.length > 0 && (
                <Box css={syncCss}>
                  <chakra.h3 css={syncTitleCss}>{t("schemaCompareDataTitle")}</chakra.h3>
                  <chakra.p margin={0} fontSize="sm" color="app.textMuted">{t("schemaCompareDataDesc")}</chakra.p>
                  <Box css={syncControlsCss}>
                    <Select value={dataTable} onChange={(e) => setDataTable(e.target.value)}>
                      <option value="">{t("schemaCompareDataSelectTable")}</option>
                      {comparableTables.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </Select>
                    <chakra.label css={limitCss}>
                      {t("schemaCompareDataLimit")}
                      <Input
                        type="number"
                        min={1}
                        max={5000}
                        value={dataLimit}
                        onChange={(e) =>
                          setDataLimit(Math.max(1, Math.min(5000, Number(e.target.value) || 1)))
                        }
                      />
                    </chakra.label>
                    <Button onClick={compareData} disabled={!dataTable || dataComparing}>
                      {dataComparing ? t("schemaCompareComparing") : t("schemaCompareDataCompare")}
                    </Button>
                  </Box>

                  {dataDiff && (
                    <>
                      <Box css={summaryCss}>
                        <chakra.span css={chipCss("source_only")}>
                          {t("schemaCompareDataInserts")}: {dataCounts.source_only}
                        </chakra.span>
                        <chakra.span css={chipCss("different")}>
                          {t("schemaCompareDataUpdates")}: {dataCounts.different}
                        </chakra.span>
                        <chakra.span css={chipCss("target_only")}>
                          {t("schemaCompareDataDeletes")}: {dataCounts.target_only}
                        </chakra.span>
                      </Box>
                      {dataDiff.truncated && (
                        <chakra.p css={backupCss}>
                          {t("schemaCompareDataTruncated", { limit: dataLimit })}
                        </chakra.p>
                      )}
                      <Box css={syncControlsCss}>
                        <chakra.label css={destructiveCss}>
                          <Checkbox
                            checked={allowDelete}
                            onChange={(e) => setAllowDelete(e.target.checked)}
                          />
                          {t("schemaCompareAllowDelete")}
                        </chakra.label>
                        <Button onClick={generateDataPlan} disabled={generating}>
                          {generating ? t("schemaCompareGenerating") : t("schemaCompareDataGenerate")}
                        </Button>
                      </Box>
                    </>
                  )}
                </Box>
              )}

              {syncError && <chakra.p css={warningCss}>{syncError}</chakra.p>}
              {applyResult && <chakra.p css={successCss}>{applyResult}</chakra.p>}

              {plan && (
                <Box>
                  {plan.statements.length === 0 ? (
                    <chakra.p css={emptyCss}>{t("schemaCompareNoStatements")}</chakra.p>
                  ) : (
                    <>
                      <chakra.ul css={statementsCss}>
                        {plan.statements.map((stmt, i) => (
                          <SyncStatementRow
                            key={`${stmt.table}-${i}`}
                            statement={stmt}
                            checked={selected.has(i)}
                            onToggle={() => toggleStatement(i)}
                            t={t}
                          />
                        ))}
                      </chakra.ul>
                      <chakra.p css={backupCss}>{t("schemaCompareBackupNote")}</chakra.p>
                      <Box css={actionsCss}>
                        <PressableButton
                          variant="primary"
                          onClick={applyPlan}
                          disabled={applying || selectedCount === 0}
                        >
                          {applying
                            ? t("schemaCompareApplying")
                            : t("schemaCompareApply", { count: selectedCount })}
                        </PressableButton>
                      </Box>
                    </>
                  )}
                  {plan.warnings.length > 0 && (
                    <chakra.ul css={planWarningsCss}>
                      {plan.warnings.map((w, i) => (
                        <chakra.li key={i}>{w}</chakra.li>
                      ))}
                    </chakra.ul>
                  )}
                </Box>
              )}
            </Box>
          )}
        </>
      )}
      {confirmDialog}
      {typedConfirmDialog}
    </Box>
  );
}

function syncKindLabel(kind: SyncKind, t: ReturnType<typeof useT>): string {
  switch (kind) {
    case "create_table":
      return t("schemaCompareKindCreateTable");
    case "add_column":
      return t("schemaCompareKindAddColumn");
    case "alter_column":
      return t("schemaCompareKindAlterColumn");
    case "drop_column":
      return t("schemaCompareKindDropColumn");
    case "drop_table":
      return t("schemaCompareKindDropTable");
    case "insert_row":
      return t("schemaCompareKindInsertRow");
    case "update_row":
      return t("schemaCompareKindUpdateRow");
    case "delete_row":
      return t("schemaCompareKindDeleteRow");
  }
}

function SyncStatementRow({
  statement,
  checked,
  onToggle,
  t,
}: {
  statement: SyncStatement;
  checked: boolean;
  onToggle: () => void;
  t: ReturnType<typeof useT>;
}) {
  return (
    <chakra.li css={statementCss(statement.destructive)}>
      <chakra.label css={statementHeadCss}>
        <Checkbox checked={checked} onChange={onToggle} />
        <chakra.span css={kindCss(statement.kind)}>
          {syncKindLabel(statement.kind, t)}
        </chakra.span>
        {statement.destructive && (
          <chakra.span css={destructiveFlagCss}>{t("schemaCompareDestructiveFlag")}</chakra.span>
        )}
      </chakra.label>
      <chakra.code css={sqlCss}>{statement.sql}</chakra.code>
    </chakra.li>
  );
}

function SidePicker({
  label,
  side,
  state,
  profiles,
  onSelectProfile,
  onSelectDatabase,
  t,
}: {
  label: string;
  side: Side;
  state: SideState;
  profiles: ConnectionProfile[];
  onSelectProfile: (side: Side, profileId: string) => void;
  onSelectDatabase: (side: Side, database: string) => void;
  t: ReturnType<typeof useT>;
}) {
  return (
    <Box css={sideCss}>
      <chakra.span css={sideLabelCss}>{label}</chakra.span>
      <Select
        value={state.profileId ?? ""}
        onChange={(e) => onSelectProfile(side, e.target.value)}
      >
        <option value="">{t("schemaCompareSelectProfile")}</option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
      <Select
        value={state.database ?? ""}
        onChange={(e) => onSelectDatabase(side, e.target.value)}
        disabled={!state.databases || state.connecting}
      >
        <option value="">
          {state.connecting ? t("schemaCompareConnecting") : t("schemaCompareSelectDatabase")}
        </option>
        {(state.databases ?? []).map((db) => (
          <option key={db} value={db}>
            {db}
          </option>
        ))}
      </Select>
      {state.error && <chakra.span css={sideErrorCss}>{state.error}</chakra.span>}
    </Box>
  );
}

function StatusChip({
  status,
  count,
  t,
}: {
  status: DiffStatus;
  count: number;
  t: ReturnType<typeof useT>;
}) {
  return (
    <chakra.span css={chipCss(status)}>
      {statusLabel(status, t)}: {count}
    </chakra.span>
  );
}

function statusLabel(status: DiffStatus, t: ReturnType<typeof useT>): string {
  switch (status) {
    case "source_only":
      return t("schemaCompareStatusSourceOnly");
    case "target_only":
      return t("schemaCompareStatusTargetOnly");
    case "different":
      return t("schemaCompareStatusDifferent");
    case "same":
      return t("schemaCompareStatusSame");
  }
}

function TableDiffRow({ table, t }: { table: TableDiff; t: ReturnType<typeof useT> }) {
  const expandable = table.columns.length > 0;
  return (
    <chakra.details css={tableCss} open={table.status === "different"}>
      <chakra.summary>
        <chakra.span css={badgeCss(table.status)}>
          {statusLabel(table.status, t)}
        </chakra.span>
        <chakra.span css={tableNameCss}>{table.name}</chakra.span>
        {expandable && (
          <chakra.span css={colcountCss}>
            {t("schemaCompareColumnCount", { count: table.columns.length })}
          </chakra.span>
        )}
      </chakra.summary>
      {expandable && (
        <chakra.ul css={columnsCss}>
          {table.columns.map((col) => (
            <ColumnDiffRow key={col.name} column={col} t={t} />
          ))}
        </chakra.ul>
      )}
    </chakra.details>
  );
}

function fieldLabel(field: string, t: ReturnType<typeof useT>): string {
  switch (field) {
    case "data_type":
      return t("schemaCompareFieldDataType");
    case "nullable":
      return t("schemaCompareFieldNullable");
    case "default":
      return t("schemaCompareFieldDefault");
    case "key":
      return t("schemaCompareFieldKey");
    case "extra":
      return t("schemaCompareFieldExtra");
    case "foreign_key":
      return t("schemaCompareFieldForeignKey");
    default:
      return field;
  }
}

function fieldValue(
  col: TableColumnInfo | null,
  field: string,
  t: ReturnType<typeof useT>,
): string {
  if (!col) return "—";
  switch (field) {
    case "data_type":
      return col.data_type;
    case "nullable":
      return col.nullable ? t("schemaCompareYes") : t("schemaCompareNo");
    case "default":
      return col.default ?? "NULL";
    case "key":
      return col.key || "—";
    case "extra":
      return col.extra || "—";
    case "foreign_key":
      return col.referenced_table
        ? `${col.referenced_table}(${col.referenced_column ?? "?"})`
        : "—";
    default:
      return "—";
  }
}

function ColumnDiffRow({ column, t }: { column: ColumnDiff; t: ReturnType<typeof useT> }) {
  const def = column.source ?? column.target;
  return (
    <chakra.li css={columnCss}>
      <chakra.span css={badgeCss(column.status)}>
        {statusLabel(column.status, t)}
      </chakra.span>
      <chakra.span css={columnNameCss}>{column.name}</chakra.span>
      {column.status === "different" ? (
        <chakra.span css={changesCss}>
          {column.changed_fields.map((field) => (
            <chakra.span key={field} css={changeCss}>
              {fieldLabel(field, t)}: {fieldValue(column.source, field, t)} →{" "}
              {fieldValue(column.target, field, t)}
            </chakra.span>
          ))}
        </chakra.span>
      ) : (
        <chakra.span css={coltypeCss}>{def?.data_type ?? ""}</chakra.span>
      )}
    </chakra.li>
  );
}
