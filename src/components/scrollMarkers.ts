// エディタの右端 (スクロールバーの横) に、文書全体に対する位置をティックで示す帯の「データ側」 (#2382)。
//
// 実行エラー (#2330) / バッチ各文の成否 (#2331) / 構文チェックの指摘 / 検索ヒット / 現在の文の範囲 (#2354) を
// 既存の `StateField` から読むだけで、新しい状態は持たない。描画 (ティックの DOM・ツールチップ) は
// `ScrollMarkerStrip.tsx` が受け持ち、ここは次の 2 つを提供する。
//
// - 純関数 (`buildScrollTicks` ほか): 位置のバケット化と、重なったときの重大度優先。CodeMirror に触れない。
// - `scrollMarkers` (ViewPlugin): 層の変化を検知してスナップショットを作り直し、React へ渡す。
//   層は `read()` の戻り値で変化を判定するので、文書が長くても再計算は変更があった層だけに限る
//   (入力中は doc 変更をデバウンスして 1 回にまとめる)。

import { forEachDiagnostic } from "@codemirror/lint";
import { getSearchQuery, searchPanelOpen, type SearchQuery } from "@codemirror/search";
import { type EditorState, type Extension, StateEffect, type Text } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { activeStatementRange } from "./activeStatement";
import type { MarkerLayer } from "./editorMarkers";

/** 帯に出す印の種別。重大度の高い順に `error` > `warning` > `search` > `ok`。 */
export type ScrollMarkKind = "error" | "warning" | "search" | "ok";

/** 重なったときの優先度 (大きいほど優先)。 */
export const SCROLL_MARK_SEVERITY: Record<ScrollMarkKind, number> = {
  error: 4,
  warning: 3,
  search: 2,
  ok: 1,
};

/** 帯の元になる印 1 件。`pos` はクリックで移動する先 (文書オフセット)、`label` はツールチップ用の本文 (1 行目)。 */
export interface ScrollMarkSource {
  pos: number;
  line: number;
  kind: ScrollMarkKind;
  label: string;
}

/** 帯に描くティック 1 本 (近い位置の印を 1 本にまとめたもの)。 */
export interface ScrollTick {
  /** 帯の上端からの位置 (0〜1)。 */
  frac: number;
  /** クリックで移動する先 (まとめた印のうち最も重大なもの)。 */
  pos: number;
  line: number;
  kind: ScrollMarkKind;
  label: string;
  /** このティックにまとまった印の数 (代表を含む)。 */
  count: number;
}

/** 帯の元データ。`activeLines` は現在の文の範囲 (行番号、両端を含む)。 */
export interface ScrollMarkSnapshot {
  sources: readonly ScrollMarkSource[];
  totalLines: number;
  activeLines: { from: number; to: number } | null;
}

/** 検索ヒットを帯に載せる上限 (1 文字検索などで数万件になっても帯の計算を一定に保つ)。 */
export const MAX_SEARCH_TICKS = 5000;

/** 行番号 (1 始まり) を帯上の位置 (0〜1) にする。1 行だけの文書は先頭 (0)。 */
export function lineFraction(line: number, totalLines: number): number {
  if (totalLines <= 1) return 0;
  return Math.min(1, Math.max(0, (line - 1) / (totalLines - 1)));
}

/**
 * 印をバケット (帯を `buckets` 等分したもの) にまとめてティックにする。同じバケットに複数あれば
 * 重大度の高い印を代表にし (同じ重大度なら文書の先頭側)、`count` に総数を残す。
 * 結果は位置の昇順。`buckets` は帯の高さから決める (ティックが細すぎて重ならない数)。
 */
