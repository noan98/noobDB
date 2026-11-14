import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type ChangeDesc,
  type ChangeSet,
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
 *
 * #2331 (バッチ実行の各文の成否をガターに積む) は次の拡張点を使う:
 * - `renderGutter`: ガターのマーカー DOM を呼び出し側が描く (成功 / 失敗 / 所要時間 / スピナー)。
 *   同じ行に複数のマーカーがあるときは、その行のマーカー全部を渡す (合成は呼び出し側が決める)。
 * - `dataEq`: 描画データの比較。差があるときだけガター要素を作り直す (CSS アニメーションを再生し直さない)。
 * - `onGutterClick` / `gutterLabel`: ガターを `<button>` にしてクリック・キーボード (Enter / Space) で操作できる。
 * - `onEdit`: `"drop"` (捨てる) / `"stale"` (`stale: true` にして残す) / `"keep"` (そのまま追従)。
 * - `update`: 位置を保ったまま、現在のマーカーを関数で書き換える効果 (状態の更新用。編集で動いた位置を巻き戻さない)。
 * - `gutter: false`: 波線とホバーだけを使い、ガター列を増やさない層。
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
  /** 範囲を編集されて位置が信用できなくなった (`onEdit: "stale"` の層が立てる)。見た目は呼び出し側が薄くする。 */
  stale?: boolean;
  data?: D;
}

/** 範囲を編集されたときの扱い。 */
export type EditMode = "drop" | "stale" | "keep";

/**
 * 文書の変更 `changes` に合わせてマーカーの位置を追従させる。範囲と重なる編集 (範囲の端・内側への挿入を
 * 含む) を受けたマーカーは `"drop"` なら捨てる。`"stale"` は範囲の中身を変える編集 (内側への編集と、文の外側ではない端への挿入。
 * 空白・`;` だけの端への挿入は除く) を受けたものを `stale: true` にして残す。手前 / 後ろの編集ではどちらでも何もしない。`mode` の boolean は旧呼び出し (#2330) との互換で、true = `"drop"`、false = `"keep"`。
 */
export function mapMarkers<D>(
  markers: readonly EditorMarker<D>[],
  changes: ChangeDesc | ChangeSet,
  mode: EditMode | boolean,
): EditorMarker<D>[] {
  const m0: EditMode = mode === true ? "drop" : mode === false ? "keep" : mode;
  const out: EditorMarker<D>[] = [];
  for (const m of markers) {
    // `"stale"` は端への純粋な挿入 (直前の改行や直後の文の追加) では古い扱いにしない。`"drop"` は従来どおり端も含める。
    const touched =
      m0 === "drop"
        ? rangeTouched(m.from, m.to, changes)
        : m0 === "stale" && rangeInvaded(m.from, m.to, changes);
    if (touched && m0 === "drop") continue;
    const from = changes.mapPos(m.from, 1);
    const to = Math.max(from, changes.mapPos(m.to, -1));
    out.push(touched ? { ...m, from, to, stale: true } : { ...m, from, to });
  }
  return out;
}

/**
 * `[from, to)` の中身を変える編集があるか (`stale` 判定用)。内側に食い込む編集は常に該当する。範囲の端への
 * 純粋な挿入は、挿入文の内容で見分ける (`changes` が `ChangeSet` で挿入文が分かるときだけ):
 * 文の外側の挿入 (先頭側が空白・`;` で終わる / 末尾側が空白・`;` で始まる) は無害、それ以外 (`SELECT 1;` の
 * `;` 直前に `0` を足す、先頭に文字を足す) は文の中身が変わるので該当する。`ChangeDesc` だけのときは無害とみなす。
 */
function rangeInvaded(from: number, to: number, changes: ChangeDesc | ChangeSet): boolean {
  let hit = false;
  const outside = (text: string, atStart: boolean): boolean => {
    if (text.length === 0) return true;
    const ch = atStart ? text[text.length - 1] : text[0];
    return ch === ";" || /\s/.test(ch ?? "");
  };
  if ("iterChanges" in changes) {
    changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (fromA !== toA) {
        if (fromA < to && toA > from) hit = true;
      } else if (fromA > from && fromA < to) {
        hit = true;
      } else if (fromA === from || fromA === to) {
        const text = inserted.toString();
        if (!outside(text, fromA === from)) hit = true;
      }
    });
    return hit;
  }
  changes.iterChangedRanges((fromA, toA) => {
    if (fromA === toA ? fromA > from && fromA < to : fromA < to && toA > from) hit = true;
  });
  return hit;
}

