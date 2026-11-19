// エディタ上の「その場で押せる実行ボタン」(#2450)。
//
// - ガターの ▶: 帯 (#2354) が出ている文 (= 2 文以上のときのカーソル位置の文) の先頭行に出し、
//   押すと `runStatement` (カーソル位置の文を実行) と同じ経路で実行する。`createMarkerLayer` の
//   ボタン化したガター (`onGutterClick` / `gutterLabel`) を使う。
// - CTE 名の横のインラインウィジェット: カーソルが CTE の定義の中にあるとき「CTE まで ▶」を出し、
//   無効な理由 (書き込み CTE / MySQL 5.7 など) は既存の `CTE_BLOCK_KEYS` の文言をツールチップに出す。
//   一度でも単体実行した CTE には、直近の行数バッジを付ける (編集後は stale で薄く、`cteRunBadge.ts`)。
// 実行そのものは呼び出し側 (`QueryEditor`) の既存経路 (`runStatementUnderCursor` / `runCteUnderCursor`) に任せる。
// これらは読み取り専用ガード・危険クエリ確認・自動 LIMIT の通る `onRun` / `onRunCte` を使うので、ここでは何も迂回しない。
// ツールチップは共有 `TooltipBubble` (呼び出し側が描く) に任せ、ここは hover の検出だけを担う (native title 禁止)。

import { type EditorState, type Extension, StateEffect } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { buildCteRun, CTE_BLOCK_KEYS, listCteDefs } from "../cteRun";
import { cteBadge, type CteBadge, type CteRunRecord } from "../cteRunBadge";
import { t } from "../i18n";
import { statementAtOffset } from "../sqlScript";
import { activeStatementRange } from "./activeStatement";
import { createMarkerLayer } from "./editorMarkers";
import type { TooltipRect } from "./tooltipPosition";

/** 入力・カーソル移動への追従のデバウンス (ms)。帯 (#2354) と同じ。 */
const DEBOUNCE_MS = 100;

/** ツールチップを出すまでの待ち (ms)。共有 `Tooltip` の `TOOLTIP_OPEN_DELAY_MS` と同じ。 */
const TIP_DELAY_MS = 400;

/** 設定・ドライバ・行数の入れ替えなど、外部の状態が変わったので描き直させる。 */
export const refreshRunAffordances = StateEffect.define<null>();

/** 装飾を作り直したので、見た目だけ反映させる (内部用。再計算は起こさない)。 */
const decorationsReady = StateEffect.define<null>();

export interface RunTip {
  label: string;
  rect: TooltipRect;
}

export interface RunAffordancesOptions {
  getDriver: () => string | undefined;
  /** 帯 (#2354) の設定。ガターの ▶ は帯が出ているときだけ出す。 */
  isBandEnabled: () => boolean;
  /** 「CTE まで ▶」を出すか (`onRunCte` が渡されている)。 */
  isCteEnabled: () => boolean;
  /** 接続先が WITH を解釈できない (MySQL 5.x など)。 */
  isCteUnsupported: () => boolean;
  getCteLimit: () => number | null | undefined;
  getCteRuns: () => readonly CteRunRecord[];
  /** カーソル位置の文を実行する (`runStatementUnderCursor` と同じ)。 */
  runStatement: (view: EditorView) => void;
  /** `offset` を含む CTE までを実行する (`runCteUnderCursor` と同じ)。 */
  runCte: (view: EditorView, offset: number) => void;
  /** ツールチップの表示 / 非表示 (null)。 */
  onTip: (tip: RunTip | null) => void;
}

/** 行数バッジの文言と状態を決める純関数 (テスト用に公開)。 */
export function cteBadgeText(badge: CteBadge): { text: string; tip: string } {
  // 自動 LIMIT で打ち切られた可能性があるときは「N+」と出す。
  const n = badge.truncated ? `${badge.rows}+` : badge.rows;
  const text = t("cteRunBadgeRows", { n });
  const tip = badge.stale ? t("cteRunBadgeStale", { n }) : t("cteRunBadgeFresh", { n });
  return { text, tip };
}

interface CteItem {
  /** ウィジェットを置く位置 (CTE 名の直後)。 */
  pos: number;
  /** 単体実行の対象 (カーソルのある CTE) か。 */
  cursor: boolean;
  /** 実行を始められる位置 (CTE の定義の先頭。カーソル移動で変わらないので `eq` では比べない)。 */
  offset: number;
  /** 実行できない理由の文言。実行できるなら null。 */
  blockedTip: string | null;
  badge: CteBadge | null;
}

function sameBadge(a: CteBadge | null, b: CteBadge | null): boolean {
  return a === b || (!!a && !!b && a.rows === b.rows && a.stale === b.stale && a.truncated === b.truncated);
}

