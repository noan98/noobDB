import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import { useT } from "../i18n";

interface Props {
  onRun: (sql: string) => void;
  onPreview?: (sql: string) => void;
  disabled?: boolean;
}

export function QueryEditor({ onRun, onPreview, disabled }: Props) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [hasContent, setHasContent] = useState(false);

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: "SELECT 1;",
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          sql(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setHasContent(u.state.doc.length > 0);
          }),
        ],
      }),
    });
    viewRef.current = view;
    setHasContent(true);
    return () => view.destroy();
  }, []);

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

  return (
    <div className="editor">
      <div className="toolbar">
        <button className="primary" onClick={runSelectionOrAll} disabled={disabled || !hasContent}>
          {t("editorRun")}
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
        <span className="muted" style={{ fontSize: 12 }}>
          {disabled ? t("editorHintDisabled") : t("editorHint")}
        </span>
      </div>
      <div className="cm" ref={hostRef} />
    </div>
  );
}
