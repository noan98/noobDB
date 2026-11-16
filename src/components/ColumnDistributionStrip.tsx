import type { useDelegatedTooltip } from "./Tooltip";
import type { useT } from "../i18n";
import {
  binFilterBounds,
  binHeightRatios,
  binRangeLabel,
  type ColumnDistribution,
  topWidthRatios,
} from "./gridColumnDistribution";
import type { ColumnFilter } from "./gridSortFilter";

/**
 * 列ヘッダのミニ分布 (#2383) の描画。集計は純モジュール `gridColumnDistribution.ts`、
 * ここは結果を小さな DOM (ビン = 最大 16 個) にするだけ。高さは scaleY、幅は flex-grow で表し、
 * 再計算時は CSS の transition で補間する (`prefers-reduced-motion` では即時、App.css)。
 * ツールチップは委譲型 (`bind`) で、native `title` は使わない。
 */
interface Props {
  dist: ColumnDistribution | null;
  colName: string;
  /** この列の現在の列フィルタ (ビンのクリックで作った範囲の強調に使う)。 */
  filter: ColumnFilter | undefined;
  /** ビンのクリックで範囲フィルタを使えるか (サーバ側フィルタの画面では false)。 */
  canFilter: boolean;
  /** `null` でこの列の範囲フィルタを解除する。 */
  onBinFilter: (filter: ColumnFilter | null) => void;
  t: ReturnType<typeof useT>;
  bindTooltip: ReturnType<typeof useDelegatedTooltip>["bind"];
}

function percentText(ratio: number): string {
  const p = ratio * 100;
  return p > 0 && p < 1 ? p.toFixed(1) : Math.round(p).toString();
}

export function ColumnDistributionStrip({
  dist,
  colName,
  filter,
  canFilter,
  onBinFilter,
  t,
  bindTooltip,
}: Props) {
  if (!dist) return <div className="th-dist" aria-hidden />;
  const basis = t("gridDistBasis", { n: dist.total.toLocaleString() });
  const aria = t("gridDistAria", { column: colName });

  let body: React.ReactNode = null;
  if (dist.mode === "none") {
    body = null;
  } else if (dist.mode === "top") {
    const { parts, other } = topWidthRatios(dist);
    const nonNull = dist.total - dist.nulls;
    body = (
      <div className="th-dist-stack">
        {dist.top.map((tv, i) => (
          <div
            key={tv.label}
            className="th-dist-seg"
            data-rank={i}
            style={{ flexGrow: parts[i] }}
            {...bindTooltip(
              t("gridDistTop", {
                value: tv.label,
                count: tv.count.toLocaleString(),
                percent: percentText(nonNull > 0 ? tv.count / nonNull : 0),
                basis,
              }),
            )}
          />
        ))}
        {dist.otherCount > 0 && (
          <div
            className="th-dist-seg"
            data-rank="other"
            style={{ flexGrow: other }}
            {...bindTooltip(
              t("gridDistOther", {
                count: dist.otherCount.toLocaleString(),
                percent: percentText(other),
                basis,
              }),
            )}
          />
        )}
      </div>
    );
  } else {
    const ratios = binHeightRatios(dist.bins);
    const active =
      filter?.op === "between"
        ? dist.bins.findIndex((_, i) => {
            const b = binFilterBounds(dist, i);
            return b !== null && b.lo === filter.value && b.hi === filter.value2;
          })
        : -1;
    body = dist.bins.map((bin, i) => {
      const bounds = canFilter ? binFilterBounds(dist, i) : null;
      const range = binRangeLabel(dist, i);
      const isActive = i === active;
      const label = t(bounds ? (isActive ? "gridDistBinActive" : "gridDistBin") : "gridDistBinInfo", {
        range,
        count: bin.count.toLocaleString(),
        basis,
      });
      return (
        <button
          key={i}
          type="button"
          tabIndex={-1}
          className={`th-dist-bin ${bounds ? "is-clickable" : ""} ${active >= 0 && !isActive ? "is-dim" : ""}`}
          aria-label={label}
          aria-pressed={bounds ? isActive : undefined}
          onClick={
            bounds
              ? () =>
                  onBinFilter(
                    isActive ? null : { op: "between", value: bounds.lo, value2: bounds.hi, nullMode: "any" },
                  )
              : undefined
          }
          {...bindTooltip(label)}
        >
          <span
            className="th-dist-bin-fill"
            style={{ transform: `scaleY(${bin.count > 0 ? Math.max(ratios[i], 0.12) : 0})` }}
          />
        </button>
      );
    });
  }

  return (
    <div className="th-dist" role="group" aria-label={aria}>
      {dist.mode === "none" ? (
        <div className="th-dist-stack" aria-hidden {...bindTooltip(t("gridDistNone", { basis }))} />
      ) : (
        body
      )}
      {dist.unique && (
        <span
          className="th-dist-unique"
          {...bindTooltip(t("gridDistUniqueTip", { n: dist.total.toLocaleString(), basis }))}
        >
          {t("gridDistUnique")}
        </span>
      )}
    </div>
  );
}
