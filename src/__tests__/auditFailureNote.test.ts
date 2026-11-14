import { describe, expect, it } from "vitest";
import { auditFailureNoteKey } from "../components/auditFailureNote";
import { setLocale, t } from "../i18n";

// 監査トリガー実行失敗時の注記 (#2335): MySQL は新規作成の部分適用 (監査表だけ残る) も案内する。
describe("auditFailureNoteKey", () => {
  it("MySQL の新規作成でも注記を出す", () => {
    expect(auditFailureNoteKey("mysql", "create")).toBe("auditMysqlPartialCreateNote");
  });
  it("MySQL の再生成・削除は従来の注記", () => {
    expect(auditFailureNoteKey("mysql", "regenerate")).toBe("auditMysqlPartialNote");
    expect(auditFailureNoteKey("mysql", "remove")).toBe("auditMysqlPartialNote");
  });
  it("MySQL 以外は出さない", () => {
    expect(auditFailureNoteKey("postgres", "create")).toBeNull();
    expect(auditFailureNoteKey("sqlite", "create")).toBeNull();
    expect(auditFailureNoteKey(undefined, "create")).toBeNull();
  });
  it("文言が ja / en にある", () => {
    for (const loc of ["ja", "en"] as const) {
      setLocale(loc);
      expect(t("auditMysqlPartialCreateNote")).not.toBe("auditMysqlPartialCreateNote");
    }
    setLocale("en");
  });
});
