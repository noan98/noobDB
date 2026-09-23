import { useEffect, useRef, type ReactNode } from "react";
import { Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import { useReturnFocus } from "../keyboardNav";
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
 * - **閉じたら開く前のフォーカス要素へ戻す** (`keyboardNav.ts` の `useReturnFocus`)。
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

  // 宣言順が重要: useReturnFocus の effect が先に走って「開く前のフォーカス」を
  // 記憶し、その後で下の effect がフォーカスをコンテナへ移す。
  useReturnFocus();
  useEffect(() => {
    const el = ref.current;
    // 中身が自前で初期フォーカスを決めた (autoFocus 等) ならそれを尊重する。
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, []);

  // 最新の onClose を参照する (インライン関数で毎レンダ変わってもリスナを張り替えない)。
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
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
  }, [view]);

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
      data-workspace-surface={view}
    >
      {children}
    </Flex>
  );
}
