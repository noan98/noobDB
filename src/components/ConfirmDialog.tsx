import { useCallback, useRef, useState, type ReactNode } from "react";
import { chakra } from "@chakra-ui/react";
import { AnimatePresence } from "motion/react";
import { useT } from "../i18n";
import { isConfirmSuppressed, suppressConfirm } from "../settings";
import { typedConfirmMatches } from "../typeToConfirm";
import { FieldLabel, FormSection } from "./modalForm";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Checkbox, Input, PressableButton } from "./ui";

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
  /**
   * When set, requires the user to type this text exactly before the
   * confirm button is enabled — the "type the target name to confirm" gate
   * (#675) used for irreversible operations (DROP/TRUNCATE) on production
   * connections. A UI safety net only, like `confirm_writes`: the backend
   * does not require or check this text.
   */
  typedConfirmation?: string;
  /**
   * 第 3 の選択肢 (破壊的な「破棄」など) のラベル。指定すると `choose()` で使え、左端に
   * dangerOutline で置かれる。Esc / × / キャンセルは「何も壊さない側」(= cancel) のまま。
   * 通常の確認 (tone: primary) でのみ有効。
   */
  altLabel?: string;
  /**
   * 指定すると「今後は表示しない」を選べる (#1626)。**非破壊の確認 (tone: primary) だけ**で有効で、
   * danger / warning・タイプ確認・第 3 の選択肢 (altLabel) があるときは無視される (出さない)。
   * 選ぶと確認なしで即「確認」として解決し、設定画面の「安全」から戻せる。本番接続の確認には付けないこと。
   */
  rememberKey?: string;
}

/** `rememberKey` が有効になる確認か (非破壊で、タイプ確認も第 3 の選択肢も無い)。 */
function rememberApplies(opts: ConfirmOptions): boolean {
  return (
    !!opts.rememberKey && (opts.tone ?? "primary") === "primary" && !opts.altLabel && !opts.typedConfirmation
  );
}

/** `choose()` の結果。cancel は Esc / × / キャンセルボタン。 */
export type ConfirmChoice = "confirm" | "alt" | "cancel";

