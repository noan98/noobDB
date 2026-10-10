import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Icon, ICON_SIZES, ICON_STROKE } from "./Icon";
import { completionIconName, type CompletionIconName } from "./sqlSchemaCompletion";

/**
 * 補完ポップアップの種別アイコン (#1413)。CodeMirror 既定の文字グリフ (`::after`) の
 * 代わりに、アプリ共通の `Icon` を DOM にして差し込む (`autocompletion({ icons: false,
 * addToOptions })`)。tabler の直 import や手書きの svg 要素を避け、サイズ / 線幅は
 * `ICON_SIZES` / `ICON_STROKE` のトークンを使う。色は `App.css` の
 * `.cm-completionIcon-<アイコン名>` が CSS 変数で与える。
 *
 * 描画は `react-dom/client` (本体に既にある) で種別ごとに 1 回だけ行い、以後は
 * `cloneNode` で使い回す。`react-dom/server` を引くとエディタのチャンクが数倍になる。
 */
const templateCache = new Map<CompletionIconName, Element>();

/**
 * 種別ごとに `Icon` を一度だけ描いたテンプレート。React のレンダー / コミット中 (補完の
 * 再構成が `useEffect` から走るときなど) は `flushSync` が効かず要素が得られないので、
 * その場合は null を返し (キャッシュしない)、次の呼び出しで描き直す。
 */
function iconTemplate(name: CompletionIconName): Element | null {
  const cached = templateCache.get(name);
  if (cached) return cached;
  const host = document.createElement("span");
  const root = createRoot(host);
  flushSync(() => {
    root.render(<Icon name={name} size={ICON_SIZES.sm} strokeWidth={ICON_STROKE.regular} />);
  });
  const first = host.firstElementChild;
  root.unmount();
  if (!first) return null;
  const tpl = first.cloneNode(true) as Element;
  templateCache.set(name, tpl);
  return tpl;
}

/**
 * 全種別のテンプレートを先に描いておく。モジュール読み込み時は React の描画の外なので
 * `flushSync` が確実に効く。
 */
for (const name of ["table", "database", "columns", "link", "routine", "braces", "hash"] as const) {
  iconTemplate(name);
}

/** 候補 1 件ぶんのアイコン要素。種別が未知でも幅を保つため空の枠は返す。 */
export function renderCompletionIcon(type: string | undefined): HTMLElement {
  const el = document.createElement("span");
  el.className = "cm-completionIcon";
  const name = completionIconName(type);
  if (name) {
    el.classList.add(`cm-completionIcon-${name}`);
    const tpl = iconTemplate(name);
    if (tpl) el.append(tpl.cloneNode(true));
  }
  return el;
}
