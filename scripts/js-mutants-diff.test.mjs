import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  FIXTURE_TO_SOURCES,
  parseDiffRanges,
  parseVitestInclude,
  planMutation,
  TEST_TO_SOURCES,
} from "./js-mutants-diff.mjs";

const MUTATE = [
  "src/dangerousSql.ts",
  "src/sqlScript.ts",
  "src/components/preflight.ts",
  "src/components/cellEdit.ts",
];
const INCLUDE = ["src/__tests__/cellEdit.test.ts", "src/__tests__/unknown.test.ts"];

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
diff --git a/src/gone.ts b/src/gone.ts
--- a/src/gone.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-a
`;

test("追加/変更行だけを範囲にし、純削除は範囲なし、削除ファイルは旧パスで空範囲", () => {
  const r = parseDiffRanges(diff);
  assert.deepEqual(r.get("src/dangerousSql.ts"), [
    [11, 12],
    [33, 33],
  ]);
  assert.deepEqual(r.get("src/other.ts"), [[1, 1]]);
  assert.deepEqual(r.get("src/gone.ts"), []);
});

test("内容が '++ ' / '-- ' で始まる行をファイルヘッダと誤認しない", () => {
  const d = `diff --git a/src/sqlScript.ts b/src/sqlScript.ts
--- a/src/sqlScript.ts
+++ b/src/sqlScript.ts
@@ -1 +1,2 @@
+++ b/src/evil.ts
+-- comment
`;
  const r = parseDiffRanges(d);
  assert.deepEqual([...r.keys()], ["src/sqlScript.ts"]);
  assert.deepEqual(r.get("src/sqlScript.ts"), [[1, 2]]);
});

test("ソースの差分行だけなら lines モード (対象外ファイルは無視)", () => {
  const p = planMutation(parseDiffRanges(diff), MUTATE, INCLUDE);
  assert.equal(p.mode, "lines");
  assert.deepEqual(p.specs, ["src/dangerousSql.ts:11-12", "src/dangerousSql.ts:33-33"]);
});

test("テストの変更 (純削除でも) は対応ソース全体、fixtures も同様", () => {
  const d = (f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -3,2 +2,0 @@\n-x\n`;
  assert.deepEqual(
    planMutation(parseDiffRanges(d("src/__tests__/cellEdit.test.ts")), MUTATE, INCLUDE),
    { specs: ["src/components/cellEdit.ts"], mode: "files", wholeFiles: ["src/components/cellEdit.ts"], lineFiles: [] },
  );
  const f = planMutation(parseDiffRanges(d("src/__tests__/fixtures/maskVectors.json")), MUTATE, INCLUDE);
  assert.deepEqual(f.specs, ["src/dangerousSql.ts"]);
});

test("対応不明の include テストと設定変更は conf.mutate 全件、無関係なテストは対象外", () => {
  const d = (f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-a\n+b\n`;
  assert.deepEqual(
    planMutation(parseDiffRanges(d("src/__tests__/unknown.test.ts")), MUTATE, INCLUDE).wholeFiles.sort(),
    [...MUTATE].sort(),
  );
  assert.equal(planMutation(parseDiffRanges(d("stryker.conf.json")), MUTATE, INCLUDE).mode, "files");
  assert.equal(planMutation(parseDiffRanges(d("src/__tests__/zzz.test.ts")), MUTATE, INCLUDE).mode, "none");
});

test("全体と行が混在するとき、全体側のファイルの行範囲は重複させない", () => {
  const d = `${diff}diff --git a/src/__tests__/dangerousSql.test.ts b/src/__tests__/dangerousSql.test.ts
--- a/src/__tests__/dangerousSql.test.ts
+++ b/src/__tests__/dangerousSql.test.ts
@@ -1 +1 @@
-a
+b
diff --git a/src/sqlScript.ts b/src/sqlScript.ts
--- a/src/sqlScript.ts
+++ b/src/sqlScript.ts
@@ -4 +4 @@
-a
+b
`;
  const p = planMutation(parseDiffRanges(d), MUTATE, INCLUDE);
  assert.equal(p.mode, "mixed");
  assert.deepEqual(p.specs, ["src/dangerousSql.ts", "src/sqlScript.ts:4-4"]);
});

test("対応表は vitest.mutants.config.ts の include と整合し、ワークフローの paths が対象を包含する", () => {
  const include = parseVitestInclude(readFileSync("vitest.mutants.config.ts", "utf8"));
  const conf = JSON.parse(readFileSync("stryker.conf.json", "utf8"));
  for (const t of Object.keys(TEST_TO_SOURCES)) assert.ok(include.includes(t), `${t} が include に無い`);
  for (const srcs of [...Object.values(TEST_TO_SOURCES), ...Object.values(FIXTURE_TO_SOURCES)])
    for (const s of srcs) assert.ok(conf.mutate.includes(s), `${s} が mutate に無い`);
  const yml = readFileSync(".github/workflows/js-mutants-diff.yml", "utf8");
  const block = yml.slice(yml.indexOf("    paths:"), yml.indexOf("permissions:"));
  const paths = new Set([...block.matchAll(/^\s+- "([^"]+)"/gm)].map((m) => m[1]));
  // include のテストは対応表の有無を問わず、変更したら起動できなければならない。
  const required = [
    ...conf.mutate,
    ...include,
    ...Object.keys(FIXTURE_TO_SOURCES),
    "stryker.conf.json",
    "vitest.mutants.config.ts",
  ];
  for (const f of required) assert.ok(paths.has(f), `paths に ${f} が無い`);
});
