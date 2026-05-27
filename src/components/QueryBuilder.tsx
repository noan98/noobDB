import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Box, chakra } from "@chakra-ui/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { sql as sqlLang } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { api } from "../api/tauri";
import { useT } from "../i18n";
import { codeMirrorSqlDialectFor, isSystemDatabase, quoteIdentFor } from "./sqlDialect";
import { Icon } from "./Icon";
import { Button, Checkbox, Select } from "./ui";

const qbHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syntax-keyword)", fontWeight: "bold" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--syntax-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--syntax-number)" },
  {
    tag: [tags.lineComment, tags.blockComment, tags.docComment],
    color: "var(--syntax-comment)",
    fontStyle: "italic",
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--syntax-function)",
  },
  { tag: tags.operator, color: "var(--syntax-operator)" },
]);

export type QueryKind = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

const WHERE_OPERATORS = ["=", "!=", "<", "<=", ">", ">=", "LIKE", "IN", "IS NULL", "IS NOT NULL"] as const;

export interface WhereCondition {
  column: string;
  operator: string;
  value: string;
}

function normalizeOperator(op: string): string {
  return op.trim().toUpperCase();
}

function isNullOperator(op: string): boolean {
  const n = normalizeOperator(op);
  return n === "IS NULL" || n === "IS NOT NULL";
}

export interface ColumnValuePair {
  column: string;
  value: string;
}

/**
 * Full snapshot of the builder's inputs. Lifted into the owning tab's state so
 * the most recent Run / Dry Run can be restored when the builder is reopened
 * in the same tab. Held in memory only — never persisted to disk.
 */
export interface QueryBuilderSnapshot {
  kind: QueryKind;
  database: string;
  table: string;
  selectAll: boolean;
  selectColumns: string[];
  whereConditions: WhereCondition[];
  limit: string;
  setPairs: ColumnValuePair[];
  insertPairs: ColumnValuePair[];
}

interface Props {
  sessionId: string;
  driver: string;
  defaultDatabase?: string | null;
  defaultTable?: string | null;
  initialSnapshot?: QueryBuilderSnapshot | null;
  /**
   * When true the session rejects writes, so Run is disabled for write query
   * kinds (INSERT/UPDATE/DELETE). The kind pills and Dry Run stay enabled — the
   * user can still build/copy a statement or preview it (a dry run rolls back).
   */
  readOnly?: boolean;
  onExecute: (sql: string) => void;
  onPreview?: (sql: string) => void;
  onPersist?: (snapshot: QueryBuilderSnapshot) => void;
  onClose: () => void;
}

function pickDefaultDatabase(driver: string, list: string[]): string | null {
  const user = list.find((d) => !isSystemDatabase(driver, d));
  return user ?? list[0] ?? null;
}

