import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MASK_PATTERNS,
  MASK_PLACEHOLDER,
  formatMaskPatterns,
  isCellMasked,
  isCellRevealed,
  isColumnMasked,
  maskedCopyText,
  matchesMaskPattern,
  parseMaskPatterns,
  resolveMaskedColumns,
  rowHasMaskedCell,
  sanitizeMaskPatterns,
  toggleMaskOverride,
} from "../components/columnMask";
import {
  normalizeGridView,
  readStoredGridView,
  toPersistedGridView,
  writeStoredGridView,
} from "../components/gridViewState";
import { DEFAULT_SETTINGS, deserializeSettingsImport } from "../settings";

// 結果グリッドの機微カラム表示マスク (#1069) の純ロジック。

describe("matchesMaskPattern", () => {
  it("ワイルドカード無しは大文字小文字を無視した部分一致", () => {
    expect(matchesMaskPattern("user_email", ["email"])).toBe(true);
    expect(matchesMaskPattern("EmailAddress", ["email"])).toBe(true);
    expect(matchesMaskPattern("name", ["email"])).toBe(false);
  });

  it("* / ? を含むパターンは列名全体に対するグロブ", () => {
    expect(matchesMaskPattern("card_pin", ["*_pin"])).toBe(true);
    expect(matchesMaskPattern("pin_code", ["*_pin"])).toBe(false);
    expect(matchesMaskPattern("pin", ["p?n"])).toBe(true);
    expect(matchesMaskPattern("spin", ["p?n"])).toBe(false);
  });

  it("正規表現のメタ文字はリテラル扱い (パターンから正規表現を注入できない)", () => {
    expect(matchesMaskPattern("a.b", ["a.b*"])).toBe(true);
    expect(matchesMaskPattern("axb", ["a.b*"])).toBe(false);
    expect(matchesMaskPattern("x(y", ["x(y"])).toBe(true);
  });

  it("空・空白だけのパターンは何にも一致しない", () => {
    expect(matchesMaskPattern("email", ["", "   "])).toBe(false);
  });

  it("既定パターンは代表的な機微カラムに一致する", () => {
    for (const name of ["password_hash", "api_token", "SSN", "client_secret", "email"]) {
      expect(matchesMaskPattern(name, DEFAULT_MASK_PATTERNS)).toBe(true);
    }
    for (const name of ["id", "name", "created_at", "qty"]) {
      expect(matchesMaskPattern(name, DEFAULT_MASK_PATTERNS)).toBe(false);
    }
  });
});

describe("sanitizeMaskPatterns / parseMaskPatterns", () => {
  it("配列でなければ fallback", () => {
    expect(sanitizeMaskPatterns("email", ["x"])).toEqual(["x"]);
    expect(sanitizeMaskPatterns(undefined, DEFAULT_MASK_PATTERNS)).toEqual([
      ...DEFAULT_MASK_PATTERNS,
    ]);
  });

  it("非文字列・空・長すぎるものを捨て、小文字化して重複を除く", () => {
    expect(sanitizeMaskPatterns([" Email ", 3, "", "email", "x".repeat(101), "Token"], [])).toEqual([
      "email",
      "token",
    ]);
  });

  it("空配列は空配列のまま (パターンでは何もマスクしない)", () => {
    expect(sanitizeMaskPatterns([], DEFAULT_MASK_PATTERNS)).toEqual([]);
  });

  it("カンマ/改行区切りの入力を解析し、表示用に整形し直せる", () => {
    const parsed = parseMaskPatterns("email, token\nSSN,, ");
    expect(parsed).toEqual(["email", "token", "ssn"]);
    expect(formatMaskPatterns(parsed)).toBe("email, token, ssn");
  });
});

describe("isColumnMasked / resolveMaskedColumns", () => {
  const base = { enabled: true, patterns: ["email"] };

  it("機能オフなら何もマスクしない (上書きがあっても)", () => {
    expect(isColumnMasked("email", { ...base, enabled: false })).toBe(false);
    expect(
      isColumnMasked("name", { ...base, enabled: false, overrides: { name: true } }),
    ).toBe(false);
    expect(resolveMaskedColumns(["email"], { ...base, enabled: false })).toBeNull();
  });

  it("列単位の上書きはパターンより優先 (両方向)", () => {
    expect(isColumnMasked("email", { ...base, overrides: { email: false } })).toBe(false);
    expect(isColumnMasked("name", { ...base, overrides: { name: true } })).toBe(true);
  });

  it("1 列もマスクしなければ null、あれば列順のフラグ", () => {
    expect(resolveMaskedColumns(["id", "name"], base)).toBeNull();
    expect(resolveMaskedColumns(["id", "email", "name"], base)).toEqual([false, true, false]);
  });
});

