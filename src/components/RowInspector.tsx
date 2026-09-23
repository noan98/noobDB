import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Box, chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import type { CellValue, Column, QueryResult } from "../api/tauri";
import { useT } from "../i18n";
import { transitions } from "../motion";
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
  rowNumber,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}: Props) {
  const t = useT();
  const toast = useToast();
  // タブは ↑/↓ で行を移っても保持する (関連を眺めながら親行を送る探索のため)。
  const [view, setView] = useState<"fields" | "related">("fields");
  const hasRelated = !!related && related.entries.length > 0;
  const activeView = hasRelated ? view : "fields";

  // Esc closes the inspector when focus is inside it (the grid handler covers
  // the case where focus is still on a cell).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copyField = async (raw: string) => {
    const ok = await copyToClipboard(raw);
    toast[ok ? "success" : "error"](ok ? t("gridCopied") : t("clipboardCopyFailed"));
  };

  return createPortal(
    <AnimatePresence>
      <MotionDrawer
        key="row-inspector"
        role="dialog"
        aria-label={t("gridRowInspectorTitle", { row: rowNumber })}
        initial={{ opacity: 0, x: 28 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 28 }}
        transition={transitions.enter}
        position="fixed"
        top={0}
        right={0}
        bottom={0}
        zIndex="modal"
        width={activeView === "related" ? "min(560px, 92vw)" : "min(380px, 92vw)"}
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
          <Tooltip label={t("gridInspectorPrev")} focusableWrapper={!hasPrev}>
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
              disabled={!hasPrev}
              onClick={onPrev}
              aria-label={t("gridInspectorPrev")}
            >
              <Icon name="chevron-left" size={ICON_SIZES.md} />
            </chakra.button>
          </Tooltip>
          <Tooltip label={t("gridInspectorNext")} focusableWrapper={!hasNext}>
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
              disabled={!hasNext}
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
              onChange={setView}
              ariaLabel={t("inspectorTabsAria")}
              options={[
                { value: "fields", label: t("inspectorTabFields") },
                {
                  value: "related",
                  label: t("inspectorTabRelated", { count: related?.entries.length ?? 0 }),
                  icon: "link",
                },
              ]}
            />
          </Box>
        )}

        <Box flex="1" overflowY="auto" css={{ scrollbarWidth: "thin" }} px="3" py="2">
          {activeView === "related" && related ? (
            <RelatedRowsPanel
              entries={related.entries}
              driver={related.driver}
              database={related.database}
              runQuery={related.runQuery}
              onOpenInGrid={related.onOpenInGrid}
            />
          ) : columns.length === 0 ? (
            <chakra.div fontStyle="italic" color="app.textMuted" fontSize="sm">
              {t("gridInspectorEmpty")}
            </chakra.div>
          ) : (
            columns.map((col, i) => {
              const v = values[i] ?? null;
              const isNull = v === null || v === undefined;
              const isBinary = columnKinds[i] === "binary";
              const raw = isNull ? "" : isBinary ? `0x${String(v)}` : String(v);
              const json = !isNull && !isBinary ? tryFormatJson(String(v)) : null;
              const display = json ?? raw;
              const masked = !!maskedColumns?.[i];
              const comment = comments?.[i] ?? null;
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
                    <Tooltip label={withComment(`${col.name} — ${col.type_name}`, comment)}>
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
                    <Tooltip
                      label={masked ? t("gridMaskedCellTitle") : t("gridInspectorCopyField")}
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
                        _disabled={{ opacity: 0.35, cursor: "not-allowed" }}
                        disabled={isNull || masked}
                        onClick={() => void copyField(display)}
                        aria-label={t("gridInspectorCopyField")}
                      >
                        <Icon name="copy" size={ICON_SIZES.sm} />
                      </chakra.button>
                    </Tooltip>
                  </Box>
                  {comment && (
                    <chakra.span fontSize="xs" color="app.textSecondary" wordBreak="break-word">
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
                    <chakra.span fontSize="sm" fontStyle="italic" color="app.textMuted">
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
        </Box>
      </MotionDrawer>
    </AnimatePresence>,
    document.body,
  );
}
