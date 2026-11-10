import { describe, expect, it } from "vitest";
import type { PublicationInfo } from "../api/tauri";
import {
  buildPublicationStatements,
  formatPublicationPreview,
  publicationActionFor,
  lacksReplicaIdentity,
  publicationMembership,
  publishesRowChanges,
  replicaIdentityBlocksWrites,
  replicaIdentityKind,
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
      tables: [
        {
          schema: "public",
          table: "orders",
          columns: null,
          row_filter: null,
          replica_identity: "d",
          has_primary_key: true,
        },
      ],
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
      tables: [
        {
          schema: "public",
          table: "t",
          columns: null,
          row_filter: null,
          replica_identity: "d",
          has_primary_key: true,
        },
      ],
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

describe("buildPublicationStatements: REPLICA IDENTITY FULL (#2212)", () => {
  const picks = [{ publication: "pub_a", action: "add" as const }];
  it("指定すると先頭に ALTER TABLE ... REPLICA IDENTITY FULL を足す", () => {
    expect(buildPublicationStatements("public", "orders", picks, { replicaIdentityFull: true })).toEqual([
      'ALTER TABLE "public"."orders" REPLICA IDENTITY FULL',
      'ALTER PUBLICATION "pub_a" ADD TABLE "public"."orders"',
    ]);
  });
  it("指定が無ければ足さない。選択が空なら単独で出さない", () => {
    expect(buildPublicationStatements("public", "orders", picks)).toHaveLength(1);
    expect(buildPublicationStatements("public", "orders", [], { replicaIdentityFull: true })).toEqual([]);
  });
});

describe("REPLICA IDENTITY の判定 (#2212)", () => {
  it("UPDATE / DELETE を公開するときだけ対象 (INSERT / TRUNCATE だけなら不要)", () => {
    expect(publishesRowChanges(["insert"])).toBe(false);
    expect(publishesRowChanges(["insert", "truncate"])).toBe(false);
    expect(publishesRowChanges([])).toBe(false);
    expect(publishesRowChanges(["update"])).toBe(true);
    expect(publishesRowChanges(["delete"])).toBe(true);
    expect(publishesRowChanges(["insert", "update", "delete", "truncate"])).toBe(true);
  });

  it("n は常に、d は主キーが無いときだけ手段なし。f / i は主キーに関係なく問題なし", () => {
    const cases: [string, boolean, boolean][] = [
      ["d", true, false],
      ["d", false, true],
      ["n", true, true],
      ["n", false, true],
      ["f", true, false],
      ["f", false, false],
      ["i", true, false],
      ["i", false, false],
      ["?", false, false],
    ];
    for (const [ident, pk, lacks] of cases) {
      expect(lacksReplicaIdentity({ replica_identity: ident, has_primary_key: pk }), `${ident}/${pk}`).toBe(
        lacks,
      );
    }
  });

  it("publish の組み合わせ × relreplident × 主キーの有無 の全組み合わせ", () => {
    const publishes: [string[], boolean][] = [
      [["insert"], false],
      [["truncate"], false],
      [["insert", "truncate"], false],
      [["update"], true],
      [["delete"], true],
      [["insert", "update"], true],
      [["insert", "delete"], true],
      [["update", "delete"], true],
      [["insert", "update", "delete", "truncate"], true],
    ];
    for (const [publish, rows] of publishes) {
      for (const ident of ["d", "n", "f", "i"]) {
        for (const pk of [true, false]) {
          const lacks = ident === "n" || (ident === "d" && !pk);
          expect(
            replicaIdentityBlocksWrites(publish, { replica_identity: ident, has_primary_key: pk }),
            `${publish.join(",")} / ${ident} / pk=${pk}`,
          ).toBe(rows && lacks);
        }
      }
    }
  });

  it("identity が不明 (null) なら警告しない", () => {
    expect(replicaIdentityBlocksWrites(["update"], null)).toBe(false);
  });

  it("表示の種別", () => {
    const k = (replica_identity: string, has_primary_key: boolean) =>
      replicaIdentityKind({ replica_identity, has_primary_key });
    expect(k("d", true)).toBe("default");
    expect(k("d", false)).toBe("defaultNoPk");
    expect(k("n", true)).toBe("nothing");
    expect(k("f", false)).toBe("full");
    expect(k("i", false)).toBe("index");
  });
});
