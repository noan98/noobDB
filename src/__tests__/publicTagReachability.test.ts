import { describe, expect, it } from "vitest";

// `@public` タグの死蔵検出 (#1076)。
//
// `knip.json` の `"tags": ["-public"]` は JSDoc に `@public` を持つエクスポートを
// 未使用検出から除外する (意図的な公開 API をベースライン green にするため)。
// 便利な反面、**`@public` を付けた瞬間に knip からは二度と見えなくなる**ので、
// 「一度も参照されないまま `@public` で隠され続けるエクスポート」を誰も検出でき
// ない盲点になっていた (#1076 の発端: ランタイム未配線の `previewResult` zod
// スキーマが `@public` で隠れていた)。
//
// ここでは `src/` 配下の全 TS/TSX から「`@public` を含む JSDoc の直後にある
// `export` 宣言」を抽出し、その名前が**宣言以外のどこか**で参照されていることを
// 検証する (#907 apiReachabilityParity / #1031 commandRegistration と同じ
// 「到達性を可視化する」思想)。
//
// 参照として数えるのは原則**本体コード (`__tests__/` 以外)** からの参照だけ。
// テストからしか触られていないのに「公開 API」を名乗るのは、まさに
// `previewResult` (実参照は schemaParity.test.ts の列挙だけ) のパターンだから。
// ただし次の 2 つはテストからの参照でよい:
//
// - JSDoc に「テスト」と明記して**テストのために公開している**と宣言したもの
//   (例: 共有ゴールデンが直接検証する `quoteSqlIdent` / `sqlLiteral`)。
// - `__tests__/` 配下のテスト用ヘルパ自身 (`browser/tauriMock.ts` など)。
//
// 同一ファイル内での利用 (宣言以外の出現) も本体からの参照として数える。
// `// …` / `/* … */` コメント内の言及は参照に数えない。

const allSources = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * 参照されていなくても `@public` のまま残す例外。**空に近いまま維持する**のが理想で、
 * 追加するときは「なぜどこからも参照されないのに残すのか」を必ず併記すること。
 * 「いつか使うかも」は理由にならない — その場合は消して、使うときに復活させる。
 */
const INTENTIONALLY_UNREFERENCED: Record<string, string> = {
  emitTauriEvent:
    "ブラウザモード用フェイク Tauri ランタイム (tauriMock.ts) の公開契約。Channel へ移行していない" +
    "名前付きイベント (csv-import:* / export-stream:* / dump-stream:*) を注入する唯一の口で、" +
    "`listen` のモック実装と対になる。",
};

/** `// …` と `/* … *\/` を除去する (文字列内の `//` まで厳密には扱わない簡易版)。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

interface PublicExport {
  name: string;
  file: string;
  /** テストからの参照だけで到達とみなしてよいか (上記の 2 条件)。 */
  testReferencesSuffice: boolean;
}

/**
 * `import.meta.glob` のキーはこのテストファイルからの相対パスなので、
 * `src/__tests__/` 直下とその配下は `./…` で始まる (`../__tests__/…` にはならない)。
 */
const isTestFile = (file: string) => file.startsWith("./") || file.includes("/__tests__/");

/**
 * `@public` を含む JSDoc (`/** … *\/`) の直後 (空白のみを挟む) にある
 * `export` 宣言の名前を集める。ファイル冒頭の説明ブロックのように直後が
 * `export` でない JSDoc は対象外。
 */
function collectPublicExports(): PublicExport[] {
  const found: PublicExport[] = [];
  const re =
    /(\/\*\*(?:(?!\*\/)[\s\S])*?@public(?:(?!\*\/)[\s\S])*?\*\/)\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const [file, src] of Object.entries(allSources)) {
    for (const m of src.matchAll(re)) {
      found.push({
        name: m[2],
        file,
        testReferencesSuffice: m[1].includes("テスト") || isTestFile(file),
      });
    }
  }
  return found;
}

// このテスト自身は既知の名前を文字列で持つので、参照の数え上げからは外す。
const strippedSources = Object.entries(allSources)
  .filter(([file]) => !file.endsWith("/publicTagReachability.test.ts"))
  .map(([file, src]) => [file, stripComments(src)] as const);

/**
 * `name` を識別子として含む箇所の数を、宣言ファイルとそれ以外に分けて数える。
 * `includeTests` が false なら `__tests__/` 配下からの参照は数えない。
 */
function references(
  name: string,
  declFile: string,
  includeTests: boolean,
): { own: number; others: string[] } {
  // 識別子には `$` しか正規表現のメタ文字が現れないが、将来の取り違えを防ぐため
  // バックスラッシュを含むすべてのメタ文字をエスケープする。
  const escaped = name.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
  const re = new RegExp(`(^|[^\\w$])${escaped}(?![\\w$])`, "g");
  let own = 0;
  const others: string[] = [];
  for (const [file, src] of strippedSources) {
    const count = [...src.matchAll(re)].length;
    if (file === declFile) own = count;
    else if (count > 0 && (includeTests || !isTestFile(file))) others.push(file);
  }
  return { own, others };
}

const publicExports = collectPublicExports();

describe("@public タグ付きエクスポートの到達性 (knip の -public 盲点ガード)", () => {
  it("走査対象のソースを十分な数だけ読み込めている", () => {
    expect(Object.keys(allSources).length).toBeGreaterThanOrEqual(100);
  });

  it("@public エクスポートを抽出できている (抽出ロジックの保険)", () => {
    const names = publicExports.map((e) => e.name);
    expect(names.length).toBeGreaterThanOrEqual(5);
    // 既知の @public エクスポートが拾えていること。
    expect(names).toContain("quoteSqlIdent");
    expect(names).toContain("SkeletonTableRows");
    expect(names).toContain("IconSizeToken");
  });

  it("@public を付けたまま一度も参照されないエクスポートが無い", () => {
    const dead = publicExports.filter(({ name, file, testReferencesSuffice }) => {
      if (name in INTENTIONALLY_UNREFERENCED) return false;
      const { own, others } = references(name, file, testReferencesSuffice);
      // 宣言そのもので 1 回数えるので、同一ファイル内の利用は 2 回目以降。
      return others.length === 0 && own <= 1;
    });
    expect(
      dead.map((e) => `${e.file}: ${e.name}`),
      "`@public` で knip から隠れたまま本体から参照されないエクスポートがあります。削除するか、" +
        "テスト専用なら JSDoc に「テスト」のためと明記するか、本当に残す理由があれば " +
        "INTENTIONALLY_UNREFERENCED に理由付きで追加してください。",
    ).toEqual([]);
  });

  it("例外リストに陳腐化したエントリが無い (参照されたら / 消えたらリストから外す)", () => {
    const stale = Object.keys(INTENTIONALLY_UNREFERENCED).filter((name) => {
      const decl = publicExports.find((e) => e.name === name);
      if (!decl) return true;
      const { own, others } = references(name, decl.file, decl.testReferencesSuffice);
      return others.length > 0 || own > 1;
    });
    expect(stale).toEqual([]);
  });
});
