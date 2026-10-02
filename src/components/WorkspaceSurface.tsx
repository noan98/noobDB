import { useEffect, useRef, type ReactNode } from "react";
import { Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import { useKeepAliveActive } from "./KeepAlive";
import {
  hasOpenNestedLayer,
  isEditableElement,
  resolveWorkspaceEscape,
  WORKSPACE_SURFACE_LABEL_KEYS,
  type ClosableWorkspaceView,
} from "./workspaceEscape";

/**
 * `<main>` を置き換える全画面サーフェス (ER 図・スキーマ比較など) の共通の器 (#1070)。
 *
 * 既存モーダルと同じ「開いたら中へ、閉じたら元へ」のキーボード体験を横展開する:
 *
 * - **開いたらコンテナへフォーカスを移す** (`tabIndex=-1` の領域)。これで Tab の
 *   起点がサーフェス内になり、Escape もすぐ効く。
 * - **閉じたら開く前のフォーカス要素へ戻す** (`useReturnFocus` と同じ方式)。
 *   戻るボタン・Escape のどちらで閉じても同じ。
 * - **Escape で `onClose`** — ただしネストした Modal / ContextMenu / ポップオーバー、
 *   入力欄のローカル Esc を優先する。判定は `workspaceEscape.ts` の純関数で、
 *   レイアウト最大化の Escape (`App.tsx`) と同じ関数を引いて排他にしている。
 *
 * 見た目は持たない (親の flex 列をそのまま子へ引き継ぐだけ)。アニメーションも
 * 追加しない (切替のクロスフェードは `App.tsx` の `AnimatePresence` が持つ)。
 */
export function WorkspaceSurface({
  view,
  onClose,
  children,
}: {
  view: ClosableWorkspaceView;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);

  // レンダー中に「開く前のフォーカス」を記憶する (#1185。`useReturnFocus` と同じ理由:
  // 子の autoFocus が先に走ると開く前の位置が分からなくなる)。その後で下の effect が
  // フォーカスをコンテナへ移す。
  //
  // keep-alive で非表示のまま保持される間 (#1311) は「閉じた」扱いにする: 非アクティブ
  // → アクティブで開いた扱い (記憶してフォーカスを移す)、アクティブ → 非アクティブで
  // 閉じた扱い (記憶した要素へ戻す)。マウント解除も同じ後始末を通る。
  const active = useKeepAliveActive();
  const returnTo = useRef<Element | null>(null);
  const wasActive = useRef(false);
  if (active && !wasActive.current) {
    returnTo.current = document.activeElement;
    wasActive.current = true;
  } else if (!active) {
    wasActive.current = false;
  }
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    // 中身が自前で初期フォーカスを決めた (autoFocus 等) ならそれを尊重する。
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    return () => {
      const back = returnTo.current;
      if (back instanceof HTMLElement && document.contains(back)) back.focus();
    };
  }, [active]);

  // 最新の onClose を参照する (インライン関数で毎レンダ変わってもリスナを張り替えない)。
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    // 非表示の間は Escape に反応しない (見えていないサーフェスが閉じ操作を奪わない)。
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      const action = resolveWorkspaceEscape({
        key: e.key,
        defaultPrevented: e.defaultPrevented,
        isComposing: e.isComposing,
        nestedLayerOpen: hasOpenNestedLayer(document),
        editableFocused: isEditableElement(document.activeElement),
        view,
        // サーフェスを閉じる判定は最大化状態に依らない (サーフェスが常に優先)。
        layoutMaximized: false,
      });
      if (action !== "closeView") return;
      e.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [view, active]);

  return (
    <Flex
      ref={ref}
      role="region"
      aria-label={t(WORKSPACE_SURFACE_LABEL_KEYS[view])}
      tabIndex={-1}
      outline="none"
      direction="column"
      flex="1"
      minH="0"
      minW="0"
      overflow="hidden"
      bg="app.bg"
      data-workspace-surface={view}
    >
      {children}
    </Flex>
  );
}
