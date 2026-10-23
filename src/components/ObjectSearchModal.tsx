import { chakra, Box, Flex } from "@chakra-ui/react";
import { motion, useReducedMotion } from "motion/react";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, type ObjectSearchHit, type ObjectSearchScope } from "../api/tauri";
import { useT } from "../i18n";
import { ActiveRowHighlight } from "./ActiveRowHighlight";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES, type IconName } from "./Icon";
import { NoResultsIllustration } from "./illustrations";
import { Modal } from "./Modal";
import { Segmented } from "./Segmented";
import { SkeletonSearchRows } from "./Skeleton";
import { shouldStaggerEntrance } from "./commandPaletteSearch";
import { staggerContainer, variants } from "../motion";
import { ErrorNote } from "./modalForm";
import { isImeComposing } from "./modalKeys";
import { formatRowEstimate } from "./rowEstimate";
import { scrollFollowIntoView } from "./scrollFollow";

/**
 * スキーマ横断のグローバルオブジェクト検索。テーブル・ビュー・ルーチン・トリガー名とカラム名を
 * 全 DB (またはカレント DB) 串刺しで部分一致検索し、選択で該当テーブルを開く (#1629:
 * 列ヒットは開いたテーブルのその列へ移動、ルーチン / トリガーは定義を開く。Shift+Enter /
 * Shift+クリックは新しいタブで開く)。既存コマンドパレット (Cmd/Ctrl+K) とは別キー
 * (Cmd/Ctrl+Shift+O) で起動する。
 *
 * 索引の構築・スコアリング・上位 N 件の抽出は Rust (`search_schema_objects`、#1261) が行い、
 * 全 DB 分の索引はバックエンドの Schema Cache に保持される。ここは入力状態 (デバウンス付きの
 * 検索要求)・キーボードナビ・描画のみを担う。開いた直後 (とスコープ切替時) は空クエリで
 * 要求して索引を先に作らせ (ウォームアップ)、その間は skeleton を出す。
 */
interface Props {
  sessionId: string;
  /** 既定スコープ (カレント DB)。null なら最初から全 DB を読む。 */
  currentDatabase: string | null;
  /**
   * テーブル / ビュー / 列ヒットを開く。通常は 2 引数。列ヒットでは `column`、Shift 操作では
   * `newTab` を第 3 引数で渡す。
   */
  onOpenTable: (database: string, table: string, opts?: { newTab?: boolean; column?: string }) => void;
  /** ルーチン / トリガーの定義を開く。省略時はこれらのヒットを開けない。 */
  onOpenObject?: (database: string, kind: string, name: string, id: string | null) => void;
  onClose: () => void;
}

type Scope = "current" | "all";

// CommandPalette と同じ stagger 語彙 (#1212)。`variants` を子へ伝播させるため forwardProps で通す。
const MotionListBox = chakra(motion.div, {}, { forwardProps: ["variants", "initial", "animate"] });
const MotionRow = chakra(motion.button, {}, { forwardProps: ["variants"] });

const RESULT_LIMIT = 300;

/** キー入力から検索要求を出すまでの待ち時間 (連打中は最後の入力だけを問い合わせる)。 */
const SEARCH_DEBOUNCE_MS = 120;

