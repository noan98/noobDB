import { describe, expect, it } from "vitest";
import type { I18nKey } from "../i18n";
import { dictionaries } from "../i18n";

// #665: i18n 文字列テーブル (ja / en) のキー整合性自動検証。
//
// `ja: Dict = { ... }` (Dict = Record<I18nKey, string>) の型付けにより、ja/en の
// キー集合が食い違うと `tsc` (pnpm run build) が excess/missing property として
// 落ちる。ただし `pnpm test` (vitest) は型チェックをしないため、型を経由しない
// 不整合 (例: 将来 Dict の型が緩められる、`as any` で回避される等) を検出できない。
// このファイルは同じ不変条件を実行時にも独立に検証する安全網。

function extractTokens(s: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of s.matchAll(/\{(\w+)\}/g)) {
    tokens.add(m[1]);
  }
  return tokens;
}

describe("i18n キー整合性 (ja ↔ en)", () => {
  const { en, ja } = dictionaries;
  const enKeys = Object.keys(en).sort();
  const jaKeys = Object.keys(ja).sort();

  it("十分な数のキーを保持している (抽出ロジックの保険)", () => {
    expect(enKeys.length).toBeGreaterThan(100);
  });

  it("ja と en のキー集合が完全一致する", () => {
    const enOnly = enKeys.filter((k) => !jaKeys.includes(k));
    const jaOnly = jaKeys.filter((k) => !enKeys.includes(k));
    expect(enOnly, `en にしか無いキー: ${enOnly.join(", ")}`).toEqual([]);
    expect(jaOnly, `ja にしか無いキー: ${jaOnly.join(", ")}`).toEqual([]);
  });

  it("すべてのキーで値が空文字/空白のみでない", () => {
    const emptyInEn = enKeys.filter((k) => en[k as I18nKey].trim() === "");
    const emptyInJa = jaKeys.filter((k) => ja[k as I18nKey].trim() === "");
    expect(emptyInEn, `en で値が空のキー: ${emptyInEn.join(", ")}`).toEqual([]);
    expect(emptyInJa, `ja で値が空のキー: ${emptyInJa.join(", ")}`).toEqual([]);
  });

  it("every key has matching {token} sets in en and ja", () => {
    const keys = Object.keys(en) as I18nKey[];

    const mismatches: {
      key: I18nKey;
      enOnly: string[];
      jaOnly: string[];
    }[] = [];

    for (const key of keys) {
      const enTokens = extractTokens(en[key]);
      const jaTokens = extractTokens(ja[key]);

      const enOnly = [...enTokens].filter((t) => !jaTokens.has(t)).sort();
      const jaOnly = [...jaTokens].filter((t) => !enTokens.has(t)).sort();

      if (enOnly.length > 0 || jaOnly.length > 0) {
        mismatches.push({ key, enOnly, jaOnly });
      }
    }

    if (mismatches.length > 0) {
      const detail = mismatches
        .map((m) => {
          const parts: string[] = [];
          if (m.enOnly.length > 0)
            parts.push(`en only: {${m.enOnly.join("}, {")}}`);
          if (m.jaOnly.length > 0)
            parts.push(`ja only: {${m.jaOnly.join("}, {")}}`);
          return `  ${m.key}: ${parts.join(" / ")}`;
        })
        .join("\n");
      expect.fail(
        `Placeholder mismatch in ${mismatches.length} key(s):\n${detail}`,
      );
    }
  });
});

// --- 静的走査: 孤立キー / 未定義参照キーの検出 -----------------------------
//
// `import.meta.glob` + `?raw` でソース全文を文字列として取り込む
// (ipcCommandParity.test.ts と同じ方針。Node の `fs` に依存せず、tsc の型
// チェックでも追加の型定義が要らない)。i18n.ts 自身 (キー定義そのもの) と
// テストファイル群は「参照」としてカウントしない。
const sourceModules = import.meta.glob("../**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const usageSources = Object.entries(sourceModules).filter(
  ([path]) => !path.endsWith("/i18n.ts") && !path.includes("/__tests__/"),
);

