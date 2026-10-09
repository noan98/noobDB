import { beforeEach, describe, expect, it } from "vitest";
import { renderInBrowser } from "./render";
import { installTauriMock, invocationsOf, onCommand } from "./tauriMock";
import { QueryEditor } from "../../components/QueryEditor";

// #1413 — 補完ポップアップの種別アイコンと、列候補の情報パネル (型・NULL 可否・FK 参照先)。
// CodeMirror のポップアップ / info は実レイアウトが要るので実ブラウザで確かめる。
describe("SQL 補完ポップアップ (実ブラウザ)", () => {
  beforeEach(() => installTauriMock());

  it("列候補に種別アイコンが付き、選択すると情報パネルに型・NULL 可否・FK 参照先が出る", async () => {
    onCommand("foreign_keys", () => [
      {
        table: "orders",
        column: "user_id",
        referenced_table: "users",
        referenced_column: "id",
        constraint_name: "fk_orders_user",
      },
    ]);
    onCommand("describe_table", () => [
      {
        name: "user_id",
        data_type: "bigint",
        nullable: true,
        key: "MUL",
        default: null,
        extra: "",
        referenced_table: "users",
        referenced_column: "id",
      },
    ]);
    const screen = await renderInBrowser(
      <QueryEditor
        onRun={() => {}}
        initialSql="SELECT orders.user"
        sessionId="s1"
        driver="mysql"
        defaultDatabase="shop"
        schemaTable={{ database: "shop", name: "orders", columns: ["id", "user_id"] }}
        databaseSchema={[{ name: "orders", columns: ["id", "user_id"] }]}
      />,
    );
    // FK が届くと補完が作り直される。届いてから (作り直しを待って) ポップアップを開く。
    await expect.poll(() => invocationsOf("foreign_keys").length, { timeout: 5_000 }).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 300));
    const content = screen.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    content?.focus();
    // 末尾へ移動して補完を明示的に開く (Ctrl+Space)。
    await screen.getByRole("textbox").click();
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", ctrlKey: true, bubbles: true }),
    );
    await expect
      .poll(() => document.querySelector(".cm-tooltip-autocomplete .cm-completionIcon-key svg") !== null, {
        timeout: 5_000,
      })
      .toBe(true);
    await expect
      .poll(() => document.querySelector(".cm-completionInfo .cm-sqlInfo")?.textContent ?? "", {
        timeout: 5_000,
      })
      .toContain("bigint");
    const info = document.querySelector(".cm-completionInfo .cm-sqlInfo")?.textContent ?? "";
    expect(info).toContain("users.id");
  });
});
