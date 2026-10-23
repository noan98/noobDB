import { chakra } from "@chakra-ui/react";

/**
 * スケルトン UI プリミティブ。
 *
 * ## 使い分けガイド (ローディング / 空 / エラーの 3 状態)
 *
 * ```
 * 状態         コンポーネント       用途
 * ──────────   ────────────────────  ──────────────────────────────────────────
 * ロード中     Skeleton /            構造の予兆を示しつつデータ到着を待つ。
 *              SkeletonRow           初回ロード時・遅延フェッチ中に使う。
 * 空 / エラー  EmptyState            クエリ結果 0 件・DB 接続なし・エラー詳細
 *                                    など「確定した状態」を人間向けに伝える。
 * 操作結果     Toast (useToast)      コピー完了・Apply 成功など短命の通知。
 * ```
 *
 * ## 強制レベル
 * - スケルトンはあくまで **視覚的なプレースホルダ** で、ロード完了後に実データへ
 *   差し替わる。アクセシビリティのため `aria-hidden` で支援技術からは隠す。
 *
 * ## `prefers-reduced-motion` 対応
 * シマーアニメーション (`skeleton-shimmer`) は `App.css` 末尾の
 * `@media (prefers-reduced-motion: reduce)` ルールで `animation-duration: 0.01ms`
 * に上書きされ、実質静止する (他の keyframe と同方式)。
 *
 * @public
 */

/** スケルトンのシマー演出が共有する土台 (`position`/`overflow`/`background`)。
 *  サイズ (`height`/`borderRadius`/余白) は利用側で上書きする。
 *
 * @public
 */
export const shimmerContainerCss = {
  position: "relative",
  overflow: "hidden",
  background: "var(--bg-muted)",
} as const;

/** シマーのハイライト帯を描く `::after` 疑似要素のスタイル。`Skeleton` /
 *  `SkeletonRow` / `ResultGrid` の grid-skeleton-cell が共有する単一の定義
 *  で、帯幅・色・周期を変えるときの修正漏れを防ぐ (#719)。
 *
 *  ハイライト帯は疑似要素の `transform: translateX` でスライドさせる
 *  (background-position の補間は再ペイントを毎フレーム誘発するため使わない)。
 *  スタッガ用の `animationDelay` は要素の inline style に渡せば疑似要素が
 *  `animation-delay: inherit` で引き継ぐ。
 *
 * @public
 */
export const shimmerAfterCss = {
  content: '""',
  position: "absolute",
  inset: 0,
  background: "linear-gradient(90deg, transparent, var(--bg-elevated), transparent)",
  animation: "skeleton-shimmer var(--dur-shimmer) ease-in-out infinite",
  animationDelay: "inherit",
} as const;

/** 1 行スケルトンプリミティブ。幅・高さを props で制御する。
 *
 *  シマーは `skeleton-shimmer` keyframe (App.css) で実装済みで、
 *  `prefers-reduced-motion` では静止する。テーマの `--bg-muted` /
 *  `--bg-elevated` トークンを使うのでライト/ダーク切替に自動追従する。
 */
export const Skeleton = chakra("div", {
  base: {
    ...shimmerContainerCss,
    borderRadius: "var(--radius-xs)",
    "&::after": shimmerAfterCss,
  },
});

/** ツリーノード行サイズのスケルトン行。ConnectionList の遅延ロード表示に使う。
 *
 *  `Skeleton` と同じシマーアニメーションを持つが、ツリー行の高さ (22px) に
 *  合わせて縦余白を確保し、インデント付きで並べやすい形に整えてある。
 *  `aria-hidden` はレンダリング側で付与すること。
 */
export const SkeletonRow = chakra("div", {
  base: {
    ...shimmerContainerCss,
    height: "22px",
    mx: "1",
    my: "0.75",
    borderRadius: "var(--radius-sm)",
    "&::after": shimmerAfterCss,
  },
});

/** テーブル行スケルトンのバー幅パターン。視覚的な単調さを避けるため列/行の位置で
 *  周期させる (`ConnectionList` の `SKELETON_ROW_WIDTHS` と同じ発想)。 */
