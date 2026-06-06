import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Box, chakra, type SystemStyleObject } from "@chakra-ui/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { sql as sqlLang } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { api } from "../api/tauri";
import { useT } from "../i18n";
import { codeMirrorSqlDialectFor, isSystemDatabase, quoteIdentFor } from "./sqlDialect";
import { copyToClipboard } from "./clipboard";
import { Icon } from "./Icon";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Checkbox, Select } from "./ui";

/**
 * Query Builder のフォーム部のスタイル。以前は `.qb-*` の className + 子孫セレクタで
 * `App.css` 〜コンポーネント内 `css` を当てていたが、className を撤去して各要素へ
 * 直接 `css` を適用する形へ移行した。SQL プレビューの CodeMirror 周りのレイアウト
 * (`.cm-*`) だけは CodeMirror が生成する DOM を対象にするため、`previewCss` 内で
 * タグ/要素スコープのセレクタとして残す (CodeMirror 本体のテーマは対象外)。
 */
const errorCss: SystemStyleObject = {
  padding: "8px 10px",
  border: "1px solid var(--border)",
  background: "var(--bg-error)",
  color: "var(--text-error)",
  borderRadius: "var(--radius-md)",
  fontSize: "var(--text-sm)",
  marginBottom: "10px",
};
const sectionCss: SystemStyleObject = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
  marginBottom: "10px",
};
const sectionTitleCss: SystemStyleObject = {
  fontSize: "var(--text-xs)",
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--text-muted)",
};
const sectionRowCss: SystemStyleObject = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-2)",
};
// `qb-section` + `qb-grid-2` の合成 (grid が flex を上書きする)。
const grid2SectionCss: SystemStyleObject = {
  marginBottom: "10px",
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "var(--space-3)",
};
const grid2ChildCss: SystemStyleObject = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
};
const pillListCss: SystemStyleObject = { display: "flex", flexWrap: "wrap", gap: "var(--space-1)" };
/** クエリ種別ピル (旧 `.qb-pill`)。選択中はアクセント色。 */
function pillCss(active: boolean): SystemStyleObject {
  const base: SystemStyleObject = {
    padding: "4px 10px",
    border: "1px solid var(--border-strong)",
    background: "var(--bg-elevated)",
    color: "var(--text)",
    borderRadius: "var(--radius-pill)",
    fontSize: "var(--text-sm)",
    cursor: "pointer",
    transition: "background 0.12s, border-color 0.12s",
    _hover: { background: "var(--bg-hover)" },
  };
  if (active) {
    return { ...base, background: "var(--accent)", color: "var(--accent-text)", borderColor: "var(--accent)" };
  }
  return base;
}
const checkboxLabelCss: SystemStyleObject = {
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  fontSize: "var(--text-md)",
  fontWeight: 500,
  color: "var(--text)",
  margin: 0,
};
const rowCss: SystemStyleObject = { display: "flex", gap: "6px", alignItems: "center" };
// 行内の入力 (旧 `.qb-row-input` / `.qb-col-input`) は伸縮させる。
const rowInputCss: SystemStyleObject = { flex: 1, minWidth: 0 };
const opCss: SystemStyleObject = { width: "110px", flexShrink: 0 };
const eqCss: SystemStyleObject = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--text-muted)",
  fontWeight: 600,
  minWidth: "16px",
};
const iconBtnCss: SystemStyleObject = {
  padding: "2px 8px",
  fontSize: "var(--text-sm)",
  border: "1px solid var(--border-strong)",
  background: "var(--bg-elevated)",
  color: "var(--text-muted)",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  flexShrink: 0,
  "&:hover:not(:disabled)": {
    color: "var(--text-error)",
    borderColor: "var(--text-error)",
  },
};
const selectedColsWrapCss: SystemStyleObject = {
  overflowX: "auto",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  background: "var(--bg-muted)",
};
// 属性テーブルのみ `td` をタグセレクタで括る (className ではなく要素スコープ)。
const selectedColsCss: SystemStyleObject = {
  borderCollapse: "collapse",
  width: "max-content",
  minWidth: "100%",
  "& td": {
    padding: "4px 6px 4px 10px",
    borderRight: "1px solid var(--border)",
    fontSize: "var(--text-sm)",
    color: "var(--text)",
    whiteSpace: "nowrap",
    verticalAlign: "middle",
  },
  "& td:last-child": { borderRight: "none" },
};
const selectedColNameCss: SystemStyleObject = { marginRight: "6px" };
const chipRemoveCss: SystemStyleObject = {
  padding: "0 6px",
  fontSize: "var(--text-xs)",
  lineHeight: 1.4,
  border: "1px solid transparent",
  background: "transparent",
  color: "var(--text-muted)",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  _hover: { color: "var(--text-error)", borderColor: "var(--text-error)" },
};
const smallBtnCss: SystemStyleObject = {
  padding: "3px 10px",
  fontSize: "var(--text-xs)",
  borderRadius: "var(--radius-sm)",
};
// `qb-section` + `qb-limit-section` の合成。
const limitSectionCss: SystemStyleObject = {
  marginBottom: "10px",
  display: "grid",
  gridTemplateColumns: "80px 1fr",
  alignItems: "center",
  gap: "var(--space-3)",
};
const limitInputCss: SystemStyleObject = { maxWidth: "120px" };
const previewWrapCss: SystemStyleObject = { position: "relative" };
const previewCopyCss: SystemStyleObject = {
  position: "absolute",
  top: "6px",
  right: "6px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "26px",
  height: "26px",
  padding: 0,
  border: "1px solid var(--border-strong)",
  background: "var(--bg-elevated)",
  color: "var(--text-muted)",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  zIndex: 1,
  transition: "color 0.12s, border-color 0.12s, background 0.12s",
  _hover: { color: "var(--text)", background: "var(--bg-hover)" },
  _focusVisible: {
    outline: "none",
    borderColor: "var(--accent)",
    boxShadow: "0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent)",
  },
};
const previewCss: SystemStyleObject = {
  margin: 0,
  background: "var(--bg-muted)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  overflow: "hidden",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  color: "var(--text)",
  lineHeight: 1.5,
  "& .cm-editor": {
    background: "transparent",
    fontFamily: "inherit",
    fontSize: "inherit",
    color: "inherit",
    lineHeight: "inherit",
  },
  "& .cm-editor.cm-focused": { outline: "none" },
  "& .cm-scroller": { fontFamily: "inherit", overflow: "auto" },
  "& .cm-content": { padding: "10px 40px 10px 12px" },
  "& .cm-line": { padding: 0 },
};

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
  whereEnabled: boolean;
  whereConditions: WhereCondition[];
  limitEnabled: boolean;
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
  whereEnabled: boolean,
  whereConditions: WhereCondition[],
  limitEnabled: boolean,
  limit: string,
  setPairs: ColumnValuePair[],
  insertPairs: ColumnValuePair[],
): string {
  const ref = tableRef(driver, database, table);
  const where = whereEnabled ? renderWhereClause(driver, whereConditions) : "";
  switch (kind) {
    case "SELECT": {
      const cols = selectAll || selectColumns.length === 0
        ? "*"
        : selectColumns.map((c) => quoteIdentFor(driver, c)).join(", ");
      const trimmedLimit = limit.trim();
      const limitClause = limitEnabled && trimmedLimit && /^\d+$/.test(trimmedLimit) ? ` LIMIT ${trimmedLimit}` : "";
      return `SELECT ${cols} FROM ${ref}${where}${limitClause};`;
    }
    case "UPDATE": {
      const set = setPairs
        .filter((p) => p.column)
        .map((p) => `${quoteIdentFor(driver, p.column)} = ${quoteValue(driver, p.value)}`)
        .join(", ");
      const setClause = set || "<column> = <value>";
      return `UPDATE ${ref} SET ${setClause}${where};`;
    }
    case "DELETE": {
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
  const [whereEnabled, setWhereEnabled] = useState(initialSnapshot?.whereEnabled ?? true);
  const [whereConditions, setWhereConditions] = useState<WhereCondition[]>(
    initialSnapshot?.whereConditions ?? [{ column: "", operator: "=", value: "" }],
  );
  const [limitEnabled, setLimitEnabled] = useState(initialSnapshot?.limitEnabled ?? true);
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
    () => buildSql(driver, kind, database, table, selectColumns, selectAll, whereEnabled, whereConditions, limitEnabled, limit, setPairs, insertPairs),
    [driver, kind, database, table, selectColumns, selectAll, whereEnabled, whereConditions, limitEnabled, limit, setPairs, insertPairs],
  );

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(sql);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [sql]);

  const captureSnapshot = useCallback((): QueryBuilderSnapshot => ({
    kind,
    database,
    table,
    selectAll,
    selectColumns: [...selectColumns],
    whereEnabled,
    whereConditions: whereConditions.map((c) => ({ ...c })),
    limitEnabled,
    limit,
    setPairs: setPairs.map((p) => ({ ...p })),
    insertPairs: insertPairs.map((p) => ({ ...p })),
  }), [kind, database, table, selectAll, selectColumns, whereEnabled, whereConditions, limitEnabled, limit, setPairs, insertPairs]);

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
    <Modal onClose={onClose}>
      <ModalHeader onClose={onClose} closeLabel={t("qbClose")}>
        {t("qbTitle")}
      </ModalHeader>
      <ModalBody>
        <Box display="flex" flexDirection="column" gap="6px">
          {loadError && <Box css={errorCss}>{loadError}</Box>}

          <chakra.section css={sectionCss}>
            <Box css={sectionTitleCss}>{t("qbQueryType")}</Box>
            <Box css={pillListCss}>
              {(["SELECT", "INSERT", "UPDATE", "DELETE"] as QueryKind[]).map((k) => (
                <chakra.button
                  key={k}
                  type="button"
                  css={pillCss(kind === k)}
                  onClick={() => setKind(k)}
                >
                  {k}
                </chakra.button>
              ))}
            </Box>
          </chakra.section>

          <chakra.section css={grid2SectionCss}>
            <Box css={grid2ChildCss}>
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
            <Box css={grid2ChildCss}>
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
            <chakra.section css={sectionCss}>
              <Box css={sectionTitleCss}>{t("qbColumns")}</Box>
              <chakra.label css={checkboxLabelCss}>
                <Checkbox
                  checked={selectAll}
                  w="auto"
                  m={0}
                  onChange={(e) => setSelectAll(e.target.checked)}
                />
                <chakra.span>{t("qbAllColumns")}</chakra.span>
              </chakra.label>
              {!selectAll && (
                <>
                  <Box css={rowCss}>
                    <ComboBox
                      css={rowInputCss}
                      value={newSelectCol}
                      options={columnOptions.filter((c) => !selectColumns.includes(c))}
                      placeholder={loadingColumns ? t("qbLoading") : t("qbColumn")}
                      onChange={setNewSelectCol}
                      onEnter={() => addSelectColumn(newSelectCol)}
                    />
                    <chakra.button
                      type="button"
                      css={smallBtnCss}
                      onClick={() => addSelectColumn(newSelectCol)}
                      disabled={!newSelectCol.trim()}
                    >
                      + {t("qbAddColumn")}
                    </chakra.button>
                  </Box>
                  {selectColumns.length > 0 ? (
                    <Box css={selectedColsWrapCss}>
                      <chakra.table css={selectedColsCss}>
                        <tbody>
                          <tr>
                            {selectColumns.map((c) => (
                              <chakra.td key={c}>
                                <chakra.span css={selectedColNameCss}>{c}</chakra.span>
                                <chakra.button
                                  type="button"
                                  css={chipRemoveCss}
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
                    <chakra.span color="app.textMuted" fontSize="12px">
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
            <chakra.section css={sectionCss}>
              <Box css={sectionRowCss}>
                <Box css={sectionTitleCss}>{t("qbSet")}</Box>
                <chakra.button type="button" css={smallBtnCss} onClick={() => addPair("set")}>
                  + {t("qbAddSet")}
                </chakra.button>
              </Box>
              {setPairs.map((p, i) => (
                <Box css={rowCss} key={`set-${i}`}>
                  <ColumnPicker
                    value={p.column}
                    options={columnOptions}
                    onChange={(v) => updatePair("set", i, { column: v })}
                    placeholder={t("qbColumn")}
                  />
                  <chakra.span css={eqCss}>=</chakra.span>
                  <chakra.input
                    css={rowInputCss}
                    value={p.value}
                    placeholder={t("qbValue")}
                    onChange={(e) => updatePair("set", i, { value: e.target.value })}
                  />
                  <chakra.button
                    type="button"
                    css={iconBtnCss}
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
            <chakra.section css={sectionCss}>
              <Box css={sectionRowCss}>
                <Box css={sectionTitleCss}>{t("qbInsertValues")}</Box>
                <chakra.button type="button" css={smallBtnCss} onClick={() => addPair("insert")}>
                  + {t("qbAddValue")}
                </chakra.button>
              </Box>
              {insertPairs.map((p, i) => (
                <Box css={rowCss} key={`ins-${i}`}>
                  <ColumnPicker
                    value={p.column}
                    options={columnOptions}
                    onChange={(v) => updatePair("insert", i, { column: v })}
                    placeholder={t("qbColumn")}
                  />
                  <chakra.span css={eqCss}>=</chakra.span>
                  <chakra.input
                    css={rowInputCss}
                    value={p.value}
                    placeholder={t("qbValue")}
                    onChange={(e) => updatePair("insert", i, { value: e.target.value })}
                  />
                  <chakra.button
                    type="button"
                    css={iconBtnCss}
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
            <chakra.section css={sectionCss}>
              <Box css={sectionRowCss}>
                <chakra.label css={{ ...checkboxLabelCss, ...sectionTitleCss }}>
                  <Checkbox
                    checked={whereEnabled}
                    w="auto"
                    m={0}
                    onChange={(e) => setWhereEnabled(e.target.checked)}
                    aria-label={t("qbWhereToggle")}
                  />
                  <chakra.span>{t("qbWhere")}</chakra.span>
                </chakra.label>
                {whereEnabled && (
                  <chakra.button type="button" css={smallBtnCss} onClick={addCondition}>
                    + {t("qbAddCondition")}
                  </chakra.button>
                )}
              </Box>
              {whereEnabled && whereConditions.map((c, i) => (
                <Box css={rowCss} key={`w-${i}`}>
                  <ColumnPicker
                    value={c.column}
                    options={columnOptions}
                    onChange={(v) => updateCondition(i, { column: v })}
                    placeholder={t("qbColumn")}
                  />
                  <ComboBox
                    css={opCss}
                    value={c.operator}
                    options={[...WHERE_OPERATORS]}
                    onChange={(v) => updateCondition(i, { operator: v })}
                  />
                  <chakra.input
                    css={rowInputCss}
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
                    css={iconBtnCss}
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
            <chakra.section css={limitSectionCss}>
              <chakra.label css={{ ...checkboxLabelCss, m: 0 }}>
                <Checkbox
                  checked={limitEnabled}
                  w="auto"
                  m={0}
                  onChange={(e) => setLimitEnabled(e.target.checked)}
                  aria-label={t("qbLimitToggle")}
                />
                <chakra.span>{t("qbLimit")}</chakra.span>
              </chakra.label>
              <chakra.input
                id="qb-limit"
                css={limitInputCss}
                value={limit}
                placeholder="100"
                disabled={!limitEnabled}
                onChange={(e) => setLimit(e.target.value)}
                inputMode="numeric"
              />
            </chakra.section>
          )}

          <chakra.section css={sectionCss}>
            <Box css={sectionTitleCss}>{t("qbPreview")}</Box>
            <Box css={previewWrapCss}>
              <chakra.button
                type="button"
                css={previewCopyCss}
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
      </ModalBody>

      <ModalFooter>
        <Box flex={1} />
        {onPreview && kind !== "SELECT" && (
          <Button variant="warning" onClick={handlePreview} title={t("editorPreviewTitle")}>
            <chakra.span display="inline-flex" flexShrink={0} aria-hidden>
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
          onClick={handleExecute}
          disabled={runBlockedByReadOnly}
          title={runBlockedByReadOnly ? t("qbExecuteReadOnlyTitle") : undefined}
        >
          <chakra.span display="inline-flex" flexShrink={0} aria-hidden>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 3.5v9a.5.5 0 0 0 .77.42l7-4.5a.5.5 0 0 0 0-.84l-7-4.5A.5.5 0 0 0 4 3.5z" />
            </svg>
          </chakra.span>
          {t("qbExecute")}
        </Button>
      </ModalFooter>
    </Modal>
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
      css={rowInputCss}
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
  css?: SystemStyleObject;
  disabled?: boolean;
  id?: string;
  onEnter?: () => void;
}

function ComboBox({
  value,
  options,
  onChange,
  placeholder,
  css,
  disabled,
  id,
  onEnter,
}: ComboBoxProps) {
  const listId = useId();
  return (
    <>
      <chakra.input
        id={id}
        css={css}
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

  return <Box css={previewCss} ref={hostRef} />;
}
