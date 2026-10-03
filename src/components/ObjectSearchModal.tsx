import { chakra, Box, Flex } from "@chakra-ui/react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ObjectSearchHit, type ObjectSearchScope } from "../api/tauri";
import { useT } from "../i18n";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { NoResultsIllustration } from "./illustrations";
import { Modal } from "./Modal";
import { SkeletonSearchRows } from "./Skeleton";
import { shouldStaggerEntrance } from "./commandPaletteSearch";
import { staggerContainer, variants } from "../motion";
import { ErrorNote } from "./modalForm";

/**
 * スキーマ横断のグローバルオブジェクト検索。テーブル名・カラム名を全 DB (またはカレント DB)
 * 串刺しで部分一致検索し、選択で該当テーブルを開く。既存コマンドパレット (Cmd/Ctrl+K) とは
 * 別キー (Cmd/Ctrl+Shift+O) で起動する。
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
  onOpenTable: (database: string, table: string) => void;
  onClose: () => void;
}

type Scope = "current" | "all";

// CommandPalette と同じ stagger 語彙 (#1212)。`variants` を子へ伝播させるため forwardProps で通す。
const MotionListBox = chakra(motion.div, {}, { forwardProps: ["variants", "initial", "animate"] });
const MotionRow = chakra(motion.button, {}, { forwardProps: ["variants"] });

const RESULT_LIMIT = 300;

/** キー入力から検索要求を出すまでの待ち時間 (連打中は最後の入力だけを問い合わせる)。 */
const SEARCH_DEBOUNCE_MS = 120;

export function ObjectSearchModal({ sessionId, currentDatabase, onOpenTable, onClose }: Props) {
  const t = useT();
  const reduced = useReducedMotion() ?? false;
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>(currentDatabase ? "current" : "all");
  const [results, setResults] = useState<ObjectSearchHit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  // 最後に発行した要求の番号。古い応答 (追い越された要求) は捨てる。
  const requestSeq = useRef(0);
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
  useEffect(() => {
    const run = () => {
      const seq = ++requestSeq.current;
      setLoading(true);
      api
        .searchSchemaObjects({ sessionId, scope: searchScope, query, limit: RESULT_LIMIT })
        .then((hits) => {
          if (!mounted.current || requestSeq.current !== seq) return;
          setResults(hits);
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

  useEffect(() => {
    const active = results[activeIndex];
    if (!active) return;
    itemRefs.current.get(entryKey(active))?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, results]);

  const openAt = (i: number) => {
    const entry = results[i];
    if (!entry) return;
    onClose();
    onOpenTable(entry.database, entry.table);
  };

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
        e.preventDefault();
        openAt(activeIndex);
        break;
    }
  };

  return (
    <Modal
      // no-submit: 検索 UI。Enter が候補の決定を担う
      open onClose={onClose} width="640px" initialFocusEl={() => inputRef.current}>
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
          <chakra.div display="inline-flex" borderRadius="md" overflow="hidden" borderWidth="1px" borderColor="app.border" flexShrink={0}>
            <ScopeButton active={scope === "current"} onClick={() => setScope("current")}>
              {t("objSearchScopeCurrent")}
            </ScopeButton>
            <ScopeButton active={scope === "all"} onClick={() => setScope("all")}>
              {t("objSearchScopeAll")}
            </ScopeButton>
          </chakra.div>
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
              ref={(el) => {
                if (el) itemRefs.current.set(entryKey(entry), el);
                else itemRefs.current.delete(entryKey(entry));
              }}
              entry={entry}
              animateEntrance={shouldStaggerEntrance(i)}
              active={i === activeIndex}
              onMouseMove={() => {
                if (i !== activeIndex) setActiveIndex(i);
              }}
              onClick={() => openAt(i)}
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

function ScopeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <chakra.button
      type="button"
      onClick={onClick}
      px="2"
      py="0.75"
      fontSize="xs"
      cursor="pointer"
      bg={active ? "app.active" : "transparent"}
      color={active ? "app.text" : "app.textMuted"}
      _hover={{ bg: "app.rowHover" }}
    >
      {children}
    </chakra.button>
  );
}

interface RowProps {
  entry: ObjectSearchHit;
  active: boolean;
  /** 先頭 `MAX_STAGGER_ITEMS` 件だけ stagger 出現させる (CommandPalette と同じ上限ガード)。 */
  animateEntrance: boolean;
  onMouseMove: () => void;
  onClick: () => void;
  ref?: (el: HTMLButtonElement | null) => void;
}

function ResultRow({ entry, active, animateEntrance, onMouseMove, onClick, ref }: RowProps) {
  return (
    <MotionRow
      ref={ref}
      type="button"
      role="option"
      variants={animateEntrance ? variants.staggerItem : undefined}
      aria-selected={active}
      tabIndex={-1}
      onMouseMove={onMouseMove}
      onClick={onClick}
      display="flex"
      alignItems="center"
      gap="2"
      w="100%"
      textAlign="left"
      px="4"
      py="1.75"
      border="none"
      cursor="pointer"
      bg={active ? "app.active" : "transparent"}
      color="app.text"
      css={{ scrollMarginBlock: "8px" }}
    >
      <Box color="app.textMuted" flexShrink={0} display="inline-flex">
        <Icon name={entry.kind === "column" ? "columns" : "table"} size={ICON_SIZES.md} />
      </Box>
      <Flex direction="column" minW={0} flex="1" gap="0.25">
        <chakra.span fontSize="sm" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
          {entry.kind === "column" ? entry.column : entry.table}
        </chakra.span>
        <chakra.span fontSize="xs" color="app.textMuted" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
          {entry.kind === "column"
            ? `${entry.database} › ${entry.table}`
            : entry.database}
        </chakra.span>
      </Flex>
    </MotionRow>
  );
}
