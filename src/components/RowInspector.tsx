import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { Box, chakra } from "@chakra-ui/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { CellValue, Column, QueryResult } from "../api/tauri";
import { useT } from "../i18n";
import { directionalSlide, transitions } from "../motion";
import {
  inspectorWidth,
  rowSlideDirection,
  type NavDirection,
} from "./rowInspectorNav";
import { copyToClipboard } from "./clipboard";
import { useToast } from "./Toast";
import { Icon, ICON_SIZES } from "./Icon";
import type { CellKind } from "./cellTypeMeta";
import { Tooltip } from "./Tooltip";
import { withComment } from "./schemaComment";
import { MASK_PLACEHOLDER } from "./columnMask";
import { RelatedRowsPanel } from "./RelatedRowsPanel";
import { Segmented } from "./Segmented";
import type { RelatedEntry } from "../relatedRows";
import type { I18nKey } from "../i18n";
import { FieldError, FieldLabel } from "./modalForm";
import { Button, Input, PressableButton, Select, Textarea } from "./ui";
import { isModalSubmitKey, pickModalKeys } from "./modalKeys";
import { boolSelectValue, fromNativeValue, toNativeValue } from "./typedEditor";
import {
  collectInspectorEdits,
  draftFromRow,
  inspectorControlFor,
  rowChangedSince,
  type InspectorDraft,
} from "./rowInspectorEdit";

/**
 * 「関連」タブ (master-detail、#1028) の入力。被参照 FK が 1 件以上あるテーブルの
 * 結果で、子行を取得できるとき (セッションあり) だけ渡される。
 */
export interface RowInspectorRelated {
  entries: RelatedEntry[];
  driver: string;
  database: string | null;
  runQuery: (sql: string) => Promise<QueryResult>;
  onOpenInGrid?: (sql: string) => void;
}

/**
 * 行のフォーム編集 (#1394)。結果グリッドが「テーブルタブで編集できる (PK あり・読み取り
 * 専用でない)」ときだけ渡す。列の可否・行の状態・検証・適用はグリッドと同じ判定を
 * 呼び出し側から受け取るので、ここでは判定を持たない。
 */
export interface RowInspectorEdit {
  /** 行の識別 (`rowEditKey`)。行が変わると編集中の下書きは破棄する。 */
  rowKey: string;
  /** 列ごとの編集可否 (`inspectorEditableColumns` 済み)。全部 false なら編集ボタンを出さない。 */
  editableColumns: boolean[];
  /** 行単位で編集を始められない理由 (`inspectorRowEditBlock`)。`null` なら編集可。 */
  blockedReason: I18nKey | null;
  /** 1 セルの検証 (グリッドの `validateEdit` と同じ)。 */
  validate: (colIdx: number, raw: string) => I18nKey | null;
  /** 変更差分を適用する。戻り値は適用が完了したか (確認で止めた・失敗は false)。 */
  onApply: (edits: Record<number, string>) => Promise<boolean>;
}

interface Props {
  /** Column metadata (names) for the inspected row. */
  columns: Column[];
  /** 列コメント (#1002)。`columns` と同じ並び。無い列は `null`、未指定なら表示しない。 */
  comments?: (string | null)[];
  /** The row's raw cell values (original column order). */
  values: CellValue[];
  /** Per-column classified kinds (for NULL/BLOB/JSON aware rendering). */
  columnKinds: CellKind[];
  /**
   * 機微カラム表示マスク (#1069): 列ごとに「このセルはマスク中か」。true の列は
   * 値を伏せ字で表示し、フィールドのコピーも無効にする (グリッドで reveal すると
   * false になり実値が出る)。省略時はマスク無し。
   */
  maskedColumns?: boolean[];
  /** 「関連」タブ (#1028)。省略時・0 件のときはタブ自体を出さない。 */
  related?: RowInspectorRelated;
  /** フォーム編集 (#1394)。省略時は閲覧専用。 */
  edit?: RowInspectorEdit;
  /** 1-based visible row number shown in the header. */
  rowNumber: number;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev: boolean;
  hasNext: boolean;
}

