import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { sql as sqlLang, MySQL } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { api } from "../api/tauri";
import { useT } from "../i18n";

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

interface WhereCondition {
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

interface ColumnValuePair {
  column: string;
  value: string;
}

interface Props {
  sessionId: string;
  defaultDatabase?: string | null;
  defaultTable?: string | null;
  onExecute: (sql: string) => void;
  onPreview?: (sql: string) => void;
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
      const opNorm = normalizeOperator(c.operator);
      if (opNorm === "IS NULL" || opNorm === "IS NOT NULL") {
        return `${col} ${opNorm}`;
      }
      if (opNorm === "IN") {
        const items = c.value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map(quoteValue);
        const inner = items.length > 0 ? items.join(", ") : "<values>";
        return `${col} IN (${inner})`;
      }
      const opOut = c.operator.trim() || "=";
      return `${col} ${opOut} ${quoteValue(c.value)}`;
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

export function QueryBuilder({ sessionId, defaultDatabase, defaultTable, onExecute, onPreview, onClose }: Props) {
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
  const [newSelectCol, setNewSelectCol] = useState("");
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

  const handlePreview = useCallback(() => {
    if (!onPreview) return;
    onPreview(sql);
    onClose();
  }, [sql, onPreview, onClose]);

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
              <ComboBox
                id="qb-db"
                value={database}
                options={databases}
                placeholder="—"
                onChange={(v) => {
                  if (v !== database) setTable("");
                  setDatabase(v);
                }}
              />
            </div>
            <div>
              <label htmlFor="qb-tbl">{t("qbTable")}</label>
              <ComboBox
                id="qb-tbl"
                value={table}
                options={tables}
                placeholder={loadingTables ? t("qbLoading") : "—"}
                disabled={!database || loadingTables}
                onChange={setTable}
              />
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
                <>
                  <div className="qb-row">
                    <ComboBox
                      className="qb-col-input"
                      value={newSelectCol}
                      options={columnOptions.filter((c) => !selectColumns.includes(c))}
                      placeholder={loadingColumns ? t("qbLoading") : t("qbColumn")}
                      onChange={setNewSelectCol}
                      onEnter={() => addSelectColumn(newSelectCol)}
                    />
                    <button
                      type="button"
                      className="qb-small"
                      onClick={() => addSelectColumn(newSelectCol)}
                      disabled={!newSelectCol.trim()}
                    >
                      + {t("qbAddColumn")}
                    </button>
                  </div>
                  {selectColumns.length > 0 ? (
                    <div className="qb-selected-cols-wrap">
                      <table className="qb-selected-cols">
                        <tbody>
                          <tr>
                            {selectColumns.map((c) => (
                              <td key={c}>
                                <span className="qb-selected-col-name">{c}</span>
                                <button
                                  type="button"
                                  className="qb-chip-remove"
                                  onClick={() => removeSelectColumn(c)}
                                  aria-label={t("qbRemove")}
                                  title={t("qbRemove")}
                                >
                                  ✕
                                </button>
                              </td>
                            ))}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <span className="muted" style={{ fontSize: 12 }}>
                      {columnOptions.length === 0 && !loadingColumns
                        ? t("qbPickTableFirst")
                        : t("qbNoSelectedColumns")}
                    </span>
                  )}
                </>
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
                  <ComboBox
                    className="qb-op"
                    value={c.operator}
                    options={[...WHERE_OPERATORS]}
                    onChange={(v) => updateCondition(i, { operator: v })}
                  />
                  <input
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
            <div className="qb-preview-wrap">
              <button
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
              </button>
              <SqlPreview sql={sql} />
            </div>
          </section>
        </div>

        <footer className="modal-footer">
          <button onClick={onClose}>{t("qbClose")}</button>
          <div style={{ flex: 1 }} />
          {onPreview && kind !== "SELECT" && (
            <button onClick={handlePreview} title={t("editorPreviewTitle")}>
              {t("qbPreviewRun")}
            </button>
          )}
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
      <input
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
}

function SqlPreview({ sql }: SqlPreviewProps) {
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
          sqlLang({ dialect: MySQL, upperCaseKeywords: true }),
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
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === sql) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: sql } });
  }, [sql]);

  return <div className="qb-preview" ref={hostRef} />;
}
