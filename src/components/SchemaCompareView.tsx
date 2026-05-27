import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  api,
  type ColumnDiff,
  type ConnectionProfile,
  type DiffStatus,
  type DriverKind,
  type SchemaDiff,
  type TableColumnInfo,
  type TableDiff,
} from "../api/tauri";
import { useT } from "../i18n";
import { Icon } from "./Icon";

type Side = "source" | "target";

function coerceDriver(driver: string): DriverKind {
  return driver === "postgres" || driver === "sqlite" ? driver : "mysql";
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
 * Phase-1 schema comparison (Issue #245): pick a source and a target
 * connection + database, then view how their schemas differ. This view opens
 * its own short-lived, read-only sessions on demand (one per distinct profile)
 * and tears them down on close, so it never disturbs the main workspace
 * connection. Generating the reconciling DDL is a later phase.
 */
export function SchemaCompareView({
  profiles,
  onClose,
}: {
  profiles: ConnectionProfile[];
  onClose: () => void;
}) {
  const t = useT();

  const [source, setSource] = useState<SideState>(EMPTY_SIDE);
  const [target, setTarget] = useState<SideState>(EMPTY_SIDE);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [diff, setDiff] = useState<SchemaDiff | null>(null);
  const [hideSame, setHideSame] = useState(true);

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
            </div>
          )}
        </>
      )}
    </div>
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
