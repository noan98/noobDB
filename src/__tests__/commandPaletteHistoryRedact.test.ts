import { describe, expect, it } from "vitest";
import { CREDENTIAL_PLACEHOLDER, redactCredentials } from "../sqlCredentials";

// App.tsx の履歴「実行」アクションは、履歴 SQL が CREDENTIAL_PLACEHOLDER を含むと無効にする (#2425)。
describe("履歴 SQL の伏せ字判定", () => {
  it("伏せ字化した資格情報つき SQL は placeholder を含み、通常の SQL は含まない", () => {
    expect(redactCredentials("CREATE USER 'a'@'%' IDENTIFIED BY 'pw'", "mysql")).toContain(
      CREDENTIAL_PLACEHOLDER,
    );
    expect(redactCredentials("SELECT 1", "mysql")).not.toContain(CREDENTIAL_PLACEHOLDER);
  });
});
