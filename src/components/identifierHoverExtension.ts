import { StateEffect, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  hoverTooltip,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { TableColumnInfo, TableSchema } from "../api/tauri";
import { renderColumnInfo } from "./completionInfoPanel";
import { describeTableCard, jumpableRanges, resolveIdentifierHover } from "./identifierHover";
import { isMacPlatform, isSchemaJumpModifier, type SchemaJumpTarget } from "./identifierJump";
import { describeColumn, findColumnInfo, type ColumnInfoLabels } from "./sqlSchemaCompletion";

/**
 * SQL エディタの識別子ホバーカードと Ctrl/Cmd 押下中のジャンプ下線 (#2352)。解決は純関数
 * (`identifierHover.ts` / `identifierJump.ts`) に任せ、ここは CodeMirror と DOM の配線だけを持つ。
 * 色・余白は App.css の `.cm-identifier-hover` / `.cm-jump-link` (CSS 変数のみ)。
 */

export interface IdentifierHoverLabels {
  column: ColumnInfoLabels;
  loading: string;
  unavailable: string;
  revealTree: string;
  openStructure: string;
  pk: string;
  fk: string;
  /** 推定行数 (`{n}` 展開済みの文言を返す)。 */
  tableRows: (n: number) => string;
  moreColumns: (n: number) => string;
}

export interface IdentifierHoverOptions {
  /** 設定でオフにされているか (毎回読む)。 */
  isEnabled: () => boolean;
  /** 補完用スキーマとデータベース名 (毎回読む)。 */
  getSchema: () => {
    tables: readonly TableSchema[] | null | undefined;
    defaultDatabase: string | null | undefined;
  };
  /** 列メタデータ (キャッシュ付きの遅延取得)。失敗は reject でよい (カード側で縮退する)。 */
  getColumns: (table: string) => Promise<TableColumnInfo[]>;
  getRowEstimate: (table: string) => Promise<number | null>;
  getLabels: () => IdentifierHoverLabels;
  onReveal: (target: SchemaJumpTarget) => void;
  onOpenStructure: (database: string, table: string) => void;
}

/** ホバーカードが出るまでの待ち時間 (ms)。 */
export const IDENTIFIER_HOVER_DELAY_MS = 400;
/** 修飾キー押下中に下線を引く文書長の上限 (走査コストを抑える)。 */
const MAX_LINKED_LENGTH = 200_000;

const refreshEffect = StateEffect.define<null>();
const linkMark = Decoration.mark({ class: "cm-jump-link" });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderTableCard(
  database: string,
  table: string,
  columns: TableColumnInfo[],
  rowEstimate: number | null,
  labels: IdentifierHoverLabels,
): HTMLElement {
  const model = describeTableCard(columns, rowEstimate);
  const root = el("div", "cm-sqlInfo");
  root.append(el("div", "cm-sqlInfo-title", `${database}.${table}`));
  if (model.rowEstimate !== null) {
    root.append(el("div", "cm-sqlInfo-comment", labels.tableRows(model.rowEstimate)));
  }
  const list = el("ul", "cm-hoverCard-cols");
  for (const c of model.columns) {
    const li = document.createElement("li");
    li.append(el("span", "cm-hoverCard-colName", c.name), el("span", "cm-hoverCard-colType", c.type));
    if (c.pk) li.append(el("span", "cm-hoverCard-badge", labels.pk));
    if (c.fk) li.append(el("span", "cm-hoverCard-badge", labels.fk));
    list.append(li);
  }
  root.append(list);
  if (model.more > 0) root.append(el("div", "cm-sqlInfo-comment", labels.moreColumns(model.more)));
  return root;
}

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "cm-hoverCard-btn", label);
  b.type = "button";
  // エディタのフォーカスとカーソル位置を奪わない。
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", onClick);
  return b;
}

