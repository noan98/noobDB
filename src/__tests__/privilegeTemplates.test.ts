import { describe, expect, it } from "vitest";
import {
  applyPrivilegeTemplate,
  generatePassword,
  parseColumnList,
  parseRoleInput,
  templateFlags,
} from "../components/privilegeTemplates";

const off = { select: false, insert: false, update: false, delete: false, ddl: false };

describe("privilegeTemplates (#1622)", () => {
  it("読み取り専用は SELECT のみ、アプリ用読み書きは DDL を含まない", () => {
    expect(templateFlags("readOnly")).toEqual({ ...off, select: true });
    expect(templateFlags("appReadWrite")).toEqual({
      ...off,
      select: true,
      insert: true,
      update: true,
      delete: true,
    });
    expect(templateFlags("full").ddl).toBe(true);
    expect(templateFlags("none")).toEqual(off);
  });

  it("テンプレートは指定テーブルだけを上書きし、入力と共有しない", () => {
    const edited = { a: { ...off, ddl: true }, keep: { ...off, delete: true } };
    const out = applyPrivilegeTemplate(edited, ["a", "constructor"], "readOnly");
    expect(out.a).toEqual({ ...off, select: true });
    expect(out.constructor).toEqual({ ...off, select: true });
    expect(out.keep).toBe(edited.keep);
    expect(edited.a.ddl).toBe(true);
    out.a.select = false;
    expect(templateFlags("readOnly").select).toBe(true);
  });
});

describe("generatePassword (#1622)", () => {
  it("既定長で全クラスの文字を含み、引用符やバックスラッシュを含まない", () => {
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword();
      expect(pw).toHaveLength(24);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[!#$%&*+\-=?@^_]/);
      expect(pw).not.toMatch(/['"\\\s`]/);
    }
  });

  it("短すぎる長さでも 4 クラスぶんは確保し、毎回異なる値になる", () => {
    expect(generatePassword(2)).toHaveLength(4);
    expect(generatePassword()).not.toBe(generatePassword());
  });

  it("乱数源を差し替えられる", () => {
    expect(generatePassword(8, () => 0)).toBe(generatePassword(8, () => 0));
    expect(generatePassword(8, () => 0)).toHaveLength(8);
  });
});

describe("parseRoleInput / parseColumnList (#1622)", () => {
  it("ロール入力を名前とホストに分ける", () => {
    expect(parseRoleInput("  ")).toBeNull();
    expect(parseRoleInput("reader")).toEqual({ role: "reader", host: null });
    expect(parseRoleInput("reader@localhost")).toEqual({ role: "reader", host: "localhost" });
    expect(parseRoleInput("reader@")).toEqual({ role: "reader", host: null });
    expect(parseRoleInput("@h")).toEqual({ role: "@h", host: null });
  });

  it("列入力は空要素と重複を除く", () => {
    expect(parseColumnList("id, name,,id\n email ")).toEqual(["id", "name", "email"]);
    expect(parseColumnList("")).toEqual([]);
  });
});
