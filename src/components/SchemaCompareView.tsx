import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { Icon } from "./Icon";

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
 * Schema comparison + sync (Issue #245, phases 1–2): pick a source and a
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

  const [source, setSource] = useState<SideState>(EMPTY_SIDE);
  const [target, setTarget] = useState<SideState>(EMPTY_SIDE);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [diff, setDiff] = useState<SchemaDiff | null>(null);
  const [hideSame, setHideSame] = useState(true);

  // Sync (phases 2–3) state. A single plan / selection / apply path is shared
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

  // Data sync (phase 3) state.
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
    if (!window.confirm(confirmMsg)) return;
    if (
      targetProfile.is_production &&
      settings.confirmProductionConnect &&
      !window.confirm(t("schemaCompareApplyProductionConfirm", { name: targetProfile.name }))
    ) {
      return;
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
    t,
    runCompare,
    compareData,
  ]);

  const selectedCount = selected.size;

  return (
    <div className="settings schema-compare">
      <header className="settings-header">
        <h2>{t("schemaCompareTitle")}</h2>
        <button
          className="icon"
          onClick={onClose}
          aria-label={t("schemaCompareClose")}
          title={t("schemaCompareClose")}
        >
          <Icon name="close" size={13} />
        </button>
      </header>

      <p className="settings-help">{t("schemaCompareDesc")}</p>

      {profiles.length === 0 ? (
        <p className="schema-compare-empty">{t("schemaCompareNoProfiles")}</p>
      ) : (
        <>
          <div className="schema-compare-sides">
            <SidePicker
              label={t("schemaCompareSource")}
              side="source"
              state={source}
              profiles={profiles}
              onSelectProfile={selectProfile}
              onSelectDatabase={setDatabase}
              t={t}
            />
            <button
              type="button"
              className="icon schema-compare-swap"
              onClick={swap}
              title={t("schemaCompareSwap")}
              aria-label={t("schemaCompareSwap")}
            >
              <Icon name="refresh" size={14} />
            </button>
            <SidePicker
              label={t("schemaCompareTarget")}
              side="target"
              state={target}
              profiles={profiles}
              onSelectProfile={selectProfile}
              onSelectDatabase={setDatabase}
              t={t}
            />
          </div>

          {driverMismatch && (
            <p className="schema-compare-warning">{t("schemaCompareDriverMismatch")}</p>
          )}

          <div className="schema-compare-actions">
            <button className="primary" onClick={runCompare} disabled={!canCompare}>
              {comparing ? t("schemaCompareComparing") : t("schemaCompareCompare")}
            </button>
          </div>

          {compareError && <p className="schema-compare-warning">{compareError}</p>}

          {diff && (
            <div className="schema-compare-results">
              <div className="schema-compare-summary">
                <StatusChip status="different" count={counts.different} t={t} />
                <StatusChip status="source_only" count={counts.source_only} t={t} />
                <StatusChip status="target_only" count={counts.target_only} t={t} />
                <StatusChip status="same" count={counts.same} t={t} />
                <label className="schema-compare-hidesame">
                  <input
                    type="checkbox"
                    checked={hideSame}
                    onChange={(e) => setHideSame(e.target.checked)}
                  />
                  {t("schemaCompareHideSame")}
                </label>
              </div>

              {visibleTables.length === 0 ? (
                <p className="schema-compare-empty">
                  {counts.different + counts.source_only + counts.target_only === 0
                    ? t("schemaCompareIdentical")
                    : t("schemaCompareAllHidden")}
                </p>
              ) : (
                <div className="schema-compare-tables">
                  {visibleTables.map((tbl) => (
                    <TableDiffRow key={tbl.name} table={tbl} t={t} />
                  ))}
                </div>
              )}

              {hasDifferences && (
                <div className="schema-compare-sync">
                  <h3 className="schema-compare-sync-title">{t("schemaCompareSyncTitle")}</h3>
                  <p className="settings-help">{t("schemaCompareSyncDesc")}</p>
                  <div className="schema-compare-sync-controls">
                    <label className="schema-compare-destructive">
                      <input
                        type="checkbox"
                        checked={allowDestructive}
                        onChange={(e) => setAllowDestructive(e.target.checked)}
                      />
                      {t("schemaCompareAllowDestructive")}
                    </label>
                    <button onClick={generatePlan} disabled={generating}>
                      {generating ? t("schemaCompareGenerating") : t("schemaCompareGenerate")}
                    </button>
                  </div>
                </div>
              )}

              {comparableTables.length > 0 && (
                <div className="schema-compare-sync">
                  <h3 className="schema-compare-sync-title">{t("schemaCompareDataTitle")}</h3>
                  <p className="settings-help">{t("schemaCompareDataDesc")}</p>
                  <div className="schema-compare-sync-controls">
                    <select value={dataTable} onChange={(e) => setDataTable(e.target.value)}>
                      <option value="">{t("schemaCompareDataSelectTable")}</option>
                      {comparableTables.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    <label className="schema-compare-limit">
                      {t("schemaCompareDataLimit")}
                      <input
                        type="number"
                        min={1}
                        max={5000}
                        value={dataLimit}
                        onChange={(e) =>
                          setDataLimit(Math.max(1, Math.min(5000, Number(e.target.value) || 1)))
                        }
                      />
                    </label>
                    <button onClick={compareData} disabled={!dataTable || dataComparing}>
                      {dataComparing ? t("schemaCompareComparing") : t("schemaCompareDataCompare")}
                    </button>
                  </div>

                  {dataDiff && (
                    <>
                      <div className="schema-compare-summary">
                        <span className="schema-compare-chip status-source_only">
                          {t("schemaCompareDataInserts")}: {dataCounts.source_only}
                        </span>
                        <span className="schema-compare-chip status-different">
                          {t("schemaCompareDataUpdates")}: {dataCounts.different}
                        </span>
                        <span className="schema-compare-chip status-target_only">
                          {t("schemaCompareDataDeletes")}: {dataCounts.target_only}
                        </span>
                      </div>
                      {dataDiff.truncated && (
                        <p className="schema-compare-backup">
                          {t("schemaCompareDataTruncated", { limit: dataLimit })}
                        </p>
                      )}
                      <div className="schema-compare-sync-controls">
                        <label className="schema-compare-destructive">
                          <input
                            type="checkbox"
                            checked={allowDelete}
                            onChange={(e) => setAllowDelete(e.target.checked)}
                          />
                          {t("schemaCompareAllowDelete")}
                        </label>
                        <button onClick={generateDataPlan} disabled={generating}>
                          {generating ? t("schemaCompareGenerating") : t("schemaCompareDataGenerate")}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {syncError && <p className="schema-compare-warning">{syncError}</p>}
              {applyResult && <p className="schema-compare-success">{applyResult}</p>}

              {plan && (
                <div className="schema-compare-plan">
                  {plan.statements.length === 0 ? (
                    <p className="schema-compare-empty">{t("schemaCompareNoStatements")}</p>
                  ) : (
                    <>
                      <ul className="schema-compare-statements">
                        {plan.statements.map((stmt, i) => (
                          <SyncStatementRow
                            key={`${stmt.table}-${i}`}
                            statement={stmt}
                            checked={selected.has(i)}
                            onToggle={() => toggleStatement(i)}
                            t={t}
                          />
                        ))}
                      </ul>
                      <p className="schema-compare-backup">{t("schemaCompareBackupNote")}</p>
                      <div className="schema-compare-actions">
                        <button
                          className="primary"
                          onClick={applyPlan}
                          disabled={applying || selectedCount === 0}
                        >
                          {applying
                            ? t("schemaCompareApplying")
                            : t("schemaCompareApply", { count: selectedCount })}
                        </button>
                      </div>
                    </>
                  )}
                  {plan.warnings.length > 0 && (
                    <ul className="schema-compare-plan-warnings">
                      {plan.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
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
    <li className={`schema-compare-statement ${statement.destructive ? "destructive" : ""}`}>
      <label className="schema-compare-statement-head">
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span className={`schema-compare-kind kind-${statement.kind}`}>
          {syncKindLabel(statement.kind, t)}
        </span>
        {statement.destructive && (
          <span className="schema-compare-destructive-flag">{t("schemaCompareDestructiveFlag")}</span>
        )}
      </label>
      <code className="schema-compare-sql">{statement.sql}</code>
    </li>
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
    <div className="schema-compare-side">
      <span className="schema-compare-side-label">{label}</span>
      <select
        value={state.profileId ?? ""}
        onChange={(e) => onSelectProfile(side, e.target.value)}
      >
        <option value="">{t("schemaCompareSelectProfile")}</option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <select
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
      </select>
      {state.error && <span className="schema-compare-side-error">{state.error}</span>}
    </div>
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
    <span className={`schema-compare-chip status-${status}`}>
      {statusLabel(status, t)}: {count}
    </span>
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
    <details className="schema-compare-table" open={table.status === "different"}>
      <summary>
        <span className={`schema-compare-badge status-${table.status}`}>
          {statusLabel(table.status, t)}
        </span>
        <span className="schema-compare-table-name">{table.name}</span>
        {expandable && (
          <span className="schema-compare-colcount">
            {t("schemaCompareColumnCount", { count: table.columns.length })}
          </span>
        )}
      </summary>
      {expandable && (
        <ul className="schema-compare-columns">
          {table.columns.map((col) => (
            <ColumnDiffRow key={col.name} column={col} t={t} />
          ))}
        </ul>
      )}
    </details>
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
    <li className={`schema-compare-column status-${column.status}`}>
      <span className={`schema-compare-badge status-${column.status}`}>
        {statusLabel(column.status, t)}
      </span>
      <span className="schema-compare-column-name">{column.name}</span>
      {column.status === "different" ? (
        <span className="schema-compare-changes">
          {column.changed_fields.map((field) => (
            <span key={field} className="schema-compare-change">
              {fieldLabel(field, t)}: {fieldValue(column.source, field, t)} →{" "}
              {fieldValue(column.target, field, t)}
            </span>
          ))}
        </span>
      ) : (
        <span className="schema-compare-coltype">{def?.data_type ?? ""}</span>
      )}
    </li>
  );
}