describe("toggleMaskOverride", () => {
  it("パターンと異なる指定だけを上書きとして残す", () => {
    const patterns = ["email"];
    const off = toggleMaskOverride({}, "email", patterns, false);
    expect(off).toEqual({ email: false });
    // パターンと同じ状態へ戻すと上書きは消える (パターン設定の変更に再び追従する)。
    expect(toggleMaskOverride(off, "email", patterns, true)).toEqual({});
    expect(toggleMaskOverride({}, "name", patterns, true)).toEqual({ name: true });
    expect(toggleMaskOverride({ name: true }, "name", patterns, false)).toEqual({});
  });

  it("元のオブジェクトを変更しない", () => {
    const orig = { name: true };
    toggleMaskOverride(orig, "name", [], false);
    expect(orig).toEqual({ name: true });
  });
});

describe("reveal / マスク中判定", () => {
  const masked = [false, true, true];

  it("セル reveal はそのセルだけ、列 reveal はその列の全行", () => {
    const cell = { kind: "cell" as const, rowIdx: 2, colIdx: 1 };
    expect(isCellRevealed(cell, 2, 1)).toBe(true);
    expect(isCellRevealed(cell, 3, 1)).toBe(false);
    expect(isCellRevealed(cell, 2, 2)).toBe(false);
    const col = { kind: "column" as const, colIdx: 1 };
    expect(isCellRevealed(col, 0, 1)).toBe(true);
    expect(isCellRevealed(col, 99, 1)).toBe(true);
    expect(isCellRevealed(col, 0, 2)).toBe(false);
    expect(isCellRevealed(null, 0, 1)).toBe(false);
  });

  it("マスク対象かつ未 reveal のときだけマスク中", () => {
    expect(isCellMasked(masked, null, 0, 0)).toBe(false);
    expect(isCellMasked(masked, null, 0, 1)).toBe(true);
    expect(isCellMasked(masked, { kind: "column", colIdx: 1 }, 0, 1)).toBe(false);
    expect(isCellMasked(null, null, 0, 1)).toBe(false);
  });

  it("行内にマスク中セルがあるか (列 reveal で全列解除されれば false)", () => {
    expect(rowHasMaskedCell(masked, null, 0, 3)).toBe(true);
    expect(rowHasMaskedCell([false, true], { kind: "column", colIdx: 1 }, 0, 2)).toBe(false);
    expect(rowHasMaskedCell(null, null, 0, 3)).toBe(false);
  });
});

describe("maskedCopyText", () => {
  it("マスク中かつプレースホルダ設定オンのときだけ伏せ字", () => {
    expect(maskedCopyText("secret", true, true)).toBe(MASK_PLACEHOLDER);
    expect(maskedCopyText("secret", true, false)).toBe("secret");
    expect(maskedCopyText("secret", false, true)).toBe("secret");
  });

  it("伏せ字は値の長さに依らず固定長", () => {
    expect(maskedCopyText("a", true, true)).toBe(maskedCopyText("a".repeat(500), true, true));
  });
});

describe("gridViewState の列マスク上書き (#1069)", () => {
  const KEY = "noobdb.gridview.v1::test";

  beforeEach(() => {
    localStorage.clear();
  });

  it("masks を保存・復元する (ソート/フィルタが無くても消さない)", () => {
    writeStoredGridView(KEY, toPersistedGridView([], [], { email: false, name: true }));
    expect(readStoredGridView(KEY)).toEqual({ masks: { email: false, name: true } });
  });

  it("上書きが空ならエントリを消す", () => {
    writeStoredGridView(KEY, { masks: { a: true } });
    writeStoredGridView(KEY, toPersistedGridView([], [], {}));
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("壊れた masks は捨て、他のフィールドは残す", () => {
    expect(
      normalizeGridView({ sorting: [{ id: "0", desc: true }], masks: { a: "yes", b: true } }),
    ).toEqual({ sorting: [{ id: "0", desc: true }], masks: { b: true } });
    expect(normalizeGridView({ masks: ["email"] })).toEqual({});
  });
});

describe("settings の列マスク設定 (#1069)", () => {
  it("既定で有効・既定パターン・伏せ字コピー", () => {
    expect(DEFAULT_SETTINGS.columnMaskEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.columnMaskPatterns).toEqual([...DEFAULT_MASK_PATTERNS]);
    expect(DEFAULT_SETTINGS.columnMaskCopyPlaceholder).toBe(true);
  });

  it("インポート時に不正値を既定へ戻し、パターンを正規化する", () => {
    const restored = deserializeSettingsImport(
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        columnMaskEnabled: "no",
        columnMaskPatterns: ["  Phone ", 42, "phone"],
        columnMaskCopyPlaceholder: false,
      }),
    );
    expect(restored.columnMaskEnabled).toBe(true);
    expect(restored.columnMaskPatterns).toEqual(["phone"]);
    expect(restored.columnMaskCopyPlaceholder).toBe(false);
  });
});
