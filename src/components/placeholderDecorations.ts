import { RangeSetBuilder, type Extension } from "@codemirror/state";
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

/** これより長い文書は装飾しない (キー入力ごとの全体走査を避ける)。 */
const MAX_DECORATED_LENGTH = 200_000;

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
      constructor(view: EditorView) {
        this.driver = getDriver();
        this.decorations = build(view, this.driver);
      }
      update(u: ViewUpdate) {
        const driver = getDriver();
        if (u.docChanged || driver !== this.driver) {
          this.driver = driver;
          this.decorations = build(u.view, driver);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
  const tooltip = hoverTooltip((view, pos) => {
    const doc = view.state.doc;
    if (doc.length > MAX_DECORATED_LENGTH) return null;
    const hit = findPlaceholderRanges(doc.toString(), getDriver()).find(
      (r) => pos >= r.start && pos <= r.end,
    );
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
