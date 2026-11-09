import { describe, expect, it } from "vitest";
import type { PublicationInfo } from "../api/tauri";
import {
  buildPublicationStatements,
  formatPublicationPreview,
  publicationActionFor,
  publicationMembership,
} from "../components/publicationSql";

// パブリケーションへの表の追加 / 除外 (`ALTER PUBLICATION ... ADD / DROP TABLE`) の組み立て (#2181)。

const base: PublicationInfo = {
  name: "pub",
  all_tables: false,
  publish: ["insert", "update"],
  via_root: false,
  tables: [],
  schemas: [],
};

describe("publicationMembership", () => {
  it("明示的に入っている表は member、別スキーマの同名の表は入っていない", () => {
    const p: PublicationInfo = {
      ...base,
      tables: [{ schema: "public", table: "orders", columns: null, row_filter: null }],
    };
    expect(publicationMembership(p, "public", "orders")).toBe("member");
    expect(publicationMembership(p, "audit", "orders")).toBe("none");
    expect(publicationMembership(p, "public", "items")).toBe("none");
  });

  it("FOR ALL TABLES / TABLES IN SCHEMA は個別には外せない。明示的に入っていれば member を優先する", () => {
    expect(publicationMembership({ ...base, all_tables: true }, "public", "t")).toBe("all");
    expect(publicationMembership({ ...base, schemas: ["public"] }, "public", "t")).toBe("schema");
    const both: PublicationInfo = {
      ...base,
      schemas: ["public"],
      tables: [{ schema: "public", table: "t", columns: null, row_filter: null }],
    };
    expect(publicationMembership(both, "public", "t")).toBe("member");
  });

  it("できる操作は none → add、member → drop、それ以外は無し", () => {
    expect(publicationActionFor("none")).toBe("add");
    expect(publicationActionFor("member")).toBe("drop");
    expect(publicationActionFor("all")).toBeNull();
    expect(publicationActionFor("schema")).toBeNull();
  });
});

describe("buildPublicationStatements", () => {
  it("識別子を引用し、選んだ順に ADD / DROP を並べる", () => {
    const sqls = buildPublicationStatements("public", "orders", [
      { publication: "pub_a", action: "add" },
      { publication: 'we"ird', action: "drop" },
    ]);
    expect(sqls).toEqual([
      'ALTER PUBLICATION "pub_a" ADD TABLE "public"."orders"',
      'ALTER PUBLICATION "we""ird" DROP TABLE "public"."orders"',
    ]);
    expect(formatPublicationPreview(sqls)).toBe(`${sqls[0]};\n${sqls[1]};`);
  });

  it("何も選ばなければ空", () => {
    expect(buildPublicationStatements("public", "t", [])).toEqual([]);
  });
});
