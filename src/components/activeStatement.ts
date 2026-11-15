// カーソル位置の文 (文単位実行の対象) を常に淡い帯と左端のバーで示す CodeMirror 拡張 (#2354)。
//
// 範囲の計算は `highlightedStatementAtOffset` (= 実行と同じ `statementAtOffset` の文分割・帰属)
// なので、表示と実行は必ず一致する。入力中は約 100ms のデバウンスで追従し、装飾は
// 可視範囲の行だけに付ける (1 万行の SQL でも描画コストが文の長さに比例しない)。
// 見た目 (帯・バー・クロスフェード・reduced-motion) は App.css の `.cm-active-stmt`。

import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { highlightedStatementAtOffset } from "../sqlScript";

/** 入力・カーソル移動への追従のデバウンス (ms)。 */
export const ACTIVE_STATEMENT_DEBOUNCE_MS = 100;

interface Span {
  from: number;
  to: number;
}

const setActiveStatement = StateEffect.define<Span | null>();

/** 設定トグルやドライバの切替後に、範囲を計算し直させる。 */
export const refreshActiveStatement = StateEffect.define<null>();

const activeStatementField = StateField.define<Span | null>({
  create: () => null,
  update(value, tr) {
    // 計算が追いつくまでの間も、編集に追従して帯がずれないようにする。
    if (value && tr.docChanged) {
      const from = tr.changes.mapPos(value.from, 1);
      const to = tr.changes.mapPos(value.to, -1);
      value = to > from ? { from, to } : null;
    }
    for (const e of tr.effects) {
      if (e.is(setActiveStatement)) value = e.value;
    }
    return value;
  },
});

const lineDeco = Decoration.line({ class: "cm-active-stmt" });

/**
 * 範囲 `[from, to]` にかかる行のうち、可視範囲 `visible` に入るものの行頭オフセットを返す。
 * 純関数 (テスト用に公開)。`lineStarts` は行番号 → 行頭の写像ではなく、実 doc から求める。
 */
export function visibleLineStarts(
  doc: { lineAt(pos: number): { from: number; to: number } },
  span: Span,
  visible: readonly Span[],
): number[] {
  const out: number[] = [];
  for (const v of visible) {
    const start = Math.max(span.from, v.from);
    const end = Math.min(span.to, v.to);
    if (end < start) continue;
    let pos = start;
    for (;;) {
      const line = doc.lineAt(pos);
      if (out.length === 0 || out[out.length - 1] !== line.from) out.push(line.from);
      if (line.to >= end) break;
      pos = line.to + 1;
    }
  }
  return out;
}

/**
 * @param getDriver 文分割に使うドライバ (実行と同じ解釈にするため ref 越しに最新を読む)
 * @param isEnabled 設定のオン・オフ (ref 越し)
 */
export function activeStatementHighlight(
  getDriver: () => string | undefined,
  isEnabled: () => boolean,
): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private timer: number | null = null;

      constructor(private readonly view: EditorView) {
        this.schedule(0);
      }

      update(u: ViewUpdate) {
        const refresh = u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshActiveStatement)));
        if (u.docChanged || u.selectionSet || refresh)
          this.schedule(refresh ? 0 : ACTIVE_STATEMENT_DEBOUNCE_MS);
        this.decorations = this.build(u.view);
      }

      destroy() {
        if (this.timer !== null) window.clearTimeout(this.timer);
      }

      private schedule(delay: number) {
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
          this.timer = null;
          this.compute();
        }, delay);
      }

      private compute() {
        const { view } = this;
        let next: Span | null = null;
        const sel = view.state.selection.main;
        if (isEnabled() && sel.empty) {
          const r = highlightedStatementAtOffset(view.state.doc.toString(), sel.head, getDriver());
          if (r) next = { from: r.from, to: r.to };
        }
        const cur = view.state.field(activeStatementField);
        if (cur?.from === next?.from && cur?.to === next?.to) return;
        try {
          view.dispatch({ effects: setActiveStatement.of(next) });
        } catch {
          // view が破棄済みなら無視。
        }
      }

      private build(view: EditorView): DecorationSet {
        const span = view.state.field(activeStatementField);
        // 選択範囲があるときは選択を実行するので即座に消す (デバウンスを待たない)。
        if (!span || !isEnabled() || !view.state.selection.main.empty) return Decoration.none;
        const starts = visibleLineStarts(view.state.doc, span, view.visibleRanges);
        return Decoration.set(starts.map((pos) => lineDeco.range(pos)));
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [activeStatementField, plugin];
}