/** `[from, to)` と重なる編集があるか (範囲の端・内側への挿入も含む)。 */
export function rangeTouched(from: number, to: number, changes: ChangeDesc): boolean {
  let touched = false;
  changes.iterChangedRanges((fromA, toA) => {
    if (fromA === toA ? fromA >= from && fromA <= to : fromA < to && toA > from) touched = true;
  });
  return touched;
}

/** `pos` を覆うマーカー (`from <= pos < to`。空範囲は `pos === from`。`side < 0` の末端 `pos === to` も含む)。複数なら先頭のもの。 */
export function markerAt<D>(
  markers: readonly EditorMarker<D>[],
  pos: number,
  side = 0,
): EditorMarker<D> | null {
  return (
    markers.find((m) =>
      m.from === m.to ? pos === m.from : pos >= m.from && (pos < m.to || (side < 0 && pos === m.to)),
    ) ?? null
  );
}

export interface MarkerLayerOptions<D> {
  /** 波線に付けるクラス (種別ごとに `${markClass}-${kind}` も付く)。 */
  markClass: string;
  /** ガターのクラス。マーカー要素には `${gutterClass}-glyph` と `${gutterClass}-glyph-${kind}` が付く。 */
  gutterClass: string;
  /** 範囲を編集したときの扱い (捨てる / 古い印にして残す / そのまま追従)。 */
  onEdit: EditMode;
  /** false ならガター列を作らない (波線とホバーだけの層)。既定は true。 */
  gutter?: boolean;
  /**
   * ガターのマーカー DOM を描く。同じ行のマーカーが全部渡る (空にはならない)。省略時は先頭 1 件の丸印
   * (`${gutterClass}-glyph` / `-glyph-${kind}`、`stale` なら `-glyph-stale` も)。
   */
  renderGutter?: (markers: readonly EditorMarker<D>[], view: EditorView) => HTMLElement;
  /** ガターに出すマーカーかどうか。省略時はすべて出す (波線やホバーには影響しない)。 */
  showInGutter?: (marker: EditorMarker<D>) => boolean;
  /** ガター列の幅を決めるダミー要素。省略時は丸印の大きさ。表示内容が変わっても列の幅を動かしたくないときに使う。 */
  renderSpacer?: () => HTMLElement;
  /** `data` の比較。省略時は浅い比較。差がなければガター要素を作り直さない。 */
  dataEq?: (a: D | undefined, b: D | undefined) => boolean;
  /**
   * 指定すると、ガターのマーカーを `<button>` で包み、クリック / Enter / Space でこれを呼ぶ。
   * `gutterLabel` を `aria-label` にする。
   */
  onGutterClick?: (markers: readonly EditorMarker<D>[], view: EditorView) => void;
  gutterLabel?: (markers: readonly EditorMarker<D>[]) => string;
  /** ホバー時のツールチップ本文。null を返せば出さない。省略時はツールチップなし。 */
  renderTooltip?: (marker: EditorMarker<D>, view: EditorView) => HTMLElement | null;
}

export interface MarkerLayer<D> {
  /** エディタの拡張へ載せる (波線 + ガター + ホバー)。 */
  extension: Extension;
  /** 層の内容を丸ごと差し替える効果。空配列で全消去。 */
  set: (markers: readonly EditorMarker<D>[]) => StateEffect<readonly EditorMarker<D>[]>;
  /** 現在のマーカーを関数で書き換える効果。編集で動いた位置を保ったまま、`data` などだけを更新できる。 */
  update: (
    fn: (markers: readonly EditorMarker<D>[]) => readonly EditorMarker<D>[],
  ) => StateEffect<(markers: readonly EditorMarker<D>[]) => readonly EditorMarker<D>[]>;
  /** 現在のマーカー。 */
  get: (state: EditorState) => readonly EditorMarker<D>[];
}

