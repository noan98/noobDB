import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/tauri";
import { useT } from "../i18n";

export type QueryKind = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

const WHERE_OPERATORS = ["=", "!=", "<", "<=", ">", ">=", "LIKE", "IN", "IS NULL", "IS NOT NULL"] as const;
type WhereOperator = (typeof WHERE_OPERATORS)[number];

interface WhereCondition {
  column: string;
  operator: WhereOperator;
  value: string;
}

interface ColumnValuePair {
  column: string;
  value: string;
}

interface Props {
  sessionId: string;
  defaultDatabase?: string | null;
  defaultTable?: string | null;
  onExecute: (sql: string) => void;
  onClose: () => void;
}

function quoteIdent(name: string): string {
  if (!name) return "";
  return "`" + name.replace(/`/g, "``") + "`";
}

function quoteValue(raw: string): string {
  const v = raw.trim();
  if (v === "") return "''";
  if (/^null$/i.test(v)) return "NULL";
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (/^(true|false)$/i.test(v)) return v.toUpperCase();
  return "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

function tableRef(database: string, table: string): string {
  const tbl = table ? quoteIdent(table) : "<table>";
  if (database) return `${quoteIdent(database)}.${tbl}`;
  return tbl;
}

function renderWhereClause(conditions: WhereCondition[]): string {
  const rendered = conditions
    .filter((c) => c.column)
    .map((c) => {
      const col = quoteIdent(c.column);
      if (c.operator === "IS NULL" || c.operator === "IS NOT NULL") {
        return `${col} ${c.operator}`;
      }
      if (c.operator === "IN") {
        const items = c.value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map(quoteValue);
        const inner = items.length > 0 ? items.join(", ") : "<values>";
        return `${col} IN (${inner})`;
      }
      return `${col} ${c.operator} ${quoteValue(c.value)}`;
    });
  if (rendered.length === 0) return " WHERE <column> = <value>";
  return " WHERE " + rendered.join(" AND ");
}

function buildSql(
  kind: QueryKind,
  database: string,
  table: string,
  selectColumns: string[],
  selectAll: boolean,
  whereConditions: WhereCondition[],
  limit: string,
  setPairs: ColumnValuePair[],
  insertPairs: ColumnValuePair[],
): string {
  const ref = tableRef(database, table);
  switch (kind) {
    case "SELECT": {
      const cols = selectAll || selectColumns.length === 0
        ? "*"
        : selectColumns.map(quoteIdent).join(", ");
      const where = renderWhereClause(whereConditions);
      const trimmedLimit = limit.trim();
      const limitClause = trimmedLimit && /^\d+$/.test(trimmedLimit) ? ` LIMIT ${trimmedLimit}` : "";
      return `SELECT ${cols} FROM ${ref}${where}${limitClause};`;
    }
    case "UPDATE": {
      const set = setPairs
        .filter((p) => p.column)
        .map((p) => `${quoteIdent(p.column)} = ${quoteValue(p.value)}`)
        .join(", ");
      const where = renderWhereClause(whereConditions);
      const setClause = set || "<column> = <value>";
      return `UPDATE ${ref} SET ${setClause}${where};`;
    }
    case "DELETE": {
      const where = renderWhereClause(whereConditions);
      return `DELETE FROM ${ref}${where};`;
    }
    case "INSERT": {
      const active = insertPairs.filter((p) => p.column);
      const cols = active.length > 0
        ? active.map((p) => quoteIdent(p.column)).join(", ")
        : "<column>";
      const vals = active.length > 0
        ? active.map((p) => quoteValue(p.value)).join(", ")
        : "<value>";
      return `INSERT INTO ${ref} (${cols}) VALUES (${vals});`;
    }
  }
}

export function QueryBuilder({ sessionId, defaultDatabase, defaultTable, onExecute, onClose }: Props) {
  const t = useT();

  const [kind, setKind] = useState<QueryKind>("SELECT");
  const [databases, setDatabases] = useState<string[]>([]);
  const [database, setDatabase] = useState<string>(defaultDatabase ?? "");
  const [tables, setTables] = useState<string[]>([]);
  const [table, setTable] = useState<string>(defaultTable ?? "");
  const [columns, setColumns] = useState<string[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [loadingColumns, setLoadingColumns] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectAll, setSelectAll] = useState(true);
  const [selectColumns, setSelectColumns] = useState<string[]>([]);
  const [whereConditions, setWhereConditions] = useState<WhereCondition[]>([
    { column: "", operator: "=", value: "" },
  ]);
  const [limit, setLimit] = useState("100");
  const [setPairs, setSetPairs] = useState<ColumnValuePair[]>([{ column: "", value: "" }]);
  const [insertPairs, setInsertPairs] = useState<ColumnValuePair[]>([{ column: "", value: "" }]);

  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.listDatabases(sessionId)
      .then((list) => { if (!cancelled) setDatabases(list); })
      .catch((e) => { if (!cancelled) setLoadError(String(e)); });
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    if (!database) {
      setTables([]);
      return;
    }
    let cancelled = false;
    setLoadingTables(true);
    api.listTables(sessionId, database)
      .then((list) => { if (!cancelled) setTables(list); })
      .catch((e) => { if (!cancelled) setLoadError(String(e)); })
      .finally(() => { if (!cancelled) setLoadingTables(false); });
    return () => { cancelled = true; };
  }, [sessionId, database]);

  useEffect(() => {
    if (!database || !table) {
      setColumns([]);
      return;
    }
    let cancelled = false;
    setLoadingColumns(true);
    api.describeTable(sessionId, database, table)
      .then((cols) => { if (!cancelled) setColumns(cols.map((c) => c.name)); })
      .catch((e) => { if (!cancelled) setLoadError(String(e)); })
      .finally(() => { if (!cancelled) setLoadingColumns(false); });
    return () => { cancelled = true; };
  }, [sessionId, database, table]);

  const sql = useMemo(
    () => buildSql(kind, database, table, selectColumns, selectAll, whereConditions, limit, setPairs, insertPairs),
    [kind, database, table, selectColumns, selectAll, whereConditions, limit, setPairs, insertPairs],
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = sql;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [sql]);

  const handleExecute = useCallback(() => {
    onExecute(sql);
    onClose();
  }, [sql, onExecute, onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const toggleSelectColumn = (col: string) => {
    setSelectColumns((prev) =>
      prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col],
    );
  };

  const updateCondition = (idx: number, patch: Partial<WhereCondition>) => {
    setWhereConditions((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };
  const addCondition = () =>
    setWhereConditions((prev) => [...prev, { column: "", operator: "=", value: "" }]);
  const removeCondition = (idx: number) =>
    setWhereConditions((prev) => prev.filter((_, i) => i !== idx));

  const updatePair = (which: "set" | "insert", idx: number, patch: Partial<ColumnValuePair>) => {
    const apply = (prev: ColumnValuePair[]) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p));
    if (which === "set") setSetPairs(apply);
    else setInsertPairs(apply);
  };
  const addPair = (which: "set" | "insert") => {
    if (which === "set") setSetPairs((p) => [...p, { column: "", value: "" }]);
    else setInsertPairs((p) => [...p, { column: "", value: "" }]);
  };
  const removePair = (which: "set" | "insert", idx: number) => {
    if (which === "set") setSetPairs((p) => p.filter((_, i) => i !== idx));
    else setInsertPairs((p) => p.filter((_, i) => i !== idx));
  };

  const showWhere = kind === "SELECT" || kind === "UPDATE" || kind === "DELETE";
  const showSelectColumns = kind === "SELECT";
  const showLimit = kind === "SELECT";
  const showSet = kind === "UPDATE";
  const showInsertValues = kind === "INSERT";

  const columnOptions = columns;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal qb-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>{t("qbTitle")}</h2>
          <button className="icon" onClick={onClose} aria-label={t("qbClose")} title={t("qbClose")}>
            ✕
          </button>
        </header>

        <div className="modal-body qb-body">
          {loadError && <div className="qb-error">{loadError}</div>}

          <section className="qb-section">
            <div className="qb-section-title">{t("qbQueryType")}</div>
            <div className="qb-pill-list">
              {(["SELECT", "INSERT", "UPDATE", "DELETE"] as QueryKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`qb-pill ${kind === k ? "active" : ""}`}
                  onClick={() => setKind(k)}
                >
                  {k}
                </button>
              ))}
            </div>
          </section>

          <section className="qb-section qb-grid-2">
            <div>
              <label htmlFor="qb-db">{t("qbDatabase")}</label>
              <select
                id="qb-db"
                value={database}
                onChange={(e) => { setDatabase(e.target.value); setTable(""); }}
              >
                <option value="">—</option>
                {databases.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="qb-tbl">{t("qbTable")}</label>
              <select
                id="qb-tbl"
                value={table}
                onChange={(e) => setTable(e.target.value)}
                disabled={!database || loadingTables}
              >
                <option value="">{loadingTables ? t("qbLoading") : "—"}</option>
                {tables.map((tname) => <option key={tname} value={tname}>{tname}</option>)}
              </select>
            </div>
          </section>

          {showSelectColumns && (
            <section className="qb-section">
              <div className="qb-section-title">{t("qbColumns")}</div>
              <label className="qb-checkbox">
                <input
                  type="checkbox"
                  checked={selectAll}
                  onChange={(e) => setSelectAll(e.target.checked)}
                />
                <span>{t("qbAllColumns")}</span>
              </label>
              {!selectAll && (
                <div className="qb-pill-list">
                  {columnOptions.length === 0 ? (
                    <span className="muted" style={{ fontSize: 12 }}>
                      {loadingColumns ? t("qbLoading") : t("qbPickTableFirst")}
                    </span>
                  ) : columnOptions.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`qb-pill ${selectColumns.includes(c) ? "active" : ""}`}
                      onClick={() => toggleSelectColumn(c)}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {showSet && (
            <section className="qb-section">
              <div className="qb-section-row">
                <div className="qb-section-title">{t("qbSet")}</div>
                <button type="button" className="qb-small" onClick={() => addPair("set")}>
                  + {t("qbAddSet")}
                </button>
              </div>
              {setPairs.map((p, i) => (
                <div className="qb-row" key={`set-${i}`}>
                  <ColumnPicker
                    value={p.column}
                    options={columnOptions}
                    onChange={(v) => updatePair("set", i, { column: v })}
                    placeholder={t("qbColumn")}
                  />
                  <span className="qb-eq">=</span>
                  <input
                    className="qb-row-input"
                    value={p.value}
                    placeholder={t("qbValue")}
                    onChange={(e) => updatePair("set", i, { value: e.target.value })}
                  />
                  <button
                    type="button"
                    className="qb-icon-btn"
                    onClick={() => removePair("set", i)}
                    aria-label={t("qbRemove")}
                    title={t("qbRemove")}
                    disabled={setPairs.length <= 1}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </section>
          )}

          {showInsertValues && (
            <section className="qb-section">
              <div className="qb-section-row">
                <div className="qb-section-title">{t("qbInsertValues")}</div>
                <button type="button" className="qb-small" onClick={() => addPair("insert")}>
                  + {t("qbAddValue")}
                </button>
              </div>
              {insertPairs.map((p, i) => (
                <div className="qb-row" key={`ins-${i}`}>
                  <ColumnPicker
                    value={p.column}
                    options={columnOptions}
                    onChange={(v) => updatePair("insert", i, { column: v })}
                    placeholder={t("qbColumn")}
                  />
                  <span className="qb-eq">=</span>
                  <input
                    className="qb-row-input"
                    value={p.value}
                    placeholder={t("qbValue")}
                    onChange={(e) => updatePair("insert", i, { value: e.target.value })}
                  />
                  <button
                    type="button"
                    className="qb-icon-btn"
                    onClick={() => removePair("insert", i)}
                    aria-label={t("qbRemove")}
                    title={t("qbRemove")}
                    disabled={insertPairs.length <= 1}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </section>
          )}

          {showWhere && (
            <section className="qb-section">
              <div className="qb-section-row">
                <div className="qb-section-title">{t("qbWhere")}</div>
                <button type="button" className="qb-small" onClick={addCondition}>
                  + {t("qbAddCondition")}
                </button>
              </div>
              {whereConditions.map((c, i) => (
                <div className="qb-row" key={`w-${i}`}>
                  <ColumnPicker
                    value={c.column}
                    options={columnOptions}
                    onChange={(v) => updateCondition(i, { column: v })}
                    placeholder={t("qbColumn")}
                  />
                  <select
                    className="qb-op"
                    value={c.operator}
                    onChange={(e) => updateCondition(i, { operator: e.target.value as WhereOperator })}
                  >
                    {WHERE_OPERATORS.map((op) => (
                      <option key={op} value={op}>{op}</option>
                    ))}
                  </select>
                  <input
                    className="qb-row-input"
                    value={c.value}
                    placeholder={
                      c.operator === "IS NULL" || c.operator === "IS NOT NULL"
                        ? "—"
                        : c.operator === "IN"
                          ? t("qbValuesPlaceholder")
                          : t("qbValue")
                    }
                    disabled={c.operator === "IS NULL" || c.operator === "IS NOT NULL"}
                    onChange={(e) => updateCondition(i, { value: e.target.value })}
                  />
                  <button
                    type="button"
                    className="qb-icon-btn"
                    onClick={() => removeCondition(i)}
                    aria-label={t("qbRemove")}
                    title={t("qbRemove")}
                    disabled={whereConditions.length <= 1}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </section>
          )}

          {showLimit && (
            <section className="qb-section qb-limit-section">
              <label htmlFor="qb-limit">{t("qbLimit")}</label>
              <input
                id="qb-limit"
                className="qb-limit-input"
                value={limit}
                placeholder="100"
                onChange={(e) => setLimit(e.target.value)}
                inputMode="numeric"
              />
            </section>
          )}

          <section className="qb-section">
            <div className="qb-section-title">{t("qbPreview")}</div>
            <pre className="qb-preview">{sql}</pre>
          </section>
        </div>

        <footer className="modal-footer">
          <button onClick={onClose}>{t("qbClose")}</button>
          <div style={{ flex: 1 }} />
          <button onClick={handleCopy}>{copied ? t("qbCopied") : t("qbCopy")}</button>
          <button className="primary" onClick={handleExecute}>{t("qbExecute")}</button>
        </footer>
      </div>
    </div>
  );
}

interface ColumnPickerProps {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  placeholder?: string;
}

function ColumnPicker({ value, options, onChange, placeholder }: ColumnPickerProps) {
  const listId = useMemo(() => `qb-cols-${Math.random().toString(36).slice(2, 9)}`, []);
  return (
    <>
      <input
        className="qb-col-input"
        value={value}
        list={listId}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {options.map((c) => <option key={c} value={c} />)}
      </datalist>
    </>
  );
}
