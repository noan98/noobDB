import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type BackupKind, buildBackupPlan } from "../backupBeforeDestructive";
import { qualifiedTableName } from "../components/sqlDialect";
import type { PgColumnFlags } from "../tableClone";

// 退避コピー (#2448) の共有ベクタ。TS が組み立てた退避文・復元 SQL を `fixtures/backupVectors.json` に固定し、
// Rust の統合テスト (`src-tauri/tests/backup_before_destructive_integration.rs`) が同じ JSON を実 DB
// (SQLite は常時、MySQL / PostgreSQL は環境変数ゲート) で流して「退避 → 本操作 → 復元で元の行に戻る」ことを確かめる。
// JSON を作り直すには `UPDATE_BACKUP_VECTORS=1 pnpm exec vitest run src/__tests__/backupGolden.test.ts`。

const FIXTURE = new URL("./fixtures/backupVectors.json", import.meta.url);
const NOW = new Date(2026, 10, 19, 9, 5);
const DB = "nb2448_backup";

interface CaseInput {
  name: string;
  driver: "sqlite" | "mysql" | "postgres";
  table: string;
  kind: BackupKind;
  /** 親表 + 対象表 (+ 行)。SQLite では対象表の CREATE 文が get_object_definition の DDL になる。 */
  setup: string[];
  ddl: string;
  columns: string[];
  pgColumns?: PgColumnFlags;
  /** 退避後・本操作前に流す文。親行の削除が CASCADE で退避の行を消さないことを確かめる。 */
  afterBackup: string[];
  /** 復元の前に親行を戻す文 (復元先の表の FK を満たすため)。 */
  beforeRestore: string[];
  checkSql: string;
}

const q = (driver: string, db: string | null, t: string) => qualifiedTableName(driver, db, t);

const sqliteSetup = (t: string, parent: string) => [
  `CREATE TABLE ${parent} (id INTEGER PRIMARY KEY)`,
  `INSERT INTO ${parent} VALUES (1), (2)`,
  `CREATE TABLE ${q("sqlite", null, t)} (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INT REFERENCES ${parent}(id) ON DELETE CASCADE, price INT, total INT GENERATED ALWAYS AS (price * 2) STORED, label TEXT)`,
  `INSERT INTO ${q("sqlite", null, t)} (parent_id, price, label) VALUES (1, 10, 'a'), (2, 20, 'it''s'), (NULL, 30, NULL)`,
];

const mysqlSetup = (t: string) => [
  `CREATE TABLE ${q("mysql", DB, `${t}_p`)} (id INT PRIMARY KEY)`,
  `INSERT INTO ${q("mysql", DB, `${t}_p`)} VALUES (1), (2)`,
  `CREATE TABLE ${q("mysql", DB, t)} (id INT AUTO_INCREMENT PRIMARY KEY, parent_id INT, price INT, total INT GENERATED ALWAYS AS (price * 2) STORED, label VARCHAR(20), FOREIGN KEY (parent_id) REFERENCES ${q("mysql", DB, `${t}_p`)}(id) ON DELETE CASCADE)`,
  `INSERT INTO ${q("mysql", DB, t)} (parent_id, price, label) VALUES (1, 10, 'a'), (2, 20, 'it''s'), (NULL, 30, NULL)`,
];

const pgSetup = (t: string, idDef: string) => [
  `CREATE TABLE ${q("postgres", DB, `${t}_p`)} (id int PRIMARY KEY)`,
  `INSERT INTO ${q("postgres", DB, `${t}_p`)} VALUES (1), (2)`,
  `CREATE TABLE ${q("postgres", DB, t)} (id ${idDef} PRIMARY KEY, parent_id int REFERENCES ${q("postgres", DB, `${t}_p`)}(id) ON DELETE CASCADE, price int, total int GENERATED ALWAYS AS (price * 2) STORED, label text)`,
  `INSERT INTO ${q("postgres", DB, t)} (parent_id, price, label) VALUES (1, 10, 'a'), (2, 20, 'it''s'), (NULL, 30, NULL)`,
];