function sameItems(a: readonly CteItem[], b: readonly CteItem[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i] as CteItem;
      return (
        x.pos === y.pos &&
        x.offset === y.offset &&
        x.cursor === y.cursor &&
        x.blockedTip === y.blockedTip &&
        sameBadge(x.badge, y.badge)
      );
    })
  );
}

class CteWidget extends WidgetType {
  constructor(
    private readonly item: CteItem,
    private readonly opts: RunAffordancesOptions,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    if (!(other instanceof CteWidget)) return false;
    const a = this.item;
    const b = other.item;
    // offset はクリック時に渡す実行位置。手前の編集で CTE がずれたら作り直して古い位置を使わない
    // (カーソル移動では変わらない値なので、CTE 内のカーソル移動では作り直さない)。
    return (
      a.offset === b.offset &&
      a.cursor === b.cursor &&
      a.blockedTip === b.blockedTip &&
      sameBadge(a.badge, b.badge)
    );
  }

  ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const { item, opts } = this;
    const root = document.createElement("span");
    root.className = "cm-cte-run";
    if (item.cursor) {
      const blocked = item.blockedTip !== null;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `cm-cte-run-btn${blocked ? " cm-cte-run-btn-disabled" : ""}`;
      const label = blocked ? (item.blockedTip as string) : t("cteRunInlineTip");
      btn.setAttribute("aria-label", blocked ? `${t("cteRunInline")}: ${label}` : t("cteRunInline"));
      btn.setAttribute("data-run-tip", label);
      if (blocked) btn.setAttribute("aria-disabled", "true");
      btn.textContent = t("cteRunInline");
      // エディタのフォーカスとカーソル位置を奪わない。
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        opts.onTip(null);
        if (!blocked) opts.runCte(view, item.offset);
      });
      root.append(btn);
    }
    if (item.badge) {
      const { text, tip } = cteBadgeText(item.badge);
      const chip = document.createElement("span");
      chip.className = `cm-cte-badge${item.badge.stale ? " cm-cte-badge-stale" : ""}`;
      chip.textContent = text;
      chip.setAttribute("data-run-tip", tip);
      root.append(chip);
    }
    return root;
  }
}

/** カーソルの文の CTE ごとに、ウィジェットの内容を決める (重い計算なのでデバウンスして呼ぶ)。 */
function computeCteItems(state: EditorState, opts: RunAffordancesOptions): CteItem[] {
  if (!opts.isCteEnabled()) return [];
  const driver = opts.getDriver() ?? "";
  const text = state.doc.toString();
  const head = state.selection.main.head;
  const range = statementAtOffset(text, head, driver);
  if (!range) return [];
  const stmt = text.slice(range.from, range.to);
  const defs = listCteDefs(stmt, driver);
  if (defs.length === 0) return [];
  const rel = head - range.from;
  const runs = opts.getCteRuns();
  const unsupported = opts.isCteUnsupported();
  const items: CteItem[] = [];
  for (const d of defs) {
    const cursor = rel >= d.start && rel <= d.end + 1;
    const hasRun = runs.some((r) => r.name.toLowerCase() === d.name.toLowerCase());
    if (!cursor && !hasRun) continue;
    const offset = range.from + d.start;
    // いま実行したら組み立てられる SQL。バッジの最新 / stale 判定と、無効な理由の両方に使う。
    const plan =
      unsupported || (!cursor && !hasRun)
        ? null
        : buildCteRun({ text, offset, driver, limit: opts.getCteLimit() });
    const blockedTip =
      !cursor || !opts.isCteEnabled()
        ? null
        : unsupported
          ? t(CTE_BLOCK_KEYS.unsupported)
          : plan && !plan.ok
            ? t(CTE_BLOCK_KEYS[plan.reason])
            : null;
    items.push({
      pos: range.from + d.start + d.rawName.length,
      cursor,
      offset,
      blockedTip,
      badge: cteBadge(runs, d.name, plan?.ok ? plan.sql : null, opts.getCteLimit()),
    });
  }
  return items;
}

/** hover の検出 (イベント委譲)。`[data-run-tip]` を持つ要素に載ったら遅延してツールチップを出す。 */
function tipListeners(view: EditorView, onTip: (tip: RunTip | null) => void): () => void {
  let timer: number | null = null;
  let current: Element | null = null;
  const clear = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  const hide = () => {
    clear();
    if (current) onTip(null);
    current = null;
  };
  const over = (e: MouseEvent) => {
    const el = e.target instanceof Element ? e.target.closest("[data-run-tip]") : null;
    if (el === current) return;
    hide();
    if (!el) return;
    current = el;
    timer = window.setTimeout(() => {
      timer = null;
      const label = el.getAttribute("data-run-tip");
      if (!label) return;
      const r = el.getBoundingClientRect();
      onTip({
        label,
        rect: {
          top: r.top,
          left: r.left,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        },
      });
    }, TIP_DELAY_MS);
  };
  view.dom.addEventListener("mouseover", over);
  view.dom.addEventListener("mouseleave", hide);
  view.dom.addEventListener("mousedown", hide, true);
  view.scrollDOM.addEventListener("scroll", hide, { passive: true });
  return () => {
    hide();
    view.dom.removeEventListener("mouseover", over);
    view.dom.removeEventListener("mouseleave", hide);
    view.dom.removeEventListener("mousedown", hide, true);
    view.scrollDOM.removeEventListener("scroll", hide);
  };
}

