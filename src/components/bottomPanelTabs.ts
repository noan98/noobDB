/**
 * ボトムパネル (#1112 / Epic #1110 Phase 2) の純ロジック。副作用なし
 * (DOM / localStorage に触れない) なので Vitest で単体テストできる。
 *
 * ## なぜボトムパネルを置くのか
 *
 * #1112 以前、アドバイザ・クエリインスペクタ・プロセスモニタは **`<main>` を丸ごと
 * 置き換える全画面サーフェス**だった。つまり「アドバイザの指摘を見ながら SQL を直す」
 * 「実行中のクエリを見ながら次を書く」ができず、参照のたびに作業画面が消えていた。
 *
 * これらは **継続的に参照する情報** なので、Epic の狙い (SQL Editor → Result Grid を
 * 主役にする) に従ってワークスペースの下に並べる。逆に ER 図・スキーマ比較・ユーザ
 * 管理・結果比較は「広い面積を占有して、それ自体が作業対象になる」ため全画面のまま。
 * この線引きは `.claude/rules/ui-design-system.md` の §7.1 に記述している。
 */

/**
 * ボトムパネルに並ぶタブ。表示順もこの配列の順で、**用途のグループごとに並べる**
 * (#1114)。グループの切れ目はタブバーに区切り線として出る (`BOTTOM_PANEL_TAB_GROUP`)。
 *
 * 1. **ログ** (`output` / `messages` / `activity`) — このセッションで何が起きたか。
 *    接続の有無に関係なく開ける (接続失敗のメッセージこそ未接続時に読みたい)。
 *    - 出力: 実行した文ごとの結末 (件数・所要時間・エラー本文)。`outputLog.ts`
 *    - メッセージ: ステータスバーに出た文の履歴 (最新 1 件しか出ないため)。`messageLog.ts`
 *    - アクティビティ: トーストの履歴 (ベルのポップオーバーと同じストア)。`activityLog.ts`
 * 2. **診断** (`advisor` / `inspector` / `processes` / `assertions` / `health`) —
 *    DB とサーバの状態・改善提案・データ品質の検証。
 * 3. **参照** (`whereUsed` / `structure` / `profile`) — 選んだオブジェクトの詳細。
 *
 * `whereUsed` (影響分析、#1027) は「DROP / RENAME の前に参照元を確かめながら
 * DDL を書く」ための参照情報なので、全画面ではなくここに置く。対象のデータベースは
 * パネル内のフォームで決める (スキーマツリーの右クリックから開くと埋まった状態で
 * 始まる) ため、開ける条件は接続中であることだけ。
 *
 * `structure` (テーブル構造、#1112) は Database Explorer でテーブルを選んだあと
 * 「データ」と並ぶもう一方の行き先。列・インデックス・外部キーを見ながら SQL を
 * 書くための参照情報なので、全画面ではなくここに置く。
 *
 * `timelapse` (テーブル・タイムラプス、#739) はウォッチ登録したテーブルの世代間の
 * 行差分。「さっきの変更で何が変わったか」を見ながら SQL を書くための参照情報なので
 * ここに置く。ウォッチはプロファイル単位で保存するため、保存済みプロファイルで
 * 接続しているときだけ開ける。
 * `assertions` (データ品質アサーション、#742) は「検証結果を見ながら違反行を SQL で
 * 追う」ための診断情報なので、ここ (診断グループ) に置く。検証するデータベースはアクティブタブ →
 * プロファイル既定の順で決まり (未決定ならセッションの既定)、開ける条件は接続中で
 * あることだけ。追加・編集は `AssertionEditorModal` (一時的な操作 = Modal)。
 */
export const BOTTOM_PANEL_TABS = [
  "output",
  "messages",
  "activity",
  "advisor",
  "inspector",
  "processes",
  "assertions",
  "health",
  "whereUsed",
  "structure",
  "profile",
  "timelapse",
] as const;

export type BottomPanelTab = (typeof BOTTOM_PANEL_TABS)[number];

/** タブの用途グループ (表示順は `BOTTOM_PANEL_TABS` のまま)。 */
export type BottomPanelTabGroup = "log" | "diagnostics" | "reference";

