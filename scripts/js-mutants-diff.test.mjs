import assert from "node:assert/strict";
import test from "node:test";
import { buildMutateSpecs, parseDiffRanges } from "./js-mutants-diff.mjs";

const diff = `diff --git a/src/dangerousSql.ts b/src/dangerousSql.ts
--- a/src/dangerousSql.ts
+++ b/src/dangerousSql.ts
@@ -10,0 +11,2 @@ foo
+a
+b
@@ -30,2 +33 @@ bar
-x
-y
+z
@@ -50,3 +52,0 @@ baz
-d
diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1 +1 @@
-a
+b
diff --git a/src/maskLiteralsIdentifiers.ts b/src/maskLiteralsIdentifiers.ts
--- a/src/maskLiteralsIdentifiers.ts
+++ b/src/maskLiteralsIdentifiers.ts
@@ -5 +5,4 @@
+q
diff --git a/src/gone.ts b/src/gone.ts
--- a/src/gone.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-a
`;

test("追加/変更行だけを範囲にし、純削除と削除ファイルは無視する", () => {
  const r = parseDiffRanges(diff);
  assert.deepEqual(r.get("src/dangerousSql.ts"), [
    [11, 12],
    [33, 33],
  ]);
  assert.deepEqual(r.get("src/other.ts"), [[1, 1]]);
  assert.equal(r.has("src/gone.ts"), false);
});

test("mutate と EXTRA_FILES に含まれるファイルだけが対象になる", () => {
  const specs = buildMutateSpecs(parseDiffRanges(diff), ["src/dangerousSql.ts"]);
  assert.deepEqual(specs, [
    "src/dangerousSql.ts:11-12",
    "src/dangerousSql.ts:33-33",
    "src/maskLiteralsIdentifiers.ts:5-8",
  ]);
});

test("対象外のみの差分は空", () => {
  assert.deepEqual(buildMutateSpecs(parseDiffRanges("+++ b/README.md\n@@ -1 +1 @@\n"), ["src/a.ts"]), []);
});
