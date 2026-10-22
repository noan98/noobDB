import { describe, expect, it } from "vitest";
import errorRs from "../../src-tauri/src/error.rs?raw";
import errorHintsTs from "../errorHints.ts?raw";
import vectors from "./fixtures/errorKindVectors.json";

// AppError の kind ゴールデン網羅性パリティ (#1779)。
//
// `AppError::kind()` は全バリアントを `match` で返すので、バリアント追加時の `kind()` 更新
// はコンパイラが強制する。だが「その kind が共有ゴールデン `errorKindVectors.json` に載り、
// フロントの分類方針が決まっているか」は誰も強制していなかった。`error_kind_golden.rs` /
// `errorKindGolden.test.ts` は JSON に載っているケースしか回さないため、載せ忘れは素通り
// する (`serdeCoverageParity.test.ts` が出力側で塞いだのと同じ穴のエラー側)。
//
// ここでは `error.rs::kind()` の match 腕から kind 文字列を機械的に全抽出し、次を強制する:
//
//   - すべての kind が `COVERED` (errorKindVectors.json に 1 ケース以上ある。ヒントの有無は
//     そのケースの hintKey が `errorKindGolden.test.ts` で固定するので、hintForKind の分類
//     判断も「ヒントあり / null」のどちらかで必ず明示される) か、理由つき `EXCLUDED`。
//   - フロントが kind 文字列で分岐する箇所 (`hintForKind` / `aiErrorHintKey` /
//     `KIND_MESSAGE_KEYS`) の綴りが、Rust の実在 kind と一致する (綴りドリフト検出)。
//   - ゴールデンの `kind` も Rust の実在 kind である。

/** `kind()` の match 腕 (`AppError::Xxx(..) => "yyy"`) から kind 文字列を全て抜き出す。 */
function extractKinds(src: string): string[] {
  const cleaned = src
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  const start = cleaned.indexOf("pub fn kind(&self)");
  expect(start, "error.rs に `pub fn kind(&self)` が見つからない").toBeGreaterThanOrEqual(0);
  const open = cleaned.indexOf("match self {", start);
  expect(open).toBeGreaterThan(start);
  // match 本体の閉じ括弧まで (波括弧の深さで追う。腕の `{ .. }` パターンも釣り合う)。
  let depth = 0;
  let end = open;
  for (let i = open + "match self ".length; i < cleaned.length; i++) {
    if (cleaned[i] === "{") depth++;
    else if (cleaned[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = cleaned.slice(open, end);
  const kinds: string[] = [];
  // `=> { "x" }` のブロック形式の腕も拾う。
  for (const m of body.matchAll(/=>\s*\{?\s*"(\w+)"/g)) kinds.push(m[1]);
  // 取りこぼし検出: 腕 (`=>`) の数と抽出した kind の数が一致すること。
  const arms = body.match(/=>/g)?.length ?? 0;
  expect(kinds.length, "kind() の腕から kind 文字列を抽出しきれていない").toBe(arms);
  return kinds;
}

/** 関数 `anchor` の本体にある `case "x":` を返す。 */
function extractCaseLabels(src: string, anchor: string): string[] {
  const start = src.indexOf(anchor);
  expect(start, `errorHints.ts に ${anchor} が見つからない`).toBeGreaterThanOrEqual(0);
  const rest = src.slice(start);
  const next = rest.indexOf("\n}\n");
  expect(next, `${anchor} の本体の終端が見つからない`).toBeGreaterThanOrEqual(0);
  const block = rest.slice(0, next);
  return [...block.matchAll(/case\s+"(\w+)":/g)].map((m) => m[1]);
}

function extractKindMessageKeys(src: string): string[] {
  const start = src.indexOf("const KIND_MESSAGE_KEYS");
  expect(start).toBeGreaterThanOrEqual(0);
  const block = src.slice(start, src.indexOf("\n};", start));
  return [...block.matchAll(/^\s+(\w+):\s*"/gm)].map((m) => m[1]);
}

const rustKinds = extractKinds(errorRs);
const rustKindSet = new Set(rustKinds);

const vectorKinds = new Set((vectors.cases as { kind: string }[]).map((c) => c.kind));

/**
 * ゴールデンに 1 ケースも載せられない kind (理由つき)。理想は空。
 * 追加するときは「なぜ載せられないか」を日本語で書く。
 */
const EXCLUDED: Record<string, string> = {};

describe("AppError.kind の golden 網羅性 (error.rs ⇔ errorKindVectors.json ⇔ errorHints.ts)", () => {
  it("error.rs の kind() から十分な数の kind を抽出できている (抽出ロジックの保険)", () => {
    expect(rustKinds.length).toBeGreaterThanOrEqual(25);
    // ガード付きの腕 (`Sqlx(e) if ..`) も、`{ .. }` パターンの腕も、単位バリアントも拾えている。
    for (const k of ["connectionLost", "db", "connectTimeout", "configDir", "other"]) {
      expect(rustKindSet.has(k), k).toBe(true);
    }
    expect(rustKindSet.size, "kind() に同じ kind 文字列が重複している").toBe(rustKinds.length);
  });

  it("すべての kind がゴールデンに 1 ケース以上あるか、理由つき EXCLUDED である", () => {
    const unclassified = rustKinds.filter((k) => !vectorKinds.has(k) && !(k in EXCLUDED));
    expect(
      unclassified,
      "errorKindVectors.json に載っていない kind があります。cases に 1 ケース足して " +
        "(src-tauri/tests/error_kind_golden.rs の build_native にも分岐を追加) " +
        "hintKey でフロントの分類方針 (ヒントあり / null) を固定するか、" +
        "載せられない理由があれば EXCLUDED に追記してください",
    ).toEqual([]);
  });

  it("ゴールデンの kind はすべて error.rs に実在する (綴りドリフト検出)", () => {
    const unknown = [...vectorKinds].filter((k) => !rustKindSet.has(k)).sort();
    expect(unknown, "Rust の kind() が返さない kind がゴールデンにあります").toEqual([]);
  });

  it("hintForKind / aiErrorHintKey / KIND_MESSAGE_KEYS が分岐する kind は Rust に実在する", () => {
    const labels = [
      ...extractCaseLabels(errorHintsTs, "export function hintForKind"),
      ...extractCaseLabels(errorHintsTs, "export function aiErrorHintKey"),
      ...extractKindMessageKeys(errorHintsTs),
    ];
    // 抽出が空だと素通りするので、既知の分岐が拾えていることを確認する。
    expect(labels).toContain("sshHostKeyMismatch");
    expect(labels).toContain("aiBudgetExceeded");
    expect(labels).toContain("flightProfileMismatch");
    const unknown = [...new Set(labels)].filter((k) => !rustKindSet.has(k)).sort();
    expect(unknown, "errorHints.ts が Rust に無い kind 文字列で分岐しています").toEqual([]);
  });

  it("EXCLUDED に実在しない kind・ゴールデンに載った kind・空の理由が残っていない", () => {
    const stale = Object.keys(EXCLUDED).filter((k) => !rustKindSet.has(k));
    expect(stale, "kind() に無い kind が EXCLUDED に残っています").toEqual([]);
    const both = Object.keys(EXCLUDED).filter((k) => vectorKinds.has(k));
    expect(both, "ゴールデンに載っている kind は EXCLUDED から外してください").toEqual([]);
    const empty = Object.entries(EXCLUDED)
      .filter(([, reason]) => reason.trim() === "")
      .map(([k]) => k);
    expect(empty).toEqual([]);
  });
});
