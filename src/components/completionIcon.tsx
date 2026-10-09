import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Icon } from "./Icon";
import { completionIconName, completionKind, type CompletionKind } from "./sqlCompletionSchema";

const cache = new Map<CompletionKind, Node>();

/** 切り離した要素へ `<Icon>` を一度だけ描画してキャッシュする (描画のたびに cloneNode)。 */
function iconNode(kind: CompletionKind): Node | null {
  let node = cache.get(kind);
  if (!node) {
    const host = document.createElement("span");
    const root = createRoot(host);
    flushSync(() => root.render(<Icon name={completionIconName(kind)} size="sm" />));
    if (!host.firstChild) return null;
    node = host.firstChild;
    cache.set(kind, node);
    root.unmount();
  }
  return node.cloneNode(true);
}

/**
 * 補完候補の種別アイコン (`autocompletion({ addToOptions })` の render)。
 * `Icon.tsx` の語彙を使い、色は `App.css` の `.cm-completionKindIcon-*` が `var()` で与える。
 * 未知の種別も同幅の空 span を返して行頭を揃える。
 */
export function renderCompletionKindIcon(completion: { type?: string }): Node {
  const kind = completionKind(completion.type);
  const el = document.createElement("span");
  el.className = `cm-completionKindIcon${kind ? ` cm-completionKindIcon-${kind}` : ""}`;
  const icon = kind ? iconNode(kind) : null;
  if (icon) el.appendChild(icon);
  return el;
}

// React のライフサイクル中に初回の flushSync が走って警告になるのを避けるため、
// 読み込み時に全種別を先に描画しておく (DOM が無い環境では何もしない)。
if (typeof document !== "undefined") {
  for (const kind of ["table", "column", "keyword", "function"] as const) iconNode(kind);
}
