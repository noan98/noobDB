import { chakra, Dialog, Portal } from "@chakra-ui/react";
import { motion, useIsPresent } from "motion/react";
import { useId, useState } from "react";
import type { ComponentProps, KeyboardEvent, PointerEvent, ReactNode } from "react";
import { transitions, variants } from "../motion";
import { Button } from "./ui";
import { Icon, ICON_SIZES } from "./Icon";
import { Tooltip } from "./Tooltip";
import { rejectSubmit } from "./submitRejectFeedback";
import { isModalSubmitKey, pickModalKeys } from "./modalKeys";

/**
 * Chakra の `Dialog` (ポータル + バックドロップ +
 * フォーカストラップ + Esc クローズ) に乗せた共通モーダルラッパー。各モーダルはここから
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

/**
 * 全画面のバックドロップ。ぼかし (`backdrop-filter`) は、フェード中に毎フレーム
 * 背後の内容ぶん再計算されるため、入場アニメーションが完了してから付け、退場が
 * 始まったら外す (#1322)。フェード中は `--overlay` の色だけで暗くする。
 * ぼかしは 2px と弱く、付与の瞬間の変化は目立たない。
 */
function ModalBackdrop() {
  const isPresent = useIsPresent();
  const [settled, setSettled] = useState(false);
  return (
    <MotionBackdrop
      {...variants.fade}
      transition={transitions.fade}
      onAnimationComplete={() => setSettled(true)}
      data-blurred={settled && isPresent ? "" : undefined}
      css={{
        position: "fixed",
        inset: 0,
        zIndex: "modal",
        bg: "var(--overlay)",
        "&[data-blurred]": { backdropFilter: "blur(2px)" },
      }}
    />
  );
}

interface ModalProps {
  /** 制御された開閉フラグ。条件付きマウント前提で既定 true。 */
  open?: boolean;
  onClose: () => void;
  /** コンテンツ幅。`min(width, 100%)` として適用される。 */
  width?: string;
  /** バックドロップ (外側) クリックで閉じるか。既定 true。 */
  closeOnInteractOutside?: boolean;
  /** Escape キーで閉じるか。既定 true。 */
  closeOnEscape?: boolean;
  /**
   * 開いたときにフォーカスする要素を返す (例: キャンセルボタン)。省略時は本文の最初の
   * 操作できる要素 (`firstBodyFocusable`)。ヘッダ右上の × に当てると、開いた瞬間に
   * 「閉じる」の吹き出しが出て見出しに重なるため、既定では避ける。
   */
  initialFocusEl?: () => HTMLElement | null;
  /**
   * 主アクション (フッター右端の primary ボタンと同じ処理)。渡すと
   * **Cmd/Ctrl+Enter** でどのフィールドからでも実行できる (#1114、`modalKeys.ts`)。
   * 破壊的な確認ダイアログには渡さない (`designTokens.test.ts` が免除リストで管理)。
   */
  onSubmit?: () => void;
  /**
   * 主アクションのボタンが無効なときは true。キーボードからも実行せず、Cmd/Ctrl+Enter と
   * 無効な主ボタン (フッター最後のボタン) の pointerdown には共有の「拒否」演出
   * (`data-submit-rejected` + `submit-reject-shake`、#1831) を一度だけ返す。
   */
  submitDisabled?: boolean;
  /**
   * 処理中 (保存中・実行中など) で無効なときは true。拒否は「入力が足りない」ことを伝える
   * 演出なので、処理中は揺らさずスクロールもしない (キー操作は握り潰すだけ)。
   */
  submitBusy?: boolean;
  children: ReactNode;
}

/** 本文 (`ModalBody`) の中で最初にフォーカスできる要素。無ければ null (Ark の既定に任せる)。 */
const BODY_FOCUSABLE =
  "input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex='-1'])";
export function firstBodyFocusable(root: ParentNode | null): HTMLElement | null {
  const body = root?.querySelector("[data-modal-body]");
  const first = body?.querySelector<HTMLElement>(BODY_FOCUSABLE) ?? null;
  // ラジオグループは選択中の項目に当てる (矢印キーでの移動の起点になる)。
  if (first instanceof HTMLInputElement && first.type === "radio" && first.name) {
    const checked = body?.querySelector<HTMLElement>(
      `input[type='radio'][name="${CSS.escape(first.name)}"]:checked`,
    );
    if (checked) return checked;
  }
  return first;
}

