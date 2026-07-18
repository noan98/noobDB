import { describe, expect, it } from "vitest";
import { BackendError, errorKindOf, normalizeBackendError } from "../api/tauri";

// invoke ラッパーが reject 値を正規化する BackendError (#683) の単体テスト。
// バックの構造化エラー ({kind, message})・旧形式の素文字列・その他の値をすべて
// 一貫した形へ落とし込むこと、String(e) が従来どおり message になることを固定する。

describe("normalizeBackendError", () => {
  it("構造化エラー {kind, message} を BackendError にする", () => {
    const e = normalizeBackendError({ kind: "sshHostKeyMismatch", message: "boom" });
    expect(e).toBeInstanceOf(BackendError);
    expect(e.kind).toBe("sshHostKeyMismatch");
    expect(e.message).toBe("boom");
  });

  it("旧形式の素の文字列は kind='unknown' で後方互換に受ける", () => {
    const e = normalizeBackendError("legacy string error");
    expect(e.kind).toBe("unknown");
    expect(e.message).toBe("legacy string error");
  });

  it("Error オブジェクトは message を保つ", () => {
    const e = normalizeBackendError(new Error("native error"));
    expect(e.kind).toBe("unknown");
    expect(e.message).toBe("native error");
  });

  it("BackendError はそのまま返す (二重ラップしない)", () => {
    const original = new BackendError("timeout", "slow");
    expect(normalizeBackendError(original)).toBe(original);
  });

  it("String(e) は message を返す (既存の String(e) 経路を壊さない)", () => {
    const e = new BackendError("db", "table not found");
    expect(String(e)).toBe("table not found");
    expect(`${e}`).toBe("table not found");
  });
});

describe("errorKindOf", () => {
  it("BackendError からは kind を、それ以外からは null を返す", () => {
    expect(errorKindOf(new BackendError("ssh", "x"))).toBe("ssh");
    expect(errorKindOf("plain string")).toBeNull();
    expect(errorKindOf(new Error("native"))).toBeNull();
    expect(errorKindOf(undefined)).toBeNull();
  });
});