function cases(): CaseInput[] {
  const out: CaseInput[] = [];
  for (const kind of ["drop", "truncate"] as const) {
    const sqliteT = `Odd Name ${kind}`;
    const sqliteParent = `parents_${kind}`;
    const sqliteSql = sqliteSetup(sqliteT, sqliteParent);
    out.push({
      name: `sqlite ${kind} (空白入りの名前・自動採番・生成列・FK)`,
      driver: "sqlite",
      table: sqliteT,
      kind,
      setup: sqliteSql,
      ddl: sqliteSql[2],
      columns: ["id", "parent_id", "price", "label"],
      afterBackup: [`DELETE FROM ${sqliteParent}`],
      beforeRestore: [`INSERT INTO ${sqliteParent} VALUES (1), (2)`],
      checkSql: `SELECT id, parent_id, price, total, label FROM ${q("sqlite", null, sqliteT)} ORDER BY id`,
    });
    const myT = `odd\`name_${kind}`;
    out.push({
      name: `mysql ${kind} (バッククォート入りの名前・自動採番・生成列・FK)`,
      driver: "mysql",
      table: myT,
      kind,
      setup: mysqlSetup(myT),
      ddl: `CREATE TABLE ${q("mysql", DB, myT)} (id int)`,
      columns: ["id", "parent_id", "price", "label"],
      afterBackup: [`DELETE FROM ${q("mysql", DB, `${myT}_p`)}`],
      beforeRestore: [`INSERT INTO ${q("mysql", DB, `${myT}_p`)} VALUES (1), (2)`],
      checkSql: `SELECT id, parent_id, price, total, label FROM ${q("mysql", DB, myT)} ORDER BY id`,
    });
    const pgT = `Odd "Name" ${kind}`;
    out.push({
      name: `postgres ${kind} (引用符入りの名前・identity・生成列・FK)`,
      driver: "postgres",
      table: pgT,
      kind,
      setup: pgSetup(pgT, "int GENERATED ALWAYS AS IDENTITY"),
      ddl: `CREATE TABLE ${q("postgres", DB, pgT)} (id int)`,
      columns: ["id", "parent_id", "price", "label"],
      pgColumns: { generated: ["total"], identity: ["id"], serial: [] },
      afterBackup: [`DELETE FROM ${q("postgres", DB, `${pgT}_p`)}`],
      beforeRestore: [`INSERT INTO ${q("postgres", DB, `${pgT}_p`)} VALUES (1), (2)`],
      checkSql: `SELECT id, parent_id, price, total, label FROM ${q("postgres", DB, pgT)} ORDER BY id`,
    });
    const serialT = `serial_${kind}`;
    out.push({
      name: `postgres ${kind} (serial)`,
      driver: "postgres",
      table: serialT,
      kind,
      setup: pgSetup(serialT, "serial"),
      ddl: `CREATE TABLE ${q("postgres", DB, serialT)} (id int)`,
      columns: ["id", "parent_id", "price", "label"],
      pgColumns: { generated: ["total"], identity: [], serial: ["id"] },
      afterBackup: [`DELETE FROM ${q("postgres", DB, `${serialT}_p`)}`],
      beforeRestore: [`INSERT INTO ${q("postgres", DB, `${serialT}_p`)} VALUES (1), (2)`],
      checkSql: `SELECT id, parent_id, price, total, label FROM ${q("postgres", DB, serialT)} ORDER BY id`,
    });
  }
  return out;
}

function build() {
  return {
    note: "退避コピー (#2448) の共有ベクタ。backupGolden.test.ts が生成し、Rust の backup_before_destructive_integration.rs が実 DB で流す。",
    database: DB,
    cases: cases().map((c) => {
      const database = c.driver === "sqlite" ? "main" : DB;
      const plan = buildBackupPlan({
        driver: c.driver,
        database,
        table: c.table,
        kind: c.kind,
        now: NOW,
        ddl: c.ddl,
        columns: c.columns,
        pgColumns: c.pgColumns ?? null,
      });
      expect(plan.errors).toEqual([]);
      expect(plan.statements.length).toBeGreaterThan(0);
      const orig = q(c.driver, c.driver === "sqlite" ? null : DB, c.table);
      const main =
        c.kind === "drop"
          ? `DROP TABLE ${orig}`
          : c.driver === "sqlite"
            ? `DELETE FROM ${orig}`
            : `TRUNCATE TABLE ${orig}`;
      return {
        name: c.name,
        driver: c.driver,
        database: c.driver === "sqlite" ? null : DB,
        kind: c.kind,
        setup: c.setup,
        checkSql: c.checkSql,
        backupStatements: plan.statements,
        afterBackup: c.afterBackup,
        beforeRestore: c.beforeRestore,
        mainSql: main,
        restoreSql: plan.restoreSql.replace(/;$/, ""),
      };
    }),
  };
}

describe("退避コピーの共有ベクタ (#2448)", () => {
  it("fixtures/backupVectors.json が TS の組み立て結果と一致する", () => {
    const built = build();
    if (process.env.UPDATE_BACKUP_VECTORS) {
      writeFileSync(FIXTURE, `${JSON.stringify(built, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(built);
  });
});
