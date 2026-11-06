import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 安全網と変異テスト対象リストの突合 (#2103)。
//
// 変異テスト (Rust: cargo-mutants / フロント: Stryker) は「安全網のテストが本当に変更を
// 検出できるか」を測る唯一の仕組みだが、対象リストは手書きで、安全網を足しても対象に入れ
// 忘れると静かに測られなくなる (実際にチャンク DML の `validate_fragment` が漏れていた)。
// ここでは次を CI で強制する。
//   1. `db/chunked_dml.rs` の関数は、mutants.toml の `examine_re` に入っているか、
//      理由つきの除外リストにある (新しい関数を足して対象に入れ忘れると落ちる)
//   2. `examine_re` の名前は実在する関数を指す (リネーム・削除でのドリフト検出)
//   3. 対象ファイルは mutants.toml の `examine_globs` と mutants-diff.yml の `paths:` にある
//   4. フロントの対応関数 (`chunkedDml.ts`) は Stryker の `mutate` / テストは
//      vitest.mutants.config.ts の `include` / PR 差分ワークフローの `paths:` にある
//   5. Rust の安全網関数ごとに、TS の対応関数が存在する

const read = (p: string) => readFileSync(p, "utf8");

const RUST_FILE = "src/db/chunked_dml.rs";
const TS_FILE = "src/components/chunkedDml.ts";

/** 変異テストに入れない Rust 関数 (理由つき)。ここに無い関数は examine_re に必須。 */
const RUST_EXCLUDED: Record<string, string> = {
  code: "エラー識別子の文字列対応表。共有ゴールデンが code を比較するので別途固定される",
};

/** Rust の安全網関数 → TS の対応関数 (TS に実装が無いものは null と理由)。 */
const RUST_TO_TS: Record<string, string | null> = {
  validate_fragment: "validateFragment",
  is_ident_char: "isIdentChar",
  check_common: "checkCommon",
  build_chunk_sql: "buildChunkSql",
  build_count_sql: "buildCountSql",
  pick_sqlite_row_key: "pickSqliteRowKey",
  // sql_mode の検査は接続時にバックエンドだけが行う (フロントに対応実装は無い)。
  mysql_sql_mode_is_unsafe: null,
};

/** テスト用モジュール (`#[cfg(test)] mod tests`) より前の `fn` 名を取り出す。 */
function rustFnNames(): string[] {
  const src = read(`src-tauri/${RUST_FILE}`);
  const body = src.slice(0, src.indexOf("#[cfg(test)]"));
  return [...body.matchAll(/^\s*(?:pub(?:\([a-z]+\))? )?fn ([a-z0-9_]+)/gm)].map((m) => m[1]);
}

/** mutants.toml の examine_re から、関数名の選択肢 (`a|b|c`) を取り出す。 */
function examineReNames(toml: string): string[] {
  const block = toml.slice(toml.indexOf("examine_re = ["));
  const re = block.slice(0, block.indexOf("\n]"));
  const m = re.match(/\(([A-Za-z_0-9|]+)\)\( -> \|\$\)/);
  if (!m) throw new Error("examine_re の関数名リストを解釈できない");
  return m[1].split("|");
}

function tomlGlobs(toml: string): string[] {
  const block = toml.slice(toml.indexOf("examine_globs = ["));
  return [...block.slice(0, block.indexOf("]")).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function ymlPaths(yml: string): Set<string> {
  const block = yml.slice(yml.indexOf("    paths:"), yml.indexOf("permissions:"));
  return new Set([...block.matchAll(/^\s+- "([^"]+)"/gm)].map((m) => m[1]));
}

describe("チャンク DML の安全網と変異テスト対象の突合 (#2103)", () => {
  const toml = read("src-tauri/.cargo/mutants.toml");
  const names = examineReNames(toml);
  const fns = rustFnNames();

  it("Rust: chunked_dml.rs の全関数が examine_re にあるか除外リストにある", () => {
    expect(fns.length).toBeGreaterThan(5);
    const missing = fns.filter((f) => !names.includes(f) && !(f in RUST_EXCLUDED));
    expect(
      missing,
      `mutants.toml の examine_re に追加するか RUST_EXCLUDED に理由つきで足す: ${missing}`,
    ).toEqual([]);
  });

  it("Rust: 除外リストと対応表が実在する関数だけを指し、除外が examine_re と矛盾しない", () => {
    for (const f of Object.keys(RUST_EXCLUDED)) {
      expect(fns, `RUST_EXCLUDED の ${f} は chunked_dml.rs に無い`).toContain(f);
      expect(names, `${f} は除外なのに examine_re にある`).not.toContain(f);
    }
    for (const f of Object.keys(RUST_TO_TS))
      expect(fns, `RUST_TO_TS の ${f} は chunked_dml.rs に無い`).toContain(f);
    const covered = fns.filter((f) => !(f in RUST_EXCLUDED));
    expect(Object.keys(RUST_TO_TS).sort()).toEqual(covered.sort());
  });

  it("Rust: 安全網の中核関数が examine_re にある", () => {
    for (const f of ["validate_fragment", "build_chunk_sql", "mysql_sql_mode_is_unsafe"])
      expect(names).toContain(f);
  });

  it("Rust: 対象ファイルが examine_globs と mutants-diff.yml の paths にある", () => {
    expect(tomlGlobs(toml)).toContain(RUST_FILE);
    const paths = ymlPaths(read(".github/workflows/mutants-diff.yml"));
    expect(paths.has(`src-tauri/${RUST_FILE}`)).toBe(true);
    // examine_globs はすべて PR 差分ワークフローの起動条件に入っている (ドリフト防止)。
    for (const g of tomlGlobs(toml)) expect(paths.has(`src-tauri/${g}`), `paths に ${g} が無い`).toBe(true);
  });

  it("TS: Rust の安全網関数に対応する関数が chunkedDml.ts に実在し、Stryker の対象にある", () => {
    const ts = read(TS_FILE);
    for (const [rust, tsName] of Object.entries(RUST_TO_TS)) {
      if (tsName === null) continue;
      expect(ts, `${rust} に対応する ${tsName} が ${TS_FILE} に無い`).toMatch(
        new RegExp(`(?:function|const) ${tsName}\\b`),
      );
    }
    const conf = JSON.parse(read("stryker.conf.json")) as { mutate: string[] };
    expect(conf.mutate).toContain(TS_FILE);
  });

  it("TS: ゴールデンテストが Stryker 実行と PR 差分ワークフローの対象にある", () => {
    const include = read("vitest.mutants.config.ts");
    expect(include).toContain("src/__tests__/chunkedDmlGolden.test.ts");
    const paths = ymlPaths(read(".github/workflows/js-mutants-diff.yml"));
    for (const f of [
      TS_FILE,
      "src/__tests__/chunkedDmlGolden.test.ts",
      "src/__tests__/fixtures/chunkedDmlVectors.json",
    ])
      expect(paths.has(f), `js-mutants-diff.yml の paths に ${f} が無い`).toBe(true);
  });
});
