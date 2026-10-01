import { matchesQuery } from "./sectionNav";

/** 検索対象にする、解決済み (翻訳済み) のカード 1 枚分のテキスト。 */
export interface HelpFeatureTexts {
  title: string;
  desc: string;
  steps?: string[];
  note?: string;
}

export interface HelpSectionTexts<F> {
  header: string;
  desc: string;
  features: F[];
}

/**
 * ヘルプのカード絞り込み (#1273)。節の見出し・説明に一致したら節内の全カードを残し、
 * そうでなければカードのタイトル・説明・手順・注記のいずれかに一致するものだけ残す。
 * カードが 0 件になった節は取り除く。空クエリでは入力をそのまま (新しい配列で) 返す。
 */
export function filterHelpSections<F, S extends HelpSectionTexts<F>>(
  sections: readonly S[],
  query: string,
  textsOf: (feature: F) => HelpFeatureTexts,
): S[] {
  if (query.trim() === "") return [...sections];
  const out: S[] = [];
  for (const sec of sections) {
    if (matchesQuery(query, sec.header, sec.desc)) {
      out.push(sec);
      continue;
    }
    const features = sec.features.filter((f) => {
      const x = textsOf(f);
      return matchesQuery(query, x.title, x.desc, x.note, ...(x.steps ?? []));
    });
    if (features.length > 0) out.push({ ...sec, features });
  }
  return out;
}
