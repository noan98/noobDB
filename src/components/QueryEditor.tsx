import { useEffect, useMemo, useRef, useState } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql, MySQL, type SQLNamespace } from "@codemirror/lang-sql";
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
import { useT } from "../i18n";
import { QueryBuilder } from "./QueryBuilder";

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
  disabled?: boolean;
  schemaTable?: SchemaTable | null;
  activeTable?: ActiveTable | null;
  initialSql?: string;
  sessionId?: string | null;
  defaultDatabase?: string | null;
}

function buildSqlExtension(schemaTable: SchemaTable | null | undefined) {
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
    dialect: MySQL,
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
  disabled,
  schemaTable,
  activeTable,
  initialSql,
  sessionId,
  defaultDatabase,
}: Props) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const sqlCompartment = useMemo(() => new Compartment(), []);
  const [hasContent, setHasContent] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

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
          sqlCompartment.of(buildSqlExtension(schemaTable)),
          keymap.of([
            { key: "Tab", run: acceptCompletion },
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
    view.dispatch({ effects: sqlCompartment.reconfigure(buildSqlExtension(schemaTable)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaKey]);

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
          className="primary"
          onClick={runSelectionOrAll}
          disabled={disabled || !hasContent}
          title={runTitle}
        >
          {runLabel}
        </button>
        {onPreview && (
          <button
            onClick={previewSelectionOrAll}
            disabled={disabled || !hasContent}
            title={t("editorPreviewTitle")}
          >
            {t("editorPreview")}
          </button>
        )}
        {sessionId && (
          <button
            onClick={() => setShowBuilder(true)}
            disabled={disabled}
            title={t("editorBuilderTitle")}
          >
            {t("editorBuilder")}
          </button>
        )}
      </div>
      <div className="cm" ref={hostRef} />
      {showBuilder && sessionId && (
        <QueryBuilder
          sessionId={sessionId}
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
