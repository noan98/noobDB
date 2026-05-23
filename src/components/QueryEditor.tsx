import { useEffect, useMemo, useRef, useState } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql, type SQLNamespace } from "@codemirror/lang-sql";
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { format as formatSql } from "sql-formatter";
import { useT } from "../i18n";
import { QueryBuilder } from "./QueryBuilder";
import { codeMirrorSqlDialectFor, sqlFormatterLanguageFor } from "./sqlDialect";

const tableXHighlightStyle = HighlightStyle.define([
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

export interface SchemaTable {
  database: string;
  name: string;
  columns: string[];
}

export interface ActiveTable {
  database: string;
  name: string;
}

interface Props {
  onRun: (sql: string) => void;
  onPreview?: (sql: string) => void;
  onChange?: (sql: string) => void;
  onFormatError?: (error: string) => void;
  disabled?: boolean;
  schemaTable?: SchemaTable | null;
  activeTable?: ActiveTable | null;
  initialSql?: string;
  sessionId?: string | null;
  defaultDatabase?: string | null;
  driver?: string;
}

function formatEditorContent(
  view: EditorView,
  driver: string,
  onError?: (message: string) => void,
): boolean {
  const sel = view.state.selection.main;
  const isSelection = !sel.empty;
  const text = isSelection
    ? view.state.sliceDoc(sel.from, sel.to)
    : view.state.doc.toString();
  if (text.trim().length === 0) return false;
  let formatted: string;
  try {
    formatted = formatSql(text, { language: sqlFormatterLanguageFor(driver) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onError?.(message);
    return true;
  }
  if (formatted === text) return true;
  if (isSelection) {
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: formatted },
      selection: { anchor: sel.from, head: sel.from + formatted.length },
    });
  } else {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: formatted },
    });
  }
  return true;
}

function buildSqlExtension(driver: string, schemaTable: SchemaTable | null | undefined) {
  let schema: SQLNamespace | undefined;
  let defaultTable: string | undefined;
  let defaultSchema: string | undefined;
  if (schemaTable && schemaTable.columns.length > 0) {
    schema = {
      [schemaTable.database]: { [schemaTable.name]: schemaTable.columns },
      [schemaTable.name]: schemaTable.columns,
    };
    defaultTable = schemaTable.name;
    defaultSchema = schemaTable.database;
  }
  return sql({
    dialect: codeMirrorSqlDialectFor(driver),
    schema,
    defaultTable,
    defaultSchema,
    upperCaseKeywords: true,
  });
}

export function QueryEditor({
  onRun,
  onPreview,
  onChange,
  onFormatError,
  disabled,
  schemaTable,
  activeTable,
  initialSql,
  sessionId,
  defaultDatabase,
  driver = "mysql",
}: Props) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const sqlCompartment = useMemo(() => new Compartment(), []);
  const [hasContent, setHasContent] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onFormatErrorRef = useRef(onFormatError);
  onFormatErrorRef.current = onFormatError;
  const driverRef = useRef(driver);
  driverRef.current = driver;

  useEffect(() => {
    if (!hostRef.current) return;
    const startDoc = initialSql ?? "SELECT 1;";
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: startDoc,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          syntaxHighlighting(tableXHighlightStyle, { fallback: true }),
          autocompletion(),
          sqlCompartment.of(buildSqlExtension(driver, schemaTable)),
          keymap.of([
            { key: "Tab", run: acceptCompletion },
            {
              key: "Mod-Shift-f",
              preventDefault: true,
              run: (v) => formatEditorContent(v, driverRef.current, onFormatErrorRef.current),
            },
            ...defaultKeymap,
            ...historyKeymap,
            ...completionKeymap,
            ...closeBracketsKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              setHasContent(u.state.doc.length > 0);
              onChangeRef.current?.(u.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    setHasContent(startDoc.length > 0);
    return () => view.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const schemaKey = schemaTable
    ? `${schemaTable.database}.${schemaTable.name}|${schemaTable.columns.join(",")}`
    : "";

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: sqlCompartment.reconfigure(buildSqlExtension(driver, schemaTable)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaKey, driver]);

  const currentText = (): string | null => {
    const view = viewRef.current;
    if (!view) return null;
    const sel = view.state.selection.main;
    const text = sel.empty ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to);
    if (text.trim().length === 0) return null;
    return text;
  };

  const runSelectionOrAll = () => {
    const text = currentText();
    if (text !== null) onRun(text);
  };

  const formatSelectionOrAll = () => {
    const view = viewRef.current;
    if (!view) return;
    formatEditorContent(view, driver, onFormatErrorRef.current);
  };

  const previewSelectionOrAll = () => {
    if (!onPreview) return;
    const text = currentText();
    if (text !== null) onPreview(text);
  };

  const runLabel = activeTable
    ? t("editorRunOnTable", { table: activeTable.name })
    : t("editorRun");
  const runTitle = activeTable
    ? t("editorRunOnTableTitle", { database: activeTable.database, table: activeTable.name })
    : undefined;

  return (
    <div className="editor">
      <div className="toolbar">
        <button
          className="success with-icon"
          onClick={runSelectionOrAll}
          disabled={disabled || !hasContent}
          title={runTitle}
        >
          <span className="btn-icon" aria-hidden>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 3.5v9a.5.5 0 0 0 .77.42l7-4.5a.5.5 0 0 0 0-.84l-7-4.5A.5.5 0 0 0 4 3.5z" />
            </svg>
          </span>
          {runLabel}
        </button>
        {onPreview && (
          <button
            className="warning with-icon"
            onClick={previewSelectionOrAll}
            disabled={disabled || !hasContent}
            title={t("editorPreviewTitle")}
          >
            <span className="btn-icon" aria-hidden>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1.5 8s2.5-5 6.5-5 6.5 5 6.5 5-2.5 5-6.5 5S1.5 8 1.5 8z" />
                <circle cx="8" cy="8" r="2" />
              </svg>
            </span>
            {t("editorPreview")}
          </button>
        )}
        <button
          className="with-icon"
          onClick={formatSelectionOrAll}
          disabled={disabled || !hasContent}
          title={t("editorFormatTitle")}
        >
          <span className="btn-icon" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 3h12" />
              <path d="M2 7h8" />
              <path d="M2 11h10" />
              <path d="M2 15h6" />
            </svg>
          </span>
          {t("editorFormat")}
        </button>
        {sessionId && (
          <button
            className="with-icon"
            onClick={() => setShowBuilder(true)}
            disabled={disabled}
            title={t("editorBuilderTitle")}
          >
            <span className="btn-icon" aria-hidden>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11.5 2.5a3 3 0 0 0-3.9 3.6L2.5 11.2a1.5 1.5 0 1 0 2.1 2.1l5.1-5.1a3 3 0 0 0 3.6-3.9l-1.7 1.7-1.5-.4-.4-1.5z" />
              </svg>
            </span>
            {t("editorBuilder")}
          </button>
        )}
      </div>
      <div className="cm" ref={hostRef} />
      {showBuilder && sessionId && (
        <QueryBuilder
          sessionId={sessionId}
          driver={driver}
          defaultDatabase={defaultDatabase ?? activeTable?.database ?? null}
          defaultTable={activeTable?.name ?? null}
          onExecute={(builtSql) => onRun(builtSql)}
          onPreview={onPreview ? (builtSql) => onPreview(builtSql) : undefined}
          onClose={() => setShowBuilder(false)}
        />
      )}
    </div>
  );
}
