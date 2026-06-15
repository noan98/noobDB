import { useEffect, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import {
  PAGE_SIZE_OPTIONS,
  canGoNext,
  canGoPrev,
  pageRange,
} from "../pagination";
import { ICON_SIZES, Icon } from "./Icon";
import { Spinner } from "./Spinner";

/**
 * table タブの結果グリッド下に置くページネーションバー。先頭/前/次/末尾の
 * 送り、任意ページへのジャンプ、ページサイズ変更を提供する。総ページ数は行数推定が
 * あるときだけ表示し、推定が無い場合は「直近ページが満杯か」で次送りの可否を判断する。
 */
interface Props {
  page: number;
  pageSize: number;
  rowsOnPage: number;
  /** 行数推定から算出した総ページ数の目安。不明なら null。 */
  totalPages: number | null;
  loading: boolean;
  onGoToPage: (page: number) => void;
  onSetPageSize: (size: number) => void;
}

const NavButton = chakra("button", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minW: "28px",
    h: "26px",
    px: "1.5",
    borderRadius: "6px",
    borderWidth: 0,
    color: "app.text",
    bg: "transparent",
    cursor: "pointer",
    _hover: { bg: "app.rowHover" },
    _disabled: { opacity: 0.4, cursor: "not-allowed", _hover: { bg: "transparent" } },
  },
});

export function PaginationBar({
  page,
  pageSize,
  rowsOnPage,
  totalPages,
  loading,
  onGoToPage,
  onSetPageSize,
}: Props) {
  const t = useT();
  // ジャンプ入力はローカル編集状態。ページが外部で変わったら同期する。
  const [jump, setJump] = useState(String(page));
  useEffect(() => {
    setJump(String(page));
  }, [page]);

  const prevOk = canGoPrev(page) && !loading;
  const nextOk = canGoNext(page, totalPages, rowsOnPage, pageSize) && !loading;
  const lastOk = totalPages != null && page < totalPages && !loading;
  const range = pageRange(page, pageSize, rowsOnPage);

  const submitJump = () => {
    const n = Number.parseInt(jump, 10);
    if (Number.isFinite(n) && n >= 1) onGoToPage(n);
    else setJump(String(page));
  };

  return (
    <Flex
      align="center"
      gap="2"
      px="2.5"
      py="5px"
      borderTopWidth="1px"
      borderTopColor="app.border"
      bg="app.surface"
      fontSize="sm"
      color="app.textSecondary"
      flex="none"
      flexWrap="wrap"
    >
      <NavButton
        type="button"
        onClick={() => onGoToPage(1)}
        disabled={!prevOk}
        title={t("pageFirst")}
        aria-label={t("pageFirst")}
      >
        «
      </NavButton>
      <NavButton
        type="button"
        onClick={() => onGoToPage(page - 1)}
        disabled={!prevOk}
        title={t("pagePrev")}
        aria-label={t("pagePrev")}
      >
        <Icon name="chevron-left" size={ICON_SIZES.sm} />
      </NavButton>

      <chakra.span display="inline-flex" alignItems="center" gap="1.5" minW="0">
        {t("pageLabel", { page })}
        {totalPages != null && (
          <chakra.span color="app.textMuted">{t("pageOfTotal", { total: totalPages })}</chakra.span>
        )}
        {loading && <Spinner size={12} />}
      </chakra.span>

      <NavButton
        type="button"
        onClick={() => onGoToPage(page + 1)}
        disabled={!nextOk}
        title={t("pageNext")}
        aria-label={t("pageNext")}
      >
        <Icon name="chevron-right" size={ICON_SIZES.sm} />
      </NavButton>
      <NavButton
        type="button"
        onClick={() => totalPages != null && onGoToPage(totalPages)}
        disabled={!lastOk}
        title={t("pageLast")}
        aria-label={t("pageLast")}
      >
        »
      </NavButton>

      <chakra.span color="app.textMuted" fontSize="xs">
        {range.to > 0 ? t("pageRowRange", { from: range.from, to: range.to }) : ""}
      </chakra.span>

      <chakra.span flex="1" />

      <chakra.label display="inline-flex" alignItems="center" gap="1.5" fontSize="xs" whiteSpace="nowrap">
        {t("pageJumpLabel")}
        <chakra.input
          type="number"
          min={1}
          value={jump}
          onChange={(e) => setJump(e.target.value)}
          onBlur={submitJump}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitJump();
          }}
          disabled={loading}
          w="60px"
          h="26px"
          px="1.5"
          borderWidth="1px"
          borderColor="app.border"
          borderRadius="6px"
          bg="app.surface"
          color="app.text"
        />
      </chakra.label>

      <chakra.label display="inline-flex" alignItems="center" gap="1.5" fontSize="xs" whiteSpace="nowrap">
        {t("pageSizeLabel")}
        <chakra.select
          value={pageSize}
          onChange={(e) => onSetPageSize(Number.parseInt(e.target.value, 10))}
          disabled={loading}
          h="26px"
          // ネイティブ select の右側に描かれるドロップダウン矢印と数値が重なって
          // 見切れないよう、右パディングを広めに取り、最小幅も確保する。
          minW="60px"
          pl="1.5"
          pr="5"
          borderWidth="1px"
          borderColor="app.border"
          borderRadius="6px"
          bg="app.surface"
          color="app.text"
        >
          {/* 現在のサイズが選択肢に無ければ先頭に足して必ず選べるようにする。 */}
          {(PAGE_SIZE_OPTIONS as readonly number[]).includes(pageSize)
            ? null
            : <option value={pageSize}>{pageSize}</option>}
          {PAGE_SIZE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </chakra.select>
      </chakra.label>
    </Flex>
  );
}
