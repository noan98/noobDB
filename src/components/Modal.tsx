import { chakra, Dialog, Portal } from "@chakra-ui/react";
import { motion } from "motion/react";
import type { ComponentProps, ReactNode } from "react";
import { transitions, variants } from "../motion";
import { Button } from "./ui";
import { Icon } from "./Icon";

/**
 * 自前のモーダル/ダイアログ実装を Chakra の `Dialog` (ポータル + バックドロップ +
 * フォーカストラップ + Esc クローズ) に統一するための共通ラッパー。`App.css` の
 * `.modal-overlay` / `.modal` / `.modal-header` / `.modal-body` / `.modal-footer`
 * の見た目を `app.*` トークンの style props で再現する。各モーダルはここから
 * `Modal` / `ModalHeader` / `ModalBody` / `ModalFooter` を import して使い、内部の
 * フォーム要素・ボタンは `ui.tsx` の共通 recipe を使う。
 *
 * 呼び出し側はモーダルを開いているときだけ条件付きでマウントするため、`open` は
 * 既定で true。クローズ操作 (Esc / バックドロップクリック / クローズボタン) は
 * `onOpenChange` 経由で `onClose` に集約され、親側のアンマウントで閉じる。
 *
 * ## 開閉アニメーション (Motion / AnimatePresence)
 *
 * バックドロップの fade と本体の scale/slide を **enter/exit 対称**に動かすため、
 * バックドロップと本体を `motion/react` の `motion.div` で描画する (共有プリセット
 * `variants.fade` / `variants.dialog` + `transitions` を使用)。Chakra/Ark 自身の
 * CSS プリセットアニメは二重掛けになるため `motionPreset="none"` で無効化している。
 *
 * **閉じるアニメ (exit) は呼び出し側の `AnimatePresence` が前提**である。各呼び出し
 * 側は `{cond && }` を `` で包むこと。CSS では
 * アンマウントを動かせないのに対し、`AnimatePresence` はアンマウントされる要素を
 * exit が完了するまで (直前の props のまま) 保持するため、`Modal` の `open` は
 * 開いている間 true のまま据え置き、実際の開閉は親のマウント/アンマウントで行う。
 * `prefers-reduced-motion: reduce` 時は `MotionConfig reducedMotion="user"`
 * (`src/main.tsx`) により enter/exit が自動的に即時化される。
 */

/** バックドロップ/本体を motion 化するためのラッパー。`transition` を Chakra の
 *  style prop に飲まれず motion 側へ渡すため `forwardProps` に含める (TabBar と同方式)。 */
const MotionBackdrop = chakra(motion.div, {}, { forwardProps: ["transition"] });
const MotionContent = chakra(motion.div, {}, { forwardProps: ["transition"] });

interface ModalProps {
  /** 制御された開閉フラグ。条件付きマウント前提で既定 true。 */
  open?: boolean;
  onClose: () => void;
  /** コンテンツ幅。`App.css` の `.modal { width: min(N, 100%) }` を再現する。 */
  width?: string;
  /** バックドロップ (外側) クリックで閉じるか。既定 true。 */
  closeOnInteractOutside?: boolean;
  /** Escape キーで閉じるか。既定 true。 */
  closeOnEscape?: boolean;
  /** 開いたときにフォーカスする要素を返す (例: キャンセルボタン)。 */
  initialFocusEl?: () => HTMLElement | null;
  children: ReactNode;
}

export function Modal({
  open = true,
  onClose,
  width = "760px",
  closeOnInteractOutside = true,
  closeOnEscape = true,
  initialFocusEl,
  children,
}: ModalProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        if (!e.open) onClose();
      }}
      placement="center"
      closeOnInteractOutside={closeOnInteractOutside}
      closeOnEscape={closeOnEscape}
      initialFocusEl={initialFocusEl}
      // 開閉アニメは motion 側で対称に行うため、Chakra/Ark の CSS プリセットは無効化。
      motionPreset="none"
    >
      <Portal>
        {/* バックドロップは Ark の挙動 (外側クリック判定) に必須ではない純粋な装飾
            なので Dialog.Backdrop ではなく motion.div で描画し、recipe アニメとの
            二重掛けを避ける。外側クリックでの close は Content の境界判定で効く。 */}
        <MotionBackdrop
          {...variants.fade}
          transition={transitions.fade}
          css={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            bg: "rgba(0, 0, 0, 0.45)",
            backdropFilter: "blur(2px)",
          }}
        />
        <Dialog.Positioner
          css={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "5",
          }}
        >
          <Dialog.Content asChild>
            <MotionContent
              {...variants.dialog}
              transition={transitions.enter}
              css={{
                display: "flex",
                flexDirection: "column",
                width: `min(${width}, 100%)`,
                maxWidth: `min(${width}, 100%)`,
                maxHeight: "90vh",
                overflow: "hidden",
                bg: "app.surface",
                border: "1px solid",
                borderColor: "app.border",
                borderRadius: "lg",
                boxShadow: "xl",
              }}
            >
              {children}
            </MotionContent>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

interface ModalHeaderProps {
  /** ヘッダタイトル。`Dialog.Title` として描画され aria-labelledby に紐づく。 */
  children: ReactNode;
  onClose: () => void;
  /** クローズボタンの aria-label / title。 */
  closeLabel: string;
  /** クローズボタンを無効化する (例: インポート実行中)。 */
  closeDisabled?: boolean;
  /** タイトル要素への追加 props (例: 省略表示やツールチップ)。 */
  titleProps?: ComponentProps<typeof Dialog.Title>;
}

export function ModalHeader({
  children,
  onClose,
  closeLabel,
  closeDisabled,
  titleProps,
}: ModalHeaderProps) {
  return (
    <Dialog.Header
      css={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "3",
        padding: "12px 16px",
        borderBottom: "1px solid",
        borderColor: "app.border",
        bg: "app.toolbar",
      }}
    >
      <Dialog.Title
        css={{ margin: 0, minWidth: 0, fontSize: "lg", fontWeight: 600, color: "app.text" }}
        {...titleProps}
      >
        {children}
      </Dialog.Title>
      <Button
        type="button"
        variant="ghost"
        onClick={onClose}
        disabled={closeDisabled}
        aria-label={closeLabel}
        title={closeLabel}
        css={{ flex: "none", minWidth: "28px", padding: "4px 8px", fontSize: "base", lineHeight: 1 }}
      >
        <Icon name="close" size={13} />
      </Button>
    </Dialog.Header>
  );
}

type ModalBodyProps = ComponentProps<typeof Dialog.Body>;

export function ModalBody({ children, ...rest }: ModalBodyProps) {
  return (
    <Dialog.Body css={{ flex: 1, overflowY: "auto", padding: "14px 16px" }} {...rest}>
      {children}
    </Dialog.Body>
  );
}

type ModalFooterProps = ComponentProps<typeof Dialog.Footer>;

export function ModalFooter({ children, ...rest }: ModalFooterProps) {
  return (
    <Dialog.Footer
      css={{
        display: "flex",
        alignItems: "center",
        gap: "2",
        padding: "10px 16px",
        borderTop: "1px solid",
        borderColor: "app.border",
        bg: "app.toolbar",
      }}
      {...rest}
    >
      {children}
    </Dialog.Footer>
  );
}
