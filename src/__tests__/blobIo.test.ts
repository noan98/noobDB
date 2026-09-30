import { describe, expect, it } from "vitest";
import { blobFileName, blobKeyParts, bytesToHex, formatBlobSize } from "../components/blobIo";
import { buildBlobUpdateStatement } from "../components/cellEdit";
import type { Column } from "../api/tauri";

const cols: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "data", type_name: "BLOB" },
];

describe("bytesToHex", () => {
  it("小文字 2 桁ずつの 16 進にする", () => {
    expect(bytesToHex(new Uint8Array([0, 255, 16]))).toBe("00ff10");
    expect(bytesToHex(new Uint8Array([]))).toBe("");
  });
});

describe("blobFileName / formatBlobSize", () => {
  it("列名を安全なファイル名にし拡張子を付ける", () => {
    expect(blobFileName("avatar", "png")).toBe("avatar.png");
    expect(blobFileName("a/b c", null)).toBe("a_b_c.bin");
    expect(blobFileName("///", null)).toBe("blob.bin");
  });
  it("サイズを 1024 進で表記する", () => {
    expect(formatBlobSize(10)).toBe("10 B");
    expect(formatBlobSize(2048)).toBe("2.0 KiB");
    expect(formatBlobSize(3 * 1024 * 1024)).toBe("3.0 MiB");
  });
});

describe("blobKeyParts", () => {
  const isBin = (i: number) => i === 1;
  it("主キーの列名と値を返す", () => {
    expect(blobKeyParts(cols, [7, "00"], [0], isBin)).toEqual([{ column: "id", value: 7 }]);
  });
  it("キー無し・NULL キー・バイナリキーは無効 (null)", () => {
    expect(blobKeyParts(cols, [7, "00"], [], isBin)).toBeNull();
    expect(blobKeyParts(cols, [null, "00"], [0], isBin)).toBeNull();
    expect(blobKeyParts(cols, [7, "00"], [1], isBin)).toBeNull();
  });
});

describe("buildBlobUpdateStatement", () => {
  const base = { database: "app", table: "files", columns: cols, row: [7, "00"], pkIndices: [0], colIdx: 1 };
  it("ドライバ別の BLOB リテラルで UPDATE を作る", () => {
    expect(buildBlobUpdateStatement({ ...base, driver: "mysql", hex: "DEAD" })).toBe(
      "UPDATE `app`.`files` SET `data` = 0xdead WHERE `id` = 7;",
    );
    expect(buildBlobUpdateStatement({ ...base, driver: "postgres", hex: "dead" })).toBe(
      "UPDATE \"app\".\"files\" SET \"data\" = '\\xdead' WHERE \"id\" = 7;",
    );
    expect(buildBlobUpdateStatement({ ...base, driver: "sqlite", hex: "dead" })).toBe(
      "UPDATE \"files\" SET \"data\" = X'dead' WHERE \"id\" = 7;",
    );
  });
  it("空ファイルは MySQL では '' になる", () => {
    expect(buildBlobUpdateStatement({ ...base, driver: "mysql", hex: "" })).toContain("= ''");
  });
  it("主キー無し・不正な 16 進・範囲外の列は null", () => {
    expect(buildBlobUpdateStatement({ ...base, driver: "mysql", hex: "00", pkIndices: [] })).toBeNull();
    expect(buildBlobUpdateStatement({ ...base, driver: "mysql", hex: "0" })).toBeNull();
    expect(buildBlobUpdateStatement({ ...base, driver: "mysql", hex: "0g" })).toBeNull();
    expect(buildBlobUpdateStatement({ ...base, driver: "mysql", hex: "00", colIdx: 9 })).toBeNull();
  });
});
