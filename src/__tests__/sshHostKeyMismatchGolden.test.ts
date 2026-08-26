import { describe, expect, it } from "vitest";
import { parseHostKeyFingerprints } from "../components/hostKeyFingerprints";
import vectors from "./fixtures/sshHostKeyMismatchVectors.json";

// SshHostKeyMismatch のメッセージ書式ゴールデンテスト — フロント側 (#1030)。
//
// バック (`error.rs` の `#[error(...)]` テンプレート) が生成するメッセージと、フロント
// (`parseHostKeyFingerprints`、`src/components/hostKeyFingerprints.ts`) がそれをパース
// する 2 本の正規表現は、これまで手写しの文字列リテラルだけで繋がっていた (#880 /
// errorHint ゴールデンと同型の穴)。ここでは共有ベクタ
// (`fixtures/sshHostKeyMismatchVectors.json`) の厳密なレンダリング後メッセージを
// `parseHostKeyFingerprints` に通し、抽出した expected/actual fingerprint と
// 失敗ホップの host:port が期待どおりであることを検証する。バック側は同じ JSON を
// `src-tauri/tests/ssh_host_key_mismatch_golden.rs` が読み、`{host, port, expected,
// actual}` から構築した `AppError::SshHostKeyMismatch` の `.to_string()` が同じ
// `message` になることを検証する。片方だけテンプレート/正規表現を変えてズレると、
// どちらかのテストが落ちる。

interface VectorCase {
  id: string;
  note: string;
  host: string;
  port: number;
  expected: string;
  actual: string;
  message: string;
  /** null は「endpoint (host:port) の抽出に失敗する」ケースを表す (例: IPv6 ホスト)。 */
  parsedHost: string | null;
  parsedPort: number | null;
}

const cases = vectors.cases as VectorCase[];

describe("SshHostKeyMismatch メッセージ ゴールデン (フロント parseHostKeyFingerprints)", () => {
  it("ケース id が一意である", () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ベクタが十分なケース数を持つ (取りこぼし防止)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
  });

  it("IPv6 ホスト (`:` を含む) のケースを含み、host/port が正しく抽出できる (#1053)", () => {
    // #1053 以前は endpoint 抽出用正規表現 ([^\s:]+) がホストに ':' を許さず、
    // IPv6 ホストで host/port が undefined になっていた。非貪欲マッチへの変更で
    // 解消したことをここで固定する — 退行時にすぐ気付けるよう、少なくとも 1 件は
    // ':' を含む host で host/port 抽出に成功するケースを維持する。
    const ipv6Cases = cases.filter((c) => c.host.includes(":"));
    expect(ipv6Cases.length).toBeGreaterThan(0);
    for (const c of ipv6Cases) {
      expect(c.parsedHost).not.toBeNull();
    }
  });

  for (const c of cases) {
    it(`[${c.id}] ${c.note}`, () => {
      const parsed = parseHostKeyFingerprints(c.message);

      // fingerprint 自体は常に抽出できる (host/port 抽出の成否とは独立)。
      expect(parsed).not.toBeNull();
      expect(parsed!.expected).toBe(c.expected);
      expect(parsed!.actual).toBe(c.actual);

      if (c.parsedHost === null) {
        expect(parsed!.host).toBeUndefined();
        expect(parsed!.port).toBeUndefined();
      } else {
        expect(parsed!.host).toBe(c.parsedHost);
        expect(parsed!.port).toBe(c.parsedPort);
      }
    });
  }
});
