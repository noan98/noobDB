import { describe, expect, it } from "vitest";
import { renderWithProviders } from "./testUtils";
import type { QueryResult } from "../api/tauri";
import { ResultGrid } from "../components/ResultGrid";
import { ResultPaneSkeleton } from "../components/ResultPaneSkeleton";
import {
  RESULT_SKELETON_DEFAULT_COLUMNS,
  RESULT_SKELETON_MAX_COLUMNS,
  resultSkeletonColumns,
  resultSkeletonRows,
  showsResultSkeletonFallback,
} from "../components/resultSkeleton";

/**
 * 結果ペインの初回実行スケルトン (#1071)。
 * 副次パネルと同じ `SkeletonTableRows` + ヘッダ骨格を、列数に追従して出す。
 */

describe("resultSkeletonColumns (#1071)", () => {
  it("列数未知 (null / 0 / 不正値) は既定列数", () => {
    expect(resultSkeletonColumns(null)).toBe(RESULT_SKELETON_DEFAULT_COLUMNS);
    expect(resultSkeletonColumns(undefined)).toBe(RESULT_SKELETON_DEFAULT_COLUMNS);
    expect(resultSkeletonColumns(0)).toBe(RESULT_SKELETON_DEFAULT_COLUMNS);
    expect(resultSkeletonColumns(-3)).toBe(RESULT_SKELETON_DEFAULT_COLUMNS);
    expect(resultSkeletonColumns(NaN)).toBe(RESULT_SKELETON_DEFAULT_COLUMNS);
  });

  it("列数既知ならその列数に合わせ、上限でクランプする", () => {
    expect(resultSkeletonColumns(1)).toBe(1);
    expect(resultSkeletonColumns(3)).toBe(3);
    expect(resultSkeletonColumns(RESULT_SKELETON_MAX_COLUMNS)).toBe(RESULT_SKELETON_MAX_COLUMNS);
    expect(resultSkeletonColumns(200)).toBe(RESULT_SKELETON_MAX_COLUMNS);
  });
});

describe("resultSkeletonRows (#1071)", () => {
  it("密度が詰まるほど行数が増え、3〜8 行に収まる", () => {
    const compact = resultSkeletonRows("compact");
    const normal = resultSkeletonRows("normal");
    const spacious = resultSkeletonRows("spacious");
    expect(compact).toBeGreaterThanOrEqual(normal);
    expect(normal).toBeGreaterThanOrEqual(spacious);
    for (const n of [compact, normal, spacious]) {
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(8);
    }
  });
});

describe("showsResultSkeletonFallback (#1071)", () => {
  it("表の結果をストリーミング中のときだけ骨格", () => {
    expect(showsResultSkeletonFallback({ streaming: true, kind: "query" })).toBe(true);
    expect(showsResultSkeletonFallback({ streaming: true, kind: "table" })).toBe(true);
  });

  it("非実行中・EXPLAIN・バッチ結果は従来の Spinner", () => {
    expect(showsResultSkeletonFallback({ streaming: false, kind: "query" })).toBe(false);
    expect(showsResultSkeletonFallback({ kind: "query" })).toBe(false);
    expect(showsResultSkeletonFallback({ streaming: true, kind: "explain" })).toBe(false);
    expect(showsResultSkeletonFallback({ streaming: true, kind: "query", batchResults: [] })).toBe(false);
  });
});

describe("ResultGrid の columns 受信前 (#1071)", () => {
  it("ストリーミング中で列未着なら、実行中ステータス + 共有の結果ペイン骨格を出す", () => {
    const { container } = renderWithProviders(
      <ResultGrid
        result={{ columns: [], rows: [], rows_affected: 0, elapsed_ms: 0 } as unknown as QueryResult}
        streaming
      />,
    );
    const status = container.querySelector('[role="status"][aria-busy="true"]');
    expect(status).toBeTruthy();
    const skeleton = status?.querySelector(".result-pane-skeleton");
    expect(skeleton).toBeTruthy();
    expect(skeleton?.querySelectorAll("thead th")).toHaveLength(RESULT_SKELETON_DEFAULT_COLUMNS);
  });

  it("ストリーミング完了後 (列なし = DML) は骨格を出さない", () => {
    const { container } = renderWithProviders(
      <ResultGrid
        result={{ columns: [], rows: [], rows_affected: 3, elapsed_ms: 5 } as unknown as QueryResult}
      />,
    );
    expect(container.querySelector(".result-pane-skeleton")).toBeNull();
  });
});

describe("ResultPaneSkeleton (#1071)", () => {
  it("列数未知では既定列数のヘッダ骨格 + 行骨格を出し、支援技術からは隠す", () => {
    const { container } = renderWithProviders(<ResultPaneSkeleton columnCount={null} density="normal" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelectorAll("thead th")).toHaveLength(RESULT_SKELETON_DEFAULT_COLUMNS);
    const bodyRows = container.querySelectorAll("tbody tr");
    expect(bodyRows).toHaveLength(resultSkeletonRows("normal"));
    expect(bodyRows[0].querySelectorAll("td")).toHaveLength(RESULT_SKELETON_DEFAULT_COLUMNS);
  });

  it("列数既知ならその列数に追従する", () => {
    const { container } = renderWithProviders(<ResultPaneSkeleton columnCount={3} density="compact" />);
    expect(container.querySelectorAll("thead th")).toHaveLength(3);
    expect(container.querySelectorAll("tbody tr")[0].querySelectorAll("td")).toHaveLength(3);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(resultSkeletonRows("compact"));
  });
});
