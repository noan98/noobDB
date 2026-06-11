import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Box, chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { CellValue, Column } from "../api/tauri";
import { useT } from "../i18n";
import { transitions } from "../motion";
import { copyToClipboard } from "./clipboard";
import { useToast } from "./Toast";
import { Icon } from "./Icon";
import type { CellKind } from "./cellTypeMeta";

interface Props {
  /** Column metadata (names) for the inspected row. */
  columns: Column[];
  /** The row's raw cell values (original column order). */
  values: CellValue[];
  /** Per-column classified kinds (for NULL/BLOB/JSON aware rendering). */
  columnKinds: CellKind[];
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
 * 行インスペクタ (#462)。選択中の 1 行の全カラムを「カラム名 → 値」で縦に並べた
 * 右側ドロワー。横スクロールせずに 1 レコードを一望でき、各フィールドを個別に
 * コピーできる。表示は表示専用 (JSON 整形・BLOB の 0x・NULL 明示) で、コピーは
 * 常に元の値を使う。グリッドのキーボード行移動 (↑/↓) に追従し、Esc で閉じる。
 * 開閉アニメは Motion で、reduced-motion は MotionConfig により自動抑制される。
 */
export function RowInspector({
  columns,
  values,
  columnKinds,
  rowNumber,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}: Props) {
  const t = useT();
  const toast = useToast();

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
        width="min(380px, 92vw)"
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
          <chakra.span fontWeight={600} fontSize="sm" color="app.text" flex="1">
            {t("gridRowInspectorTitle", { row: rowNumber })}
          </chakra.span>
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
            title={t("gridInspectorPrev")}
            aria-label={t("gridInspectorPrev")}
          >
            <Icon name="chevron-left" size={16} />
          </chakra.button>
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
            title={t("gridInspectorNext")}
            aria-label={t("gridInspectorNext")}
          >
            <Icon name="chevron-right" size={16} />
          </chakra.button>
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
            title={t("gridInspectorClose")}
            aria-label={t("gridInspectorClose")}
          >
            <Icon name="close" size={16} />
          </chakra.button>
        </Box>

        <Box flex="1" overflowY="auto" css={{ scrollbarWidth: "thin" }} px="3" py="2">
          {columns.length === 0 ? (
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
                    <chakra.span
                      flex="1"
                      fontSize="xs"
                      fontFamily="mono"
                      color="app.textMuted"
                      overflow="hidden"
                      textOverflow="ellipsis"
                      whiteSpace="nowrap"
                      title={`${col.name} — ${col.type_name}`}
                    >
                      {col.name}
                    </chakra.span>
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
                      disabled={isNull}
                      onClick={() => void copyField(display)}
                      title={t("gridInspectorCopyField")}
                      aria-label={t("gridInspectorCopyField")}
                    >
                      <Icon name="copy" size={13} />
                    </chakra.button>
                  </Box>
                  {isNull ? (
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