function buildCard(target: SchemaJumpTarget, opts: IdentifierHoverOptions): HTMLElement {
  const labels = opts.getLabels();
  const root = el("div", "cm-identifier-hover");
  const body = el("div", "cm-hoverCard-body");
  body.append(el("div", "cm-sqlInfo-comment", labels.loading));
  const actions = el("div", "cm-hoverCard-actions");
  actions.append(
    actionButton(labels.revealTree, () => opts.onReveal(target)),
    actionButton(labels.openStructure, () => opts.onOpenStructure(target.database, target.table)),
  );
  root.append(body, actions);

  // 列メタが未取得でも先にカードを出し、取得できたら中身を差し替える。失敗はトーストにせず縮退する。
  const fallbackTitle = target.column
    ? `${target.table}.${target.column}`
    : `${target.database}.${target.table}`;
  const degrade = () => {
    const box = el("div", "cm-sqlInfo");
    box.append(
      el("div", "cm-sqlInfo-title", fallbackTitle),
      el("div", "cm-sqlInfo-comment", labels.unavailable),
    );
    body.replaceChildren(box);
  };
  void (async () => {
    try {
      const columns = await opts.getColumns(target.table);
      if (target.column) {
        const meta = findColumnInfo(columns, target.column);
        if (!meta) return degrade();
        const card = renderColumnInfo({ ...describeColumn(meta, labels.column), title: fallbackTitle });
        body.replaceChildren(card);
        return;
      }
      // 行数推定は付加情報。取れなくても列一覧は出す。
      const estimate = await opts.getRowEstimate(target.table).catch(() => null);
      body.replaceChildren(renderTableCard(target.database, target.table, columns, estimate, labels));
    } catch {
      degrade();
    }
  })();
  return root;
}

/** Ctrl (macOS では Cmd) を押している間だけ、ジャンプできる識別子に下線を引く。 */
function jumpLinks(opts: IdentifierHoverOptions): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      held = false;
      private readonly mac = isMacPlatform();
      private readonly view: EditorView;
      private readonly sync = (e: KeyboardEvent | MouseEvent) =>
        // キー入力は、ポインタがこのエディタの上にあるときだけ見る (他のエディタを再計算しない)。
        this.setHeld(isSchemaJumpModifier(e, this.mac) && this.view.dom.matches(":hover"));
      private readonly release = () => this.setHeld(false);
      constructor(view: EditorView) {
        this.view = view;
        // フォーカスの外でもポインタが乗っていれば効かせたいので、文書全体のキー入力を見る。
        document.addEventListener("keydown", this.sync);
        document.addEventListener("keyup", this.sync);
        view.dom.addEventListener("mousemove", this.sync);
        view.dom.addEventListener("mouseleave", this.release);
        window.addEventListener("blur", this.release);
      }
      setHeld(next: boolean) {
        if (next === this.held) return;
        this.held = next;
        this.view.dom.classList.toggle("cm-jump-mod", next);
        // 状態の変更を update() に伝えるための空の更新。
        this.view.dispatch({ effects: refreshEffect.of(null) });
      }
      update(u: ViewUpdate) {
        const refresh = u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshEffect)));
        if (!this.held || !opts.isEnabled()) {
          this.decorations = Decoration.none;
          return;
        }
        if (!(refresh || u.docChanged || u.viewportChanged)) return;
        this.decorations = this.build(u.view);
      }
      build(view: EditorView): DecorationSet {
        const doc = view.state.doc;
        if (doc.length > MAX_LINKED_LENGTH) return Decoration.none;
        const { tables, defaultDatabase } = opts.getSchema();
        const ranges = view.visibleRanges.flatMap((r) =>
          jumpableRanges({ text: doc.toString(), from: r.from, to: r.to, tables, defaultDatabase }),
        );
        return Decoration.set(
          ranges.map((r) => linkMark.range(r.from, r.to)),
          true,
        );
      }
      destroy() {
        document.removeEventListener("keydown", this.sync);
        document.removeEventListener("keyup", this.sync);
        this.view.dom.removeEventListener("mousemove", this.sync);
        this.view.dom.removeEventListener("mouseleave", this.release);
        window.removeEventListener("blur", this.release);
        this.view.dom.classList.remove("cm-jump-mod");
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** 識別子ホバーのクイック情報カードと、修飾キー押下中のジャンプ下線を合わせた拡張。 */
export function identifierHover(opts: IdentifierHoverOptions): Extension {
  const tooltip = hoverTooltip(
    (view, pos, side) => {
      if (!opts.isEnabled()) return null;
      const { tables, defaultDatabase } = opts.getSchema();
      const hit = resolveIdentifierHover({
        text: view.state.doc.toString(),
        pos,
        side,
        tables,
        defaultDatabase,
      });
      if (!hit) return null;
      return {
        pos: hit.from,
        end: hit.to,
        above: true,
        create: () => ({ dom: buildCard(hit.target, opts) }),
      };
    },
    { hoverTime: IDENTIFIER_HOVER_DELAY_MS },
  );
  return [tooltip, jumpLinks(opts)];
}
