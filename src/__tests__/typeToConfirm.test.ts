import { describe, expect, it } from "vitest";
import {
  TYPE_TO_CONFIRM_FALLBACK,
  resolveTypedConfirmTarget,
  typedConfirmMatches,
} from "../typeToConfirm";

// #675: 本番接続での不可逆操作 (DROP/TRUNCATE/同期適用) に追加した
// 「タイプして確認」ゲートの純ロジック。対象名解決とタイプ一致判定を
// UI から切り離してテストする。
describe("resolveTypedConfirmTarget", () => {
  it("候補が単一の非空名に揃っている場合はその名前を返す", () => {
    expect(resolveTypedConfirmTarget(["users"])).toBe("users");
    expect(resolveTypedConfirmTarget(["users", "users"])).toBe("users");
  });

  it("候補が空/null/未定義しかない場合はフォールバックを返す", () => {
    expect(resolveTypedConfirmTarget([])).toBe(TYPE_TO_CONFIRM_FALLBACK);
    expect(resolveTypedConfirmTarget([null, undefined])).toBe(TYPE_TO_CONFIRM_FALLBACK);
    expect(resolveTypedConfirmTarget(["", "  "])).toBe(TYPE_TO_CONFIRM_FALLBACK);
  });

  it("複数の異なる対象名がある (曖昧) 場合はフォールバックを返す", () => {
    expect(resolveTypedConfirmTarget(["users", "orders"])).toBe(TYPE_TO_CONFIRM_FALLBACK);
  });

  it("前後の空白は無視して同一名として扱う", () => {
    expect(resolveTypedConfirmTarget([" users ", "users"])).toBe("users");
  });

  it("解決できない対象 (null) が混じっていても単一の実名があればそれを使う", () => {
    expect(resolveTypedConfirmTarget([null, "users"])).toBe("users");
  });
});

describe("typedConfirmMatches", () => {
  it("完全一致で true を返す", () => {
    expect(typedConfirmMatches("users", "users")).toBe(true);
  });

  it("前後の空白を無視する", () => {
    expect(typedConfirmMatches("  users  ", "users")).toBe(true);
  });

  it("大文字小文字を区別する (近似一致を許さない)", () => {
    expect(typedConfirmMatches("Users", "users")).toBe(false);
    expect(typedConfirmMatches("USERS", "users")).toBe(false);
  });

  it("部分一致・空文字は false", () => {
    expect(typedConfirmMatches("user", "users")).toBe(false);
    expect(typedConfirmMatches("", "users")).toBe(false);
  });

  it("フォールバックワードにもそのまま使える", () => {
    expect(typedConfirmMatches(TYPE_TO_CONFIRM_FALLBACK, TYPE_TO_CONFIRM_FALLBACK)).toBe(true);
    expect(typedConfirmMatches("confirm", TYPE_TO_CONFIRM_FALLBACK)).toBe(false);
  });
});