const TABLE_ROW_SKELETON_WIDTHS = [70, 45, 85, 60, 78, 52];

/** 表構造を持つパネル (`ServerInfoPanel` / `TableStatisticsPanel` /
 *  `ProcessListPanel` など) の初回ロード中に、`<tbody>` の中身だけを差し替える
 *  行スケルトンヘルパー (#846)。実データの `<thead>` はそのまま表示し続けるため、
 *  列見出しを消さずに構造の予兆だけを示せる。
 *
 *  `Skeleton` と同じシマー・`prefers-reduced-motion` 挙動を継承する。行ごとに
 *  `opacity`/`animationDelay` を段階的にずらして奥行きを出す (`ResultGrid` の
 *  grid-skeleton-row と同じ考え方)。ロード状態は呼び出し側の既存インジケータ
 *  (ツールバーの `Spinner` など、`role="status"`) が ARIA で伝えるため、ここは
 *  純粋に視覚的なプレースホルダとして `aria-hidden` を付ける。
 *
 * @public
 */
export function SkeletonTableRows({
  columns,
  rows = 6,
}: {
  /** 列数 (各行に敷くバーの数)。実データの `<thead>` の列数に合わせる。 */
  columns: number;
  /** 表示する行数。既定 6 (ResultGrid のストリーミングスケルトンに合わせる)。 */
  rows?: number;
}) {
  return (
    <>
      {Array.from({ length: rows }, (_, ri) => (
        <tr key={ri} aria-hidden style={{ opacity: 1 - ri * 0.12 }}>
          {Array.from({ length: columns }, (_, ci) => (
            <td key={ci} style={{ padding: "var(--space-1-25) var(--space-2-5)" }}>
              <Skeleton
                height="13px"
                style={{
                  width: `${TABLE_ROW_SKELETON_WIDTHS[(ri + ci) % TABLE_ROW_SKELETON_WIDTHS.length]}%`,
                  animationDelay: `${(ri * columns + ci) * 0.035}s`,
                }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** 横断検索モーダル (オブジェクト検索 / データ検索) の結果行を模した行スケルトン
 *  (#1212)。先頭のアイコン枠 + 2 段の文字バーという結果行の形を保ち、スキャン中
 *  に「ここに結果が並ぶ」予兆を示す。`SkeletonTableRows` と同様に行ごとに
 *  `opacity`/`animationDelay` を段階的にずらし、`aria-hidden` の純粋な視覚
 *  プレースホルダとする (待機は呼び出し側の `aria-busy` が伝える)。
 *
 * @public
 */
export function SkeletonSearchRows({ rows = 5 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, ri) => (
        <div
          key={ri}
          aria-hidden
          data-testid="search-skeleton-row"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-1-75) var(--space-4)",
            opacity: 1 - ri * 0.12,
          }}
        >
          <Skeleton
            style={{
              width: "var(--space-4)",
              height: "var(--space-4)",
              flexShrink: 0,
              animationDelay: `${ri * 0.035}s`,
            }}
          />
          <div
            style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)", flex: 1, minWidth: 0 }}
          >
            <Skeleton
              style={{
                height: "var(--space-3)",
                width: `${TABLE_ROW_SKELETON_WIDTHS[ri % TABLE_ROW_SKELETON_WIDTHS.length]}%`,
                animationDelay: `${ri * 0.035}s`,
              }}
            />
            <Skeleton
              style={{
                height: "var(--space-2-5)",
                width: `${TABLE_ROW_SKELETON_WIDTHS[(ri + 3) % TABLE_ROW_SKELETON_WIDTHS.length] / 2}%`,
                animationDelay: `${ri * 0.035}s`,
              }}
            />
          </div>
        </div>
      ))}
    </>
  );
}

/** ER 図ローディング用のノードグラフ風スケルトン (#1834)。テーブルカード (ヘッダ +
 *  列バー) を 2 行に並べ、カード間をシマーする細い線で結んで「ここにテーブルと
 *  リレーションが描かれる」予兆を示す。親は `position: relative` の領域で、
 *  絶対配置で全面を覆う。`aria-hidden` の純粋な視覚プレースホルダで、待機の通知は
 *  呼び出し側の `role="status"` 文言が担う。
 *
 * @public
 */
export const ER_GRAPH_SKELETON_NODES: readonly { left: number; top: number; cols: readonly number[] }[] = [
  { left: 8, top: 10, cols: [70, 55, 62] },
  { left: 42, top: 6, cols: [60, 75, 48, 66] },
  { left: 74, top: 14, cols: [66, 52] },
  { left: 20, top: 52, cols: [58, 72, 50] },
  { left: 58, top: 50, cols: [64, 46, 70] },
];

/** ノード間の接続線 (横線 / 縦線) の位置。`left`/`top`/`size` は親に対する % */
const ER_GRAPH_SKELETON_LINKS: readonly { left: number; top: number; w?: number; h?: number }[] = [
  { left: 24, top: 20, w: 18 },
  { left: 58, top: 20, w: 16 },
  { left: 14, top: 36, h: 16 },
  { left: 52, top: 40, h: 10 },
  { left: 36, top: 62, w: 22 },
];

export function ErGraphSkeleton() {
  return (
    <div
      aria-hidden
      data-testid="er-graph-skeleton"
      style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}
    >
      {ER_GRAPH_SKELETON_LINKS.map((l, i) => (
        <Skeleton
          key={`l${i}`}
          style={{
            position: "absolute",
            left: `${l.left}%`,
            top: `${l.top}%`,
            width: l.w != null ? `${l.w}%` : "var(--space-0-5)",
            height: l.h != null ? `${l.h}%` : "var(--space-0-5)",
            animationDelay: `${i * 0.05}s`,
          }}
        />
      ))}
      {ER_GRAPH_SKELETON_NODES.map((n, i) => (
        <div
          key={`n${i}`}
          style={{
            position: "absolute",
            left: `${n.left}%`,
            top: `${n.top}%`,
            width: "18%",
            minWidth: "calc(var(--space-12) * 3)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-1-5)",
            padding: "var(--space-2)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-md)",
            opacity: 1 - i * 0.08,
          }}
        >
          <Skeleton style={{ height: "var(--space-3-5)", width: "70%", animationDelay: `${i * 0.05}s` }} />
          {n.cols.map((w, ci) => (
            <Skeleton
              key={ci}
              style={{ height: "var(--space-2-5)", width: `${w}%`, animationDelay: `${(i + ci) * 0.04}s` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** チャートの集計待ち用スケルトン (#1834)。左に Y 軸の目盛り線、下に X 軸、棒が
 *  立ち上がる形のバーを並べて「ここにチャートが描かれる」予兆を示す。棒の高さは
 *  `CHART_SKELETON_BARS` (%) で周期させ、`aria-hidden` の視覚プレースホルダとする。
 *
 * @public
 */
export const CHART_SKELETON_BARS: readonly number[] = [42, 68, 55, 82, 38, 74, 60, 90, 48, 66];

export function ChartSkeleton() {
  return (
    <div
      aria-hidden
      data-testid="chart-skeleton"
      style={{
        height: "100%",
        minHeight: "calc(var(--space-12) * 3)",
        display: "flex",
        gap: "var(--space-2)",
        padding: "var(--space-2)",
      }}
    >
      <Skeleton style={{ width: "var(--space-0-5)", flexShrink: 0 }} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "var(--space-2)", minWidth: 0 }}>
        <div style={{ flex: 1, display: "flex", alignItems: "flex-end", gap: "var(--space-2)" }}>
          {CHART_SKELETON_BARS.map((h, i) => (
            <Skeleton key={i} style={{ flex: 1, height: `${h}%`, animationDelay: `${i * 0.05}s` }} />
          ))}
        </div>
        <Skeleton style={{ height: "var(--space-0-5)" }} />
      </div>
    </div>
  );
}
