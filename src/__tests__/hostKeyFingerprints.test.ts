import { describe, expect, it } from "vitest";
import { parseHostKeyFingerprints } from "../components/hostKeyFingerprints";

// parseHostKeyFingerprints の単体テスト (#1053)。
//
// 境界ケース (IPv6 ホスト) の網羅は共有ゴールデン
// (`fixtures/sshHostKeyMismatchVectors.json` / `sshHostKeyMismatchGolden.test.ts`)
// でバックエンドのメッセージ生成と突き合わせているが、ここでは
// `parseHostKeyFingerprints` 単体の入出力として、裸の IPv6・角括弧付き IPv6・
// 既存ドライバ (IPv4・FQDN・非標準ポート) の回帰が無いことを直接固定する。

const buildMessage = (endpoint: string, expected: string, actual: string) =>
  `ssh host key mismatch for ${endpoint}: stored fingerprint ${expected}, ` +
  `server presented ${actual}. If you did not expect the server's key to change, ` +
  `this could indicate a man-in-the-middle attack.`;

describe("parseHostKeyFingerprints", () => {
  it("裸の IPv6 ホストから host/port を抽出できる (#1053)", () => {
    const message = buildMessage("2001:db8::1:22", "SHA256:old", "SHA256:new");
    const parsed = parseHostKeyFingerprints(message);
    expect(parsed).toEqual({
      expected: "SHA256:old",
      actual: "SHA256:new",
      host: "2001:db8::1",
      port: 22,
    });
  });

  it("角括弧付き IPv6 ホスト ([host]:port) から host/port を抽出できる (#1053)", () => {
    const message = buildMessage("[2001:db8::1]:2222", "SHA256:old", "SHA256:new");
    const parsed = parseHostKeyFingerprints(message);
    expect(parsed).toEqual({
      expected: "SHA256:old",
      actual: "SHA256:new",
      host: "2001:db8::1",
      port: 2222,
    });
  });

  it("フル形式 (省略なし) の IPv6 ホストでも抽出できる", () => {
    const message = buildMessage(
      "2001:0db8:0000:0000:0000:0000:0000:0001:22",
      "SHA256:old",
      "SHA256:new",
    );
    const parsed = parseHostKeyFingerprints(message);
    expect(parsed?.host).toBe("2001:0db8:0000:0000:0000:0000:0000:0001");
    expect(parsed?.port).toBe(22);
  });

  it("IPv4 ホストの回帰が無い", () => {
    const message = buildMessage("192.168.1.10:22", "SHA256:old", "SHA256:new");
    const parsed = parseHostKeyFingerprints(message);
    expect(parsed).toEqual({
      expected: "SHA256:old",
      actual: "SHA256:new",
      host: "192.168.1.10",
      port: 22,
    });
  });

  it("FQDN ホストの回帰が無い", () => {
    const message = buildMessage(
      "db-primary.ap-northeast-1.rds.example.co.jp:65535",
      "SHA256:old",
      "SHA256:new",
    );
    const parsed = parseHostKeyFingerprints(message);
    expect(parsed).toEqual({
      expected: "SHA256:old",
      actual: "SHA256:new",
      host: "db-primary.ap-northeast-1.rds.example.co.jp",
      port: 65535,
    });
  });

  it("非標準ポート (多段トンネルの踏み台 #708 を想定) の回帰が無い", () => {
    const message = buildMessage(
      "bastion.internal.example.com:2222",
      "SHA256:old",
      "SHA256:new",
    );
    const parsed = parseHostKeyFingerprints(message);
    expect(parsed).toEqual({
      expected: "SHA256:old",
      actual: "SHA256:new",
      host: "bastion.internal.example.com",
      port: 2222,
    });
  });

  it("単一ラベルホスト名の回帰が無い", () => {
    const message = buildMessage("jumpbox:22", "SHA256:old", "SHA256:new");
    const parsed = parseHostKeyFingerprints(message);
    expect(parsed).toEqual({
      expected: "SHA256:old",
      actual: "SHA256:new",
      host: "jumpbox",
      port: 22,
    });
  });

  it("fingerprint 部分を抽出できないメッセージは null を返す", () => {
    expect(parseHostKeyFingerprints("not a mismatch message at all")).toBeNull();
  });
});
