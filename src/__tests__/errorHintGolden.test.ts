import { describe, expect, it } from "vitest";
import {
  ALL_ERROR_HINT_KEYS,
  illustrationForError,
  matchErrorHint,
  type ErrorIllustrationKind,
} from "../errorHints";
import type { I18nKey } from "../i18n";
import vectors from "./fixtures/errorHintVectors.json";

// AppError (バック) と errorHints.ts のヒント/イラスト判定 (フロント) のゴールデン
// テスト (#667)。
//
// バックの AppError は Display 文字列としてフロントへ渡り、フロントの
// errorHints.ts (matchErrorHint / illustrationForError) がその文字列を人間向けの
// ヒント/イラストへ対応付ける。両者は独立実装のため、AppError のメッセージ文言が
// 変わると errorHints.ts のマッチが静かに外れるドリフトが起こり得る (#444 の
// 読み取り専用二重実装と同じ問題構造)。
//
// ここでは両者が参照する共有ベクタ (`fixtures/errorHintVectors.json`) をフロント側
// で読み、各 message に対する matchErrorHint / illustrationForError の判定が期待値
// と一致することを検証する。バック側は同じ JSON を
// `src-tauri/tests/error_hint_golden.rs` が `include_str!` で読み込み、
// backendKind: "native" のケースは対応する AppError バリアントを実際に構築して
// Display 出力が message と厳密一致することを、backendKind: "sqlxProtocol" の
// ケースは AppError::Sqlx でラップしても message が欠落しないことを検証する。
// 片方の実装だけ変えてズレが生じると、どちらかのテストが落ちる。

interface VectorCase {
  id: string;
  note: string;
  backendKind: "native" | "sqlxProtocol";
  variant?: string;
  arg?: string | null;
  message: string;
  hintKey: I18nKey | null;
  illustration: ErrorIllustrationKind;
}

const cases = vectors.cases as VectorCase[];

describe("errorHints ゴールデン (フロント matchErrorHint / illustrationForError)", () => {
  it("ベクタが十分なケース数を持つ (取りこぼし防止)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  it("ケース id が一意である", () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const c of cases) {
    it(`[${c.id}] ${c.note} — hintKey=${c.hintKey ?? "null"}`, () => {
      expect(matchErrorHint(c.message)).toBe(c.hintKey);
    });

    it(`[${c.id}] ${c.note} — illustration=${c.illustration}`, () => {
      expect(illustrationForError(c.message)).toBe(c.illustration);
    });
  }

  describe("dead ヒント検出 (到達しないヒントキーが無いこと)", () => {
    const usedHintKeys = new Set(
      cases.map((c) => c.hintKey).filter((k): k is I18nKey => k !== null),
    );

    it("PATTERNS の全ヒントキーが少なくとも 1 ケースで踏まれている", () => {
      const dead = ALL_ERROR_HINT_KEYS.filter((key) => !usedHintKeys.has(key));
      expect(dead).toEqual([]);
    });

    it("ベクタが参照するヒントキーはすべて実在の PATTERNS キーである (誤字/削除済みキー検出)", () => {
      const known = new Set(ALL_ERROR_HINT_KEYS);
      const unknown = [...usedHintKeys].filter((key) => !known.has(key));
      expect(unknown).toEqual([]);
    });
  });
});
