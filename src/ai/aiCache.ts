// AI の生成物 (テストデータの計画・スキーマドキュメントの節) を、接続プロファイル単位で
// 再利用するための小さなローカルキャッシュ (#1620)。保存先はブラウザの localStorage
// (他の画面の永続化と同じ) で、**秘密情報は入れない**: 入るのは AI の応答本文と、
// スキーマの指紋 (ハッシュ) だけ。API キー・パスワード・行データは扱わない。
// 読み書きは必ず try/catch で包み、使えない環境 (プライベートウィンドウなど) でも
// 画面が壊れないよう「キャッシュなし」として振る舞う。

const PREFIX = "noobdb.aiCache.v1:";
const INDEX_KEY = `${PREFIX}index`;
/** 1 エントリの上限 (文字数)。これを超える生成物は保存しない。 */
export const AI_CACHE_MAX_ENTRY_CHARS = 1_500_000;
/** 保持するエントリ数の上限。超えたら最後に使ったのが古いものから捨てる。 */
export const AI_CACHE_MAX_ENTRIES = 40;

export type AiCacheNamespace = "schemaDoc" | "testDataPlan";

interface IndexEntry {
  /** localStorage のキー。 */
  k: string;
  /** 最後に使った時刻 (ms)。 */
  at: number;
}

/** 非暗号の 53bit ハッシュ (cyrb53)。指紋の比較用で、衝突耐性や予測不能性は求めない。 */
export function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** キャッシュのキー。プロファイル ID・データベース・対象 (テーブルなど) ごとに別エントリ。 */
export function aiCacheKey(ns: AiCacheNamespace, profileId: string, ...parts: string[]): string {
  return `${PREFIX}${ns}:${[profileId, ...parts].map(encodeURIComponent).join(":")}`;
}

function readIndex(): IndexEntry[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is IndexEntry =>
        !!e &&
        typeof e === "object" &&
        typeof (e as IndexEntry).k === "string" &&
        typeof (e as IndexEntry).at === "number",
    );
  } catch {
    return [];
  }
}

function writeIndex(entries: IndexEntry[]): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(entries));
  } catch {
    /* 索引が書けなくても本体の読み書きは続ける */
  }
}

/** 保存済みの値を読む。無い・壊れている・`validate` を通らないときは `null`。 */
export function loadAiCache<T>(key: string, validate: (v: unknown) => v is T): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (!validate(value)) return null;
    // 使ったことを索引へ記録する (LRU)。
    const index = readIndex().filter((e) => e.k !== key);
    index.push({ k: key, at: Date.now() });
    writeIndex(index);
    return value;
  } catch {
    return null;
  }
}

/** 値を保存する。大きすぎる・容量超過などで保存できなければ `false` (画面は続行できる)。 */
export function saveAiCache(key: string, value: unknown): boolean {
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch {
    return false;
  }
  if (raw.length > AI_CACHE_MAX_ENTRY_CHARS) return false;
  const attempt = (): boolean => {
    try {
      localStorage.setItem(key, raw);
      return true;
    } catch {
      return false;
    }
  };
  let index = readIndex().filter((e) => e.k !== key);
  // 上限を超える分は、古い順に捨ててから書く。
  while (index.length >= AI_CACHE_MAX_ENTRIES) {
    const oldest = index.shift();
    if (oldest) removeQuietly(oldest.k);
  }
  let ok = attempt();
  // 容量超過のときは、古いものから捨てて 1 エントリずつ空けながら再試行する。
  while (!ok && index.length > 0) {
    const oldest = index.shift();
    if (oldest) removeQuietly(oldest.k);
    ok = attempt();
  }
  if (ok) index = [...index, { k: key, at: Date.now() }];
  writeIndex(index);
  return ok;
}

function removeQuietly(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 無視 */
  }
}

/** 1 エントリを消す。 */
export function removeAiCache(key: string): void {
  removeQuietly(key);
  writeIndex(readIndex().filter((e) => e.k !== key));
}