export function buildScrollTicks(
  sources: readonly ScrollMarkSource[],
  totalLines: number,
  buckets: number,
): ScrollTick[] {
  const n = Math.max(1, Math.floor(buckets));
  const slots = new Map<number, ScrollTick>();
  for (const s of sources) {
    const frac = lineFraction(s.line, totalLines);
    const slot = Math.min(n - 1, Math.floor(frac * n));
    const cur = slots.get(slot);
    if (!cur) {
      slots.set(slot, { frac, pos: s.pos, line: s.line, kind: s.kind, label: s.label, count: 1 });
      continue;
    }
    cur.count += 1;
    const better =
      SCROLL_MARK_SEVERITY[s.kind] > SCROLL_MARK_SEVERITY[cur.kind] ||
      (SCROLL_MARK_SEVERITY[s.kind] === SCROLL_MARK_SEVERITY[cur.kind] && s.pos < cur.pos);
    if (better) {
      cur.frac = frac;
      cur.pos = s.pos;
      cur.line = s.line;
      cur.kind = s.kind;
      cur.label = s.label;
    }
  }
  return [...slots.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t);
}

/** 文字列の 1 行目 (空行は読み飛ばす)。ツールチップの概要に使う。 */
export function firstLine(text: string): string {
  for (const l of text.split("\n")) {
    const t = l.trim();
    if (t) return t;
  }
  return "";
}

function mark(doc: Text, pos: number, kind: ScrollMarkKind, label: string): ScrollMarkSource {
  const p = Math.min(Math.max(0, pos), doc.length);
  return { pos: p, line: doc.lineAt(p).number, kind, label };
}

/** 層の 1 つ。`read` の戻り値が (`eq` で) 変わったときだけ `build` を呼び直す。 */
export interface ScrollMarkerLayer<V = unknown> {
  /** 現在の状態から、変化の判定に使う軽い値を読む (層の配列そのものなど)。 */
  read: (state: EditorState) => V;
  eq?: (a: V, b: V) => boolean;
  build: (value: V, state: EditorState) => ScrollMarkSource[];
}

/** 層の値の型を消して、種類の違う層を 1 つの配列に並べられるようにする。 */
export function eraseLayer<V>(layer: ScrollMarkerLayer<V>): ScrollMarkerLayer {
  const eq = layer.eq;
  return {
    read: layer.read,
    eq: eq ? (a, b) => eq(a as V, b as V) : undefined,
    build: (value, state) => layer.build(value as V, state),
  };
}

/** `createMarkerLayer` の層を帯の層にする。`toMark` が null を返すマーカーは載せない。 */
export function markerScrollLayer<D>(
  layer: MarkerLayer<D>,
  toMark: (m: { from: number; kind: string; data?: D }) => { kind: ScrollMarkKind; label: string } | null,
): ScrollMarkerLayer {
  return {
    read: (state) => layer.get(state),
    build: (value, state) => {
      const out: ScrollMarkSource[] = [];
      for (const m of value as ReturnType<MarkerLayer<D>["get"]>) {
        const r = toMark(m);
        if (r) out.push(mark(state.doc, m.from, r.kind, r.label));
      }
      return out;
    },
  };
}

interface LintSnap {
  from: number;
  severity: string;
  message: string;
}

/** 構文チェックの指摘 (`@codemirror/lint`)。`error` / `warning` だけを載せ、情報・ヒントは載せない。 */
export function lintScrollLayer(): ScrollMarkerLayer<readonly LintSnap[]> {
  return {
    read: (state) => {
      const out: LintSnap[] = [];
      forEachDiagnostic(state, (d, from) => out.push({ from, severity: d.severity, message: d.message }));
      return out;
    },
    eq: (a, b) =>
      a.length === b.length &&
      a.every((x, i) => {
        const y = b[i] as LintSnap;
        return x.from === y.from && x.severity === y.severity && x.message === y.message;
      }),
    build: (value, state) =>
      value.flatMap((d) =>
        d.severity === "error" || d.severity === "warning"
          ? [mark(state.doc, d.from, d.severity, firstLine(d.message))]
          : [],
      ),
  };
}

interface SearchSnap {
  open: boolean;
  query: SearchQuery;
  doc: Text;
}