export function ObjectSearchModal({ sessionId, currentDatabase, onOpenTable, onOpenObject, onClose }: Props) {
  const t = useT();
  const reduced = useReducedMotion() ?? false;
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>(currentDatabase ? "current" : "all");
  const [results, setResults] = useState<ObjectSearchHit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // アクティブ行ハイライトの layoutId をモーダルごとに分ける (他の layoutId と衝突させない)。
  const highlightId = `object-search-active-highlight-${useId()}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  // 最後に発行した要求の番号。古い応答 (追い越された要求) は捨てる。
  const requestSeq = useRef(0);
  // results が対応している (query, scope)。入力が先へ進んだ後の古い結果で Enter が開かないようにする。
  const [resultsFor, setResultsFor] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // current はカレント DB のみ、all は全 DB。
  const searchScope = useMemo<ObjectSearchScope>(
    () =>
      scope === "current" && currentDatabase
        ? { kind: "current", database: currentDatabase }
        : { kind: "all" },
    [scope, currentDatabase],
  );

  // 検索要求。空クエリは結果が空のまま索引だけを作らせる (ウォームアップ) ので即時に、
  // 入力があるときはデバウンスして問い合わせる。
  const searchKey = `${JSON.stringify(searchScope)}\u0000${query}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: searchKey は sessionId 以外の依存 (searchScope / query) から導出した値で、run 内でのみ使う
  useEffect(() => {
    const run = () => {
      const seq = ++requestSeq.current;
      setLoading(true);
      api
        .searchSchemaObjects({ sessionId, scope: searchScope, query, limit: RESULT_LIMIT })
        .then((hits) => {
          if (!mounted.current || requestSeq.current !== seq) return;
          setResults(hits);
          setResultsFor(searchKey);
          setError(null);
        })
        .catch((e) => {
          if (!mounted.current || requestSeq.current !== seq) return;
          setError(String(e));
        })
        .finally(() => {
          if (mounted.current && requestSeq.current === seq) setLoading(false);
        });
    };
    if (!query.trim()) {
      run();
      return;
    }
    // デバウンス待ちの間に「該当なし」が一瞬出ないよう、要求を出す前から読み込み中にする。
    setLoading(true);
    const timer = setTimeout(run, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [sessionId, searchScope, query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: query / scope は本体では使わず、変わったら選択位置を先頭へ戻すためのトリガーとして依存に置いている
  useEffect(() => {
    setActiveIndex(0);
  }, [query, scope]);

  // ホバー由来の activeIndex 変化では scrollIntoView を呼ばない (端の行にホバーするとリストが動いて連鎖するため)。
  const hoverIndex = useRef<number | null>(null);
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  useEffect(() => {
    const hovered = hoverIndex.current;
    hoverIndex.current = null;
    if (hovered !== null && hovered === activeIndex) return;
    const active = results[activeIndex];
    if (!active) return;
    scrollFollowIntoView(itemRefs.current.get(entryKey(active)));
  }, [activeIndex, results]);

  const openAt = (i: number, newTab = false) => {
    const entry = results[i];
    if (!entry) return;
    if (entry.kind === "routine" || entry.kind === "trigger") {
      // 定義を新しいクエリタブに開く (開く先は常に新しいタブ)。
      if (!onOpenObject || !entry.object_kind) return;
      onClose();
      onOpenObject(entry.database, entry.object_kind, entry.table, entry.object_id ?? null);
      return;
    }
    onClose();
    if (entry.kind === "column" && entry.column) {
      onOpenTable(entry.database, entry.table, { column: entry.column, ...(newTab ? { newTab } : {}) });
    } else if (newTab) {
      onOpenTable(entry.database, entry.table, { newTab });
    } else {
      onOpenTable(entry.database, entry.table);
    }
  };

  // 行 (memo) へ渡す安定ハンドラ。最新の openAt は ref 経由で呼ぶ。
  const openAtRef = useRef(openAt);
  openAtRef.current = openAt;
  const onRowOpen = useCallback((i: number, newTab: boolean) => openAtRef.current(i, newTab), []);
  const onRowHover = useCallback((i: number) => {
    if (i === activeIndexRef.current) return;
    hoverIndex.current = i;
    setActiveIndex(i);
  }, []);
  const setItemRef = useCallback((key: string, el: HTMLButtonElement | null) => {
    if (el) itemRefs.current.set(key, el);
    else itemRefs.current.delete(key);
  }, []);

  const move = (delta: number) => {
    if (results.length === 0) return;
    setActiveIndex((cur) => (cur + delta + results.length) % results.length);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Tab":
        // 候補があるときだけ Tab を奪う。0 件なら通常のフォーカス移動を妨げない。
        if (results.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          move(e.shiftKey ? -1 : 1);
        }
        break;
      case "Enter":
        // IME 変換確定の Enter では開かない (#1515 と同じ)。
        if (isImeComposing(e)) break;
        e.preventDefault();
        // 入力中の語に対応する結果が届くまでは開かない (古い結果の先頭を開かない)。
        if (resultsFor !== searchKey) break;
        openAt(activeIndex, e.shiftKey);
        break;
    }
  };

  return (
    <Modal
      // no-submit: 検索 UI。Enter が候補の決定を担う
      open
      onClose={onClose}
      width="640px"
      initialFocusEl={() => inputRef.current}
    >
      <Flex
        align="center"
        gap="2"
        px="3.5"
        borderBottomWidth="1px"
        borderBottomColor="app.border"
        bg="app.surface"
      >
        <Box color="app.textMuted" flexShrink={0} display="inline-flex">
          <Icon name="table" size={ICON_SIZES.md} />
        </Box>
        <chakra.input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("objSearchPlaceholder")}
          aria-label={t("objSearchPlaceholder")}
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls="object-search-list"
          aria-activedescendant={
            results.length > 0 && activeIndex >= 0 && activeIndex < results.length
              ? objectSearchOptionId(activeIndex)
              : undefined
          }
          autoComplete="off"
          spellCheck={false}
          flex="1"
          minW={0}
          py="3.5"
          bg="transparent"
          border="none"
          outline="none"
          color="app.text"
          fontSize="md"
          css={{ "&::placeholder": { color: "var(--text-muted)" } }}
        />
        {currentDatabase && (
          <Segmented<Scope>
            value={scope}
            onChange={setScope}
            ariaLabel={t("objSearchScopeLabel")}
            options={[
              { value: "current", label: t("objSearchScopeCurrent") },
              { value: "all", label: t("objSearchScopeAll") },
            ]}
          />
        )}
      </Flex>

      <MotionListBox
        id="object-search-list"
        role="listbox"
        aria-busy={loading}
        maxH="min(440px, 62vh)"
        overflowY="auto"
        py="1.5"
        variants={staggerContainer(reduced)}
        initial="initial"
        animate="animate"
      >
        {error ? (
          // 検索の失敗は操作をブロックする持続的エラーなので ErrorNote (#1114)。
          <ErrorNote mx="4" my="3" role="alert">
            {error}
          </ErrorNote>
        ) : loading && results.length === 0 ? (
          // スキャン中は結果行の形を模した skeleton を出す (#1212)。
          <SkeletonSearchRows />
        ) : results.length === 0 ? (
          // 未入力 (ヒント) / 入力あり検索一致なしの 2 状態とも、この結果一覧
          // 領域全体が空になるため ResultGrid と同じリッチなイラストで表現する
          // (#847)。
          <EmptyState
            illustration={<NoResultsIllustration />}
            icon="search"
            title={query.trim() ? t("objSearchNoResults") : t("objSearchHint")}
          />
        ) : (
          results.map((entry, i) => (
            <ResultRow
              key={entryKey(entry)}
              index={i}
              id={objectSearchOptionId(i)}
              itemKey={entryKey(entry)}
              setItemRef={setItemRef}
              entry={entry}
              animateEntrance={shouldStaggerEntrance(i)}
              active={i === activeIndex}
              highlightId={highlightId}
              onHover={onRowHover}
              onOpen={onRowOpen}
            />
          ))
        )}
      </MotionListBox>
    </Modal>
  );
}

function entryKey(e: ObjectSearchHit): string {
  return `${e.kind}:${e.database}.${e.table}.${e.column ?? ""}`;
}

/** 候補 i の DOM id。入力欄の aria-activedescendant が指す (#1529)。 */
function objectSearchOptionId(index: number): string {
  return `object-search-opt-${index}`;
}

interface RowProps {
  id: string;
  entry: ObjectSearchHit;
  active: boolean;
  /** アクティブ行ハイライトの layoutId。 */
  highlightId: string;
  /** 先頭 `MAX_STAGGER_ITEMS` 件だけ stagger 出現させる (CommandPalette と同じ上限ガード)。 */
  animateEntrance: boolean;
  index: number;
  itemKey: string;
  setItemRef: (key: string, el: HTMLButtonElement | null) => void;
  onHover: (index: number) => void;
  onOpen: (index: number, newTab: boolean) => void;
}

const HIT_ICON: Record<ObjectSearchHit["kind"], IconName> = {
  table: "table",
  column: "columns",
  view: "view",
  routine: "routine",
  trigger: "trigger",
};

/** ビュー / ルーチン / トリガーのヒットに添える種別ラベルの i18n キー。 */
function hitKindLabelKey(entry: ObjectSearchHit) {
  switch (entry.object_kind) {
    case "materialized_view":
      return "objSearchKind_materialized_view";
    case "procedure":
      return "objSearchKind_procedure";
    case "function":
      return "objSearchKind_function";
    case "trigger":
      return "objSearchKind_trigger";
    default:
      return "objSearchKind_view";
  }
}

const ResultRow = memo(function ResultRow({
  id,
  entry,
  active,
  highlightId,
  animateEntrance,
  index,
  itemKey,
  setItemRef,
  onHover,
  onOpen,
}: RowProps) {
  const t = useT();
  return (
    <MotionRow
      ref={(el: HTMLButtonElement | null) => setItemRef(itemKey, el)}
      id={id}
      type="button"
      role="option"
      variants={animateEntrance ? variants.staggerItem : undefined}
      aria-selected={active}
      tabIndex={-1}
      onMouseMove={() => onHover(index)}
      onClick={(e: React.MouseEvent) => onOpen(index, e.shiftKey)}
      display="flex"
      alignItems="center"
      gap="2"
      w="100%"
      textAlign="left"
      px="4"
      py="1.75"
      border="none"
      cursor="pointer"
      position="relative"
      bg="transparent"
      color="app.text"
      css={{ scrollMarginBlock: "8px" }}
    >
      {active && <ActiveRowHighlight layoutId={highlightId} />}
      <Box color="app.textMuted" flexShrink={0} display="inline-flex" position="relative" zIndex={1}>
        <Icon name={HIT_ICON[entry.kind]} size={ICON_SIZES.md} />
      </Box>
      <Flex direction="column" minW={0} flex="1" gap="0.25" position="relative" zIndex={1}>
        <chakra.span fontSize="sm" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
          {entry.kind === "column" ? entry.column : entry.table}
        </chakra.span>
        <chakra.span
          fontSize="xs"
          color="app.textMuted"
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
        >
          {entry.kind === "column"
            ? `${entry.database} › ${entry.table}`
            : entry.kind === "table"
              ? entry.database
              : `${entry.database} · ${t(hitKindLabelKey(entry))}`}
        </chakra.span>
      </Flex>
      {/* 行数の目安 (テーブルのみ)。大きなテーブルかを開く前に判断できる (#1629)。 */}
      {entry.kind === "table" && typeof entry.row_estimate === "number" && (
        <chakra.span
          position="relative"
          zIndex={1}
          flexShrink={0}
          fontFamily="mono"
          fontSize="2xs"
          color="app.textMuted"
          title={`${entry.row_estimate.toLocaleString()} — ${t("treeRowEstimateTitle")}`}
        >
          {formatRowEstimate(entry.row_estimate)}
        </chakra.span>
      )}
    </MotionRow>
  );
});
