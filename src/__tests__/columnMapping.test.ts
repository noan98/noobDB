import { describe, expect, it } from "vitest";
import { assignableTargetColumns, unmatchedSourceColumns } from "../components/columnMapping";
import golden from "./fixtures/columnMappingVectors.json";

// データ比較の列の対応付け (#2099)。Rust (`db/column_mapping.rs`) と同じ判定を共有ゴールデンで固定する。
describe("columnMapping 共有ゴールデン", () => {
  for (const c of golden.cases) {
    it(c.name, () => {
      expect(
        unmatchedSourceColumns(c.source, c.target, c.mapping as Record<string, string>, c.caseInsensitive),
      ).toEqual(c.unmatched);
    });
  }
});

describe("assignableTargetColumns", () => {
  const source = ["id", "user_name", "mail"];
  const target = ["id", "username", "email", "extra"];

  it("同名で対応済みの列は選択肢に出さない", () => {
    expect(assignableTargetColumns(source, target, {}, false, undefined)).toEqual([
      "username",
      "email",
      "extra",
    ]);
  });

  it("他のソース列に割り当て済みの列は除き、自分の割り当ては残す", () => {
    const mapping = { user_name: "username" };
    expect(assignableTargetColumns(source, target, mapping, false, undefined)).toEqual(["email", "extra"]);
    expect(assignableTargetColumns(source, target, mapping, false, "username")).toEqual([
      "username",
      "email",
      "extra",
    ]);
  });
});