/** 検索ヒット。検索パネルが開いていて、クエリが有効なときだけ載せる (上限 `MAX_SEARCH_TICKS`)。 */
export function searchScrollLayer(): ScrollMarkerLayer<SearchSnap> {
  return {
    read: (state) => ({ open: searchPanelOpen(state), query: getSearchQuery(state), doc: state.doc }),
    eq: (a, b) => a.open === b.open && a.query.eq(b.query) && a.doc === b.doc,
    build: (value, state) => {
      if (!value.open || !value.query.valid || value.query.search === "") return [];
      const out: ScrollMarkSource[] = [];
      const cursor = value.query.getCursor(state);
      for (let r = cursor.next(); !r.done && out.length < MAX_SEARCH_TICKS; r = cursor.next()) {
        out.push(mark(state.doc, r.value.from, "search", ""));
      }
      return out;
    },
  };
}

/** 設定のオン / オフなどで、全層を読み直させる。 */
export const refreshScrollMarkers = StateEffect.define<null>();

/** 文書の変更を何ミリ秒まとめて 1 回だけ再計算するか (入力のもたつき防止)。 */
export const SCROLL_MARKERS_DEBOUNCE_MS = 120;

export interface ScrollMarkersOptions {
  layers: readonly ScrollMarkerLayer[];
  /** 設定のオン・オフ (ref 越し)。オフなら計算もしない。 */
  isEnabled: () => boolean;
  /** 帯の描画先 (`view.dom` の中の要素)。React 側が portal で描く。破棄時は null。 */
  onHost: (el: HTMLElement | null) => void;
  /** 計算結果。無効のときは null。 */
  onSnapshot: (snap: ScrollMarkSnapshot | null) => void;
}

const sameLines = (a: ScrollMarkSnapshot["activeLines"], b: ScrollMarkSnapshot["activeLines"]) =>
  a === b || (!!a && !!b && a.from === b.from && a.to === b.to);