// 通常は `t("someKey")` のようなクォート済みリテラル、または
// `Record<X, I18nKey> = { a: "someKey" }` のようなオブジェクトリテラルの値と
// してキー名が現れる。クォートの種類 (`"` / `'` / バッククォート) は開閉が
// 一致するものだけを対象にする。
const QUOTED_IDENT_RE = /(["'`])([A-Za-z][A-Za-z0-9_]*)\1/g;

// 唯一の例外: `ResultGrid.tsx` の `t(\`gridPalette_${p.key}\` as ...)` は
// テンプレートリテラルでキーを動的合成する。`t(` の直後に続くバッククォート +
// 静的プレフィックス + `${` という形を検出し、そのプレフィックスで始まる
// キーはすべて「参照あり」とみなす。新しい動的合成パターンを追加した場合は
// ここに追記すること。
const DYNAMIC_KEY_PREFIX_RE = /\bt\(\s*`([A-Za-z][A-Za-z0-9_]*)\$\{/g;

// `t(` の直後に置かれたクォート済みリテラルのみを「参照試行」として拾う
// (孤立キー判定より狭いスコープ。存在しないキーへの参照を検出する)。
const T_CALL_LITERAL_RE = /\bt\(\s*(["'`])([A-Za-z][A-Za-z0-9_]*)\1/g;

function collectReferencedKeys(keys: ReadonlySet<string>): Set<string> {
  const referenced = new Set<string>();
  for (const [, content] of usageSources) {
    QUOTED_IDENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = QUOTED_IDENT_RE.exec(content)) !== null) {
      if (keys.has(m[2])) referenced.add(m[2]);
    }

    DYNAMIC_KEY_PREFIX_RE.lastIndex = 0;
    while ((m = DYNAMIC_KEY_PREFIX_RE.exec(content)) !== null) {
      const prefix = m[1];
      for (const k of keys) {
        if (k.startsWith(prefix)) referenced.add(k);
      }
    }
  }
  return referenced;
}

function collectAttemptedTKeys(): Set<string> {
  const attempted = new Set<string>();
  for (const [, content] of usageSources) {
    T_CALL_LITERAL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = T_CALL_LITERAL_RE.exec(content)) !== null) {
      attempted.add(m[2]);
    }
  }
  return attempted;
}

// 現時点で「どこからも参照されていない」ことを確認済みのキー。過去に使われて
// いた画面/機能が削除されたか、参照側がリファクタで別名になった際の取り残し
// と見られる。i18n.ts のキー定義自体はこのテスト追加 PR ではいじらない方針の
// ため (削除するかどうかはプロダクトオーナー判断)、既知の孤立キーとして許可
// リスト化し、"新たに" 孤立キーが増えたときだけ検出する。
const KNOWN_ORPHAN_KEYS = new Set<I18nKey>([
  "erDiagramNoSession",
  "gridFilterPlaceholder",
  "listConnect",
  "listConnecting",
  "listDbPasswordPlaceholder",
  "listDelete",
  "listEdit",
  "listEditConnection",
  "listEditTitle",
  "listEmpty",
  "listSshPassphrasePlaceholder",
  "maintenanceFailed",
  "maintenanceMenu",
  "maintenanceReadOnlyTitle",
  "reconnectDetected",
  "statusApplyEditsError",
  "statusRowsIn",
  "treeNotConnected",
]);

describe("i18n キー参照の静的走査 (#665)", () => {
  const { en } = dictionaries;
  const keys = new Set(Object.keys(en));

  it("十分な数のソースファイルを走査できている (抽出ロジックの保険)", () => {
    expect(usageSources.length).toBeGreaterThan(20);
  });

  it("許可リストの各キーは辞書に実在する (陳腐化検出)", () => {
    const stale = [...KNOWN_ORPHAN_KEYS].filter((k) => !keys.has(k)).sort();
    expect(stale, `辞書から既に削除された許可リスト項目: ${stale.join(", ")}`).toEqual(
      [],
    );
  });

  it("許可リスト外に新規の孤立キー (どこからも参照されないキー) が無い", () => {
    const referenced = collectReferencedKeys(keys);
    const orphans = [...keys].filter((k) => !referenced.has(k));
    const unexpected = orphans
      .filter((k) => !KNOWN_ORPHAN_KEYS.has(k as I18nKey))
      .sort();
    expect(
      unexpected,
      `新規の孤立キー (KNOWN_ORPHAN_KEYS に追記するか、参照漏れを直す): ${unexpected.join(", ")}`,
    ).toEqual([]);
  });

  it("t(...) の呼び出しがすべて辞書に実在するキーを参照している", () => {
    const attempted = collectAttemptedTKeys();
    const undefinedRefs = [...attempted].filter((k) => !keys.has(k)).sort();
    expect(
      undefinedRefs,
      `辞書に存在しないキーへの参照 (typo の疑い): ${undefinedRefs.join(", ")}`,
    ).toEqual([]);
  });
});
