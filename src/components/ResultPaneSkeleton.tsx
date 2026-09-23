import { Box, chakra, type SystemStyleObject } from "@chakra-ui/react";
import type { Density } from "../settings";
import { resultSkeletonColumns, resultSkeletonRows } from "./resultSkeleton";
import { Skeleton, SkeletonTableRows } from "./Skeleton";

/**
 * 結果ペインの初回実行スケルトン (#1071)。
 *
 * 副次パネルの初回ロード (`SkeletonTableRows`) と同じ骨格 — ヘッダ行 + シマー行 —
 * を、最初の行が届くまでの結果ペインに出す。使われる場面は 2 つ:
 *
 * 1. `App.tsx` の結果ペイン `Suspense` fallback: 初回実行で `ResultGrid` の
 *    チャンクを遅延ロードしている間 (従来は Spinner だけだった)。
 * 2. `ResultGrid` の `query-stream:columns` 受信前: 列数未知なので既定列数の骨格。
 *
 * 列数が分かった後 (columns 受信 → 最初の rows 到着前) は、`DataGrid` が実ヘッダの
 * 下に列数ぶんの骨格行を出す既存の経路 (#657) がそのまま担う。最初の行が届いた
 * 時点で即座に実データへ差し替わり、最小表示時間は設けない (ちらつき防止)。
 *
 * - 純粋に視覚的なプレースホルダなので `aria-hidden`。実行中であることは呼び出し側
 *   (`role="status"` / `aria-busy` を持つ親や StreamingBanner) が伝える。
 * - シマーは `Skeleton` 共有定義のため、reduced-motion では App.css の規則で静止する。
 */
export function ResultPaneSkeleton({
  columnCount,
  density,
}: {
  /** 既知の列数。未知 (columns 未着) なら null / 0。 */
  columnCount: number | null;
  density: Density;
}) {
  const columns = resultSkeletonColumns(columnCount);
  const rows = resultSkeletonRows(density);
  return (
    <Box flex="1 1 auto" minHeight={0} minWidth={0} overflow="hidden" aria-hidden className="result-pane-skeleton">
      <chakra.table width="100%" css={tableCss}>
        <thead>
          <tr>
            {Array.from({ length: columns }, (_, ci) => (
              <chakra.th key={ci} css={thCss}>
                <Skeleton
                  height="10px"
                  style={{
                    width: `${HEADER_WIDTHS[ci % HEADER_WIDTHS.length]}%`,
                    animationDelay: `${ci * 0.035}s`,
                  }}
                />
              </chakra.th>
            ))}
          </tr>
        </thead>
        <tbody>
          <SkeletonTableRows columns={columns} rows={rows} />
        </tbody>
      </chakra.table>
    </Box>
  );
}

/** ヘッダ骨格のバー幅 (列見出しは本文より短めに見せる)。 */
const HEADER_WIDTHS = [40, 55, 35, 50, 45, 60, 38, 52];

const tableCss: SystemStyleObject = {
  borderCollapse: "collapse",
  tableLayout: "fixed",
};

// 副次パネル (`ProcessListPanel` など) のヘッダ行と同じ境界・余白。面は結果グリッドの
// ヘッダ色にする (骨格バー自体が `--bg-muted` なので、同色の面だと見えなくなる)。
const thCss: SystemStyleObject = {
  background: "var(--bg-header)",
  borderBottom: "1px solid var(--border)",
  padding: "var(--space-1-5) var(--space-2-5)",
  textAlign: "left",
};
