import { describe, expect, it } from "vitest";
import type { I18nKey } from "../i18n";
import { dictionaries } from "../i18n";

function extractTokens(s: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of s.matchAll(/\{(\w+)\}/g)) {
    tokens.add(m[1]);
  }
  return tokens;
}

describe("i18n placeholder consistency (en ↔ ja)", () => {
  it("every key has matching {token} sets in en and ja", () => {
    const { en, ja } = dictionaries;
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
