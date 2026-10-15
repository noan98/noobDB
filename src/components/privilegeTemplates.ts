/**
 * 権限テンプレートとパスワード生成、ロール / 列指定の入力解釈 (#1622)。
 * どれも副作用のない純関数で、ユーザ管理パネル (`UsersPanel`) から使う。テンプレートは
 * 権限マトリクスの編集状態を書き換えるだけで、実際の GRANT / REVOKE は従来の
 * 差分 SQL 生成 → 確認ダイアログ → 適用の経路に乗る。
 */

export interface PrivilegeFlagSet {
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  ddl: boolean;
}

export type PrivilegeTemplateId = "readOnly" | "appReadWrite" | "full" | "none";

export const PRIVILEGE_TEMPLATE_IDS: readonly PrivilegeTemplateId[] = [
  "readOnly",
  "appReadWrite",
  "full",
  "none",
];

const TEMPLATE_FLAGS: Record<PrivilegeTemplateId, PrivilegeFlagSet> = {
  // 読み取り専用: SELECT のみ。
  readOnly: { select: true, insert: false, update: false, delete: false, ddl: false },
  // アプリ用読み書き: DML 4 種。DDL (CREATE / ALTER / DROP など) は付けない。
  appReadWrite: { select: true, insert: true, update: true, delete: true, ddl: false },
  // 管理者相当: DML + DDL。
  full: { select: true, insert: true, update: true, delete: true, ddl: true },
  // すべて外す。
  none: { select: false, insert: false, update: false, delete: false, ddl: false },
};

/** テンプレートの権限フラグ (呼び出し側が書き換えても影響しないコピー)。 */
export function templateFlags(id: PrivilegeTemplateId): PrivilegeFlagSet {
  return { ...TEMPLATE_FLAGS[id] };
}

/**
 * 編集中のマトリクス `edited` の指定テーブルすべてへテンプレートを反映した新しいマップを返す。
 * `tables` に無い行は触らない。入力は書き換えない。
 */
export function applyPrivilegeTemplate(
  edited: Record<string, PrivilegeFlagSet>,
  tables: readonly string[],
  id: PrivilegeTemplateId,
): Record<string, PrivilegeFlagSet> {
  // プロトタイプ無し (表名が `constructor` などでも安全)。
  const out = Object.assign(Object.create(null) as Record<string, PrivilegeFlagSet>, edited);
  for (const table of tables) out[table] = templateFlags(id);
  return out;
}

const PW_LOWER = "abcdefghijkmnopqrstuvwxyz";
const PW_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PW_DIGIT = "23456789";
// 引用符・バックスラッシュ・空白は SQL リテラルやシェルでの取り回しが面倒なので含めない。
const PW_SYMBOL = "!#$%&*+-=?@^_";
export const GENERATED_PASSWORD_LENGTH = 24;

/** 暗号論的乱数で [0, max) の整数を返す (剰余バイアスを棄却法で避ける)。 */
function secureRandomInt(max: number): number {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  for (;;) {
    crypto.getRandomValues(buf);
    const v = buf[0] ?? 0;
    if (v < limit) return v % max;
  }
}

/**
 * 安全な乱数パスワードを生成する。小文字・大文字・数字・記号を最低 1 文字ずつ含み、
 * 紛らわしい文字 (`l` `I` `O` `0` `1`) と引用符・バックスラッシュは使わない。
 * `randomInt` はテスト用の差し替え口 (既定は `crypto.getRandomValues`)。
 */
export function generatePassword(
  length: number = GENERATED_PASSWORD_LENGTH,
  randomInt: (max: number) => number = secureRandomInt,
): string {
  const classes = [PW_LOWER, PW_UPPER, PW_DIGIT, PW_SYMBOL];
  const all = classes.join("");
  const n = Math.max(length, classes.length);
  const chars: string[] = classes.map((c) => c.charAt(randomInt(c.length)));
  while (chars.length < n) chars.push(all.charAt(randomInt(all.length)));
  // Fisher-Yates でシャッフルし、先頭 4 文字が必ず各クラスになる偏りを消す。
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = chars[i] as string;
    chars[i] = chars[j] as string;
    chars[j] = tmp;
  }
  return chars.join("");
}

/**
 * ロール入力 (`role` / MySQL の `role@host`) を名前とホストに分ける。MySQL のロール名に `@` は
 * 入らないので最後の `@` で分割してよい。空は null。ホスト省略時は host = null (= `%`)、`role@` は空ホスト ("")。
 */
export function parseRoleInput(input: string): { role: string; host: string | null } | null {
  const s = input.trim();
  if (!s) return null;
  const at = s.lastIndexOf("@");
  if (at <= 0) return { role: s, host: null };
  const role = s.slice(0, at).trim();
  const host = s.slice(at + 1).trim();
  if (!role) return null;
  // `role@` の空ホストは `%` とは別のアカウント (`role`@`''`)。MySQL の member_of が空ホストを
  // `role@` で返すので、そのまま剥奪対象に渡せるよう空文字を保つ。
  return { role, host: at === s.length - 1 ? "" : host || null };
}

/** カンマ / 改行区切りの列入力を、空要素と重複を除いた列名配列にする (順序は入力順)。 */
export function parseColumnList(input: string): string[] {
  const out: string[] = [];
  for (const part of input.split(/[,\n]/)) {
    const c = part.trim();
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}
