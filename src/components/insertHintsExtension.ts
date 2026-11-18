import { type Extension, StateEffect } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { TableSchema } from "../api/tauri";
import { type ColumnLookup, type HintMode, insertValueHints, scanInsertValues } from "./insertValues";

/**
 * INSERT ... VALUES の各値の直前に列名を薄く出すインレイヒント (#2424)。解析と対応付けは純関数
 * (`insertValues.ts`) に任せ、ここは CodeMirror の `Decoration.widget` の配線だけを持つ。
 * 表示範囲 (viewport) の終わりまでしか読まないので、1 万行の INSERT を開いても入力は重くならない。
 * 色・余白・フェードは App.css の `.cm-insert-hint` (CSS 変数のみ)。
 */

export interface InsertHintsOptions {
  /** 表示モード (毎回読む)。 */
  getMode: () => HintMode;
  /** 補完用スキーマ (毎回読む)。列リスト省略時の列順に使う。 */
  getSchema: () => {
    tables: readonly TableSchema[] | null | undefined;
    defaultDatabase: string | null | undefined;
    driver?: string | null;
  };
}

/** 文書がこの長さを超えたらヒントを出さない (走査コストの安全弁)。 */
const MAX_HINT_DOC_LENGTH = 4_000_000;

/** モードやスキーマが変わったときに再描画させる合図。 */
export const insertHintsRefresh = StateEffect.define<null>();

class HintWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly active: boolean,
  ) {
    super();
  }
  eq(other: HintWidget): boolean {
    return other.label === this.label && other.active === this.active;
  }
  toDOM(): HTMLElement {
    const node = document.createElement("span");
    node.className = this.active ? "cm-insert-hint cm-insert-hint-active" : "cm-insert-hint";
    node.textContent = `${this.label}:`;
    // 文字列そのものではないのでコピー・読み上げ・クリックの対象にしない。
    node.setAttribute("aria-hidden", "true");
    return node;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function buildLookup(
  tables: readonly TableSchema[] | null | undefined,
  defaultDatabase: string | null | undefined,
): ColumnLookup {
  const byName = new Map<string, readonly string[]>();
  for (const t of tables ?? []) byName.set(t.name.toLowerCase(), t.columns);
  const db = defaultDatabase?.toLowerCase() ?? null;
  return (table, qualifier) => {
    if (qualifier !== null && qualifier !== db) return null;
    return byName.get(table) ?? null;
  };
}

function build(view: EditorView, opts: InsertHintsOptions): DecorationSet {
  const mode = opts.getMode();
  const state = view.state;
  if (mode === "off" || state.doc.length > MAX_HINT_DOC_LENGTH) return Decoration.none;
  const ranges = view.visibleRanges;
  if (ranges.length === 0) return Decoration.none;
  const cursor = state.selection.main.head;
  let from = ranges[0].from;
  const to = ranges[ranges.length - 1].to;
  if (mode === "cursor") {
    // カーソル行と重なるタプルだけ見ればよい。カーソル行が表示範囲の外なら何も出さない。
    // 複数行にまたがるタプルの続きを読むため、`to` は表示範囲の終わりのままにする。
    const line = state.doc.lineAt(cursor);
    if (line.to < from || line.from > to) return Decoration.none;
    from = Math.max(from, line.from);
  }
  const { tables, defaultDatabase, driver } = opts.getSchema();
  // 行の途中から始まる文を取りこぼさないよう、文書の先頭から読み、`to` で打ち切る。
  const text = state.doc.sliceString(0, to);
  const stmts = scanInsertValues(text, { driver, from, to });
  if (stmts.length === 0) return Decoration.none;
  const hints = insertValueHints(text, stmts, {
    mode,
    cursor,
    lookup: buildLookup(tables, defaultDatabase),
  });
  return Decoration.set(
    hints.map((h) =>
      Decoration.widget({
        widget: new HintWidget(h.label, cursor >= h.from && cursor <= h.to),
        side: -1,
      }).range(h.pos),
    ),
    true,
  );
}

/** INSERT の VALUES に列名ヒントを出す拡張。 */
export function insertHints(opts: InsertHintsOptions): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, opts);
      }
      update(u: ViewUpdate) {
        const refresh = u.transactions.some((tr) => tr.effects.some((e) => e.is(insertHintsRefresh)));
        if (refresh || u.docChanged || u.viewportChanged || u.selectionSet) {
          this.decorations = build(u.view, opts);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
