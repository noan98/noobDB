import { describe, expect, it } from "vitest";
import {
  BUILTIN_EXPORT_MASK_PRESETS,
  countMaskedColumns,
  defaultMaskRule,
  effectiveMaskRule,
  EXPORT_MASK_RULE_KINDS,
  presetRuleFor,
  resolveExportMasks,
  sameMaskRule,
  sanitizeMaskPresets,
  sanitizeMaskRule,
  upsertMaskPreset,
  type ExportMaskPreset,
} from "../components/exportMasking";

/**
 * エクスポート時のデータマスキング (#733) のフロント側純ロジック。値の変換は
 * バックエンド (`db/masking.rs`) が担うので、ここはルールの正規化・プリセット解決・
 * 列単位の上書きを固定する (バックとの正規化の一致は exportMaskingGolden.test.ts)。
 */

describe("sanitizeMaskRule", () => {
  it("フロント固有の壊れた入力 (負数・小数・文字列・未知の kind) を安全側へ丸める", () => {
    expect(sanitizeMaskRule({ kind: "partial", keepStart: -3, keepEnd: 2.7 })).toEqual({
      kind: "partial",
      keepStart: 0,
      keepEnd: 2,
    });
    expect(sanitizeMaskRule({ kind: "hash", length: "8" })).toEqual({ kind: "hash", length: 16 });
    expect(sanitizeMaskRule({ kind: "hash", length: Number.NaN })).toEqual({ kind: "hash", length: 16 });
    expect(sanitizeMaskRule({ kind: "fixed", value: 42 })).toEqual({ kind: "fixed", value: "***" });
    expect(sanitizeMaskRule({ kind: "rot13" })).toBeNull();
    expect(sanitizeMaskRule(null)).toBeNull();
    expect(sanitizeMaskRule("hash")).toBeNull();
  });

  it("余計なフィールドは落とす (IPC へ未知キーを送らない)", () => {
    expect(sanitizeMaskRule({ kind: "null", value: "x" })).toEqual({ kind: "null" });
  });

  it("全種別の既定ルールは正規形", () => {
    for (const kind of EXPORT_MASK_RULE_KINDS) {
      const r = defaultMaskRule(kind);
      expect(sanitizeMaskRule(r)).toEqual(r);
    }
  });
});

describe("sanitizeMaskPresets", () => {
  it("配列でなければ fallback (同梱プリセット) を返す", () => {
    expect(sanitizeMaskPresets(undefined, BUILTIN_EXPORT_MASK_PRESETS)).toEqual(BUILTIN_EXPORT_MASK_PRESETS);
    expect(sanitizeMaskPresets("x", [])).toEqual([]);
  });

  it("パターンを小文字化・trim し、不正ルールと重複 (先勝ち) を捨てる", () => {
    expect(
      sanitizeMaskPresets(
        [
          { pattern: "  Email ", rule: { kind: "null" } },
          { pattern: "email", rule: { kind: "fixed" } },
          { pattern: "", rule: { kind: "null" } },
          { pattern: "phone", rule: { kind: "bogus" } },
          { pattern: 3, rule: { kind: "null" } },
          "junk",
        ],
        [],
      ),
    ).toEqual([{ pattern: "email", rule: { kind: "null" } }]);
  });

  it("同梱プリセットは email / phone / name 系を含み、すべて正規形", () => {
    const patterns = BUILTIN_EXPORT_MASK_PRESETS.map((p) => p.pattern);
    expect(patterns).toEqual(expect.arrayContaining(["email", "phone", "last_name"]));
    expect(sanitizeMaskPresets(BUILTIN_EXPORT_MASK_PRESETS, [])).toEqual(BUILTIN_EXPORT_MASK_PRESETS);
  });
});

describe("列ごとのルール解決", () => {
  const presets: ExportMaskPreset[] = [
    { pattern: "email", rule: { kind: "partial", keepStart: 2, keepEnd: 4 } },
    { pattern: "*_id", rule: { kind: "hash", length: 16 } },
  ];

  it("表示マスク (#1069) と同じパターン規則 (部分一致・大文字小文字無視・グロブ) で一致する", () => {
    expect(presetRuleFor("User_EMAIL", presets)?.kind).toBe("partial");
    expect(presetRuleFor("customer_id", presets)?.kind).toBe("hash");
    expect(presetRuleFor("id", presets)).toBeNull();
  });

  it("上書きはプリセットより優先し、null は「マスクしない」", () => {
    expect(effectiveMaskRule("email", presets, { email: null })).toBeNull();
    expect(effectiveMaskRule("note", presets, { note: { kind: "null" } })).toEqual({ kind: "null" });
    expect(effectiveMaskRule("email", presets, {})?.kind).toBe("partial");
  });

  it("resolveExportMasks は同名列を 1 件にまとめ、マスクしない列を含めない", () => {
    const masks = resolveExportMasks(["id", "email", "customer_id", "email"], presets, {});
    expect(masks.map((m) => m.column)).toEqual(["email", "customer_id"]);
    // 件数は位置単位 (同名列 2 つとも出力でマスクされる)。
    expect(countMaskedColumns(["id", "email", "customer_id", "email"], masks)).toBe(3);
    expect(countMaskedColumns(["id"], [])).toBe(0);
  });
});

describe("upsertMaskPreset", () => {
  const base: ExportMaskPreset[] = [{ pattern: "email", rule: { kind: "null" } }];

  it("列名 (小文字化) のプリセットを先頭に追加し、広いパターンより優先させる", () => {
    const next = upsertMaskPreset(base, "User_Email", { kind: "hash", length: 8 });
    expect(next[0]).toEqual({ pattern: "user_email", rule: { kind: "hash", length: 8 } });
    expect(presetRuleFor("user_email", next)).toEqual({ kind: "hash", length: 8 });
  });

  it("同じパターンは置き換え、null なら削除する", () => {
    expect(upsertMaskPreset(base, "email", { kind: "fixed", value: "x" })).toEqual([
      { pattern: "email", rule: { kind: "fixed", value: "x" } },
    ]);
    expect(upsertMaskPreset(base, "email", null)).toEqual([]);
    expect(upsertMaskPreset(base, "   ", { kind: "null" })).toEqual(base);
  });
});

describe("sameMaskRule", () => {
  it("構造で比較する", () => {
    expect(sameMaskRule({ kind: "hash", length: 8 }, { kind: "hash", length: 8 })).toBe(true);
    expect(sameMaskRule({ kind: "hash", length: 8 }, null)).toBe(false);
    expect(sameMaskRule(null, null)).toBe(true);
  });
});