/** 帯の ViewPlugin。層の `read` が変わったものだけ `build` し直し、結果を `onSnapshot` で渡す。 */
export function scrollMarkers(opts: ScrollMarkersOptions): Extension {
  const layers = opts.layers;
  const plugin = ViewPlugin.fromClass(
    class {
      private readonly host: HTMLElement;
      private values: unknown[] = [];
      private built: ScrollMarkSource[][] = [];
      private activeSpan: { from: number; to: number } | null = null;
      private published: ScrollMarkSnapshot | null = null;
      private active = false;
      private dirty = true;
      private timer: number | null = null;
      private hasMarkers = false;
      /** 一度でも印が出たら、設定がオンの間は幅を確保し続ける (lint の出入りで本文幅を動かさない)。 */
      private reserved = false;
      private measured = "";
      /** 各層の `built` を作ったときの文書。 */
      private builtDoc: Text | null = null;
      private ro: ResizeObserver | null = null;

      constructor(private readonly view: EditorView) {
        this.host = document.createElement("div");
        this.host.className = "cm-scroll-markers";
        view.dom.append(this.host);
        opts.onHost(this.host);
        this.schedule(0);
        if (typeof ResizeObserver !== "undefined") {
          this.ro = new ResizeObserver(() => this.measure());
          this.ro.observe(view.scrollDOM);
        }
      }

      /** 帯の縦範囲を `scrollDOM` (スクロールバーの溝) に合わせる。検索パネルなど上に重なるものがあってもずれない。 */
      private measure() {
        const { view } = this;
        view.requestMeasure({
          key: this,
          read: (v) => ({ top: v.scrollDOM.offsetTop, height: v.scrollDOM.offsetHeight }),
          write: ({ top, height }) => {
            const key = `${top}:${height}`;
            if (key === this.measured) return;
            this.measured = key;
            this.host.style.setProperty("--scroll-marker-top", `${top}px`);
            this.host.style.setProperty("--scroll-marker-height", `${height}px`);
          },
        });
      }

      update(u: ViewUpdate) {
        const refresh = u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshScrollMarkers)));
        if (refresh) this.dirty = true;
        this.measure();
        if (!opts.isEnabled()) {
          if (this.active || refresh) this.schedule(0);
          return;
        }
        if (!this.active || u.docChanged) {
          // 文書が変わったときは (層の配列を作らずに) 再計算を予約するだけにする。
          this.dirty = true;
        } else {
          // 層ごとの軽い値だけ見て、変化があるときだけ計算を予約する。
          const s = u.state;
          layers.forEach((l, i) => {
            if (!sameValue(l, this.values[i], l.read(s))) this.dirty = true;
          });
          if (activeStatementRange(s) !== this.activeSpan) this.dirty = true;
        }
        if (this.dirty) this.schedule(u.docChanged && !refresh ? SCROLL_MARKERS_DEBOUNCE_MS : 0);
      }

      destroy() {
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.ro?.disconnect();
        opts.onSnapshot(null);
        opts.onHost(null);
        this.host.remove();
        this.clearClasses();
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
        if (!opts.isEnabled()) {
          this.active = false;
          this.dirty = false;
          this.values = [];
          this.built = [];
          this.reserved = false;
          this.hasMarkers = false;
          this.clearClasses();
          if (this.published !== null) {
            this.published = null;
            opts.onSnapshot(null);
          }
          return;
        }
        const s = view.state;
        let changed = !this.active || this.dirty;
        layers.forEach((l, i) => {
          const v = l.read(s);
          // 文書が変わったら、値が同じでも行番号は変わりうる (offset 同じで改行だけ動く) ので作り直す。
          if (this.active && s.doc === this.builtDoc && sameValue(l, this.values[i], v)) return;
          this.values[i] = v;
          this.built[i] = l.build(v, s);
          changed = true;
        });
        this.active = true;
        this.dirty = false;
        this.builtDoc = s.doc;
        const span = activeStatementRange(s);
        this.activeSpan = span;
        if (!changed) return;
        const sources = this.built.flat();
        const activeLines = span
          ? { from: s.doc.lineAt(span.from).number, to: s.doc.lineAt(Math.min(span.to, s.doc.length)).number }
          : null;
        const prev = this.published;
        const next: ScrollMarkSnapshot = { sources, totalLines: s.doc.lines, activeLines };
        // 前回も今回も印が無ければ、React を再描画させない。
        if (sources.length === 0 && (!prev || prev.sources.length === 0)) {
          this.published = next;
          this.setHas(false);
          return;
        }
        if (
          prev &&
          prev.totalLines === next.totalLines &&
          sameLines(prev.activeLines, next.activeLines) &&
          prev.sources.length === sources.length &&
          prev.sources.every((p, i) => {
            const q = sources[i] as ScrollMarkSource;
            return p.pos === q.pos && p.kind === q.kind && p.label === q.label;
          })
        )
          return;
        this.published = next;
        this.setHas(sources.length > 0);
        opts.onSnapshot(next);
      }

      private clearClasses() {
        this.host.classList.remove("cm-scroll-markers-on", "cm-scroll-markers-empty");
        this.view.scrollDOM.classList.remove("cm-scroller-reserve-markers");
      }

      private setHas(has: boolean) {
        if (this.hasMarkers === has) return;
        this.hasMarkers = has;
        if (has) this.reserved = true;
        // `.cm-editor` の class は CodeMirror がフォーカス・テーマ変更のたびに丸ごと書き換えるので、
        // 触られない要素 (帯の host と scrollDOM) に付ける。
        this.host.classList.toggle("cm-scroll-markers-on", this.reserved);
        this.host.classList.toggle("cm-scroll-markers-empty", this.reserved && !has);
        this.view.scrollDOM.classList.toggle("cm-scroller-reserve-markers", this.reserved);
      }
    },
  );
  return plugin;
}

function sameValue(l: ScrollMarkerLayer, a: unknown, b: unknown): boolean {
  return l.eq ? a !== undefined && l.eq(a, b) : Object.is(a, b);
}
