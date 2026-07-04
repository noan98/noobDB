import { useCallback, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { useT } from "../i18n";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, PressableButton } from "./ui";

/**
 * テーマに追従するカスタム確認ダイアログ。`window.confirm()` を置き換えるために
 * 用意したシンプルな汎用 Yes/No ダイアログで、Chakra Dialog (`Modal`) の上に
 * 構築されている。OS ネイティブの confirm と違い、ライト/ダーク・アクセント色・
 * フォントサイズに追従し、Esc / オーバーレイクリックでキャンセル、フォーカスは
 * 既定で「キャンセル」へ落ちる (誤って Enter で実行が走らない)。
 *
 * 呼び出し側は `useConfirm()` フックを使って `await confirm({...})` の形で
 * Promise<boolean> を受け取る。返ってきた要素 (`dialog`) を JSX 木のどこかに
 * レンダーすると、確認が必要になったタイミングで自動的に表示される。
 *
 * 想定する `tone` と Confirm ボタンの見た目 (安全側優先レイアウトのため、
 * danger/warning はベタ塗りで強調せず、キャンセル側を primary にする):
 *   - "primary"  通常の確認 (タブ復元など)。右端に primary で置く。
 *   - "warning"  注意付き実行 (本番接続など)。左に secondary (非強調) で置く。
 *   - "danger"   破壊的確認。左に dangerOutline (非強調 + 危険色) で置く。
 */

export type ConfirmTone = "primary" | "warning" | "danger";

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

interface PendingState extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

/**
 * Promise ベースの確認ダイアログフック。
 *
 * 戻り値の `confirm` 関数を呼ぶと、ユーザが「確認」を押すまで解決しない
 * Promise<boolean> を返す。`dialog` をどこかにレンダーしておくこと。
 *
 * 例:
 * ```tsx
 * const { confirm, dialog } = useConfirm();
 * // ...
 * const ok = await confirm({ title: "...", message: "..." });
 * if (!ok) return;
 * // ...
 * return <>{children}{dialog}</>;
 * ```
 */
export function useConfirm(): { confirm: (opts: ConfirmOptions) => Promise<boolean>; dialog: ReactNode } {
  const t = useT();
  const [state, setState] = useState<PendingState | null>(null);
  // 重複呼び出しのキューイングは行わず、後から来た confirm に上書きされる前に
  // 一旦キャンセルとして解決する (= UI ループ的に呼び出し側が困らない)。
  const lastResolveRef = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      if (lastResolveRef.current) lastResolveRef.current(false);
      lastResolveRef.current = resolve;
      setState({ ...opts, resolve });
    });
  }, []);

  const close = useCallback((ok: boolean) => {
    setState((cur) => {
      if (cur) cur.resolve(ok);
      lastResolveRef.current = null;
      return null;
    });
  }, []);

  // `AnimatePresence` で包み、確認を閉じる際に exit アニメを再生させてから
  // アンマウントさせる (Modal.tsx の開閉アニメ前提)。
  const dialog: ReactNode = (
    <AnimatePresence>
      {state && (
        <ConfirmDialog
          title={state.title}
          message={state.message}
          confirmLabel={state.confirmLabel ?? t("confirmDefaultOk")}
          cancelLabel={state.cancelLabel ?? t("confirmDefaultCancel")}
          tone={state.tone ?? "primary"}
          onConfirm={() => close(true)}
          onCancel={() => close(false)}
        />
      )}
    </AnimatePresence>
  );

  return { confirm, dialog };
}

interface ConfirmDialogProps {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  tone: ConfirmTone;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({ title, message, confirmLabel, cancelLabel, tone, onConfirm, onCancel }: ConfirmDialogProps) {
  // 既定フォーカスは「キャンセル」へ。stray Enter で実行が走らないようにする
  // (DangerousQueryDialog と同じ方針)。
  const cancelRef = useRef<HTMLButtonElement>(null);
  // 破壊的/注意付き確認 (danger・warning) は安全側優先レイアウトに従い、
  // 実行を左に非強調で置き、キャンセルを右端 + primary にする
  // (DangerousQueryDialog・ModalFooter のガイドラインと同一)。通常の確認 (primary)
  // は他モーダルと同じ「右端 = 主アクション」配置。danger は非強調のまま
  // 危険色を帯びる dangerOutline で「破壊的操作」であることを色でも伝える。
  const destructive = tone !== "primary";

  return (
    <Modal width="440px" onClose={onCancel} initialFocusEl={() => cancelRef.current}>
      <ModalHeader onClose={onCancel} closeLabel={cancelLabel}>
        {title}
      </ModalHeader>
      <ModalBody>{message}</ModalBody>
      <ModalFooter>
        {destructive ? (
          <>
            <Button
              type="button"
              variant={tone === "danger" ? "dangerOutline" : "secondary"}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
            <div style={{ flex: 1 }} />
            <Button ref={cancelRef} type="button" variant="primary" onClick={onCancel}>
              {cancelLabel}
            </Button>
          </>
        ) : (
          <>
            <div style={{ flex: 1 }} />
            <Button ref={cancelRef} type="button" variant="secondary" onClick={onCancel}>
              {cancelLabel}
            </Button>
            <PressableButton type="button" variant="primary" onClick={onConfirm}>
              {confirmLabel}
            </PressableButton>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
