import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";

interface Props {
  onRun: (sql: string) => void;
  disabled?: boolean;
}

export function QueryEditor({ onRun, disabled }: Props) {
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

  const runSelectionOrAll = () => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    const text = sel.empty ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to);
    if (text.trim().length === 0) return;
    onRun(text);
  };

  return (
    <div className="editor">
      <div className="toolbar">
        <button className="primary" onClick={runSelectionOrAll} disabled={disabled || !hasContent}>
          Run (selection or all)
        </button>
        <span style={{ color: "#6b7280", fontSize: 12 }}>
          {disabled ? "Connect a session to run queries." : "Tip: select text to run only that fragment."}
        </span>
      </div>
      <div className="cm" ref={hostRef} />
    </div>
  );
}