export function Modal({
  open = true,
  onClose,
  width = "760px",
  closeOnInteractOutside = true,
  closeOnEscape = true,
  initialFocusEl,
  onSubmit,
  submitDisabled = false,
  submitBusy = false,
  children,
}: ModalProps) {
  // 入れ子のモーダルでも自分の本文だけを探せるよう、コンテンツに一意の印を付ける。
  const modalId = useId();
  const defaultInitialFocus = () =>
    firstBodyFocusable(document.querySelector(`[data-modal-id="${CSS.escape(modalId)}"]`));
  const onContentKeyDown = onSubmit
    ? (e: KeyboardEvent<HTMLDivElement>) => {
        // ポータルで描画した子 (確認ダイアログなど) のキーは React ツリー上で親へ伝わるが、
        // DOM 上はこのモーダルの外。外側フォームの送信を再発火させない (#1604)。
        if (!e.currentTarget.contains(e.target as Node)) return;
        if (!isModalSubmitKey(pickModalKeys(e))) return;
        e.preventDefault();
        // 主アクションが無効なときは実行せず、拒否を一度だけ視覚で返す (#1831)。
        if (submitDisabled) {
          if (!submitBusy) rejectSubmit(e.currentTarget);
          return;
        }
        onSubmit();
      }
    : undefined;
  // disabled な主ボタンはクリックが来ないが、pointer 系イベントは祖先へ届く環境がある。
  // 届かない環境では何も起きないだけ。主ボタンはフッター最後のボタン (補助 → キャンセル →
  // 主アクション、破壊的でも「実行 (左)」は対象外) として構造から識別する。
  const onContentPointerDown =
    onSubmit && submitDisabled && !submitBusy
      ? (e: PointerEvent<HTMLDivElement>) => {
          // ポータルの子モーダルからの伝播は除外する。
          if (!e.currentTarget.contains(e.target as Node)) return;
          const btn = (e.target as Element).closest?.("button:disabled");
          const footer = btn?.closest("[data-modal-footer]");
          if (!btn || !footer) return;
          // 主ボタンはフッター内の文書順で最後のボタン。ラッパー (Tooltip の span など) に
          // 入っていても、兄弟内の最後 (`:last-of-type`) ではなく文書順で比べる。
          const buttons = footer.querySelectorAll("button");
          if (buttons[buttons.length - 1] !== btn) return;
          rejectSubmit(e.currentTarget);
        }
      : undefined;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        if (!e.open) onClose();
      }}
      placement="center"
      closeOnInteractOutside={closeOnInteractOutside}
      closeOnEscape={closeOnEscape}
      initialFocusEl={initialFocusEl ?? defaultInitialFocus}
      // 開閉アニメは motion 側で対称に行うため、Chakra/Ark の CSS プリセットは無効化。
      motionPreset="none"
    >
      <Portal>
        {/* バックドロップは Ark の挙動 (外側クリック判定) に必須ではない純粋な装飾
            なので Dialog.Backdrop ではなく motion.div で描画し、recipe アニメとの
            二重掛けを避ける。外側クリックでの close は Content の境界判定で効く。 */}
        <ModalBackdrop />
        <Dialog.Positioner
          css={{
            position: "fixed",
            inset: 0,
            zIndex: "modal",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "5",
          }}
        >
          <Dialog.Content asChild>
            <MotionContent
              data-modal-id={modalId}
              {...variants.dialog}
              transition={transitions.enter}
              onKeyDown={onContentKeyDown}
              onPointerDown={onContentPointerDown}
              css={{
                display: "flex",
                flexDirection: "column",
                width: `min(${width}, 100%)`,
                maxWidth: `min(${width}, 100%)`,
                // 開いたまま幅が変わるモーダル (Ask Agent の 2 ペイン化) で幅を滑らかに広げる。
                // reduced-motion では App.css の全体ルールが transition を止める。
                transition: "width var(--dur-med) var(--ease-out), max-width var(--dur-med) var(--ease-out)",
                maxHeight: "90vh",
                overflow: "hidden",
                bg: "app.surface",
                border: "1px solid",
                borderColor: "app.border",
                borderRadius: "lg",
                boxShadow: "elevationModal",
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
  /** ヘッダ下端にブランドグラデーションの極細罫線を敷く (#1878)。学習の目的地 (設定・ヘルプ) 用。
   *  値は App.css の `--hero-rule` が単一ソースで、hc-* では `--hero-rule-display: none` で消える。 */
  brandRule?: boolean;
}

export function ModalHeader({
  children,
  onClose,
  closeLabel,
  closeDisabled,
  titleProps,
  brandRule,
}: ModalHeaderProps) {
  return (
    <Dialog.Header
      css={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "3",
        py: "3",
        px: "4",
        borderBottom: "1px solid",
        borderColor: "app.border",
        bg: "app.toolbar",
        ...(brandRule ? { position: "relative" } : {}),
      }}
    >
      <Dialog.Title textStyle="heading" css={{ margin: 0, minWidth: 0 }} {...titleProps}>
        {children}
      </Dialog.Title>
      {/* アイコンのみのクローズボタンなので、ラベルは共有 `Tooltip` (#884) で出す。
          `closeDisabled` のときはブラウザがタブ順序から外すため
          `focusableWrapper` でキーボードからも到達できるようにする。 */}
      {/* 右上端のボタンなので左側 (ヘッダ内の空き) へ出す。既定の "top" だと画面上端に
          近いモーダルで下へフリップし、直下の主要ボタンに重なる (#1272)。 */}
      <Tooltip label={closeLabel} placement="left" focusableWrapper={closeDisabled}>
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          disabled={closeDisabled}
          aria-label={closeLabel}
          css={{ flex: "none", minWidth: "28px", py: "1", px: "2", fontSize: "base", lineHeight: 1 }}
        >
          <Icon name="close" size={ICON_SIZES.sm} />
        </Button>
      </Tooltip>
      {brandRule && (
        <chakra.div
          aria-hidden
          data-testid="modal-header-brand-rule"
          css={{
            position: "absolute",
            insetInline: 0,
            bottom: 0,
            height: "2px",
            background: "var(--hero-rule)",
            display: "var(--hero-rule-display)",
            pointerEvents: "none",
          }}
        />
      )}
    </Dialog.Header>
  );
}

