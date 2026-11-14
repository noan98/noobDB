import { useId, useMemo, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import type { CellValue, RowMergePreview } from "../api/tauri";
import { useT } from "../i18n";
import { durations, springs } from "../motion";
import { semanticColorVar } from "../semanticColors";
import { Icon, ICON_SIZES } from "./Icon";
import { useStillMotion } from "./SchemaDiffDetail";
import { Tooltip } from "./Tooltip";
import { kindOfDataType, TypeGlyph } from "./TypeGlyph";
import { Checkbox, Radio } from "./ui";

/**
 * 重複レコードのマージ (#2303) の「列 × 候補行」表 (#2322)。
 *
 * - 値が食い違う列は左端に warning の縦線と「n 通り」のバッジ。全行で同じ値の列は文字を薄くし、折りたためる。
 * - 右端に、選んだ値を組み立てた「マージ後の行」の列を固定で置く (採用元の行番号をチップで添える)。
 * - 残す行は success、消える行 (重複) は danger の薄い地で区別する。見出しにはアイコンと文字も添える。
 * - 選択枠は列ごとの `layoutId` で選び直した値へ滑らせる。結果の列のセルはクロスフェードする。
 */

const MotionPicked = chakra(motion.span, {}, { forwardProps: ["transition"] });

const MAX_CELL_CHARS = 60;

function cellText(v: CellValue | undefined): string {
  if (v === null || v === undefined) return "NULL";
  const s = String(v);
  return s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS)}…` : s;
}

/** 列ごとの食い違い数 (異なる値の種類数)。1 なら全行で同じ値。 */
export function distinctValueCount(values: readonly (CellValue | undefined)[]): number {
  return new Set(values.map((v) => (v === null || v === undefined ? "\u0000null" : `v:${String(v)}`))).size;
}

interface Props {
  preview: RowMergePreview;
  /** 表示順 → 元の行の添字 (先頭が残す行)。 */
  order: readonly number[];
  applying: boolean;
  /** プレビュー再取得中。表を薄くして操作を止める (古い採用元を見せない)。 */
  loading?: boolean;
  onPick: (column: string, pos: number) => void;
  onSurvivor: (rowIdx: number) => void;
}

export function RowMergeMatrix({ preview, order, applying, loading = false, onPick, onSurvivor }: Props) {
  const t = useT();
  const still = useStillMotion();
  const uid = useId();
  const [hideSame, setHideSame] = useState(false);

  const distinct = useMemo(
    () => preview.columns.map((_, ci) => distinctValueCount(preview.rows.map((r) => r[ci]))),
    [preview],
  );
  // 選ぶ必要がある列 = 値が食い違い、かつ選べる列。鍵付き (locked) の列は行の特定に使うだけなので数えない。
  const needsChoice = preview.columns.map((c, ci) => (distinct[ci] ?? 1) > 1 && !c.locked);
  const differing = needsChoice.filter(Boolean).length;
  const sameCount = preview.columns.length - differing;

  const warnLine = semanticColorVar("warning", "text");
  const slide = still ? { duration: 0 } : springs.snappy;
  const fade = { duration: still ? 0 : durations.quick };

  // 残す行は success、消える行は danger の薄い地。
  const tint = (pos: number) => (pos === 0 ? "app.success.subtle" : "app.error.subtle");

  return (
    <>
      <chakra.div display="flex" alignItems="center" gap="3" flexWrap="wrap">
        <chakra.span textStyle="caption" data-testid="row-merge-diff-count">
          {t("rowMergeDiffSummary", { diff: differing, total: preview.columns.length })}
        </chakra.span>
        {sameCount > 0 && (
          <chakra.label
            display="inline-flex"
            alignItems="center"
            gap="1.5"
            cursor="pointer"
            textStyle="caption"
          >
            <Checkbox
              checked={hideSame}
              onChange={(e) => setHideSame(e.target.checked)}
              data-testid="row-merge-hide-same"
            />
            {t("rowMergeHideSame", { count: sameCount })}
          </chakra.label>
        )}
      </chakra.div>
      <chakra.div
        overflowX="auto"
        maxH="320px"
        overflowY="auto"
        opacity={loading ? 0.5 : 1}
        pointerEvents={loading ? "none" : undefined}
        aria-busy={loading}
        data-testid="row-merge-matrix"
      >
        <chakra.table borderCollapse="collapse" fontSize="sm" width="100%">
          <thead>
            <tr>
              <chakra.th textAlign="left" px="2" py="1" textStyle="caption">
                {t("rowMergeColumn")}
              </chakra.th>
              {order.map((ri, pos) => (
                <chakra.th
                  key={ri}
                  textAlign="left"
                  px="2"
                  py="1"
                  textStyle="caption"
                  bg={tint(pos)}
                  data-testid={`row-merge-head-${pos}`}
                  data-role={pos === 0 ? "keep" : "remove"}
                >
                  <chakra.label display="inline-flex" alignItems="center" gap="1.5" cursor="pointer">
                    <Radio
                      name="row-merge-survivor"
                      checked={pos === 0}
                      onChange={() => onSurvivor(ri)}
                      aria-label={t("rowMergePickSurvivor", { n: ri + 1 })}
                    />
                    {t("rowMergeRowN", { n: ri + 1 })}
                    <chakra.span
                      display="inline-flex"
                      alignItems="center"
                      gap="0.5"
                      color={pos === 0 ? "app.textSuccess" : "app.textError"}
                      fontWeight={600}
                    >
                      <Icon name={pos === 0 ? "check" : "trash"} size={ICON_SIZES.sm} />
                      {pos === 0 ? t("rowMergeKeep") : t("rowMergeDuplicate", { n: pos })}
                    </chakra.span>
                  </chakra.label>
                </chakra.th>
              ))}
              <chakra.th
                textAlign="left"
                px="2"
                py="1"
                textStyle="caption"
                position="sticky"
                right="0"
                bg="app.surface"
                boxShadow="inset 1px 0 0 var(--border)"
                data-testid="row-merge-result-head"
              >
                <chakra.span
                  display="inline-flex"
                  alignItems="center"
                  gap="1"
                  color="app.textSuccess"
                  fontWeight={600}
                >
                  <Icon name="check" size={ICON_SIZES.sm} />
                  {t("rowMergeResult")}
                </chakra.span>
              </chakra.th>
            </tr>
          </thead>
          <tbody>
            {preview.columns.map((c, ci) => {
              const differs = needsChoice[ci] ?? false;
              if (hideSame && !differs) return null;
              const pickedPos = preview.picks[ci] ?? 0;
              const pickedRow = preview.rows[pickedPos];
              const resultText = cellText(pickedRow?.[ci]);
              return (
                <tr
                  key={c.name}
                  data-testid={`row-merge-row-${c.name}`}
                  data-differs={differs ? "true" : "false"}
                >
                  <chakra.td
                    px="2"
                    py="0.5"
                    whiteSpace="nowrap"
                    borderLeft="0.25em solid"
                    borderColor="transparent"
                    css={differs ? { borderLeftColor: warnLine } : undefined}
                    color={differs ? "app.text" : "app.textMuted"}
                  >
                    <chakra.span display="inline-flex" alignItems="center" gap="1.5">
                      <TypeGlyph kind={kindOfDataType(c.typeName)} tooltip />
                      <chakra.span fontFamily="mono">{c.name}</chakra.span>
                      {c.locked && (
                        <Tooltip label={t("rowMergeLocked")}>
                          <chakra.span
                            display="inline-flex"
                            color="app.textMuted"
                            role="img"
                            aria-label={t("rowMergeLocked")}
                            data-testid={`row-merge-locked-${c.name}`}
                          >
                            <Icon name="lock" size={ICON_SIZES.sm} />
                          </chakra.span>
                        </Tooltip>
                      )}
                      {differs && (
                        <chakra.span
                          textStyle="caption"
                          px="1.5"
                          borderRadius="full"
                          border="1px solid"
                          fontWeight={600}
                          color="app.textWarning"
                          bg="app.warning.subtle"
                          css={{ borderColor: warnLine }}
                          data-testid={`row-merge-badge-${c.name}`}
                        >
                          {t("rowMergeDistinct", { count: distinct[ci] ?? 0 })}
                        </chakra.span>
                      )}
                    </chakra.span>
                  </chakra.td>
                  {preview.rows.map((row, pos) => {
                    const picked = pickedPos === pos;
                    return (
                      <chakra.td key={`${c.name}-${pos}`} px="1" py="0.5" bg={tint(pos)}>
                        <chakra.button
                          type="button"
                          role="radio"
                          aria-checked={picked}
                          disabled={c.locked || applying}
                          onClick={() => onPick(c.name, pos)}
                          position="relative"
                          width="100%"
                          textAlign="left"
                          px="1.5"
                          py="0.5"
                          borderRadius="sm"
                          border="1px solid"
                          borderColor="transparent"
                          bg="transparent"
                          color={row[ci] === null ? "app.textMuted" : differs ? "app.text" : "app.textMuted"}
                          fontFamily="mono"
                          cursor={c.locked ? "default" : "pointer"}
                          _hover={c.locked ? undefined : { bg: "app.hover" }}
                          data-testid={`row-merge-cell-${c.name}-${pos}`}
                        >
                          {picked && (
                            // 同じ列の中で layoutId が移ると、Motion が前の値から滑らせる。
                            <MotionPicked
                              layoutId={`${uid}-${c.name}`}
                              transition={slide}
                              data-testid={`row-merge-picked-${c.name}`}
                              aria-hidden
                              position="absolute"
                              inset="0"
                              borderRadius="inherit"
                              border="1px solid"
                              borderColor="app.accent"
                              bg="app.accentHighlight"
                              pointerEvents="none"
                            />
                          )}
                          <chakra.span position="relative">{cellText(row[ci])}</chakra.span>
                        </chakra.button>
                      </chakra.td>
                    );
                  })}
                  <chakra.td
                    px="2"
                    py="0.5"
                    position="sticky"
                    right="0"
                    bg="app.surface"
                    boxShadow="inset 1px 0 0 var(--border)"
                    fontFamily="mono"
                    data-testid={`row-merge-result-${c.name}`}
                  >
                    <AnimatePresence initial={false} mode="wait">
                      <motion.span
                        key={`${pickedPos}:${resultText}`}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={fade}
                        style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}
                      >
                        <chakra.span color={pickedRow?.[ci] === null ? "app.textMuted" : "app.text"}>
                          {resultText}
                        </chakra.span>
                        <chakra.span
                          textStyle="caption"
                          px="1"
                          borderRadius="sm"
                          bg="app.surfaceMuted"
                          color="app.textSecondary"
                          data-testid={`row-merge-source-${c.name}`}
                        >
                          {order[pickedPos] !== undefined ? (order[pickedPos] ?? 0) + 1 : ""}
                        </chakra.span>
                      </motion.span>
                    </AnimatePresence>
                  </chakra.td>
                </tr>
              );
            })}
          </tbody>
        </chakra.table>
      </chakra.div>
    </>
  );
}
