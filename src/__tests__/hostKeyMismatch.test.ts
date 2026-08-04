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
      host: "ssh.example.com",
      port: 22,
    });
  });

  it("該当しない文言では null を返す (raw 表示へフォールバック)", () => {
    expect(parseHostKeyFingerprints("some unrelated error")).toBeNull();
    expect(parseHostKeyFingerprints("")).toBeNull();
  });

  // #708: 多段トンネルではジャンプホスト側で不一致が起きうる。エラーは実際に
  // 失敗した段の host:port を名乗るので、それをそのまま抽出できることを固定する
  // (App.tsx の再信頼フローがプロファイルの主 SSH ホストではなくこちらを使う)。
  it("ジャンプホスト側の不一致でもそのホスト:ポートを抽出する", () => {
    const jumpMessage =
      "ssh host key mismatch for bastion.example.com:2222: stored fingerprint SHA256:oldJJJ, " +
      "server presented SHA256:newKKK. If you did not expect the server's key to change, " +
      "this could indicate a man-in-the-middle attack.";
    expect(parseHostKeyFingerprints(jumpMessage)).toEqual({
      expected: "SHA256:oldJJJ",
      actual: "SHA256:newKKK",
      host: "bastion.example.com",
      port: 2222,
    });
  });
});
