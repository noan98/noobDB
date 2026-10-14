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
export function pruneSelection(selected: ReadonlySet<number>, processes: ProcessInfo[]): Set<number> {
  const alive = new Set(processes.map((p) => p.id));
  const next = new Set<number>();
  for (const id of selected) {
    if (alive.has(id)) next.add(id);
  }
  return next;
}

/** pid 再利用の検知に使う同一性キー (id 以外の、プロセスの生存中は変わらない属性)。 */
const processIdentity = (p: ProcessInfo) => `${p.user ?? ""}\u0000${p.host ?? ""}\u0000${p.database ?? ""}`;

/**
 * KILL 確認ダイアログの表示時点のスナップショット (`shown`) と、確定直前に取り直した一覧
 * (`fresh`) を突き合わせ、まだ同じプロセスだと言える id だけを返す。確認中に対象が終了して
 * 同じ id (PostgreSQL の pid など) が別接続に再利用されても、無関係な接続を kill しない。
 * fail-closed: 一覧から消えた id、スナップショットに無かった id、user / host / database が
 * 変わった id は `dropped` に入れて kill 対象から外す。
 */
export function reconcileKillTargets(
  ids: readonly number[],
  shown: readonly ProcessInfo[],
  fresh: readonly ProcessInfo[],
): { keep: number[]; dropped: number[] } {
  const before = new Map(shown.map((p) => [p.id, processIdentity(p)]));
  const after = new Map(fresh.map((p) => [p.id, processIdentity(p)]));
  const keep: number[] = [];
  const dropped: number[] = [];
  for (const id of ids) {
    const b = before.get(id);
    if (b !== undefined && b === after.get(id)) keep.push(id);
    else dropped.push(id);
  }
  return { keep, dropped };
}

/** 待機ツリーを平らに並べた 1 行 (#1417)。 */
export interface BlockingTreeRow {
  /** 外部ブロッカー (`external`) のときは id 以外が空のスタブ。 */
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
  /** 一覧に無いプロセスがブロッカーとして報告された根 (権限・取得タイミングの差)。kill 不可。 */
  external: boolean;
  /** 根から辿れない循環 (デッドロック / 循環待ち) の先頭として拾った根。 */
  deadlock: boolean;
}

/**
 * `blocked_by` 関係から待機チェーンのツリーを作り、表示順 (深さ優先) の平らな行にする (#1417)。
 *
 * - 自己参照のブロッカーは無視する。一覧に存在しないブロッカーは「一覧外のブロッカー」として
 *   kill 不可の根ノードにし、待たされているプロセスが消えないようにする。
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
  const externalIds: number[] = [];
  for (const p of byId.values()) {
    const valid: number[] = [];
    for (const b of p.blocked_by ?? []) {
      if (b === p.id || valid.includes(b)) continue;
      valid.push(b);
      if (!byId.has(b) && !externalIds.includes(b)) externalIds.push(b);
      const list = waitersOf.get(b);
      if (list) list.push(p.id);
      else waitersOf.set(b, [p.id]);
    }
    blockersOf.set(p.id, valid);
  }

  const externalStub = (id: number): ProcessInfo => ({
    id,
    user: null,
    host: null,
    database: null,
    command: null,
    state: null,
    time_secs: null,
    query_summary: null,
    query_truncated: false,
    is_self: false,
    blocked_by: [],
  });

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

  const visit = (id: number, depth: number, isRoot: boolean, deadlock = false) => {
    const known = byId.get(id);
    const process = known ?? externalStub(id);
    const external = !known;
    if (expanded.has(id)) {
      rows.push({
        process,
        depth,
        isRoot: false,
        repeated: true,
        victims: 0,
        external,
        deadlock: false,
      });
      return;
    }
    expanded.add(id);
    rows.push({
      process,
      depth,
      isRoot,
      repeated: false,
      victims: victimCount(id),
      external,
      deadlock,
    });
    for (const child of waitersOf.get(id) ?? []) visit(child, depth + 1, false);
  };

  const participants = [...byId.values()].filter(
    (p) => (blockersOf.get(p.id)?.length ?? 0) > 0 || (waitersOf.get(p.id)?.length ?? 0) > 0,
  );
  for (const p of participants) {
    if ((blockersOf.get(p.id)?.length ?? 0) === 0) visit(p.id, 0, true);
  }
  for (const id of externalIds) visit(id, 0, true);
  // 根から辿れなかった循環 (デッドロック) を拾う。
  for (const p of participants) {
    if (!expanded.has(p.id)) visit(p.id, 0, true, true);
  }
  return rows;
}

/** プロセス一覧の絞り込み条件 (#1538)。空文字 / 0 は「条件なし」。 */
export interface ProcessFilter {
  /** id・ユーザ・ホスト・DB・状態・クエリ要約を大文字小文字無視で部分一致検索する。 */
  text: string;
  /** ユーザ名の完全一致。 */
  user: string;
  /** データベース名の完全一致。 */
  database: string;
  /** `command` (粗い活動状態) の完全一致。 */
  command: string;
  /** 経過秒がこの値以上のものだけ残す。経過秒が不明 (null) のプロセスは条件ありのとき除外。 */
  minSecs: number;
}