export const BOTTOM_PANEL_TAB_GROUP: Record<BottomPanelTab, BottomPanelTabGroup> = {
  output: "log",
  messages: "log",
  activity: "log",
  advisor: "diagnostics",
  inspector: "diagnostics",
  processes: "diagnostics",
  assertions: "diagnostics",
  health: "diagnostics",
  whereUsed: "reference",
  structure: "reference",
  profile: "reference",
  timelapse: "reference",
};

/**
 * 与えられた並びで「直前のタブと別グループになる」タブ (= 手前に区切り線を
 * 引くタブ) を返す。先頭のタブは含めない (区切る相手が無い)。開けないタブが
 * 抜けた並びでも、実際に隣り合うタブ同士で判定する。
 */
export function bottomPanelGroupStarts(tabs: readonly BottomPanelTab[]): Set<BottomPanelTab> {
  const out = new Set<BottomPanelTab>();
  for (let i = 1; i < tabs.length; i++) {
    if (BOTTOM_PANEL_TAB_GROUP[tabs[i]] !== BOTTOM_PANEL_TAB_GROUP[tabs[i - 1]]) out.add(tabs[i]);
  }
  return out;
}

/** タブを開けるかどうかの判定材料。`App.tsx` の該当 state を写したもの。 */
export interface BottomPanelContext {
  /** アクティブな接続セッション。ログ系と `health` 以外のタブはこれを要求する。 */
  sessionId: string | null;
  /**
   * 開いている接続の本数 (アクティブ + 背景)。接続ヘルス (#1068) は接続横断の
   * 俯瞰なので、アクティブ接続が無くても背景接続が 1 本でもあれば開ける。
   */
  openConnectionCount: number;
  /**
   * アドバイザの対象データベース (アクティブタブ → プロファイル既定の順で解決済み)。
   * 診断はデータベース単位なので、これが無いとアドバイザだけ開けない。
   */
  advisorDatabase: string | null | undefined;
  /**
   * 「列を探索」(#974) の対象テーブル。サイドバーのテーブル / 結果グリッドの列から
   * 開いたときだけ決まり、決まっていなければプロファイルタブは開けない (対象の
   * 無い空パネルを作らない)。
   */
  profileTable?: string | null;
  /**
   * 構造タブ (#1112) の対象テーブル。ツリー / コマンドパレット / 外部キーの参照先
   * から決まり、決まっていなければ構造タブは開けない (空パネルを作らない)。
   */
  structureTable?: string | null;
  /**
   * テーブル・タイムラプス (#739) のウォッチ保存先プロファイル。アドホック接続
   * (プロファイル無し) ではウォッチを保存できないので開けない。
   */
  timelapseProfileId?: string | null;
  /**
   * アクティブ接続のドライバ。プロセスモニタとクエリインスペクタはサーバ統計を
   * 持たない SQLite では動かない (#732 / #746) ので、折りたたみ時のパネルバー
   * (`bottomPanelStripTabs`) はこれを見て「無効 + 理由」で並べる。
   * `availableBottomPanelTabs` の判定には使わない (開いたパネル側が非対応の説明を
   * 出すため、開けること自体は変えない)。`ConnectionProfile.driver` と同じ生の文字列。
   */
  driver?: string | null;
}

/** 与えられた文脈で実際に開けるタブ (表示順を保つ)。 */
export function availableBottomPanelTabs(ctx: BottomPanelContext): BottomPanelTab[] {
  return BOTTOM_PANEL_TABS.filter((tab) => {
    // ログ系は接続に依存しない (未接続時の接続失敗メッセージも読めるように)。
    if (BOTTOM_PANEL_TAB_GROUP[tab] === "log") return true;
    if (tab === "health") return !!ctx.sessionId || ctx.openConnectionCount > 0;
    if (!ctx.sessionId) return false;
    if (tab === "advisor") return !!ctx.advisorDatabase;
    if (tab === "profile") return !!ctx.profileTable;
    if (tab === "structure") return !!ctx.structureTable;
    if (tab === "timelapse") return !!ctx.timelapseProfileId;
    return true;
  });
}

/**
 * 開いているタブを文脈に合わせて解決する。切断したり、対象データベースが外れて
 * 開けなくなったタブは閉じる (`null`)。**描画側はこの関数の戻り値だけを見る**ことで、
 * 「state は advisor のままだが開けない」という宙ぶらりんな状態を作らない。
 */
