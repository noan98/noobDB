import { useEffect, useRef, type ReactNode, type Ref } from "react";
import { useKeepAliveActive } from "./KeepAlive";
import type { ResultGridHandle } from "./ResultGrid";

/**
 * keep-alive 配下の ResultGrid のハンドル登録 (#1309)。
 *
 * ペイン単位の `getGridRefSetter(paneId)` に、**今表示されているグリッドだけ**を登録する。
 * 非表示のまま保持しているタブのグリッドを登録すると、コピー・Find・フォーカスなどの
 * ref 経由の操作が見えていないタブへ飛んでしまうため。アクティブでなくなった時点で外す。
 */
export function ResultGridSlot({
  register,
  children,
}: {
  register: (h: ResultGridHandle | null) => void;
  children: (ref: Ref<ResultGridHandle>) => ReactNode;
}) {
  const active = useKeepAliveActive();
  const localRef = useRef<ResultGridHandle | null>(null);
  useEffect(() => {
    if (!active) return;
    register(localRef.current);
    return () => register(null);
  }, [active, register]);
  return <>{children(localRef)}</>;
}
