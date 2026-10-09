import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "./Icon";
import { completionIconName, completionKind } from "./sqlCompletionSchema";

const cache = new Map<string, string>();

/**
 * `Icon.tsx` の語彙を静的マークアップにして使う。
 * 色は `App.css` の `.cm-completionKindIcon-*` が `var()` で与える。
 * `<Icon>` を静的マークアップにして使う。色は `App.css` の `.cm-completionKindIcon-*` が `var()` で与える。
 */
export function renderCompletionKindIcon(completion: { type?: string }): Node | null {
  const kind = completionKind(completion.type);
  if (!kind) return null;
  let html = cache.get(kind);
  if (html === undefined) {
    html = renderToStaticMarkup(<Icon name={completionIconName(kind)} size="sm" />);
    cache.set(kind, html);
  }
  const el = document.createElement("span");
  el.className = `cm-completionKindIcon cm-completionKindIcon-${kind}`;
  el.innerHTML = html;
  return el;
}
