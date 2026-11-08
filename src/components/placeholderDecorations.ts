import { RangeSetBuilder, StateEffect, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  hoverTooltip,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { findPlaceholderRanges } from "../queryParams";

/**
 * SQL エディタのプレースホルダ装飾 (#2155)。`{{name}}` と、ネイティブの `?` / `$n` / `:name` を淡いチップで
 * 示し、実行するまでパラメータ化された SQL だと分からない状態をなくす。位置の計算は
 * `queryParams.ts` の `findPlaceholderRanges` (純関数) が担い、文字列・コメント・引用識別子の中や
 * `::cast`・jsonb の `?` 演算子は拾わない。見た目は App.css の `.cm-query-placeholder` (`--syntax-*` 由来)。
 */

const placeholderMark = Decoration.mark({ class: "cm-query-placeholder" });

/** これより長い文書は装飾しない (全体走査のコストを抑える)。 */
const MAX_DECORATED_LENGTH = 200_000;

/** 打鍵が落ち着いてから全体を走査し直すまでの待ち時間 (ms)。打鍵中は既存の装飾を変更位置に追従させるだけにする
 *  (#1316: 打鍵ごとに Text 全体を文字列化しない)。 */
const REBUILD_DELAY_MS = 150;

const rebuildEffect = StateEffect.define<null>();

function build(view: EditorView, driver: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  if (doc.length > MAX_DECORATED_LENGTH) return builder.finish();
  for (const r of findPlaceholderRanges(doc.toString(), driver)) {
    builder.add(r.start, r.end, placeholderMark);
  }
  return builder.finish();
}

/**
 * @param getDriver 現在のドライバ (接続の切り替えに追従するため関数で受ける)。
 * @param getHint ホバー時に出す文言 (翻訳済み)。
 */
export function placeholderDecorations(getDriver: () => string, getHint: () => string): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      driver: string;
      timer: ReturnType<typeof setTimeout> | null = null;
      constructor(view: EditorView) {
        this.driver = getDriver();
        this.decorations = build(view, this.driver);
      }
      update(u: ViewUpdate) {
        const driver = getDriver();
        const requested = u.transactions.some((tr) => tr.effects.some((e) => e.is(rebuildEffect)));
        if (requested || driver !== this.driver) {
          this.driver = driver;
          this.decorations = build(u.view, driver);
          return;
        }
        if (u.docChanged) {
          // 打鍵中は位置だけ追従させ、走査し直しは入力が落ち着いてから。
          this.decorations = this.decorations.map(u.changes);
          this.schedule(u.view);
        }
      }
      schedule(view: EditorView) {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          view.dispatch({ effects: rebuildEffect.of(null) });
        }, REBUILD_DELAY_MS);
      }
      destroy() {
        if (this.timer !== null) clearTimeout(this.timer);
      }
    },
    { decorations: (v) => v.decorations },
  );
  const tooltip = hoverTooltip((view, pos) => {
    // 走査し直さず、作成済みの装飾から当たりを引く。
    let hit = null as { start: number; end: number } | null;
    view.plugin(plugin)?.decorations.between(pos, pos, (from, to) => {
      if (pos >= from && pos < to) {
        hit = { start: from, end: to };
        return false;
      }
      return undefined;
    });
    if (!hit) return null;
    return {
      pos: hit.start,
      end: hit.end,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "cm-query-placeholder-tip";
        dom.textContent = getHint();
        return { dom };
      },
    };
  });
  return [plugin, tooltip];
}
