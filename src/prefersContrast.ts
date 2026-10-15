import { useSyncExternalStore } from "react";

// OS の「コントラストを上げる」設定 (`prefers-contrast: more`, #1631) を購読する。
// matchMedia が無い環境 (jsdom など) では常に false。

const QUERY = "(prefers-contrast: more)";

function mql(): MediaQueryList | null {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(QUERY)
      : null;
  } catch {
    return null;
  }
}

function subscribe(cb: () => void): () => void {
  const m = mql();
  if (!m || typeof m.addEventListener !== "function") return () => {};
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}

function getSnapshot(): boolean {
  return mql()?.matches ?? false;
}

export function usePrefersMoreContrast(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