/** Pretty-print a string as JSON, or null when it isn't valid JSON. */
function tryFormatJson(s: string): string | null {
  const trimmed = s.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

const MotionDrawer = chakra(motion.div, {}, { forwardProps: ["transition"] });

/**
 * 行インスペクタ。選択中の 1 行の全カラムを「カラム名 → 値」で縦に並べた
 * 右側ドロワー。横スクロールせずに 1 レコードを一望でき、各フィールドを個別に
 * コピーできる。表示は表示専用 (JSON 整形・BLOB の 0x・NULL 明示) で、コピーは
 * 常に元の値を使う。グリッドのキーボード行移動 (↑/↓) に追従し、Esc で閉じる。
 * 開閉アニメは Motion で、reduced-motion は MotionConfig により自動抑制される。
 */
export function RowInspector({
  columns,
  comments,
  values,
  columnKinds,
  maskedColumns,
  related,
  edit,
  rowNumber,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}: Props) {
  const t = useT();
  const toast = useToast();
  const baseId = useId();
  // タブは ↑/↓ で行を移っても保持する (関連を眺めながら親行を送る探索のため)。
  const [view, setView] = useState<"fields" | "related">("fields");
  const hasRelated = !!related && related.entries.length > 0;
  const activeView = hasRelated ? view : "fields";
  // 行送りの方向 (#1234)。行番号が変わったレンダー中に確定させ、退出側にも同じ向きを渡す。
  const [nav, setNav] = useState<{ row: number; dir: NavDirection }>({
    row: rowNumber,
    dir: 0,
  });
  if (nav.row !== rowNumber) {
    setNav({ row: rowNumber, dir: rowSlideDirection(nav.row, rowNumber) });
  }
  // 幅は MotionConfig の自動抑制対象外 (transform ではない) なので明示的に即時化する。
  const reduced = useReducedMotion();

  // フォーム編集の下書き (#1394)。行が変われば破棄する (行送りの方向と同じく、描画中に
  // 確定させて古い下書きを一瞬も表示しない)。`session` は編集開始ごとに変え、非制御の
  // 入力欄 (ネイティブ日時入力の badInput 対策) を作り直すための鍵。
  // `base` / `initial` は編集開始時点の値と下書き。差分はこれを基準にする (最新の
  // values prop を基準にすると、編集中に変わった行の値を黙って巻き戻してしまうため)。
  const [editState, setEditState] = useState<{
    key: string;
    base: CellValue[];
    initial: InspectorDraft;
    draft: InspectorDraft;
    session: number;
  } | null>(null);
  const sessionRef = useRef(0);
  const [applying, setApplying] = useState(false);
  if (editState && edit?.rowKey !== editState.key) setEditState(null);
  // 編集は「フィールド」タブでだけ。下書きがある間はタブを切り替えさせない (隠れた
  // 下書きを残さないため)。
  const editing = editState !== null && edit !== undefined && activeView === "fields";
  const canEdit =
    edit !== undefined && activeView === "fields" && edit.editableColumns.some(Boolean);

  // 編集中の差分と検証結果。基準は編集開始時の値 (base)。
  const edited =
    editing && edit && editState
      ? collectInspectorEdits({
          columns,
          base: editState.base,
          initial: editState.initial,
          draft: editState.draft,
          editable: edit.editableColumns,
          validate: edit.validate,
        })
      : null;
  const changedCount = edited ? Object.keys(edited.edits).length : 0;
  const hasErrors = edited ? Object.keys(edited.errors).length > 0 : false;
  // 編集中に行の値が変わった (自動リフレッシュ・グリッドの Apply など)。古い基準の差分は
  // 送らず、編集し直してもらう。
  const stale =
    editing && editState ? rowChangedSince(editState.base, values, columns.length) : false;
  const canApply =
    !!edit &&
    !!edited &&
    changedCount > 0 &&
    !hasErrors &&
    !stale &&
    edit.blockedReason === null &&
    !applying;

  const startEdit = () => {
    if (!edit || edit.blockedReason !== null) return;
    sessionRef.current += 1;
    const draft = draftFromRow(values, columns.length);
    setEditState({
      key: edit.rowKey,
      base: [...values],
      initial: { ...draft },
      draft,
      session: sessionRef.current,
    });
  };
  const cancelEdit = () => setEditState(null);
  const setCell = (colIdx: number, raw: string) =>
    setEditState((prev) => (prev ? { ...prev, draft: { ...prev.draft, [colIdx]: raw } } : prev));
  const applyEdit = async () => {
    if (!edit || !edited || !canApply) return;
    setApplying(true);
    let ok = false;
    try {
      ok = await edit.onApply(edited.edits);
    } catch {
      // 適用の失敗は呼び出し側 (App) がステータスで伝える。ここでは下書きを残すだけ。
      ok = false;
    } finally {
      setApplying(false);
    }
    // 成功時は結果グリッドの行が更新され、下書きは役目を終える。失敗・確認で止めた場合は
    // 下書きを残して、直してから再度適用できるようにする。
    if (ok) setEditState(null);
  };

  // Esc: 編集中は下書きを捨てて閲覧に戻す (閉じるのは次の Esc)。適用の実行中
  // (確認ダイアログ表示中を含む) は何もしない。それ以外は閉じる。
  // Esc closes the inspector when focus is inside it (the grid handler covers
  // the case where focus is still on a cell).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (editing) {
        if (!applying) setEditState(null);
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, editing, applying]);

  // Cmd/Ctrl+Enter で適用 (フォーム全体で有効。SQL エディタ・モーダルと同じキー)。
  const onFormKeyDown = (e: ReactKeyboardEvent) => {
    if (!editing) return;
    if (isModalSubmitKey(pickModalKeys(e))) {
      e.preventDefault();
      void applyEdit();
    }
  };

  const copyField = async (raw: string) => {
    const ok = await copyToClipboard(raw);
    toast[ok ? "success" : "error"](
      ok ? t("gridCopied") : t("clipboardCopyFailed"),
    );
  };

  /** 編集可能な列のフォーム欄 (#1394)。入力コントロールは `inspectorControlFor` で決める。 */
  const renderEditField = (i: number): ReactElement | null => {
    const col = columns[i];
    if (!col || !edit || !editState) return null;
    const original = values[i] ?? null;
    const start = original === null || original === undefined ? "" : String(original);
    const raw = editState.draft[i] ?? "";
    const control = inspectorControlFor(col.type_name, original);
    const id = `${baseId}-f${i}`;
    const error = edited?.errors[i];
    const changed = edited !== null && edited.edits[i] !== undefined;
    const a11y = {
      id,
      "aria-invalid": error ? true : undefined,
      "aria-describedby": error ? `${id}-err` : undefined,
    };
    let input: ReactElement;
    if (control.kind === "bool") {
      input = (
        <Select
          {...a11y}
          value={boolSelectValue(raw, start)}
          onChange={(e) => setCell(i, e.target.value)}
        >
          {control.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      );
    } else if (control.kind === "native") {
      // 非制御: 一部の欄だけ消した途中状態 (badInput) を React が巻き戻さないため
      // (グリッドの型別エディタ #1355 と同じ理由)。`session` で編集開始ごとに作り直す。
      input = (
        <Input
          key={`${editState.session}-${i}`}
          {...a11y}
          type={control.inputType}
          step={control.inputType === "date" ? undefined : 1}
          defaultValue={/^null$/i.test(raw.trim()) ? "" : toNativeValue(control.inputType, raw)}
          onChange={(e) => {
            if (e.target.value === "" && e.target.validity.badInput) return;
            setCell(i, fromNativeValue(control.inputType, e.target.value, "NULL", start));
          }}
        />
      );
    } else if (control.kind === "textarea") {
      // 長文型・改行を含む値は複数行欄 (1 行入力は改行を落とすため)。Cmd/Ctrl+Enter で適用、
      // 素の Enter は改行。
      input = (
        <Textarea
          {...a11y}
          value={raw}
          rows={Math.min(8, Math.max(2, raw.split("\n").length))}
          resize="vertical"
          fontFamily="mono"
          fontSize="sm"
          onChange={(e) => setCell(i, e.target.value)}
        />
      );
    } else {
      input = (
        <Input
          {...a11y}
          value={raw}
          onChange={(e) => setCell(i, e.target.value)}
        />
      );
    }
    return (
      <Box
        key={`${col.name}-${i}`}
        display="flex"
        flexDirection="column"
        gap="0.5"
        py="1.5"
        borderBottom="1px solid"
        borderColor="app.borderSubtle"
      >
        <Box display="flex" alignItems="center" gap="1.5" minW="0">
          <FieldLabel
            htmlFor={id}
            flex="1"
            minW="0"
            textTransform="none"
            letterSpacing="normal"
            fontFamily="mono"
            fontSize="xs"
            color="app.textMuted"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
          >
            {col.name}
          </FieldLabel>
          <chakra.span fontSize="2xs" fontFamily="mono" color="app.textMuted" flexShrink={0}>
            {col.type_name}
          </chakra.span>
          {changed && (
            <chakra.span fontSize="2xs" color="app.textWarning" flexShrink={0}>
              {t("rowInspectorFieldChanged")}
            </chakra.span>
          )}
        </Box>
        {input}
        {error && <FieldError id={`${id}-err`}>{t(error)}</FieldError>}
      </Box>
    );
  };

  return createPortal(
    <AnimatePresence>
      <MotionDrawer
        key="row-inspector"
        role="dialog"
        aria-label={t("gridRowInspectorTitle", { row: rowNumber })}
        initial={{ opacity: 0, x: 28, width: inspectorWidth(activeView) }}
        animate={{ opacity: 1, x: 0, width: inspectorWidth(activeView) }}
        exit={{ opacity: 0, x: 28 }}
        transition={reduced ? { duration: 0 } : transitions.enter}
        position="fixed"
        top={0}
        right={0}
        bottom={0}
        zIndex="modal"
        display="flex"
        flexDirection="column"
        bg="app.surface"
        borderLeft="1px solid"
        borderColor="app.borderStrong"
        boxShadow="var(--shadow-drawer)"
      >
        <Box
          display="flex"
          alignItems="center"
          gap="1.5"
          px="3"
          py="2"
          borderBottom="1px solid"
          borderColor="app.border"
          flexShrink={0}
        >
          <chakra.span textStyle="subheading" flex="1">
            {t("gridRowInspectorTitle", { row: rowNumber })}
          </chakra.span>
          {canEdit && !editing && (
            <Tooltip
              label={edit?.blockedReason ? t(edit.blockedReason) : t("rowInspectorEdit")}
              focusableWrapper={edit?.blockedReason != null}
            >
              <chakra.button
                type="button"
                display="inline-flex"
                alignItems="center"
                justifyContent="center"
                w="24px"
                h="24px"
                border="none"
                bg="transparent"
                color="app.textMuted"
                borderRadius="sm"
                cursor="pointer"
                _hover={{ bg: "app.hover", color: "app.text" }}
                _disabled={{ opacity: 0.4, cursor: "not-allowed" }}
                disabled={edit?.blockedReason != null}
                onClick={startEdit}
                aria-label={t("rowInspectorEdit")}
              >
                <Icon name="pencil" size={ICON_SIZES.md} />
              </chakra.button>
            </Tooltip>
          )}
          <Tooltip label={t("gridInspectorPrev")} focusableWrapper={!hasPrev || editing}>
            <chakra.button
              type="button"
              display="inline-flex"
              alignItems="center"
              justifyContent="center"
              w="24px"
              h="24px"
              border="none"
              bg="transparent"
              color="app.textMuted"
              borderRadius="sm"
              cursor="pointer"
              _hover={{ bg: "app.hover", color: "app.text" }}
              _disabled={{ opacity: 0.4, cursor: "not-allowed" }}
              disabled={!hasPrev || editing}
              onClick={onPrev}
              aria-label={t("gridInspectorPrev")}
            >
              <Icon name="chevron-left" size={ICON_SIZES.md} />
            </chakra.button>
          </Tooltip>
          <Tooltip label={t("gridInspectorNext")} focusableWrapper={!hasNext || editing}>
            <chakra.button
              type="button"
              display="inline-flex"
              alignItems="center"
              justifyContent="center"
              w="24px"
              h="24px"
              border="none"
              bg="transparent"
              color="app.textMuted"
              borderRadius="sm"
              cursor="pointer"
              _hover={{ bg: "app.hover", color: "app.text" }}
              _disabled={{ opacity: 0.4, cursor: "not-allowed" }}
              disabled={!hasNext || editing}
              onClick={onNext}
              aria-label={t("gridInspectorNext")}
            >
              <Icon name="chevron-right" size={ICON_SIZES.md} />
            </chakra.button>
          </Tooltip>
          <Tooltip label={t("gridInspectorClose")}>
            <chakra.button
              type="button"
              display="inline-flex"
              alignItems="center"
              justifyContent="center"
              w="24px"
              h="24px"
              border="none"
              bg="transparent"
              color="app.textMuted"
              borderRadius="sm"
              cursor="pointer"
              _hover={{ bg: "app.hover", color: "app.text" }}
              onClick={onClose}
              aria-label={t("gridInspectorClose")}
            >
              <Icon name="close" size={ICON_SIZES.md} />
            </chakra.button>
          </Tooltip>
        </Box>

        {hasRelated && (
          <Box px="3" pt="2" flexShrink={0}>
            <Segmented
              value={activeView}
              onChange={(v) => {
                if (!editing) setView(v);
              }}
              ariaLabel={t("inspectorTabsAria")}
              options={[
                { value: "fields", label: t("inspectorTabFields") },
                {
                  value: "related",
                  label: t("inspectorTabRelated", {
                    count: related?.entries.length ?? 0,
                  }),
                  icon: "link",
                },
              ]}
            />
          </Box>
        )}

        <Box
          flex="1"
          overflowY="auto"
          css={{ scrollbarWidth: "thin" }}
          px="3"
          py="2"
          onKeyDown={onFormKeyDown}
        >
          {activeView === "related" && related ? (
            <RelatedRowsPanel
              entries={related.entries}
              driver={related.driver}
              database={related.database}
              runQuery={related.runQuery}
              onOpenInGrid={related.onOpenInGrid}
            />
          ) : (
            <AnimatePresence mode="wait" initial={false} custom={nav.dir}>
              <motion.div
                key={rowNumber}
                custom={nav.dir}
                variants={directionalSlide}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={transitions.enter}
              >
                {editing && (
                  <chakra.p fontSize="xs" color="app.textMuted" mb="1">
                    {t("rowInspectorNullHint")}
                  </chakra.p>
                )}
                {columns.length === 0 ? (
                  <chakra.div
                    fontStyle="italic"
                    color="app.textMuted"
                    fontSize="sm"
                  >
                    {t("gridInspectorEmpty")}
                  </chakra.div>
                ) : (
                  columns.map((col, i) => {
                    const v = values[i] ?? null;
                    const isNull = v === null || v === undefined;
                    const isBinary = columnKinds[i] === "binary";
                    const raw = isNull
                      ? ""
                      : isBinary
                        ? `0x${String(v)}`
                        : String(v);
                    const json =
                      !isNull && !isBinary ? tryFormatJson(String(v)) : null;
                    const display = json ?? raw;
                    const masked = !!maskedColumns?.[i];
                    const comment = comments?.[i] ?? null;
                    if (editing && edit?.editableColumns[i]) {
                      return renderEditField(i);
                    }
                    return (
                      <Box
                        key={`${col.name}-${i}`}
                        display="flex"
                        flexDirection="column"
                        gap="0.5"
                        py="1.5"
                        borderBottom="1px solid"
                        borderColor="app.borderSubtle"
                      >
                        <Box display="flex" alignItems="center" gap="1.5">
                          <Tooltip
                            label={withComment(
                              `${col.name} — ${col.type_name}`,
                              comment,
                            )}
                          >
                            <chakra.span
                              flex="1"
                              fontSize="xs"
                              fontFamily="mono"
                              color="app.textMuted"
                              overflow="hidden"
                              textOverflow="ellipsis"
                              whiteSpace="nowrap"
                            >
                              {col.name}
                            </chakra.span>
                          </Tooltip>
                          {editing && !edit?.editableColumns[i] && (
                            <chakra.span
                              fontSize="2xs"
                              color="app.textMuted"
                              flexShrink={0}
                            >
                              {t("rowInspectorFieldReadonly")}
                            </chakra.span>
                          )}
                          <Tooltip
                            label={
                              masked
                                ? t("gridMaskedCellTitle")
                                : t("gridInspectorCopyField")
                            }
                            focusableWrapper={isNull || masked}
                          >
                            <chakra.button
                              type="button"
                              display="inline-flex"
                              alignItems="center"
                              justifyContent="center"
                              w="20px"
                              h="20px"
                              border="none"
                              bg="transparent"
                              color="app.textMuted"
                              borderRadius="sm"
                              cursor="pointer"
                              flexShrink={0}
                              _hover={{ bg: "app.hover", color: "app.text" }}
                              _disabled={{
                                opacity: 0.35,
                                cursor: "not-allowed",
                              }}
                              disabled={isNull || masked}
                              onClick={() => void copyField(display)}
                              aria-label={t("gridInspectorCopyField")}
                            >
                              <Icon name="copy" size={ICON_SIZES.sm} />
                            </chakra.button>
                          </Tooltip>
                        </Box>
                        {comment && (
                          <chakra.span
                            fontSize="xs"
                            color="app.textSecondary"
                            wordBreak="break-word"
                          >
                            {comment}
                          </chakra.span>
                        )}
                        {masked ? (
                          <chakra.span
                            fontSize="sm"
                            color="app.textMuted"
                            letterSpacing="wider"
                            aria-label={t("gridMaskedCellAria")}
                          >
                            {MASK_PLACEHOLDER}
                          </chakra.span>
                        ) : isNull ? (
                          <chakra.span
                            fontSize="sm"
                            fontStyle="italic"
                            color="app.textMuted"
                          >
                            {t("resultNull")}
                          </chakra.span>
                        ) : (
                          <chakra.pre
                            m={0}
                            maxH="180px"
                            overflow="auto"
                            fontFamily="mono"
                            fontSize="sm"
                            lineHeight={1.45}
                            whiteSpace="pre-wrap"
                            wordBreak="break-word"
                            color="app.text"
                          >
                            {display}
                          </chakra.pre>
                        )}
                      </Box>
                    );
                  })
                )}
              </motion.div>
            </AnimatePresence>
          )}
        </Box>

        {editing && edit && (
          <Box
            display="flex"
            alignItems="center"
            gap="2"
            px="3"
            py="2"
            borderTop="1px solid"
            borderColor="app.border"
            flexShrink={0}
          >
            <chakra.span
              flex="1"
              minW="0"
              fontSize="xs"
              color={edit.blockedReason || stale ? "app.textWarning" : "app.textMuted"}
            >
              {edit.blockedReason
                ? t(edit.blockedReason)
                : stale
                  ? t("rowInspectorEditStale")
                  : hasErrors
                    ? t("rowInspectorEditHasErrors")
                    : changedCount > 0
                      ? t("rowInspectorChangeCount", { count: changedCount })
                      : t("rowInspectorEditNoChanges")}
            </chakra.span>
            <Button type="button" variant="secondary" onClick={cancelEdit}>
              {t("rowInspectorEditCancel")}
            </Button>
            <PressableButton
              type="button"
              variant="primary"
              disabled={!canApply}
              onClick={() => void applyEdit()}
            >
              {t("editApplyButton")}
            </PressableButton>
          </Box>
        )}
      </MotionDrawer>
    </AnimatePresence>,
    document.body,
  );
}
