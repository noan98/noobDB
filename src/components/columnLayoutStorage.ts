// 結果形状ごとの表示設定 (列幅 colsizing / 列状態 colstate / ビュー gridview / プリセット gridpresets / フッター
// gridfooter) を localStorage に保存するときの共通処理。形状 (= colsizing キー) 単位の LRU で
// 件数を抑え、古い形状は 5 種のキーをまとめて削除する。容量超過で setItem が失敗したときも
// 古い形状を退避して再試行するので、増え続けた別キーのせいで保存が永続的に止まらない。

const COL_SIZING_LRU_KEY = "noobdb.colsizing.lru.v1";
const COL_SIZING_MAX_ENTRIES = 50;

const SIZING_PREFIX = "noobdb.colsizing.v1";
const SIBLING_PREFIXES = [
  "noobdb.colstate.v1",
  "noobdb.gridview.v1",
  "noobdb.gridfooter.v1",
  "noobdb.gridpresets.v1",
];

function readLruOrder(): string[] {
  try {
    const raw = localStorage.getItem(COL_SIZING_LRU_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as string[];
    }
  } catch {
    // ignore
  }
  return [];
}

function writeLruOrder(order: string[]): void {
  try {
    localStorage.setItem(COL_SIZING_LRU_KEY, JSON.stringify(order));
  } catch {
    // ignore
  }
}

/** 1 つの結果形状 (列サイジングキー) に紐づく保存キー一式。 */
function layoutKeysOf(sizingKey: string): string[] {
  return [sizingKey, ...SIBLING_PREFIXES.map((p) => sizingKey.replace(SIZING_PREFIX, p))];
}

function removeLayoutKeys(sizingKey: string): void {
  for (const k of layoutKeysOf(sizingKey)) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 結果形状 `sizingKey` を LRU の先頭へ移し、上限を超えた古い形状の保存キーを削除する。
 * 書き込みの**前**に呼ぶので、容量超過で setItem が失敗する状況でも退避が走る。
 */
export function touchColumnLayoutLru(sizingKey: string, maxEntries = COL_SIZING_MAX_ENTRIES): void {
  const order = readLruOrder().filter((k) => k !== sizingKey);
  order.unshift(sizingKey);
  if (order.length > maxEntries) {
    for (const k of order.splice(maxEntries)) removeLayoutKeys(k);
  }
  writeLruOrder(order);
}

/** colstate / gridview / gridfooter のキーから形状の colsizing キーを導いて LRU を更新する。 */
export function touchLayoutLruForKey(key: string): void {
  for (const p of SIBLING_PREFIXES) {
    if (key.includes(p)) {
      touchColumnLayoutLru(key.replace(p, SIZING_PREFIX));
      return;
    }
  }
  if (key.includes(SIZING_PREFIX)) touchColumnLayoutLru(key);
}

/** setItem が容量超過で失敗したとき、古い形状から 1/4 を退避して 1 回だけ再試行する。 */
export function setItemWithEviction(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
    return;
  } catch {
    // fall through: 容量超過の可能性。古い形状を退避して再試行する。
  }
  try {
    const order = readLruOrder();
    const keep = Math.max(1, Math.floor(order.length * 0.75));
    for (const k of order.splice(keep)) removeLayoutKeys(k);
    writeLruOrder(order);
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}