export function runAffordances(opts: RunAffordancesOptions): Extension {
  // ガターの ▶。帯が出ている文の先頭行にだけマーカーを置く。
  const gutterLayer = createMarkerLayer<null>({
    markClass: "cm-run-stmt",
    gutterClass: "cm-run-gutter",
    onEdit: "keep",
    gutterLabel: () => t("runStmtGutterTip"),
    onGutterClick: (_group, view) => {
      opts.onTip(null);
      opts.runStatement(view);
    },
    renderGutter: () => {
      const glyph = document.createElement("span");
      glyph.className = "cm-run-gutter-glyph";
      glyph.setAttribute("data-run-tip", t("runStmtGutterTip"));
      // 押してもエディタからフォーカスを奪わない。
      glyph.addEventListener("mousedown", (e) => e.preventDefault());
      return glyph;
    },
    renderSpacer: () => {
      const glyph = document.createElement("span");
      glyph.className = "cm-run-gutter-glyph";
      return glyph;
    },
  });

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private items: CteItem[] = [];
      private timer: number | null = null;
      private gutterTimer: number | null = null;
      private lastBand: string | null = null;
      private readonly dispose: () => void;

      constructor(private readonly view: EditorView) {
        this.dispose = tipListeners(view, opts.onTip);
        this.schedule(0);
        this.syncGutter();
      }

      update(u: ViewUpdate) {
        const refresh = u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshRunAffordances)));
        if (u.docChanged) this.decorations = this.decorations.map(u.changes);
        if (u.docChanged || u.selectionSet || refresh) this.schedule(refresh ? 0 : DEBOUNCE_MS);
        const band = this.bandKey(u.state);
        if (u.docChanged || u.selectionSet || refresh || band !== this.lastBand) this.syncGutter();
      }

      destroy() {
        this.dispose();
        if (this.timer !== null) window.clearTimeout(this.timer);
        if (this.gutterTimer !== null) window.clearTimeout(this.gutterTimer);
      }

      private bandKey(state: EditorState): string | null {
        const r = activeStatementRange(state);
        return r && opts.isBandEnabled() && state.selection.main.empty ? `${r.from}:${r.to}` : null;
      }

      private schedule(delay: number) {
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
          this.timer = null;
          const next = computeCteItems(this.view.state, opts);
          // 前回と同じなら装飾も作り直さず、更新サイクルも回さない (カーソル移動のたびに DOM を触らない)。
          if (sameItems(this.items, next)) return;
          this.items = next;
          this.rebuild();
        }, delay);
      }

      private rebuild() {
        const doc = this.view.state.doc;
        const ranges = this.items
          .filter((i) => i.pos <= doc.length)
          .map((i) => Decoration.widget({ widget: new CteWidget(i, opts), side: 1 }).range(i.pos));
        this.decorations = Decoration.set(ranges, true);
        // update の外 (タイマー) から装飾を反映させるため、空の効果で更新サイクルを 1 回回す。
        try {
          this.view.dispatch({ effects: decorationsReady.of(null) });
        } catch {
          // view が破棄済みなら無視。
        }
      }

      /** 帯の文の先頭行へ ▶ を置く。update の最中は dispatch できないので次のタスクで反映する。 */
      private syncGutter() {
        if (this.gutterTimer !== null) window.clearTimeout(this.gutterTimer);
        this.gutterTimer = window.setTimeout(() => {
          this.gutterTimer = null;
          const { view } = this;
          const band = this.bandKey(view.state);
          this.lastBand = band;
          const r = band ? activeStatementRange(view.state) : null;
          const cur = gutterLayer.get(view.state);
          if (!r ? cur.length === 0 : cur.length === 1 && cur[0]?.from === r.from) return;
          try {
            view.dispatch({
              effects: gutterLayer.set(
                r ? [{ from: r.from, to: r.from, kind: "run", squiggle: false, data: null }] : [],
              ),
            });
          } catch {
            // view が破棄済みなら無視。
          }
        }, 0);
      }
    },
    { decorations: (v) => v.decorations },
  );

  return [gutterLayer.extension, plugin];
}
