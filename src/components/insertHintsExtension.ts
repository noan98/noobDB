import { type Extension, StateEffect, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { TableSchema } from "../api/tauri";
import {
  type ColumnIndex,
  type HintMode,
  type InsertStatement,
  buildColumnIndex,
  ddlTargetTables,
  indexLookup,
  insertValueHints,
  scanInsertValues,
} from "./insertValues";

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
    /** アクティブテーブル。概観で列が空の表の列を補う。 */
    schemaTable?: TableSchema | null;
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

interface ScanCache {
  doc: Text;
  driver: string | null;
  from: number;
  to: number;
  text: string;
  stmts: InsertStatement[];
  /** DDL の対象表。列リストを省略した文があるときだけ求める。 */
  ddl: Set<string> | null;
}

/** プラグインごとの走査・索引のキャッシュ。選択だけが変わった更新では、走査せずヒントの再計算だけにする。 */
class HintBuilder {
  private scan: ScanCache | null = null;
  private indexKey: { tables: unknown; schemaTable: unknown } | null = null;
  private index: ColumnIndex = new Map();

  constructor(private readonly opts: InsertHintsOptions) {}

  private columnIndex(
    tables: readonly TableSchema[] | null | undefined,
    schemaTable: TableSchema | null | undefined,
  ): ColumnIndex {
    const k = this.indexKey;
    if (!k || k.tables !== tables || k.schemaTable !== schemaTable) {
      this.index = buildColumnIndex(tables, schemaTable);
      this.indexKey = { tables, schemaTable };
    }
    return this.index;
  }

  build(view: EditorView): DecorationSet {
    const mode = this.opts.getMode();
    const state = view.state;
    if (mode === "off" || state.doc.length > MAX_HINT_DOC_LENGTH) return Decoration.none;
    const ranges = view.visibleRanges;
    if (ranges.length === 0) return Decoration.none;
    const cursor = state.selection.main.head;
    // 走査範囲は常に表示範囲。カーソル移動だけなら同じ走査結果を使い回す。
    const from = ranges[0].from;
    const to = ranges[ranges.length - 1].to;
    if (mode === "cursor") {
      const line = state.doc.lineAt(cursor);
      if (line.to < from || line.from > to) return Decoration.none;
    }
    const { tables, defaultDatabase, driver, schemaTable } = this.opts.getSchema();
    let c = this.scan;
    if (!c || c.doc !== state.doc || c.driver !== (driver ?? null) || c.from !== from || c.to !== to) {
      // 文書の先頭から全部は読まず、表示範囲を含む文の先頭 (巨大な VALUES は手前のタプル) から読む。
      const text = state.doc.sliceString(0, to);
      c = { doc: state.doc, driver: driver ?? null, from, to, text, stmts: [], ddl: null };
      c.stmts = scanInsertValues(text, { driver, from, to, seek: true });
      this.scan = c;
    }
    if (c.stmts.length === 0) return Decoration.none;
    if (c.ddl === null) {
      c.ddl = c.stmts.some((s) => s.columns === null) ? ddlTargetTables(state.doc.toString()) : new Set();
    }
    const hints = insertValueHints(c.text, c.stmts, {
      mode,
      cursor,
      lookup: indexLookup(this.columnIndex(tables, schemaTable), defaultDatabase, c.ddl),
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
}

/** INSERT の VALUES に列名ヒントを出す拡張。 */
export function insertHints(opts: InsertHintsOptions): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private readonly builder = new HintBuilder(opts);
      constructor(view: EditorView) {
        this.decorations = this.builder.build(view);
      }
      update(u: ViewUpdate) {
        const refresh = u.transactions.some((tr) => tr.effects.some((e) => e.is(insertHintsRefresh)));
        if (refresh || u.docChanged || u.viewportChanged || u.selectionSet) {
          this.decorations = this.builder.build(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