interface PendingState extends ConfirmOptions {
  resolve: (choice: ConfirmChoice) => void;
  seq: number;
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
export function useConfirm(): {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  /** 3 択版。`altLabel` を足した確認で、押された選択肢を返す。 */
  choose: (opts: ConfirmOptions) => Promise<ConfirmChoice>;
  dialog: ReactNode;
} {
  const t = useT();
  const [state, setState] = useState<PendingState | null>(null);
  // 重複呼び出しのキューイングは行わず、後から来た confirm に上書きされる前に
  // 一旦キャンセルとして解決する (= UI ループ的に呼び出し側が困らない)。
  const lastResolveRef = useRef<((choice: ConfirmChoice) => void) | null>(null);
  // 呼び出しごとの連番。ConfirmDialog の key に使い、続けて別の typedConfirmation
  // で confirm() したとき前回の入力欄の値を持ち越さない (安全網の汚染防止)。
  const seqRef = useRef(0);

  const choose = useCallback((opts: ConfirmOptions) => {
    return new Promise<ConfirmChoice>((resolve) => {
      // 「今後は表示しない」にしてある確認は出さずに確認済みとして扱う。
      if (rememberApplies(opts) && opts.rememberKey && isConfirmSuppressed(opts.rememberKey)) {
        resolve("confirm");
        return;
      }
      if (lastResolveRef.current) lastResolveRef.current("cancel");
      lastResolveRef.current = resolve;
      seqRef.current += 1;
      setState({ ...opts, resolve, seq: seqRef.current });
    });
  }, []);

  const confirm = useCallback((opts: ConfirmOptions) => choose(opts).then((c) => c === "confirm"), [choose]);

  const close = useCallback((choice: ConfirmChoice) => {
    setState((cur) => {
      if (cur) cur.resolve(choice);
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
          key={state.seq}
          title={state.title}
          message={state.message}
          confirmLabel={state.confirmLabel ?? t("confirmDefaultOk")}
          cancelLabel={state.cancelLabel ?? t("confirmDefaultCancel")}
          tone={state.tone ?? "primary"}
          typedConfirmation={state.typedConfirmation}
          altLabel={state.altLabel}
          rememberKey={rememberApplies(state) ? state.rememberKey : undefined}
          onConfirm={() => close("confirm")}
          onAlt={() => close("alt")}
          onCancel={() => close("cancel")}
        />
      )}
    </AnimatePresence>
  );

  return { confirm, choose, dialog };
}

interface ConfirmDialogProps {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  tone: ConfirmTone;
  typedConfirmation?: string;
  altLabel?: string;
  rememberKey?: string;
  onConfirm: () => void;
  onAlt: () => void;
  onCancel: () => void;
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  tone,
  typedConfirmation,
  altLabel,
  rememberKey,
  onConfirm,
  onAlt,
  onCancel,
}: ConfirmDialogProps) {
  const t = useT();
  // 既定フォーカスは「キャンセル」へ。stray Enter で実行が走らないようにする
  // (DangerousQueryDialog と同じ方針)。タイプ確認ゲートがあるときはどのみち
  // 入力が必要になるので、最初から入力欄へフォーカスする。
  const cancelRef = useRef<HTMLButtonElement>(null);
  const typedInputRef = useRef<HTMLInputElement>(null);
  const [typedValue, setTypedValue] = useState("");
  const [remember, setRemember] = useState(false);
  const confirmAndRemember = () => {
    if (rememberKey && remember) suppressConfirm(rememberKey);
    onConfirm();
  };
  const requiresTyped = !!typedConfirmation;
  const typedMatches = !requiresTyped || typedConfirmMatches(typedValue, typedConfirmation);
  // 破壊的/注意付き確認 (danger・warning) は安全側優先レイアウトに従い、
  // 実行を左に非強調で置き、キャンセルを右端 + primary にする
  // (DangerousQueryDialog・ModalFooter のガイドラインと同一)。通常の確認 (primary)
  // は他モーダルと同じ「右端 = 主アクション」配置。danger は非強調のまま
  // 危険色を帯びる dangerOutline で「破壊的操作」であることを色でも伝える。
  const destructive = tone !== "primary";

  return (
    <Modal
      // no-submit: 確認ダイアログ。破壊的トーンではキャンセルが既定で、誤爆で実行させない
      width="440px"
      onClose={onCancel}
      initialFocusEl={() => (requiresTyped ? typedInputRef.current : cancelRef.current)}
    >
      <ModalHeader onClose={onCancel} closeLabel={cancelLabel}>
        {title}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="3">
        {message}
        {rememberKey && (
          <chakra.label display="flex" alignItems="center" gap="2" fontSize="sm" color="app.textMuted">
            <Checkbox checked={remember} onChange={() => setRemember((v) => !v)} />
            {t("confirmRememberLabel")}
          </chakra.label>
        )}
        {requiresTyped && (
          <FormSection>
            {/* overline の大文字化をここだけ解除する。ラベルに入力すべき対象名が入って
                おり、大文字で表示すると表示どおりに打っても一致しない (大文字小文字を区別する)。 */}
            <FieldLabel htmlFor="confirm-dialog-type-confirm-input" textTransform="none">
              {t("typeToConfirmLabel", { target: typedConfirmation })}
            </FieldLabel>
            <Input
              id="confirm-dialog-type-confirm-input"
              ref={typedInputRef}
              value={typedValue}
              onChange={(e) => setTypedValue(e.target.value)}
              placeholder={typedConfirmation}
              autoComplete="off"
              spellCheck={false}
            />
          </FormSection>
        )}
      </ModalBody>
      <ModalFooter>
        {destructive ? (
          <>
            <Button
              type="button"
              variant={tone === "danger" ? "dangerOutline" : "secondary"}
              onClick={onConfirm}
              disabled={requiresTyped && !typedMatches}
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
            {altLabel && (
              <Button type="button" variant="dangerOutline" onClick={onAlt}>
                {altLabel}
              </Button>
            )}
            <div style={{ flex: 1 }} />
            <Button ref={cancelRef} type="button" variant="secondary" onClick={onCancel}>
              {cancelLabel}
            </Button>
            <PressableButton
              type="button"
              variant="primary"
              onClick={confirmAndRemember}
              disabled={requiresTyped && !typedMatches}
            >
              {confirmLabel}
            </PressableButton>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
