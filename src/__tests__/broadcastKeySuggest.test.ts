import { describe, it, expect } from "vitest";
import { suggestKeyColumn } from "../components/BroadcastModal";
import type { Column } from "../api/tauri";

const col = (name: string): Column => ({ name, type_name: "int" }) as Column;

describe("suggestKeyColumn (#1612)", () => {
  it("id / *_id で値が一意な最初の列を返す", () => {
    const columns = [col("name"), col("user_id"), col("id")];
    const rows = [
      ["a", 1, 10],
      ["b", 2, 11],
    ];
    expect(suggestKeyColumn(columns, rows)).toBe("user_id");
  });

  it("値が重複する列や NULL を含む列は候補にしない", () => {
    const columns = [col("group_id"), col("id")];
    expect(
      suggestKeyColumn(columns, [
        [1, 10],
        [1, 11],
      ]),
    ).toBe("id");
    expect(
      suggestKeyColumn(columns, [
        [1, null],
        [1, 11],
      ]),
    ).toBeNull();
  });

  it("行が無い・候補名の列が無いときは null", () => {
    expect(suggestKeyColumn([col("id")], [])).toBeNull();
    expect(suggestKeyColumn([col("name")], [["x"]])).toBeNull();
  });

  it('数値の 1 と文字列の "1" は別の値として扱う', () => {
    expect(suggestKeyColumn([col("id")], [[1], ["1"]])).toBe("id");
  });
});