export const EMPTY_PROCESS_FILTER: ProcessFilter = {
  text: "",
  user: "",
  database: "",
  command: "",
  minSecs: 0,
};

/** 絞り込み条件が 1 つでも有効か。 */
export function isProcessFilterActive(f: ProcessFilter): boolean {
  return f.text.trim() !== "" || f.user !== "" || f.database !== "" || f.command !== "" || f.minSecs > 0;
}

/**
 * 一覧を絞り込む (#1538)。描画上限 (`PROCESS_RENDER_LIMIT`) で切る**前**に適用するための
 * 純関数で、501 件目以降のプロセスも条件に合えば先頭側に現れる。条件なしなら入力をそのまま返す。
 */
export function filterProcesses(rows: readonly ProcessInfo[], filter: ProcessFilter): readonly ProcessInfo[] {
  if (!isProcessFilterActive(filter)) return rows;
  const needle = filter.text.trim().toLowerCase();
  return rows.filter((p) => {
    if (filter.user !== "" && (p.user ?? "") !== filter.user) return false;
    if (filter.database !== "" && (p.database ?? "") !== filter.database) return false;
    if (filter.command !== "" && (p.command ?? "") !== filter.command) return false;
    if (filter.minSecs > 0 && (p.time_secs == null || p.time_secs < filter.minSecs)) return false;
    if (needle !== "") {
      const hay = [p.id, p.user, p.host, p.database, p.command, p.state, p.query_summary]
        .filter((v) => v != null)
        .join("\n")
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/** 並べ替えキー。`default` はサーバが返した順のまま。 */
export type ProcessSortKey = "default" | "timeDesc" | "timeAsc" | "id";

/**
 * 一覧を並べ替える (#1538)。入力は変更しない。経過秒が不明 (null / 負) のプロセスは
 * 昇順・降順どちらでも末尾に置く (長時間クエリ探しで不明が先頭を占めないように)。
 * 同値は id 昇順で安定させる。
 */
export function sortProcesses(rows: readonly ProcessInfo[], key: ProcessSortKey): readonly ProcessInfo[] {
  if (key === "default") return rows;
  const copy = [...rows];
  if (key === "id") return copy.sort((a, b) => a.id - b.id);
  const known = (p: ProcessInfo) => p.time_secs != null && p.time_secs >= 0;
  const dir = key === "timeDesc" ? -1 : 1;
  return copy.sort((a, b) => {
    const ka = known(a);
    const kb = known(b);
    if (ka !== kb) return ka ? -1 : 1;
    if (ka && kb) {
      const d = (a.time_secs as number) - (b.time_secs as number);
      if (d !== 0) return d * dir;
    }
    return a.id - b.id;
  });
}

/** 絞り込みの選択肢用に、列の値を重複なし・昇順で集める。null / 空は含めない。 */
export function distinctProcessValues(
  rows: readonly ProcessInfo[],
  field: "user" | "database" | "command",
): string[] {
  const set = new Set<string>();
  for (const p of rows) {
    const v = p[field];
    if (v != null && v !== "") set.add(v);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** 経過秒の絞り込みプリセット (秒)。0 は「条件なし」。 */
export const PROCESS_MIN_SECS_OPTIONS: readonly number[] = [0, 1, 10, 60, 300, 3600];