export function resolveBottomPanelTab(
  tab: BottomPanelTab | null,
  ctx: BottomPanelContext,
): BottomPanelTab | null {
  if (!tab) return null;
  return availableBottomPanelTabs(ctx).includes(tab) ? tab : null;
}

/**
 * タブを選んだときの次状態。**開いているタブをもう一度選ぶと閉じる** (トグル) —
 * ツールメニューやコマンドパレットから同じ項目を続けて選んだときに、開きっぱなしに
 * ならず「行って戻る」ができる。`paneLayout.ts` の `toggleLayoutMode` と同じ流儀。
 */
export function toggleBottomPanelTab(
  current: BottomPanelTab | null,
  next: BottomPanelTab,
): BottomPanelTab | null {
  return current === next ? null : next;
}

/**
 * 矢印キーでのタブ移動先。端で折り返す (サイドバーのタブ移動と同じ挙動)。
 * `tabs` が空、または `current` が含まれないときは `null` を返し、呼び出し側は
 * フォーカス移動を行わない。
 */
export function nextBottomPanelTab(
  tabs: readonly BottomPanelTab[],
  current: BottomPanelTab,
  delta: 1 | -1,
): BottomPanelTab | null {
  const i = tabs.indexOf(current);
  if (i < 0 || tabs.length === 0) return null;
  return tabs[(i + delta + tabs.length) % tabs.length];
}

/**
 * 折りたたみ時のパネルバーに並ぶ 1 項目。`reason` は無効なときだけ入る
 * (ツールチップで「なぜ今は開けないか」を説明するため)。
 */
export interface BottomPanelStripEntry {
  tab: BottomPanelTab;
  enabled: boolean;
  reason: BottomPanelUnavailableReason | null;
}

/** パネルバーの項目が今は開けない理由。表示文言は呼び出し側 (i18n) が解決する。 */
export type BottomPanelUnavailableReason = "needsSession" | "needsDatabase" | "sqliteUnsupported";

/**
 * ボトムパネルを閉じているときに `<main>` の下端へ出すパネルバーの項目 (#1112 の
 * 導線改善)。
 *
 * ## なぜ「開けないタブ」も並べるのか
 *
 * パネルを閉じるとタブ列ごと消える設計だったため、プロセスモニタ・クエリインスペクタ・
 * アドバイザ・接続ヘルスといった本製品の中核機能の入口が、サイドバー右上のレンチ
 * アイコン (17 項目のフラットなメニュー) とコマンドパレットしか無かった。バーを常設
 * して **存在そのものを見せる** のが目的なので、ログ / 診断グループは接続の有無に
 * 関係なく並べ、今は開けない項目は無効化して理由をツールチップで示す
 * (「接続すればプロセスモニタが使える」と、接続前に分かる)。
 *
 * 参照グループ (影響分析・構造・列を探索・タイムラプス) は並べない。対象オブジェクトを
 * 決めて開くもの (ツリーの右クリック・コマンドパレット・外部キーの参照先) で、バーに
 * 出しても「何の構造か」が伝わらないうえ、1280px 幅で右端がはみ出す。
 */
export function bottomPanelStripTabs(ctx: BottomPanelContext): BottomPanelStripEntry[] {
  const available = new Set(availableBottomPanelTabs(ctx));
  const out: BottomPanelStripEntry[] = [];
  for (const tab of BOTTOM_PANEL_TABS) {
    if (BOTTOM_PANEL_TAB_GROUP[tab] === "reference") continue;
    // SQLite はサーバ統計を持たず、プロセス一覧 / クエリ統計を取れない (#732 / #746)。
    // 開けはするが中身が非対応表示になるだけなので、バーでは無効にして理由を示す。
    const sqliteUnsupported =
      ctx.driver === "sqlite" && (tab === "processes" || tab === "inspector");
    if (available.has(tab) && !sqliteUnsupported) {
      out.push({ tab, enabled: true, reason: null });
      continue;
    }
    const reason: BottomPanelUnavailableReason = sqliteUnsupported
      ? "sqliteUnsupported"
      : tab === "advisor" && ctx.sessionId
        ? "needsDatabase"
        : "needsSession";
    out.push({ tab, enabled: false, reason });
  }
  return out;
}
