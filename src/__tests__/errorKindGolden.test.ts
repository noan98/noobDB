import { describe, expect, it } from "vitest";
import { hintForKind, resolveErrorHint } from "../errorHints";
import type { I18nKey } from "../i18n";
import vectors from "./fixtures/errorKindVectors.json";

// AppError.kind (#683) → ヒントキーの対応を固定するゴールデンテスト (フロント側)。
//
// #683 で AppError は `{ kind, message }` の構造化 JSON でシリアライズされるように
// なり、errorHints.ts は「kind による確実な分類 → message パターンはフォールバック」
// の 2 段構成 (resolveErrorHint) になった。ここでは共有ベクタ
// (`fixtures/errorKindVectors.json`) を読み、各 kind/message に対する
// resolveErrorHint の結果が期待ヒントと一致することを検証する。バック側は同じ JSON を
// `src-tauri/tests/error_kind_golden.rs` が読み、variant から構築した AppError の
// `.kind()` がベクタの kind と一致することを検証する。片方の実装だけ変えて kind の
// 綴りや分類がズレると、どちらかが落ちる。

interface KindCase {
  id: string;
  note: string;
  backendKind: "native" | "sqlxProtocol";
  variant?: string | null;
  arg?: string | null;
  message: string;
  kind: string;
  hintKey: I18nKey | null;
}

const cases = vectors.cases as KindCase[];

describe("errorHints kind ゴールデン (フロント resolveErrorHint)", () => {
  it("ケース id が一意である", () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("SSH 系の kind を少なくとも 1 件ずつ含む (空白地帯の回帰防止)", () => {
    const kinds = new Set(cases.map((c) => c.kind));
    expect(kinds.has("ssh")).toBe(true);
    expect(kinds.has("sshKey")).toBe(true);
    expect(kinds.has("sshHostKeyMismatch")).toBe(true);
  });

  for (const c of cases) {
    it(`[${c.id}] ${c.note} — resolveErrorHint=${c.hintKey ?? "null"}`, () => {
      // 構造化エラー (kind + message) からの 2 段解決が期待ヒントと一致する。
      expect(resolveErrorHint({ kind: c.kind, message: c.message })).toBe(c.hintKey);
    });
  }

  it("kind だけでヒントが決まるケースは hintForKind 単体でも一致する", () => {
    // kind 経路で確実に決まる (message フォールバック不要な) ケースを直接検証する。
    // db 系は message 依存なので hintForKind は null (フォールバック前提) になる。
    for (const c of cases.filter((x) => x.kind !== "db")) {
      const direct = hintForKind(c.kind, c.message);
      // ヒント対象外 (readOnly / invalidInput) は null、それ以外は resolve と一致。
      if (c.hintKey === null) {
        expect(direct).toBeNull();
      } else {
        expect(direct).toBe(c.hintKey);
      }
    }
  });
});
