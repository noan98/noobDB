import { useEffect, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import { PAGE_SIZE_OPTIONS, canGoNext, canGoPrev, pageRange } from "../pagination";
import { CountUpText } from "./CountUp";
import { ICON_SIZES, Icon } from "./Icon";
import { ListboxSelect } from "./ListboxSelect";
import { Spinner } from "./Spinner";
import { Tooltip } from "./Tooltip";
import { isPlainEnterKey } from "./modalKeys";

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
  /** 総ページ数が「正確な件数」(#1627) で確定した値か。推定なら false (「約」表示)。 */
  totalExact?: boolean;
  /** 数え終えた正確な総行数。未取得なら null。 */
  exactRowCount?: number | null;
  /** 正確な件数を数えている最中。 */
  counting?: boolean;
  /** 「正確な件数を数える」を押した。渡さなければボタンは出さない。 */
  onCountExact?: () => void;
  onGoToPage: (page: number) => void;
  onSetPageSize: (size: number) => void;
}

// コントロールの寸法は固定 px にせず、設定のフォントサイズ (--font-scale) に
// 追従させる。固定だとフォント拡大時に select / input の値が縦に見切れる
// (フォント・縦 padding はスケールするのに箱だけ 26px のままになるため)。
const CONTROL_H = "calc(26px * var(--font-scale))";
const CONTROL_MIN_W = "calc(60px * var(--font-scale))";

const NavButton = chakra("button", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minW: "calc(28px * var(--font-scale))",
    minH: CONTROL_H,
    px: "1.5",
    borderRadius: "var(--radius-md)",
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
  totalExact = false,
  exactRowCount = null,
  counting = false,
  onCountExact,
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
  const nextOk = canGoNext(page, totalPages, rowsOnPage, pageSize, totalExact) && !loading;
  const lastOk = totalPages != null && page < totalPages && !loading;
  const range = pageRange(page, pageSize, rowsOnPage);
  // 現在のページサイズが選択肢に無ければ先頭に足して必ず選べるようにする。
  const pageSizeOptions = (PAGE_SIZE_OPTIONS as readonly number[]).includes(pageSize)
    ? PAGE_SIZE_OPTIONS
    : [pageSize, ...PAGE_SIZE_OPTIONS];

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
      py="1.25"
      borderTopWidth="1px"
      borderTopColor="app.border"
      bg="app.surface"
      fontSize="sm"
      // ページ番号・行レンジはページ送りのたびに変わるため、バー全体を等幅数字にして
      // 桁の横揺れを防ぐ (#1072)。文字列部分には影響しない。
      textStyle="numeric"
      color="app.textSecondary"
      flex="none"
      flexWrap="wrap"
    >
      <Tooltip label={t("pageFirst")} focusableWrapper={!prevOk}>
        <NavButton type="button" onClick={() => onGoToPage(1)} disabled={!prevOk} aria-label={t("pageFirst")}>
          «
        </NavButton>
      </Tooltip>
      <Tooltip label={t("pagePrev")} focusableWrapper={!prevOk}>
        <NavButton
          type="button"
          onClick={() => onGoToPage(page - 1)}
          disabled={!prevOk}
          aria-label={t("pagePrev")}
        >
          <Icon name="chevron-left" size={ICON_SIZES.sm} />
        </NavButton>
      </Tooltip>

      <chakra.span display="inline-flex" alignItems="center" gap="1.5" minW="0">
        {/* ページ番号・総ページ数・行レンジは CountUp で遷移させる (#1024)。
            reduced-motion / 小さな差分 (前後 1 ページ送り) は即時ジャンプ。 */}
        <CountUpText values={[page]} render={([p]) => t("pageLabel", { page: p })} />
        {totalPages != null && (
          <chakra.span color="app.textMuted">
            <CountUpText
              values={[Math.max(totalPages, page)]}
              render={([n]) => t(totalExact ? "pageOfTotalExact" : "pageOfTotal", { total: n })}
            />
          </chakra.span>
        )}
        {loading && <Spinner size={12} />}
      </chakra.span>

      <Tooltip label={t("pageNext")} focusableWrapper={!nextOk}>
        <NavButton
          type="button"
          onClick={() => onGoToPage(page + 1)}
          disabled={!nextOk}
          aria-label={t("pageNext")}
        >
          <Icon name="chevron-right" size={ICON_SIZES.sm} />
        </NavButton>
      </Tooltip>
      <Tooltip label={t("pageLast")} focusableWrapper={!lastOk}>
        <NavButton
          type="button"
          onClick={() => totalPages != null && onGoToPage(totalPages)}
          disabled={!lastOk}
          aria-label={t("pageLast")}
        >
          »
        </NavButton>
      </Tooltip>

      <chakra.span color="app.textMuted" fontSize="xs">
        {range.to > 0 ? (
          <CountUpText
            values={[range.from, range.to]}
            render={([from, to]) => t("pageRowRange", { from, to })}
          />
        ) : null}
      </chakra.span>

      {exactRowCount != null && (
        <chakra.span textStyle="caption" whiteSpace="nowrap">
          {t("pageTotalRowsExact", { count: exactRowCount })}
        </chakra.span>
      )}
      {onCountExact && (
        <Tooltip label={t("pageCountExactHint")} focusableWrapper={counting}>
          <chakra.button
            type="button"
            onClick={onCountExact}
            disabled={counting}
            display="inline-flex"
            alignItems="center"
            gap="1.5"
            minH={CONTROL_H}
            px="2"
            fontSize="xs"
            whiteSpace="nowrap"
            borderWidth="1px"
            borderColor="app.border"
            borderRadius="md"
            color="app.text"
            bg="transparent"
            cursor="pointer"
            _hover={{ bg: "app.rowHover" }}
            _disabled={{ opacity: 0.6, cursor: "progress" }}
          >
            {counting && <Spinner size={12} />}
            {counting ? t("pageCounting") : exactRowCount != null ? t("pageRecount") : t("pageCountExact")}
          </chakra.button>
        </Tooltip>
      )}

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
            if (isPlainEnterKey(e)) submitJump();
          }}
          disabled={loading}
          w={CONTROL_MIN_W}
          minH={CONTROL_H}
          px="1.5"
          borderWidth="1px"
          borderColor="app.border"
          borderRadius="md"
          bg="app.surface"
          color="app.text"
        />
      </chakra.label>

      <chakra.span display="inline-flex" alignItems="center" gap="1.5" fontSize="xs" whiteSpace="nowrap">
        <chakra.span color="app.textSecondary">{t("pageSizeLabel")}</chakra.span>
        <ListboxSelect
          // 現在のサイズが選択肢に無ければ先頭に足して必ず選べるようにする。
          value={String(pageSize)}
          options={pageSizeOptions.map((s) => ({ value: String(s), label: String(s) }))}
          onChange={(v) => onSetPageSize(Number.parseInt(v, 10))}
          disabled={loading}
          ariaLabel={t("pageSizeLabel")}
          css={{ minHeight: CONTROL_H, minWidth: CONTROL_MIN_W }}
        />
      </chakra.span>
    </Flex>
  );
}