type ModalBodyProps = ComponentProps<typeof Dialog.Body>;

export function ModalBody({ children, ...rest }: ModalBodyProps) {
  return (
    <Dialog.Body data-modal-body="" css={{ flex: 1, overflowY: "auto", py: "3.5", px: "4" }} {...rest}>
      {children}
    </Dialog.Body>
  );
}

type ModalFooterProps = ComponentProps<typeof Dialog.Footer>;

/**
 * モーダルフッター。**ボタン配置は全モーダルで次の 2 パターンに統一する**:
 *
 * 1. 通常の操作 — 右端に主アクション (primary)、その左にキャンセル (secondary)。
 *    左側の補助アクションとの間は spacer (`<div style={{ flex: 1 }} />`) で空ける。
 *    例: ExportModal / RowInsertModal / RenameTableDialog。
 * 2. 破壊的・不可逆な操作 (安全側優先) — 実行を**左**に非強調 (secondary /
 *    dangerOutline) で置き、spacer を挟んで**右端にキャンセルを primary + 初期
 *    フォーカス**で置く。HIG 各種ガイドラインに倣い、破壊的アクションを視覚的に
 *    優位にしない。例: DangerousQueryDialog / ConfirmDialog (tone: danger・warning) /
 *    HostKeyMismatchDialog。
 *
 * どちらのパターンでも**閉じる / キャンセルは spacer より右**に来る (#1114 で、
 * キャンセルが左端・主アクションが右端に離れていたモーダルを揃えた)。
 * フッターに solid の `danger` ボタンは置かない (破壊的操作は左の dangerOutline)。
 * いずれも `designTokens.test.ts` の「モーダルのフッター配置」が検査する。
 *
 * キーボード: 通常の操作では `Modal` に `onSubmit` を渡し、Cmd/Ctrl+Enter で主
 * アクションを実行できるようにする。Esc は常に閉じる。
 */
export function ModalFooter({ children, ...rest }: ModalFooterProps) {
  return (
    <Dialog.Footer
      data-modal-footer=""
      css={{
        display: "flex",
        alignItems: "center",
        gap: "2",
        py: "2.5",
        px: "4",
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
