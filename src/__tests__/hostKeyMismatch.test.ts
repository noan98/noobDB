import { describe, expect, it } from "vitest";
import { parseHostKeyFingerprints } from "../components/HostKeyMismatchDialog";

// SshHostKeyMismatch のエラー本文から新旧フィンガープリントを抽出する純パーサ (#682)。
// バック error.rs の #[error(...)] 文言に追従する。文言が変わってここが抽出できなく
// なっても、ダイアログは raw メッセージ表示にフォールバックする (null 返し) 設計。

describe("parseHostKeyFingerprints", () => {
  const message =
    "ssh host key mismatch for ssh.example.com:22: stored fingerprint SHA256:oldAAA, " +
    "server presented SHA256:newBBB. If you did not expect the server's key to change, " +
    "this could indicate a man-in-the-middle attack.";

  it("バック error.rs の実文言から新旧フィンガープリントを抽出する", () => {
    expect(parseHostKeyFingerprints(message)).toEqual({
      expected: "SHA256:oldAAA",
      actual: "SHA256:newBBB",
    });
  });

  it("該当しない文言では null を返す (raw 表示へフォールバック)", () => {
    expect(parseHostKeyFingerprints("some unrelated error")).toBeNull();
    expect(parseHostKeyFingerprints("")).toBeNull();
  });
});
