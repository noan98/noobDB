import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { renderInBrowser } from "./render";
import { installTauriMock, invocationsOf, onCommand } from "./tauriMock";
import { QueryEditor } from "../../components/QueryEditor";

// #1413 — 補完ポップアップの種別アイコンと、列候補の情報パネル (型・NULL 可否・FK 参照先)。
// CodeMirror のポップアップ / info は実レイアウトが要るので実ブラウザで確かめる。

const USER_ID_META = {
  name: "user_id",
  data_type: "bigint",
  nullable: true,
  key: "MUL",
  default: null,
  extra: "",
  referenced_table: "users",
  referenced_column: "id",
};

const FK_ORDERS_USER = {
  table: "orders",
  column: "user_id",
  referenced_table: "users",
  referenced_column: "id",
  constraint_name: "fk_orders_user",
};

let bumpSchema: () => void = () => {};

/** `databaseSchema` の参照を差し替えて、スキーマ更新 (DDL 後の再取得) を再現する。 */
function Harness({ sql }: { sql: string }) {
  const [, setRev] = useState(0);
  bumpSchema = () => setRev((n) => n + 1);
  return (
    <QueryEditor
      onRun={() => {}}
      initialSql={sql}
      sessionId="s1"
      driver="mysql"
      defaultDatabase="shop"
      schemaTable={{ database: "shop", name: "orders", columns: ["id", "user_id"] }}
      databaseSchema={[{ name: "orders", columns: ["id", "user_id"] }]}
    />
  );
}

const popup = () => document.querySelector(".cm-tooltip-autocomplete");

/** 補完ポップアップが閉じていれば Ctrl+Space で開く (開いていれば何もしない)。 */
function openCompletion() {
  if (popup()) return;
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: " ", ctrlKey: true, bubbles: true }),
  );
}

async function mountEditor(sql: string) {
  const screen = await renderInBrowser(<Harness sql={sql} />);
  const content = screen.container.querySelector<HTMLElement>(".cm-content");
  expect(content).not.toBeNull();
  content?.focus();
  // 末尾へ移動する。
  await screen.getByRole("textbox").click();
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
  );
  return screen;
}

const optionLabels = () =>
  [...document.querySelectorAll(".cm-tooltip-autocomplete li .cm-completionLabel")].map(
    (e) => e.textContent ?? "",
  );

describe("SQL 補完ポップアップ (実ブラウザ)", () => {
  beforeEach(() => {
    installTauriMock();
    onCommand("foreign_keys", () => [FK_ORDERS_USER]);
    onCommand("describe_table", () => [USER_ID_META]);
  });

  it("FK 列に link アイコンが付き、選択すると情報パネルに型・NULL 可否・FK 参照先が出る", async () => {
    await mountEditor("SELECT orders.user");
    // FK が届いて補完が作り直されるまで、開き直しながら待つ (固定の待ち時間は使わない)。
    await expect
      .poll(
        () => {
          openCompletion();
          return document.querySelector(".cm-tooltip-autocomplete .cm-completionIcon-link svg") !== null;
        },
        { timeout: 5_000 },
      )
      .toBe(true);
    // 鍵アイコン (主キー用の意味づけ) は補完に出ない。
    expect(document.querySelector(".cm-tooltip-autocomplete .cm-completionIcon-key")).toBeNull();
    await expect
      .poll(() => document.querySelector(".cm-completionInfo .cm-sqlInfo")?.textContent ?? "", {
        timeout: 5_000,
      })
      .toContain("bigint");
    const info = document.querySelector(".cm-completionInfo .cm-sqlInfo")?.textContent ?? "";
    expect(info).toContain("users.id");
  });

  it("キーワードはテーブルより下位に並び、COUNT などの関数に関数アイコンが付く", async () => {
    await mountEditor("SELECT * FROM or");
    await expect.poll(() => (openCompletion(), optionLabels().length), { timeout: 5_000 }).toBeGreaterThan(1);
    const labels = optionLabels();
    const tableAt = labels.indexOf("orders");
    const keywordAt = labels.findIndex((l) => l.toUpperCase() === "ORDER");
    expect(tableAt).toBeGreaterThanOrEqual(0);
    expect(keywordAt).toBeGreaterThan(tableAt);
  });

  it("実データの関数名 (COUNT) は関数アイコン、NULL は関数アイコンにならない", async () => {
    await mountEditor("SELECT COU");
    await expect.poll(() => (openCompletion(), optionLabels().includes("COUNT")), { timeout: 5_000 }).toBe(true);
    const rowOf = (label: string) =>
      [...document.querySelectorAll(".cm-tooltip-autocomplete li")].find(
        (li) => li.querySelector(".cm-completionLabel")?.textContent === label,
      );
    expect(rowOf("COUNT")?.querySelector(".cm-completionIcon-routine svg")).not.toBeNull();
  });

  it("NULL / TRUE は関数アイコンではなくキーワードのアイコン", async () => {
    await mountEditor("SELECT NUL");
    await expect.poll(() => (openCompletion(), optionLabels().includes("NULL")), { timeout: 5_000 }).toBe(true);
    const row = [...document.querySelectorAll(".cm-tooltip-autocomplete li")].find(
      (li) => li.querySelector(".cm-completionLabel")?.textContent === "NULL",
    );
    expect(row?.querySelector(".cm-completionIcon-routine")).toBeNull();
    expect(row?.querySelector(".cm-completionIcon-braces svg")).not.toBeNull();
  });

  it("describe_table が失敗しても情報パネルは出ず、補完は壊れない", async () => {
    onCommand("describe_table", () => {
      throw new Error("describe failed");
    });
    await mountEditor("SELECT orders.user");
    await expect.poll(() => (openCompletion(), optionLabels().includes("user_id")), { timeout: 5_000 }).toBe(true);
    await expect.poll(() => invocationsOf("describe_table").length, { timeout: 5_000 }).toBeGreaterThan(0);
    // 取得の失敗が反映されるのを少し待っても、パネルは現れない。
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.querySelector(".cm-completionInfo .cm-sqlInfo")).toBeNull();
    expect(popup()).not.toBeNull();
  });

  it("スキーマが更新されると列情報のキャッシュを捨て、describe_table を取り直す", async () => {
    await mountEditor("SELECT orders.user");
    await expect
      .poll(() => (openCompletion(), document.querySelector(".cm-completionInfo .cm-sqlInfo") !== null), {
        timeout: 5_000,
      })
      .toBe(true);
    expect(invocationsOf("describe_table").length).toBe(1);
    // 閉じて、スキーマ更新 (databaseSchema の参照が変わる) 後に開き直す。
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const fkCalls = invocationsOf("foreign_keys").length;
    bumpSchema();
    await expect.poll(() => invocationsOf("foreign_keys").length, { timeout: 5_000 }).toBeGreaterThan(fkCalls);
    await expect
      .poll(
        () => {
          openCompletion();
          return invocationsOf("describe_table").length;
        },
        { timeout: 5_000 },
      )
      .toBeGreaterThan(1);
    // スキーマ更新後も FK 列の link アイコンは付いたまま。
    await expect
      .poll(() => (openCompletion(), document.querySelector(".cm-completionIcon-link svg") !== null), {
        timeout: 5_000,
      })
      .toBe(true);
  });
});
