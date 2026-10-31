import { describe, expect, it } from "vitest";
import type { SchemaObjectKind } from "../api/tauri";
import { ALL_KINDS, WHERE_USED_KIND_SUPPORT } from "../components/whereUsed";
import golden from "./fixtures/schemaObjectKinds.json";

// SchemaObject.kind (#1840) の Rust (String カタログ値) ⇔ TS union の集合一致を固定する。
//
// Rust 側は `db/types.rs` の `SCHEMA_OBJECT_KINDS` と 3 ドライバの `schema_objects` が吐く
// kind を同じ JSON (`fixtures/schemaObjectKinds.json`) と照合する。ここでは TS union の全値を
// 照合する。union に値を足すと下の Record が型エラー (キー不足) になり、JSON と食い違うと
// このテストが落ちる。

// union の全値を網羅しないとコンパイルできない (キー不足 / 余剰キーはどちらも型エラー)。
const TS_KINDS = {
  view: true,
  materialized_view: true,
  procedure: true,
  function: true,
  trigger: true,
  sequence: true,
} as const satisfies Record<SchemaObjectKind, true>;

describe("SchemaObjectKind 共有ゴールデン", () => {
  it("TS union の全値が JSON の kinds と一致する", () => {
    expect(Object.keys(TS_KINDS).sort()).toEqual([...golden.kinds].sort());
  });

  it("各ドライバの kind は kinds の部分集合で、和集合が kinds と一致する", () => {
    const all = new Set(golden.kinds);
    const union = new Set<string>();
    for (const kinds of Object.values(golden.drivers)) {
      for (const k of kinds) {
        expect(all.has(k)).toBe(true);
        union.add(k);
      }
    }
    expect([...union].sort()).toEqual([...all].sort());
  });

  it("whereUsed.ts の ALL_KINDS / WHERE_USED_KIND_SUPPORT がゴールデン (ツリー専用の種別を除く) と一致する", () => {
    const treeOnly = new Set<string>(golden.treeOnlyKinds);
    const whereUsedKinds = (kinds: readonly string[]) => kinds.filter((k) => !treeOnly.has(k)).sort();
    expect([...ALL_KINDS].sort()).toEqual(whereUsedKinds(golden.kinds));
    expect(Object.keys(WHERE_USED_KIND_SUPPORT).sort()).toEqual(Object.keys(golden.drivers).sort());
    for (const [driver, kinds] of Object.entries(golden.drivers)) {
      expect([...(WHERE_USED_KIND_SUPPORT[driver] ?? [])].sort()).toEqual(whereUsedKinds(kinds));
    }
  });
});
