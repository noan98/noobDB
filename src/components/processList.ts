import type { ProcessInfo } from "../api/tauri";
import type { LiveField } from "./liveDiff";

/** 値変化フラッシュ (#1022) の対象列。 */
export type ProcessLiveField = "command" | "state" | "time" | "query";

/**
 * プロセス一覧で「前回ポーリングから変化した」とみなす列の判定 (#1022)。
 *
 * 経過時間 (`time`) は実行中の文なら毎ティック単調に増えるのが正常で、それを
 * 毎回光らせると列全体が点滅し続けて何も読み取れない。そこで**巻き戻った
 * (= 同じ接続で新しい文が始まった)** ときと、報告の有無が切り替わったときだけ
 * 変化とみなす。単調な増加は `CountUp` の数値補間で「進んでいる」ことを示す。
 */
export const PROCESS_LIVE_FIELDS: readonly LiveField<ProcessInfo, ProcessLiveField>[] = [
  { name: "command", changed: (a, b) => (a.command ?? null) !== (b.command ?? null) },
  { name: "state", changed: (a, b) => (a.state ?? null) !== (b.state ?? null) },
  {
    name: "time",
    changed: (a, b) => {
      const before = a.time_secs ?? null;
      const after = b.time_secs ?? null;
      if (before === null || after === null) return before !== after;
      return after < before;
    },
  },
  // 要約 (200 文字まで) の変化で判定する。要約より後ろだけが変わる更新は光らないが、
  // 一覧は全文を運ばない設計 (#1259) の許容範囲。
  {
    name: "query",
    changed: (a, b) => (a.query_summary ?? null) !== (b.query_summary ?? null),
  },
];

/** プロセス行の安定 key (#1022)。ポーリング間で同じ接続は同じ key を保つ。 */
export function processKey(p: ProcessInfo): number {
  return p.id;
}

/**
 * プロセスモニタパネルの純ロジック。レンダリングから切り離してユニットテスト
 * できるよう、`erDiagram.ts` と同じ方針で分離している。
 */

/**
 * 経過秒の人間向け表示。`null` (エンジンが報告しない) は "–"。
 * 60 秒未満は "37s"、1 時間未満は "2m 05s"、それ以上は "3h 04m"。
 */
export function formatProcessTime(secs: number | null): string {
  if (secs == null || secs < 0) return "–";
  if (secs < 60) return `${secs}s`;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (secs < 3600) {
    return `${Math.floor(secs / 60)}m ${pad(secs % 60)}s`;
  }
  return `${Math.floor(secs / 3600)}h ${pad(Math.floor((secs % 3600) / 60))}m`;
}

/**
 * 再取得後のプロセス一覧に存在する id だけを選択に残す。kill や自然終了で
 * 消えたプロセスの選択を持ち越すと、次の kill が別プロセス (id 再利用) を
 * 巻き込みかねないため、リフレッシュごとに必ず刈り込む。
 */
export function pruneSelection(
  selected: ReadonlySet<number>,
  processes: ProcessInfo[],
): Set<number> {
  const alive = new Set(processes.map((p) => p.id));
  const next = new Set<number>();
  for (const id of selected) {
    if (alive.has(id)) next.add(id);
  }
  return next;
}

/** 待機ツリーを平らに並べた 1 行 (#1417)。 */
export interface BlockingTreeRow {
  process: ProcessInfo;
  /** 根 (他を待たせているが自分は待っていない) を 0 とする深さ。 */
  depth: number;
  /** 待機チェーンの根か。デッドロックなど根が無い循環では、循環の先頭を根として扱う。 */
  isRoot: boolean;
  /**
   * 既に別の場所 (または祖先) で展開済みのプロセスへの参照行。複数のブロッカーに待たされる
   * プロセスや循環 (デッドロック) で現れ、子は展開しない (無限再帰・爆発の防止)。
   */
  repeated: boolean;
  /** このプロセスが (直接・間接に) 待たせているプロセスの数 (重複なし)。参照行は 0。 */
  victims: number;
}

/**
 * `blocked_by` 関係から待機チェーンのツリーを作り、表示順 (深さ優先) の平らな行にする (#1417)。
 *
 * - 一覧に存在しない id・自己参照のブロッカーは無視する。
 * - 他を待たせている or 待たされているプロセスだけが対象 (無関係なプロセスは含まない)。
 * - 根 = 待たされておらず、他を待たせているプロセス。根から辿れない循環 (デッドロック) は、
 *   一覧順で最初のメンバーを根として拾う。
 * - 各プロセスは 1 回だけ展開し、2 回目以降 (複数ブロッカー・循環) は `repeated` の参照行にする。
 */
export function buildBlockingTree(processes: readonly ProcessInfo[]): BlockingTreeRow[] {
  const byId = new Map<number, ProcessInfo>();
  for (const p of processes) if (!byId.has(p.id)) byId.set(p.id, p);

  const blockersOf = new Map<number, number[]>();
  const waitersOf = new Map<number, number[]>();
  for (const p of byId.values()) {
    const valid: number[] = [];
    for (const b of p.blocked_by ?? []) {
      if (b === p.id || !byId.has(b) || valid.includes(b)) continue;
      valid.push(b);
      const list = waitersOf.get(b);
      if (list) list.push(p.id);
      else waitersOf.set(b, [p.id]);
    }
    blockersOf.set(p.id, valid);
  }

  const rows: BlockingTreeRow[] = [];
  const expanded = new Set<number>();

  const victimCount = (id: number): number => {
    const seen = new Set<number>();
    const stack = [...(waitersOf.get(id) ?? [])];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === undefined || cur === id || seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(waitersOf.get(cur) ?? []));
    }
    return seen.size;
  };

  const visit = (id: number, depth: number, isRoot: boolean) => {
    const process = byId.get(id);
    if (!process) return;
    if (expanded.has(id)) {
      rows.push({ process, depth, isRoot: false, repeated: true, victims: 0 });
      return;
    }
    expanded.add(id);
    rows.push({ process, depth, isRoot, repeated: false, victims: victimCount(id) });
    for (const child of waitersOf.get(id) ?? []) visit(child, depth + 1, false);
  };

  const participants = [...byId.values()].filter(
    (p) => (blockersOf.get(p.id)?.length ?? 0) > 0 || (waitersOf.get(p.id)?.length ?? 0) > 0,
  );
  for (const p of participants) {
    if ((blockersOf.get(p.id)?.length ?? 0) === 0) visit(p.id, 0, true);
  }
  // 根から辿れなかった循環 (デッドロック) を拾う。
  for (const p of participants) {
    if (!expanded.has(p.id)) visit(p.id, 0, true);
  }
  return rows;
}
