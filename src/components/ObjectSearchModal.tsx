import { chakra, Box, Flex } from "@chakra-ui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type TableSchema } from "../api/tauri";
import { useT } from "../i18n";
import { buildObjectIndex, searchObjects, type ObjectEntry } from "../objectSearch";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { Spinner } from "./Spinner";

/**
 * スキーマ横断のグローバルオブジェクト検索 (#473)。`schema_overview` を源に、テーブル名・
 * カラム名を全 DB (またはカレント DB) 串刺しで部分一致検索し、選択で該当テーブルを開く。
 * 既存コマンドパレット (Cmd/Ctrl+K) とは別キー (Cmd/Ctrl+Shift+O) で起動する。
 *
 * 絞り込み/スコアリングの純ロジックは `objectSearch.ts` に分離。ここは取得・入力状態・
 * キーボードナビ・描画のみを担う。
 */
interface Props {
  sessionId: string;
  /** 既定スコープ (カレント DB)。null なら最初から全 DB を読む。 */
  currentDatabase: string | null;
  onOpenTable: (database: string, table: string) => void;
  onClose: () => void;
}

type Scope = "current" | "all";

const RESULT_LIMIT = 300;

export function ObjectSearchModal({ sessionId, currentDatabase, onOpenTable, onClose }: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>(currentDatabase ? "current" : "all");
  const [schemasByDb, setSchemasByDb] = useState<Record<string, TableSchema[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // スコープに応じてスキーマを取得する。current はカレント DB のみ、all は全 DB。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const acc: Record<string, TableSchema[]> = {};
        if (scope === "current" && currentDatabase) {
          acc[currentDatabase] = await api.schemaOverview(sessionId, currentDatabase);
        } else {
          const dbs = await api.listDatabases(sessionId);
          for (const db of dbs) {
            if (cancelled) return;
            try {
              acc[db] = await api.schemaOverview(sessionId, db);
            } catch {
              // 1 つの DB の取得失敗で全体を止めない (権限不足など)。
            }
          }
        }
        if (!cancelled) setSchemasByDb(acc);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, scope, currentDatabase]);

  const index = useMemo(() => buildObjectIndex(schemasByDb), [schemasByDb]);
  const results = useMemo(() => searchObjects(index, query, RESULT_LIMIT), [index, query]);

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
    <Modal open onClose={onClose} width="640px" initialFocusEl={() => inputRef.current}>
      <Flex
        align="center"
        gap="2"
        px="3.5"
        borderBottomWidth="1px"
        borderBottomColor="app.border"
        bg="app.surface"
      >
        <Box color="app.textMuted" flexShrink={0} display="inline-flex">
          <Icon name="table" size={16} />
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
        {loading && <Spinner size={14} />}
        {currentDatabase && (
          <chakra.div display="inline-flex" borderRadius="6px" overflow="hidden" borderWidth="1px" borderColor="app.border" flexShrink={0}>
            <ScopeButton active={scope === "current"} onClick={() => setScope("current")}>
              {t("objSearchScopeCurrent")}
            </ScopeButton>
            <ScopeButton active={scope === "all"} onClick={() => setScope("all")}>
              {t("objSearchScopeAll")}
            </ScopeButton>
          </chakra.div>
        )}
      </Flex>

      <Box id="object-search-list" role="listbox" maxH="min(440px, 62vh)" overflowY="auto" py="1.5">
        {error ? (
          <Box px="4" py="5" textAlign="center" color="app.dangerFg" fontSize="sm">
            {error}
          </Box>
        ) : results.length === 0 ? (
          <Box px="4" py="5" textAlign="center" color="app.textMuted" fontSize="sm">
            {query.trim() ? t("objSearchNoResults") : t("objSearchHint")}
          </Box>
        ) : (
          results.map((entry, i) => (
            <ResultRow
              key={entryKey(entry)}
              ref={(el) => {
                if (el) itemRefs.current.set(entryKey(entry), el);
                else itemRefs.current.delete(entryKey(entry));
              }}
              entry={entry}
              active={i === activeIndex}
              onMouseMove={() => {
                if (i !== activeIndex) setActiveIndex(i);
              }}
              onClick={() => openAt(i)}
            />
          ))
        )}
      </Box>
    </Modal>
  );
}

function entryKey(e: ObjectEntry): string {
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
      py="3px"
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
  entry: ObjectEntry;
  active: boolean;
  onMouseMove: () => void;
  onClick: () => void;
  ref?: (el: HTMLButtonElement | null) => void;
}

function ResultRow({ entry, active, onMouseMove, onClick, ref }: RowProps) {
  return (
    <chakra.button
      ref={ref}
      type="button"
      role="option"
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
      py="7px"
      border="none"
      cursor="pointer"
      bg={active ? "app.active" : "transparent"}
      color="app.text"
      css={{ scrollMarginBlock: "8px" }}
    >
      <Box color="app.textMuted" flexShrink={0} display="inline-flex">
        <Icon name={entry.kind === "column" ? "columns" : "table"} size={15} />
      </Box>
      <Flex direction="column" minW={0} flex="1" gap="1px">
        <chakra.span fontSize="sm" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
          {entry.kind === "column" ? entry.column : entry.table}
        </chakra.span>
        <chakra.span fontSize="xs" color="app.textMuted" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
          {entry.kind === "column"
            ? `${entry.database} › ${entry.table}`
            : entry.database}
        </chakra.span>
      </Flex>
    </chakra.button>
  );
}
