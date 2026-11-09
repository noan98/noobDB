import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_PLACEHOLDER,
  findCredentialRanges,
  redactCredentials,
  redactErrorText,
} from "../sqlCredentials";
import vectors from "./fixtures/credentialRedactVectors.json";

// SQL 中の資格情報リテラルの伏せ字化 ゴールデンテスト (#2174、フロント側)。
// バックエンドの `sql_credentials::redact_credentials` は同じ JSON を
// `src-tauri/tests/credential_redact_golden.rs` で読み、対になる検証を行う。
// `mysql` / `postgres` が無いケースは「そのドライバでは変更なし」、SQLite は常に変更なし。

interface VectorCase {
  sql: string;
  note: string;
  mysql?: string;
  postgres?: string;
}

const cases = vectors.cases as VectorCase[];

interface ErrorCase {
  note: string;
  sql: string;
  error: string;
  mysql: string;
  postgres: string;
}

const errorCases = vectors.errorCases as ErrorCase[];

describe("エラー文の伏せ字化 ゴールデン (フロント redactErrorText)", () => {
  it("ケースがある", () => {
    expect(errorCases.length).toBeGreaterThanOrEqual(5);
  });

  for (const c of errorCases) {
    it(`${c.note} — ${JSON.stringify(c.error)}`, () => {
      expect(redactErrorText(c.error, c.sql, "mysql")).toBe(c.mysql);
      expect(redactErrorText(c.error, c.sql, "postgres")).toBe(c.postgres);
      expect(redactErrorText(c.error, c.sql, "sqlite")).toBe(c.error);
    });
  }

  it("ドライバ省略時は両方言の値を置換する", () => {
    const sql = "ALTER USER u IDENTIFIED BY 'p\\'ass word'";
    expect(redactErrorText("near p'ass word and p\\'ass word", sql)).toBe("near ******** and ********");
  });
});

describe("資格情報の伏せ字化 ゴールデン (フロント redactCredentials)", () => {
  it("ベクタが 3 ドライバを覆い、十分なケース数を持つ", () => {
    expect(vectors.drivers).toEqual(["mysql", "postgres", "sqlite"]);
    expect(vectors.placeholder).toBe(CREDENTIAL_PLACEHOLDER);
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(cases.some((c) => c.mysql !== undefined)).toBe(true);
    expect(cases.some((c) => c.postgres !== undefined)).toBe(true);
  });

  for (const c of cases) {
    it(`${c.note} — ${JSON.stringify(c.sql)}`, () => {
      const expected = { mysql: c.mysql ?? c.sql, postgres: c.postgres ?? c.sql, sqlite: c.sql };
      for (const driver of ["mysql", "postgres", "sqlite"] as const) {
        const out = redactCredentials(c.sql, driver);
        expect(out).toBe(expected[driver]);
        // 範囲を置き換えた結果が redactCredentials と一致し、範囲は昇順・重なりなし。
        const ranges = findCredentialRanges(c.sql, driver);
        let rebuilt = "";
        let at = 0;
        for (const r of ranges) {
          expect(r.start).toBeGreaterThanOrEqual(at);
          expect(r.end).toBeGreaterThan(r.start);
          rebuilt += c.sql.slice(at, r.start) + CREDENTIAL_PLACEHOLDER;
          at = r.end;
        }
        expect(rebuilt + c.sql.slice(at)).toBe(out);
        // 冪等 (伏せ済みをもう一度通しても変わらない)。
        expect(redactCredentials(out, driver)).toBe(out);
      }
    });
  }
});

describe("redactCredentials", () => {
  it("伏せるのは資格情報リテラルだけで、その範囲を返す", () => {
    const sql = "ALTER USER 'app'@'%' IDENTIFIED BY 'S3cret!';";
    const ranges = findCredentialRanges(sql, "mysql");
    expect(ranges).toHaveLength(1);
    expect(sql.slice(ranges[0].start, ranges[0].end)).toBe("'S3cret!'");
  });

  it("対象がなければ同じ文字列をそのまま返す", () => {
    const sql = "SELECT 1";
    expect(redactCredentials(sql, "mysql")).toBe(sql);
  });

  it("ドライバ省略時は MySQL と PostgreSQL の規則を別々に当てた範囲の和集合 (バックスラッシュを含んでも後半を残さない)", () => {
    for (const c of cases) {
      expect(redactCredentials(c.sql)).toBe(c.mysql ?? c.postgres ?? c.sql);
    }
  });

  it("ドライバ省略時に \\' を含むパスワードの後半が残らない", () => {
    expect(redactCredentials("ALTER USER u IDENTIFIED BY 'p\\'ass word';")).toBe(
      `ALTER USER u IDENTIFIED BY ${CREDENTIAL_PLACEHOLDER};`,
    );
    expect(redactCredentials("ALTER ROLE r PASSWORD E'a\\'b c'")).toBe(
      `ALTER ROLE r PASSWORD E${CREDENTIAL_PLACEHOLDER}`,
    );
  });
});
