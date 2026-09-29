import { describe, expect, it } from "vitest";
import {
  blobFileName,
  blobKeyParts,
  detectBlobKind,
  detectBlobKindFromHex,
  formatBlobSize,
  hexToBytes,
} from "../components/blobIo";
import { buildBlobUpdateStatement } from "../components/cellEdit";
import type { Column } from "../api/tauri";

const cols: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "data", type_name: "BLOB" },
];

describe("hexToBytes", () => {
  it("decodes and rejects malformed input", () => {
    expect(Array.from(hexToBytes("00ff10")!)).toEqual([0, 255, 16]);
    expect(hexToBytes("abc")).toBeNull();
    expect(hexToBytes("zz")).toBeNull();
    expect(hexToBytes("")!.length).toBe(0);
  });
});

describe("detectBlobKind (マジックバイト)", () => {
  it("画像・PDF・アーカイブを判定する", () => {
    expect(detectBlobKindFromHex("89504e470d0a1a0a0000")?.mime).toBe("image/png");
    expect(detectBlobKindFromHex("ffd8ffe000104a46")?.mime).toBe("image/jpeg");
    expect(detectBlobKindFromHex("474946383961")?.mime).toBe("image/gif");
    expect(detectBlobKindFromHex("52494646000000005745425056503820")?.mime).toBe("image/webp");
    expect(detectBlobKindFromHex("255044462d312e34")).toMatchObject({ mime: "application/pdf", image: false });
    expect(detectBlobKindFromHex("504b0304")?.ext).toBe("zip");
    expect(detectBlobKindFromHex("1f8b0800")?.ext).toBe("gz");
  });
  it("判別できないものは null、RIFF だけでは WebP にしない", () => {
    expect(detectBlobKindFromHex("deadbeef")).toBeNull();
    expect(detectBlobKindFromHex("52494646000000004156492000")).toBeNull();
    expect(detectBlobKind(new Uint8Array([]))).toBeNull();
    // "BM" だけ (14 バイト未満) は BMP と見なさない
    expect(detectBlobKind(new Uint8Array([0x42, 0x4d, 0]))).toBeNull();
  });
});

describe("blobFileName / formatBlobSize", () => {
  it("列名を安全なファイル名にし拡張子を付ける", () => {
    expect(blobFileName("avatar", { mime: "image/png", ext: "png", image: true })).toBe("avatar.png");
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
