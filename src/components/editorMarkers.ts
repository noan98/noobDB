import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type ChangeDesc,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutter, hoverTooltip, type Tooltip } from "@codemirror/view";

/**
 * エディタ上の「範囲 + ガターマーカー」を載せる汎用の部品 (#2330)。
 *
 * 実行時エラーの波線 (#2330) のほか、バッチ実行の各文の成否をガターに積む機能 (#2331) が
 * 同じ仕組みの上に乗れるよう、機能固有の知識 (エラー本文の解釈やヒント) は持たない。
 * 手元の構文チェック (`@codemirror/lint` の `linter` / `setDiagnostics`) とは別の `StateField` で
 * 持つので、互いに上書きし合わない。
 *
 * - 呼び出し側は `createMarkerLayer` で層を 1 つ作り、`extension` をエディタへ載せ、
 *   `set` / `clear` の効果を dispatch して内容を差し替える。
 * - 範囲は文書の変更に追従する。`dropOnEdit` なら、範囲を編集した時点でそのマーカーを捨てる
 *   (波線が指している箇所を直したら消える、という実行エラーの挙動)。
 * - 見た目は CSS クラスだけで決める (`markClass` / `gutterClass` と `-<kind>` 接尾辞)。
 */

/** 層に載せるマーカー 1 件。`D` は呼び出し側がツールチップなどに使う付随データ。 */
export interface EditorMarker<D = unknown> {
  /** 範囲 `[from, to)` (文書オフセット)。ガターのマーカーは `from` のある行に出る。 */
  from: number;
  to: number;
  /** 種別 (`error` / `ok` など)。波線とガターのクラスに `-<kind>` が付く。 */
  kind: string;
  /** false なら波線を引かずガターだけに出す (既定は引く)。 */
  squiggle?: boolean;
  data?: D;
}

/**
 * 文書の変更 `changes` に合わせてマーカーの位置を追従させる。`dropOnEdit` のときは、
 * 範囲と重なる編集 (範囲の内側への挿入を含む) を受けたマーカーを捨てる。範囲の両端での
 * 挿入や、手前 / 後ろの編集では捨てない。
 */
export function mapMarkers<D>(
  markers: readonly EditorMarker<D>[],
  changes: ChangeDesc,
  dropOnEdit: boolean,
): EditorMarker<D>[] {
  const out: EditorMarker<D>[] = [];
  for (const m of markers) {
    if (dropOnEdit && rangeTouched(m.from, m.to, changes)) continue;
    const from = changes.mapPos(m.from, 1);
    const to = Math.max(from, changes.mapPos(m.to, -1));
    out.push({ ...m, from, to });
  }
  return out;
}

/** `[from, to)` と重なる編集があるか (範囲内への挿入も含む。両端での挿入は含まない)。 */
export function rangeTouched(from: number, to: number, changes: ChangeDesc): boolean {
  let touched = false;
  changes.iterChangedRanges((fromA, toA) => {
    if (fromA === toA ? fromA > from && fromA < to : fromA < to && toA > from) touched = true;
  });
  return touched;
}

/** `pos` を覆うマーカー (`from <= pos < to`。空範囲は `pos === from`)。複数なら先頭のもの。 */
export function markerAt<D>(markers: readonly EditorMarker<D>[], pos: number): EditorMarker<D> | null {
  return markers.find((m) => (m.from === m.to ? pos === m.from : pos >= m.from && pos < m.to)) ?? null;
}

export interface MarkerLayerOptions<D> {
  /** 波線に付けるクラス (種別ごとに `${markClass}-${kind}` も付く)。 */
  markClass: string;
  /** ガターのクラス。マーカー要素には `${gutterClass}-glyph` と `${gutterClass}-glyph-${kind}` が付く。 */
  gutterClass: string;
  /** 範囲を編集したらそのマーカーを捨てるか。 */
  dropOnEdit: boolean;
  /** ホバー時のツールチップ本文。null を返せば出さない。省略時はツールチップなし。 */
  renderTooltip?: (marker: EditorMarker<D>, view: EditorView) => HTMLElement | null;
}

export interface MarkerLayer<D> {
  /** エディタの拡張へ載せる (波線 + ガター + ホバー)。 */
  extension: Extension;
  /** 層の内容を丸ごと差し替える効果。空配列で全消去。 */
  set: (markers: readonly EditorMarker<D>[]) => StateEffect<readonly EditorMarker<D>[]>;
  /** 現在のマーカー。 */
  get: (state: EditorState) => readonly EditorMarker<D>[];
}

class GlyphMarker extends GutterMarker {
  constructor(
    private readonly cls: string,
    private readonly kind: string,
  ) {
    super();
  }
  eq(other: GutterMarker): boolean {
    return other instanceof GlyphMarker && other.cls === this.cls && other.kind === this.kind;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = `${this.cls}-glyph ${this.cls}-glyph-${this.kind}`;
    el.setAttribute("aria-hidden", "true");
    return el;
  }
}

/** マーカー層を 1 つ作る。層ごとに独立した `StateField` を持つので、複数作っても干渉しない。 */
export function createMarkerLayer<D = unknown>(opts: MarkerLayerOptions<D>): MarkerLayer<D> {
  const setEffect = StateEffect.define<readonly EditorMarker<D>[]>();
  const field = StateField.define<readonly EditorMarker<D>[]>({
    create: () => [],
    update(markers, tr) {
      let next = markers;
      if (tr.docChanged && next.length > 0) next = mapMarkers(next, tr.changes, opts.dropOnEdit);
      for (const e of tr.effects) {
        if (e.is(setEffect)) {
          const len = tr.newDoc.length;
          next = e.value
            .map((m) => ({ ...m, from: Math.min(m.from, len), to: Math.min(Math.max(m.to, m.from), len) }))
            .sort((a, b) => a.from - b.from);
        }
      }
      return next;
    },
    provide: (f) => [
      EditorView.decorations.compute([f], (state) => {
        const builder = new RangeSetBuilder<Decoration>();
        for (const m of state.field(f)) {
          if (m.squiggle === false || m.to <= m.from) continue;
          builder.add(
            m.from,
            m.to,
            Decoration.mark({ class: `${opts.markClass} ${opts.markClass}-${m.kind}` }),
          );
        }
        return builder.finish();
      }),
    ],
  });

  const gutterExt = gutter({
    class: opts.gutterClass,
    markers: (view) => {
      const builder = new RangeSetBuilder<GutterMarker>();
      let lastLine = -1;
      for (const m of view.state.field(field)) {
        const line = view.state.doc.lineAt(m.from);
        if (line.from === lastLine) continue; // 同じ行には先頭の 1 件だけ
        lastLine = line.from;
        builder.add(line.from, line.from, new GlyphMarker(opts.gutterClass, m.kind));
      }
      return builder.finish();
    },
    initialSpacer: () => new GlyphMarker(opts.gutterClass, "spacer"),
  });

  const hover = opts.renderTooltip
    ? hoverTooltip(
        (view, pos): Tooltip | null => {
          const m = markerAt(view.state.field(field), pos);
          if (!m) return null;
          const dom = opts.renderTooltip?.(m, view);
          if (!dom) return null;
          return { pos: m.from, end: Math.max(m.to, m.from), above: true, create: () => ({ dom }) };
        },
        { hoverTime: 250 },
      )
    : [];

  return {
    extension: [field, gutterExt, hover],
    set: (markers) => setEffect.of(markers),
    get: (state) => state.field(field),
  };
}