function shallowEq(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** 1 行ぶんのマーカー (同じ行に複数あれば全部)。 */
class GroupMarker<D> extends GutterMarker {
  constructor(
    private readonly opts: MarkerLayerOptions<D>,
    readonly group: readonly EditorMarker<D>[],
  ) {
    super();
  }
  eq(other: GutterMarker): boolean {
    if (!(other instanceof GroupMarker) || other.opts !== this.opts) return false;
    if (other.group.length !== this.group.length) return false;
    const dataEq = this.opts.dataEq ?? shallowEq;
    return this.group.every((m, i) => {
      const o = other.group[i] as EditorMarker<D>;
      return m.kind === o.kind && !!m.stale === !!o.stale && dataEq(m.data, o.data);
    });
  }
  toDOM(view: EditorView): HTMLElement {
    const { opts, group } = this;
    const first = group[0] as EditorMarker<D>;
    let el: HTMLElement;
    if (opts.renderGutter) {
      el = opts.renderGutter(group, view);
    } else {
      el = document.createElement("span");
      el.className = `${opts.gutterClass}-glyph ${opts.gutterClass}-glyph-${first.kind}${first.stale ? ` ${opts.gutterClass}-glyph-stale` : ""}`;
    }
    const onClick = opts.onGutterClick;
    if (!onClick) {
      el.setAttribute("aria-hidden", "true");
      return el;
    }
    // クリックとキーボード (Enter / Space は button が click に変換する) を 1 つのハンドラで受ける。
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `${opts.gutterClass}-btn`;
    // CodeMirror は `.cm-gutters` を aria-hidden にするので、ボタンはマウス専用 (Tab 順に並べない)。
    // キーボードの操作はショートカット (カーソル位置の文の結果を表示) が受け持つ。
    btn.tabIndex = -1;
    const label = opts.gutterLabel?.(group);
    if (label) btn.setAttribute("aria-label", label);
    btn.append(el);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      onClick(group, view);
    });
    return btn;
  }
}

class SpacerMarker extends GutterMarker {
  constructor(
    private readonly cls: string,
    private readonly render?: () => HTMLElement,
  ) {
    super();
  }
  eq(other: GutterMarker): boolean {
    return other instanceof SpacerMarker && other.cls === this.cls && other.render === this.render;
  }
  toDOM(): HTMLElement {
    if (this.render) {
      const dummy = this.render();
      dummy.classList.add(`${this.cls}-spacer`);
      dummy.setAttribute("aria-hidden", "true");
      return dummy;
    }
    const el = document.createElement("span");
    el.className = `${this.cls}-glyph ${this.cls}-glyph-spacer`;
    el.setAttribute("aria-hidden", "true");
    return el;
  }
}

/** マーカー層を 1 つ作る。層ごとに独立した `StateField` を持つので、複数作っても干渉しない。 */
export function createMarkerLayer<D = unknown>(opts: MarkerLayerOptions<D>): MarkerLayer<D> {
  const setEffect = StateEffect.define<readonly EditorMarker<D>[]>();
  type Updater = (markers: readonly EditorMarker<D>[]) => readonly EditorMarker<D>[];
  const updateEffect = StateEffect.define<Updater>();
  const clampSort = (list: readonly EditorMarker<D>[], len: number) =>
    list
      .map((m) => ({ ...m, from: Math.min(m.from, len), to: Math.min(Math.max(m.to, m.from), len) }))
      .sort((a, b) => a.from - b.from);
  const field = StateField.define<readonly EditorMarker<D>[]>({
    create: () => [],
    update(markers, tr) {
      let next = markers;
      if (tr.docChanged && next.length > 0) next = mapMarkers(next, tr.changes, opts.onEdit);
      for (const e of tr.effects) {
        if (e.is(setEffect)) next = clampSort(e.value, tr.newDoc.length);
        else if (e.is(updateEffect)) next = clampSort(e.value(next), tr.newDoc.length);
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
            Decoration.mark({
              class: `${opts.markClass} ${opts.markClass}-${m.kind}${m.stale ? ` ${opts.markClass}-stale` : ""}`,
            }),
          );
        }
        return builder.finish();
      }),
    ],
  });

  const gutterExt =
    opts.gutter === false
      ? []
      : gutter({
          class: opts.gutterClass,
          markers: (view) => {
            const builder = new RangeSetBuilder<GutterMarker>();
            // 同じ行のマーカーは 1 つの印へまとめる (呼び出し側の描画へ全部渡す)。
            const groups: EditorMarker<D>[][] = [];
            let lastLine = -1;
            for (const m of view.state.field(field)) {
              if (opts.showInGutter && !opts.showInGutter(m)) continue;
              const line = view.state.doc.lineAt(m.from);
              if (line.from === lastLine) groups[groups.length - 1]?.push(m);
              else {
                lastLine = line.from;
                groups.push([m]);
              }
            }
            for (const g of groups) {
              const lineFrom = view.state.doc.lineAt((g[0] as EditorMarker<D>).from).from;
              builder.add(lineFrom, lineFrom, new GroupMarker(opts, g));
            }
            return builder.finish();
          },
          initialSpacer: () => new SpacerMarker(opts.gutterClass, opts.renderSpacer),
        });

  const hover = opts.renderTooltip
    ? hoverTooltip(
        (view, pos, side): Tooltip | null => {
          const m = markerAt(view.state.field(field), pos, side);
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
    update: (fn) => updateEffect.of(fn),
    get: (state) => state.field(field),
  };
}
