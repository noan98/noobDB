/**
 * 結果グリッドのセル値を「表示用」に整形する純ロジック。
 *
 * **重要: ここで生成するのは表示専用の文字列**であり、インライン編集・コピー・
 * エクスポートでは常に元の値 (`String(rawValue)`) を使う。整形と実値を厳密に分離
 * することで、見やすさを上げつつ編集の安全性 (`cellEdit.ts`) を損なわない。
 *
 * すべて副作用のない純関数として切り出し、`src/__tests__/cellFormat.test.ts` で
 * 単体テストする (CLAUDE.md の「安全性に直結する純ロジックをテストする」方針)。
 * グリッドは仮想化されており可視セルのみ描画されるため per-cell の処理は軽量だが、
 * いずれの関数も判定に失敗したら `null` を返し、呼び出し側が素の値へフォールバック
 * できるようにしている。
 */

/**
 * JSON 文字列を 1 行のコンパクト表現に正規化する (グリッド内のインライン表示用)。
 * `{` または `[` で始まり、かつ `JSON.parse` できる場合のみ整形し、空白を畳んだ
 * 最小表現を返す。JSON でなければ `null`。
 */
export function formatJsonCompact(s: string): string | null {
  const trimmed = s.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

// DATE / DATETIME / TIMESTAMP がドライバから返す代表的な文字列形を捕捉する。
// 日付部は必須、時刻部は任意。末尾のタイムゾーン指定 (Z / ±HH:MM) は受理するが
// **数値はそのまま (壁時計として) 表示** し、ローカルタイムへの変換は行わない
// (予期しない時刻ずれでユーザを誤認させないため)。
const DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/**
 * SQL の日付/時刻文字列をロケールに応じた読みやすい表現へ整形する。表示専用で、
 * 元の値はコピー/編集時に保持する前提 (呼び出し側が `title` に原文を残す)。
 *
 * タイムゾーン変換は意図的に行わない: 文字列中の年月日時分秒をそのまま UTC として
 * 組み立て、`Intl.DateTimeFormat` も `timeZone: "UTC"` で整形する。これにより
 * ローカルタイムへのずれを起こさず、月名や区切り順だけがロケールに従う。
 *
 * 解析できない (または暦として不正な) 文字列では `null` を返し、素の値へフォール
 * バックさせる。
 */
export function formatDateTimeDisplay(s: string, locale: string): string | null {
  const m = DATE_RE.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hasTime = h !== undefined;
  const hour = hasTime ? Number(h) : 0;
  const minute = hasTime ? Number(mi) : 0;
  const second = se !== undefined ? Number(se) : 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // ロールオーバー (例: 2 月 31 日) を弾く: 構築後に各要素が一致するか検証する。
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  try {
    const opts: Intl.DateTimeFormatOptions = hasTime
      ? {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
          timeZone: "UTC",
        }
      : { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" };
    return new Intl.DateTimeFormat(locale, opts).format(date);
  } catch {
    return null;
  }
}

/**
 * 列挙値 (ENUM/SET) を色分けバッジ表示する際の色相 (0–359)。同じ値には必ず同じ
 * 色を割り当てたいので、文字列から決定的なハッシュを取って色相に写像する。彩度/
 * 明度はテーマ側の CSS 変数で吸収するため、ここでは色相のみ算出する。
 */
export function enumBadgeHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}
