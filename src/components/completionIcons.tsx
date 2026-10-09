import { renderToStaticMarkup } from "react-dom/server";
import { Icon, ICON_SIZES, ICON_STROKE } from "./Icon";
import { completionIconName, type CompletionIconName } from "./sqlSchemaCompletion";

/**
 * 補完ポップアップの種別アイコン (#1413)。CodeMirror 既定の文字グリフ (`::after`) の
 * 代わりに、アプリ共通の `Icon` を静的 HTML にして差し込む (`autocompletion({ icons: false,
 * addToOptions })`)。tabler の直 import や手書きの svg 要素を避け、サイズ / 線幅は
 * `ICON_SIZES` / `ICON_STROKE` のトークンを使う。色は `App.css` の
 * `.cm-completionIcon-<種別>` が CSS 変数で与える。
 */
const markupCache = new Map<CompletionIconName, string>();

function iconMarkup(name: CompletionIconName): string {
  let html = markupCache.get(name);
  if (html === undefined) {
    html = renderToStaticMarkup(<Icon name={name} size={ICON_SIZES.sm} strokeWidth={ICON_STROKE.regular} />);
    markupCache.set(name, html);
  }
  return html;
}

/** 候補 1 件ぶんのアイコン要素。種別が未知でも幅を保つため空の枠は返す。 */
export function renderCompletionIcon(type: string | undefined): HTMLElement {
  const el = document.createElement("span");
  el.className = "cm-completionIcon";
  const name = completionIconName(type);
  if (name) {
    el.classList.add(...(type ?? "").split(/\s+/g).filter(Boolean).map((t) => `cm-completionIcon-${t}`));
    el.innerHTML = iconMarkup(name);
  }
  return el;
}