function quoteValue(driver: string, raw: string): string {
  const v = raw.trim();
  if (v === "") return "''";
  if (/^null$/i.test(v)) return "NULL";
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (/^(true|false)$/i.test(v)) {
    // SQLite has no native boolean literal — emit 1/0 instead of TRUE/FALSE.
    if (driver === "sqlite") return v.toLowerCase() === "true" ? "1" : "0";
    return v.toUpperCase();
  }
  return "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

function tableRef(driver: string, database: string, table: string): string {
  const tbl = table ? quoteIdentFor(driver, table) : "<table>";
  // SQLite has a single namespace per connection — no database qualifier.
  if (driver === "sqlite") return tbl;
  if (database) return `${quoteIdentFor(driver, database)}.${tbl}`;
  return tbl;
}

function renderWhereClause(driver: string, conditions: WhereCondition[]): string {
  const rendered = conditions
    .filter((c) => c.column)
    .map((c) => {
      const col = quoteIdentFor(driver, c.column);
      const opNorm = normalizeOperator(c.operator);
      if (opNorm === "IS NULL" || opNorm === "IS NOT NULL") {
        return `${col} ${opNorm}`;
      }
      if (opNorm === "IN") {
        const items = c.value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((s) => quoteValue(driver, s));
        const inner = items.length > 0 ? items.join(", ") : "<values>";
        return `${col} IN (${inner})`;
      }
      const opOut = c.operator.trim() || "=";
      return `${col} ${opOut} ${quoteValue(driver, c.value)}`;
    });
  if (rendered.length === 0) return " WHERE <column> = <value>";
  return " WHERE " + rendered.join(" AND ");
}

function buildSql(
  driver: string,
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
  const ref = tableRef(driver, database, table);
  switch (kind) {
    case "SELECT": {
      const cols = selectAll || selectColumns.length === 0
        ? "*"
        : selectColumns.map((c) => quoteIdentFor(driver, c)).join(", ");
      const where = renderWhereClause(driver, whereConditions);
      const trimmedLimit = limit.trim();
      const limitClause = trimmedLimit && /^\d+$/.test(trimmedLimit) ? ` LIMIT ${trimmedLimit}` : "";
      return `SELECT ${cols} FROM ${ref}${where}${limitClause};`;
    }
    case "UPDATE": {
      const set = setPairs
        .filter((p) => p.column)
        .map((p) => `${quoteIdentFor(driver, p.column)} = ${quoteValue(driver, p.value)}`)
        .join(", ");
      const where = renderWhereClause(driver, whereConditions);
      const setClause = set || "<column> = <value>";
      return `UPDATE ${ref} SET ${setClause}${where};`;
    }
    case "DELETE": {
      const where = renderWhereClause(driver, whereConditions);
      return `DELETE FROM ${ref}${where};`;
    }
    case "INSERT": {
      const active = insertPairs.filter((p) => p.column);
      const cols = active.length > 0
        ? active.map((p) => quoteIdentFor(driver, p.column)).join(", ")
        : "<column>";
      const vals = active.length > 0
        ? active.map((p) => quoteValue(driver, p.value)).join(", ")
        : "<value>";
      return `INSERT INTO ${ref} (${cols}) VALUES (${vals});`;
    }
  }
}

export function QueryBuilder({ sessionId, driver, defaultDatabase, defaultTable, initialSnapshot, readOnly, onExecute, onPreview, onPersist, onClose }: Props) {
  const t = useT();

  const [kind, setKind] = useState<QueryKind>(initialSnapshot?.kind ?? "SELECT");
  const [databases, setDatabases] = useState<string[]>([]);
  const [database, setDatabase] = useState<string>(initialSnapshot?.database ?? defaultDatabase ?? "");
  const [tables, setTables] = useState<string[]>([]);
  const [table, setTable] = useState<string>(initialSnapshot?.table ?? defaultTable ?? "");
  const [columns, setColumns] = useState<string[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [loadingColumns, setLoadingColumns] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectAll, setSelectAll] = useState(initialSnapshot?.selectAll ?? true);
  const [selectColumns, setSelectColumns] = useState<string[]>(initialSnapshot?.selectColumns ?? []);
  const [newSelectCol, setNewSelectCol] = useState("");
  const [whereConditions, setWhereConditions] = useState<WhereCondition[]>(
    initialSnapshot?.whereConditions ?? [{ column: "", operator: "=", value: "" }],
  );
  const [limit, setLimit] = useState(initialSnapshot?.limit ?? "100");
  const [setPairs, setSetPairs] = useState<ColumnValuePair[]>(
    initialSnapshot?.setPairs ?? [{ column: "", value: "" }],
  );
  const [insertPairs, setInsertPairs] = useState<ColumnValuePair[]>(
    initialSnapshot?.insertPairs ?? [{ column: "", value: "" }],
  );

  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.listDatabases(sessionId)
      .then((list) => {
        if (cancelled) return;
        setDatabases(list);
        if (!database) {
          const pick = pickDefaultDatabase(driver, list);
          if (pick) setDatabase(pick);
        }
      })
      .catch((e) => { if (!cancelled) setLoadError(String(e)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (!database) {
      setTables([]);
      return;
    }
    let cancelled = false;
    setLoadingTables(true);
    api.listTables(sessionId, database)
      .then((list) => {
        if (cancelled) return;
        setTables(list);
        if (!table && list.length > 0) setTable(list[0]);
      })
      .catch((e) => { if (!cancelled) setLoadError(String(e)); })
      .finally(() => { if (!cancelled) setLoadingTables(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    () => buildSql(driver, kind, database, table, selectColumns, selectAll, whereConditions, limit, setPairs, insertPairs),
    [driver, kind, database, table, selectColumns, selectAll, whereConditions, limit, setPairs, insertPairs],
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

  const captureSnapshot = useCallback((): QueryBuilderSnapshot => ({
    kind,
    database,
    table,
    selectAll,
    selectColumns: [...selectColumns],
    whereConditions: whereConditions.map((c) => ({ ...c })),
    limit,
    setPairs: setPairs.map((p) => ({ ...p })),
    insertPairs: insertPairs.map((p) => ({ ...p })),
  }), [kind, database, table, selectAll, selectColumns, whereConditions, limit, setPairs, insertPairs]);

  const handleExecute = useCallback(() => {
    onPersist?.(captureSnapshot());
    onExecute(sql);
    onClose();
  }, [sql, onExecute, onClose, onPersist, captureSnapshot]);

  const handlePreview = useCallback(() => {
    if (!onPreview) return;
    onPersist?.(captureSnapshot());
    onPreview(sql);
    onClose();
  }, [sql, onPreview, onClose, onPersist, captureSnapshot]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const addSelectColumn = (col: string) => {
    const v = col.trim();
    if (!v) return;
    setSelectColumns((prev) => (prev.includes(v) ? prev : [...prev, v]));
    setNewSelectCol("");
  };
  const removeSelectColumn = (col: string) => {
    setSelectColumns((prev) => prev.filter((c) => c !== col));
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

  // A read-only session rejects writes, so Run is disabled for write kinds.
  // SELECT still runs, and Dry Run stays available (it rolls back).
  const runBlockedByReadOnly = !!readOnly && kind !== "SELECT";

  const showWhere = kind === "SELECT" || kind === "UPDATE" || kind === "DELETE";
  const showSelectColumns = kind === "SELECT";
  const showLimit = kind === "SELECT";
  const showSet = kind === "UPDATE";
  const showInsertValues = kind === "INSERT";

  const columnOptions = columns;

  return (
    <Box className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <Box className="modal qb-modal" onClick={(e) => e.stopPropagation()}>
        <chakra.header className="modal-header">
          <chakra.h2>{t("qbTitle")}</chakra.h2>
          <chakra.button className="icon" onClick={onClose} aria-label={t("qbClose")} title={t("qbClose")}>
            <Icon name="close" size={12} />
          </chakra.button>
        </chakra.header>

        <Box className="modal-body qb-body">
          {loadError && <Box className="qb-error">{loadError}</Box>}

          <chakra.section className="qb-section">
            <Box className="qb-section-title">{t("qbQueryType")}</Box>
            <Box className="qb-pill-list">
              {(["SELECT", "INSERT", "UPDATE", "DELETE"] as QueryKind[]).map((k) => (
                <chakra.button
                  key={k}
                  type="button"
                  className={`qb-pill ${kind === k ? "active" : ""}`}
                  onClick={() => setKind(k)}
                >
                  {k}
                </chakra.button>
              ))}
            </Box>
          </chakra.section>

          <chakra.section className="qb-section qb-grid-2">
            <Box>
              <chakra.label htmlFor="qb-db">{t("qbDatabase")}</chakra.label>
              <Select
                id="qb-db"
                value={database}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v !== database) setTable("");
                  setDatabase(v);
                }}
              >
                <option value="">—</option>
                {databases.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </Select>
            </Box>
            <Box>
              <chakra.label htmlFor="qb-tbl">{t("qbTable")}</chakra.label>
              <Select
                id="qb-tbl"
                value={table}
                disabled={!database || loadingTables}
                onChange={(e) => setTable(e.target.value)}
              >
                <option value="">{loadingTables ? t("qbLoading") : "—"}</option>
                {tables.map((tname) => (
                  <option key={tname} value={tname}>{tname}</option>
                ))}
              </Select>
            </Box>
          </chakra.section>

          {showSelectColumns && (
            <chakra.section className="qb-section">
              <Box className="qb-section-title">{t("qbColumns")}</Box>
              <chakra.label className="qb-checkbox">
                <Checkbox
                  checked={selectAll}
                  onChange={(e) => setSelectAll(e.target.checked)}
                />
                <chakra.span>{t("qbAllColumns")}</chakra.span>
              </chakra.label>
              {!selectAll && (
                <>
                  <Box className="qb-row">
                    <ComboBox
                      className="qb-col-input"
                      value={newSelectCol}
                      options={columnOptions.filter((c) => !selectColumns.includes(c))}
                      placeholder={loadingColumns ? t("qbLoading") : t("qbColumn")}
                      onChange={setNewSelectCol}
                      onEnter={() => addSelectColumn(newSelectCol)}
                    />
                    <chakra.button
                      type="button"
                      className="qb-small"
                      onClick={() => addSelectColumn(newSelectCol)}
                      disabled={!newSelectCol.trim()}
                    >
                      + {t("qbAddColumn")}
                    </chakra.button>
                  </Box>
                  {selectColumns.length > 0 ? (
                    <Box className="qb-selected-cols-wrap">
                      <chakra.table className="qb-selected-cols">
                        <tbody>
                          <tr>
                            {selectColumns.map((c) => (
                              <chakra.td key={c}>
                                <chakra.span className="qb-selected-col-name">{c}</chakra.span>
                                <chakra.button
                                  type="button"
                                  className="qb-chip-remove"
                                  onClick={() => removeSelectColumn(c)}
                                  aria-label={t("qbRemove")}
                                  title={t("qbRemove")}
                                >
                                  <Icon name="close" size={12} />
                                </chakra.button>
                              </chakra.td>
                            ))}
                          </tr>
                        </tbody>
                      </chakra.table>
                    </Box>
                  ) : (
                    <chakra.span className="muted" fontSize="12px">
                      {columnOptions.length === 0 && !loadingColumns
                        ? t("qbPickTableFirst")
                        : t("qbNoSelectedColumns")}
                    </chakra.span>
                  )}
                </>
              )}
            </chakra.section>
          )}

          {showSet && (
            <chakra.section className="qb-section">
              <Box className="qb-section-row">
                <Box className="qb-section-title">{t("qbSet")}</Box>
                <chakra.button type="button" className="qb-small" onClick={() => addPair("set")}>
                  + {t("qbAddSet")}
                </chakra.button>
              </Box>
              {setPairs.map((p, i) => (
                <Box className="qb-row" key={`set-${i}`}>
                  <ColumnPicker
                    value={p.column}
                    options={columnOptions}
                    onChange={(v) => updatePair("set", i, { column: v })}
                    placeholder={t("qbColumn")}
                  />
                  <chakra.span className="qb-eq">=</chakra.span>
                  <chakra.input
                    className="qb-row-input"
                    value={p.value}
                    placeholder={t("qbValue")}
                    onChange={(e) => updatePair("set", i, { value: e.target.value })}
                  />
                  <chakra.button
                    type="button"
                    className="qb-icon-btn"
                    onClick={() => removePair("set", i)}
                    aria-label={t("qbRemove")}
                    title={t("qbRemove")}
                    disabled={setPairs.length <= 1}
                  >
                    <Icon name="close" size={12} />
                  </chakra.button>
                </Box>
              ))}
            </chakra.section>
          )}

          {showInsertValues && (
            <chakra.section className="qb-section">
              <Box className="qb-section-row">
                <Box className="qb-section-title">{t("qbInsertValues")}</Box>
                <chakra.button type="button" className="qb-small" onClick={() => addPair("insert")}>
                  + {t("qbAddValue")}
                </chakra.button>
              </Box>
              {insertPairs.map((p, i) => (
                <Box className="qb-row" key={`ins-${i}`}>
                  <ColumnPicker
                    value={p.column}
                    options={columnOptions}
                    onChange={(v) => updatePair("insert", i, { column: v })}
                    placeholder={t("qbColumn")}
                  />
                  <chakra.span className="qb-eq">=</chakra.span>
                  <chakra.input
                    className="qb-row-input"
                    value={p.value}
                    placeholder={t("qbValue")}
                    onChange={(e) => updatePair("insert", i, { value: e.target.value })}
                  />
                  <chakra.button
                    type="button"
                    className="qb-icon-btn"
                    onClick={() => removePair("insert", i)}
                    aria-label={t("qbRemove")}
                    title={t("qbRemove")}
                    disabled={insertPairs.length <= 1}
                  >
                    <Icon name="close" size={12} />
                  </chakra.button>
                </Box>
              ))}
            </chakra.section>
          )}

          {showWhere && (
            <chakra.section className="qb-section">
              <Box className="qb-section-row">
                <Box className="qb-section-title">{t("qbWhere")}</Box>
                <chakra.button type="button" className="qb-small" onClick={addCondition}>
                  + {t("qbAddCondition")}
                </chakra.button>
              </Box>
              {whereConditions.map((c, i) => (
                <Box className="qb-row" key={`w-${i}`}>
                  <ColumnPicker
                    value={c.column}
                    options={columnOptions}
                    onChange={(v) => updateCondition(i, { column: v })}
                    placeholder={t("qbColumn")}
                  />
                  <ComboBox
                    className="qb-op"
                    value={c.operator}
                    options={[...WHERE_OPERATORS]}
                    onChange={(v) => updateCondition(i, { operator: v })}
                  />
                  <chakra.input
                    className="qb-row-input"
                    value={c.value}
                    placeholder={
                      isNullOperator(c.operator)
                        ? "—"
                        : normalizeOperator(c.operator) === "IN"
                          ? t("qbValuesPlaceholder")
                          : t("qbValue")
                    }
                    disabled={isNullOperator(c.operator)}
                    onChange={(e) => updateCondition(i, { value: e.target.value })}
                  />
                  <chakra.button
                    type="button"
                    className="qb-icon-btn"
                    onClick={() => removeCondition(i)}
                    aria-label={t("qbRemove")}
                    title={t("qbRemove")}
                    disabled={whereConditions.length <= 1}
                  >
                    <Icon name="close" size={12} />
                  </chakra.button>
                </Box>
              ))}
            </chakra.section>
          )}

          {showLimit && (
            <chakra.section className="qb-section qb-limit-section">
              <chakra.label htmlFor="qb-limit">{t("qbLimit")}</chakra.label>
              <chakra.input
                id="qb-limit"
                className="qb-limit-input"
                value={limit}
                placeholder="100"
                onChange={(e) => setLimit(e.target.value)}
                inputMode="numeric"
              />
            </chakra.section>
          )}

          <chakra.section className="qb-section">
            <Box className="qb-section-title">{t("qbPreview")}</Box>
            <Box className="qb-preview-wrap">
              <chakra.button
                type="button"
                className="qb-preview-copy"
                onClick={handleCopy}
                aria-label={copied ? t("qbCopied") : t("qbCopy")}
                title={copied ? t("qbCopied") : t("qbCopy")}
              >
                {copied ? (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M3 8.5l3 3 7-7" />
                  </svg>
                ) : (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <rect x="5" y="5" width="9" height="9" rx="1.5" />
                    <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-5A1.5 1.5 0 0 0 3 3.5v5A1.5 1.5 0 0 0 4.5 10H6" />
                  </svg>
                )}
              </chakra.button>
              <SqlPreview sql={sql} driver={driver} />
            </Box>
          </chakra.section>
        </Box>

        <chakra.footer className="modal-footer">
          <Box flex={1} />
          {onPreview && kind !== "SELECT" && (
            <Button variant="warning" className="with-icon" onClick={handlePreview} title={t("editorPreviewTitle")}>
              <chakra.span className="btn-icon" aria-hidden>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1.5 8s2.5-5 6.5-5 6.5 5 6.5 5-2.5 5-6.5 5S1.5 8 1.5 8z" />
                  <circle cx="8" cy="8" r="2" />
                </svg>
              </chakra.span>
              {t("qbPreviewRun")}
            </Button>
          )}
          <Button
            variant="success"
            className="with-icon"
            onClick={handleExecute}
            disabled={runBlockedByReadOnly}
            title={runBlockedByReadOnly ? t("qbExecuteReadOnlyTitle") : undefined}
          >
            <chakra.span className="btn-icon" aria-hidden>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 3.5v9a.5.5 0 0 0 .77.42l7-4.5a.5.5 0 0 0 0-.84l-7-4.5A.5.5 0 0 0 4 3.5z" />
              </svg>
            </chakra.span>
            {t("qbExecute")}
          </Button>
        </chakra.footer>
      </Box>
    </Box>
  );
}

interface ColumnPickerProps {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  placeholder?: string;
}

function ColumnPicker({ value, options, onChange, placeholder }: ColumnPickerProps) {
  return (
    <ComboBox
      className="qb-col-input"
      value={value}
      options={options}
      placeholder={placeholder}
      onChange={onChange}
    />
  );
}

interface ComboBoxProps {
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
  onEnter?: () => void;
}

function ComboBox({
  value,
  options,
  onChange,
  placeholder,
  className,
  disabled,
  id,
  onEnter,
}: ComboBoxProps) {
  const listId = useId();
  return (
    <>
      <chakra.input
        id={id}
        className={className}
        list={listId}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  );
}

interface SqlPreviewProps {
  sql: string;
  driver: string;
}

function SqlPreview({ sql, driver }: SqlPreviewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: sql,
        extensions: [
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          syntaxHighlighting(qbHighlightStyle, { fallback: true }),
          sqlLang({ dialect: codeMirrorSqlDialectFor(driver), upperCaseKeywords: true }),
          EditorView.lineWrapping,
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driver]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === sql) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: sql } });
  }, [sql]);

  return <Box className="qb-preview" ref={hostRef} />;
}
