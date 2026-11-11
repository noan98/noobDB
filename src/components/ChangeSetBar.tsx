// 未適用の変更 (セル編集・追加行・削除予定) を 1 本にまとめる「変更セットバー」(#2235)。
//
// 以前はセル編集バー (ResultGrid) と行操作バー (PaneView) の 2 本に分かれ、どちらの「適用」も
// 3 種を全部送るのにラベルは片方の種類だけを名乗っていた。ここでは種類別のピルで内訳を見せ、
// 適用は 1 つ (実際に送る文の種類と件数をツールチップに出す)、破棄も 1 つにする。
// 件数の単一ソースは `pendingGuard.ts`。ピルは種類が新しく加わったときだけ Motion で出入りする。
import { Box, chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { useT } from "../i18n";
import { springs, transitions, variants } from "../motion";
import { changeSetStatementText } from "../pendingGuard";
import { Icon, ICON_SIZES } from "./Icon";
import { LoadingButton } from "./LoadingButton";
import { Tooltip } from "./Tooltip";
import { Button } from "./ui";

export interface ChangeSetBarProps {
  /** セル編集のあるセル数 / 行数 (UPDATE の対象)。 */
  editCells: number;
  editRows: number;
  /** 追加行 (INSERT) / 削除予定行 (DELETE) の数。 */
  inserts: number;
  deletes: number;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  /** セル編集が 1 行だけのときだけ有効な UPDATE のプレビュー。 */
  canPreview: boolean;
  previewTitle: string;
  onPreview?: () => void;
  /** 適用できない理由 (不正な入力・読み込み中)。無ければ適用できる。 */
  applyBlockedReason?: string | null;
  applying?: boolean;
  onApply?: () => void;
  onDiscard: () => void;
  /** 適用 / 破棄のショートカット表記 (ツールチップ用)。 */
  applyShortcut?: string;
  discardShortcut?: string;
  /** 複数行の編集ではプレビューが 1 行ぶんだけであることの注記。 */
  multiRowNote?: ReactNode;
}

const pillBase = {
  display: "inline-flex",
  alignItems: "center",
  py: "0.5",
  px: "2",
  borderRadius: "full",
  fontSize: "xs",
  fontWeight: 600,
  whiteSpace: "nowrap",
  flexShrink: 0,
} as const;

function Pill({ tone, children }: { tone: "update" | "insert" | "delete"; children: ReactNode }) {
  const color =
    tone === "update"
      ? "var(--preview-highlight)"
      : tone === "insert"
        ? "var(--text-success)"
        : "var(--text-error)";
  return (
    <motion.span
      layout
      data-change-pill={tone}
      initial={variants.fadeScale.initial}
      animate={variants.fadeScale.animate}
      exit={variants.fadeScale.exit}
      transition={springs.snappy}
      style={{ display: "inline-flex" }}
    >
      <chakra.span {...pillBase} color={color} background={`color-mix(in srgb, ${color} 16%, transparent)`}>
        {children}
      </chakra.span>
    </motion.span>
  );
}

/** バー自体の表示判定 (3 種のどれかが残っているか)。 */
export function hasChangeSet(c: { editCells: number; inserts: number; deletes: number }): boolean {
  return c.editCells > 0 || c.inserts > 0 || c.deletes > 0;
}

export function ChangeSetBar(props: ChangeSetBarProps) {
  const t = useT();
  const {
    editCells,
    editRows,
    inserts,
    deletes,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
    canPreview,
    previewTitle,
    onPreview,
    applyBlockedReason,
    applying,
    onApply,
    onDiscard,
    applyShortcut,
    discardShortcut,
    multiRowNote,
  } = props;
  const statements = changeSetStatementText({ editedRows: editRows, inserts, deletes });
  const canApply = !applyBlockedReason;
  const withKey = (label: string, key: string | undefined) => (key ? `${label} (${key})` : label);
  return (
    <AnimatePresence>
      {hasChangeSet({ editCells, inserts, deletes }) && (
        // reduced-motion は MotionConfig が自動で抑制する。ツールバー (幅が足りないと横スクロール) の
        // 中に置くと「適用」「破棄」が押し出されるので、ツールバー直下の独立した行に置き折り返す。
        <motion.div
          key="change-set-bar"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={transitions.enter}
          style={{ flexShrink: 0 }}
        >
          <Box
            role="group"
            aria-label={t("changeSetAria")}
            display="flex"
            alignItems="center"
            flexWrap="wrap"
            gap="1.5"
            py="1"
            px="2"
            borderBottom="1px solid var(--border-subtle)"
            background="color-mix(in srgb, var(--preview-highlight) 8%, transparent)"
          >
            <chakra.span display="contents" role="status" aria-live="polite">
              <AnimatePresence initial={false}>
                {editCells > 0 && (
                  <Pill key="update" tone="update">
                    {t("editPendingCount", { cells: editCells, rows: editRows })}
                  </Pill>
                )}
                {inserts > 0 && (
                  <Pill key="insert" tone="insert">
                    {t("changeSetPillInsert", { count: inserts })}
                  </Pill>
                )}
                {deletes > 0 && (
                  <Pill key="delete" tone="delete">
                    {t("changeSetPillDelete", { count: deletes })}
                  </Pill>
                )}
              </AnimatePresence>
            </chakra.span>
            {multiRowNote}
            <Tooltip label={t("editUndoTitle")}>
              <Button
                variant="secondary"
                size="sm"
                px="1.5"
                onClick={onUndo}
                disabled={!canUndo}
                aria-label={t("editUndoTitle")}
              >
                <Icon name="undo" />
              </Button>
            </Tooltip>
            <Tooltip label={t("editRedoTitle")}>
              <Button
                variant="secondary"
                size="sm"
                px="1.5"
                onClick={onRedo}
                disabled={!canRedo}
                aria-label={t("editRedoTitle")}
              >
                <Icon name="redo" />
              </Button>
            </Tooltip>
            {editCells > 0 && (
              <Tooltip focusableWrapper={!canPreview} label={previewTitle}>
                <Button variant="warning" size="sm" px="2.5" onClick={onPreview} disabled={!canPreview}>
                  <Icon name="eye" size={ICON_SIZES.md} /> {t("editPreviewButton")}
                </Button>
              </Tooltip>
            )}
            <Tooltip
              focusableWrapper={!canApply}
              label={withKey(
                applyBlockedReason ?? t("changeSetApplyTitle", { statements }),
                canApply ? applyShortcut : undefined,
              )}
            >
              <LoadingButton
                variant="success"
                size="sm"
                px="2.5"
                loading={applying}
                onClick={onApply}
                disabled={!canApply}
              >
                <Icon name="check" size={ICON_SIZES.md} /> {t("editApplyButton")}
              </LoadingButton>
            </Tooltip>
            <Tooltip label={withKey(t("changeSetDiscardTitle"), discardShortcut)}>
              <Button variant="secondary" size="sm" px="2.5" onClick={onDiscard} disabled={applying}>
                <Icon name="close" size={ICON_SIZES.md} /> {t("editCancelButton")}
              </Button>
            </Tooltip>
          </Box>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
