import { describe, expect, it } from "vitest";

import explainGraphView from "../components/ExplainGraphView.tsx?raw";
import { erExportGeometry } from "../components/ERDiagramView";

// 実行計画グラフの画像書き出し (#1628): ER 図と同じ全景ジオメトリを使い、PNG / SVG の両方を出す。
describe("実行計画グラフの書き出し", () => {
  it("ImageExportButton を PNG / SVG の両方で配線している", () => {
    expect(explainGraphView).toContain("<ImageExportButton");
    expect(explainGraphView).toContain("elementToPngBlob");
    expect(explainGraphView).toContain("elementToSvgBytes");
    expect(explainGraphView).toContain("erExportGeometry");
  });

  it("巨大なグラフは切り捨てず縮小して収める", () => {
    const g = erExportGeometry({ x: 0, y: 0, width: 20000, height: 400 });
    expect(g.scale).toBeLessThan(1);
    expect(g.width).toBeLessThanOrEqual(8000);
  });
});
