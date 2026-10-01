import {
  createContext,
  memo,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import { useRovingFocus } from "../keyboardNav";
import { copyToClipboard } from "./clipboard";
import { Icon, ICON_SIZES } from "./Icon";
import {
  childCount,
  childSlice,
  formatJsonPath,
  isContainer,
  jsonPathSqlExpression,
  jsonPathSqlPredicate,
  pathKey,
  scalarPreview,
  searchJsonTree,
  serializeJson,
  type JsonChild,
  type JsonNode,
  type JsonPathSegment,
  type JsonSearchResult,
} from "./jsonTree";
import { useToast } from "./Toast";
import { TreeChevron, TreeCollapse, TreeRow } from "./tree";
import { Button, Input } from "./ui";

/**
 * 展開したコンテナで一度に描画する子の数。これを超える配列/オブジェクトは
 * 「さらに N 件表示」で段階的に追加描画する (巨大 JSON で固まらないための遅延展開)。
 */
const CHILD_PAGE_SIZE = 200;

interface Props {
  /** `parseJsonLossless` 済みのルートノード。 */
  root: JsonNode;
  /** SQL 抽出式 / WHERE 条件の生成に使う列名。無ければ SQL コピーを出さない。 */
  columnName?: string;
  /** 接続ドライバ ("mysql" | "postgres" | "sqlite")。 */
  driver?: string;
}

interface Selection {
  path: JsonPathSegment[];
  node: JsonNode;
}

/**
 * ツリーの表示状態 (#1321)。行ごとに `useSyncExternalStore` で「自分に関係する部分」だけを
 * 購読するため、選択の移動や 1 ノードの開閉で再レンダーされるのは影響する行だけになる
 * (以前は `ctx` が毎回作り直され、可視行すべてが再レンダーされていた)。
 */
interface TreeState {
  search: JsonSearchResult | null;
  /** `search` が変わるたびに増える世代番号 (祖先行の子の絞り込みを再計算させる)。 */
  searchVersion: number;
  expanded: ReadonlySet<string>;
  searchCollapsed: ReadonlySet<string>;
  pages: ReadonlyMap<string, number>;
  selectedKey: string | null;
}

interface TreeStore {
  get: () => TreeState;
  set: (next: TreeState) => void;
  subscribe: (listener: () => void) => () => void;
}

function createTreeStore(initial: TreeState): TreeStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next) => {
      state = next;
      for (const l of listeners) l();
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

interface TreeActions {
  toggle: (key: string) => void;
  showMore: (key: string) => void;
  onSelect: (sel: Selection) => void;
}

const TreeContext = createContext<{ store: TreeStore; actions: TreeActions } | null>(null);

/** 1 行が見る状態を 1 本の文字列に畳む。同値なら再レンダーされない。 */
function rowSnapshot(state: TreeState, key: string, firstFocusable: boolean): string {
  const { search } = state;
  const anc = search?.ancestors.has(key) ?? false;
  const open = anc ? !state.searchCollapsed.has(key) : state.expanded.has(key);
  const sel = state.selectedKey === key;
  const match = search?.matches.has(key) ?? false;
  const focusable = sel || (state.selectedKey === null && firstFocusable);
  const shown = state.pages.get(key) ?? CHILD_PAGE_SIZE;
  // 祖先行は子を一致の枝に絞るので、検索結果が変わったら (開いているときだけ) 描き直す。
  const version = anc && open ? state.searchVersion : 0;
  return `${open ? 1 : 0}${sel ? 1 : 0}${match ? 1 : 0}${anc ? 1 : 0}${focusable ? 1 : 0}:${shown}:${version}`;
}

/**
 * JSON / JSONB セルのツリービュー (#1026)。`CellValueViewer` の閲覧モードで
 * テキスト表示と切り替えて使う。
 *
 * - 子は**展開したノードだけ**描画し、1 ノードあたり `CHILD_PAGE_SIZE` 件ずつ追加する。
 * - 検索はキー名とスカラ値の部分一致。一致ノードの祖先を自動展開し、祖先の子は
 *   一致に関係する枝だけに絞る (一致したコンテナ自体を開けば全子が見える)。
 * - 選択ノードのパス (`$.a.b[0]`)・値・方言別の SQL 抽出式・WHERE 条件をコピーできる。
 *   生成した SQL はクリップボードへ渡すだけで、DB への書き込み経路は持たない。
 * - 数値は元テキストのまま表示する (64bit 整数を丸めない)。
 */
export function JsonTreeView({ root, columnName, driver }: Props) {
  const t = useT();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const search = useMemo(() => searchJsonTree(root, deferredQuery), [root, deferredQuery]);

  const rootKey = pathKey([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([rootKey]));
  // 検索中に自動展開された祖先をユーザが畳んだ記録。クエリが変わるたびに捨てる。
  const [searchCollapsed, setSearchCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => setSearchCollapsed(new Set()), [deferredQuery]);
  const [pages, setPages] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [selected, setSelected] = useState<Selection | null>(null);

  const selectedKey = selected ? pathKey(selected.path) : null;
  // 初回描画から正しい状態で見えるよう、ストアは初回レンダーの値で作る。以降の変化は
  // レイアウト効果でストアへ流し、変わった行だけが購読経由で再レンダーされる。
  const searchVersionRef = useRef(0);
  const storeRef = useRef<TreeStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createTreeStore({
      search,
      searchVersion: 0,
      expanded,
      searchCollapsed,
      pages,
      selectedKey,
    });
  }
  const store = storeRef.current;
  const lastSearchRef = useRef(search);
  useLayoutEffect(() => {
    if (lastSearchRef.current !== search) {
      lastSearchRef.current = search;
      searchVersionRef.current += 1;
    }
    const cur = store.get();
    if (
      cur.search === search &&
      cur.expanded === expanded &&
      cur.searchCollapsed === searchCollapsed &&
      cur.pages === pages &&
      cur.selectedKey === selectedKey
    ) {
      return;
    }
    store.set({
      search,
      searchVersion: searchVersionRef.current,
      expanded,
      searchCollapsed,
      pages,
      selectedKey,
    });
  }, [store, search, expanded, searchCollapsed, pages, selectedKey]);

  const toggle = useCallback(
    (key: string) => {
      const flip = (prev: ReadonlySet<string>) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      };
      if (store.get().search?.ancestors.has(key)) setSearchCollapsed(flip);
      else setExpanded(flip);
    },
    [store],
  );
  const showMore = useCallback(
    (key: string) =>
      setPages((prev) => new Map(prev).set(key, (prev.get(key) ?? CHILD_PAGE_SIZE) + CHILD_PAGE_SIZE)),
    [],
  );
  const treeCtx = useMemo(
    () => ({ store, actions: { toggle, showMore, onSelect: setSelected } }),
    [store, toggle, showMore],
  );

  const treeRef = useRef<HTMLDivElement>(null);
  const { onKeyDown } = useRovingFocus(treeRef, "[role=treeitem]", {
    orientation: "vertical",
    wrap: false,
  });

  const copy = async (text: string) => {
    if (await copyToClipboard(text)) toast.success(t("jsonTreeCopied"));
    else toast.error(t("clipboardCopyFailed"));
  };

  const canSql = !!driver && !!columnName;
  const sqlExpr =
    selected && canSql
      ? jsonPathSqlExpression(driver!, columnName!, selected.path, !isContainer(selected.node))
      : null;
  const sqlWhere =
    selected && canSql ? jsonPathSqlPredicate(driver!, columnName!, selected.path, selected.node) : null;

  return (
    <chakra.div display="flex" flexDirection="column" gap="2" flex="1" minH="0">
      <chakra.div display="flex" alignItems="center" gap="2">
        <chakra.span color="app.textMuted" display="inline-flex" aria-hidden>
          <Icon name="search" size={ICON_SIZES.sm} />
        </chakra.span>
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("jsonTreeSearchPlaceholder")}
          aria-label={t("jsonTreeSearchPlaceholder")}
          flex="1"
        />
        {search && (
          <chakra.span fontSize="xs" color="app.textMuted" whiteSpace="nowrap" aria-live="polite">
            {search.paths.length === 0
              ? t("jsonTreeNoMatches")
              : search.truncated
                ? t("jsonTreeSearchTruncated", { count: search.paths.length })
                : t("jsonTreeSearchCount", { count: search.paths.length })}
          </chakra.span>
        )}
      </chakra.div>

      <chakra.div
        ref={treeRef}
        role="tree"
        aria-label={t("jsonTreeAria")}
        onKeyDown={onKeyDown}
        minH="120px"
        maxH="50vh"
        overflow="auto"
        py="1"
        fontFamily="mono"
        fontSize="sm"
        color="app.text"
        bg="app.bgInput"
        border="1px solid"
        borderColor="app.border"
        borderRadius="md"
      >
        <TreeContext.Provider value={treeCtx}>
          <JsonTreeRow node={root} pkey={rootKey} segment={null} level={0} firstFocusable />
        </TreeContext.Provider>
      </chakra.div>

      <chakra.div
        display="flex"
        alignItems="center"
        flexWrap="wrap"
        gap="1.5"
        minH="0"
      >
        {selected ? (
          <>
            <chakra.code
              flex="1"
              minW="0"
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
              fontFamily="mono"
              fontSize="sm"
              color="app.text"
              data-testid="json-tree-selected-path"
            >
              {formatJsonPath(selected.path)}
            </chakra.code>
            <Button type="button" size="sm" variant="ghost" onClick={() => copy(formatJsonPath(selected.path))}>
              <Icon name="link" size={ICON_SIZES.sm} />
              {t("jsonTreeCopyPath")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                copy(
                  selected.node.kind === "string"
                    ? selected.node.value
                    : serializeJson(selected.node, isContainer(selected.node) ? 2 : undefined),
                )
              }
            >
              <Icon name="copy" size={ICON_SIZES.sm} />
              {t("jsonTreeCopyValue")}
            </Button>
            {sqlExpr && selected.path.length > 0 && (
              <Button type="button" size="sm" variant="ghost" onClick={() => copy(sqlExpr)}>
                <Icon name="query" size={ICON_SIZES.sm} />
                {t("jsonTreeCopySqlExpr")}
              </Button>
            )}
            {sqlWhere && (
              <Button type="button" size="sm" variant="ghost" onClick={() => copy(sqlWhere)}>
                <Icon name="filter" size={ICON_SIZES.sm} />
                {t("jsonTreeCopySqlWhere")}
              </Button>
            )}
          </>
        ) : (
          <chakra.span fontSize="xs" color="app.textMuted">
            {t("jsonTreeSelectHint")}
          </chakra.span>
        )}
      </chakra.div>
    </chakra.div>
  );
}

interface RowProps {
  node: JsonNode;
  /**
   * `pathKey(path)` (= パスの JSON)。配列の `path` を props に持つと毎回新しい参照になって
   * memo が効かないため、文字列だけを渡して必要なときに復元する (#1321)。
   */
  pkey: string;
  /** 親から見たこのノードのキー / 添字 (ルートは null)。 */
  segment: JsonPathSegment | null;
  level: number;
  /** 何も選択されていないときに Tab で入れる行か (ルート)。 */
  firstFocusable?: boolean;
}

/** 親の `pathKey` に 1 セグメント足した子の `pathKey` (`pathKey([...path, segment])` と同値)。 */
function childKey(parentKey: string, segment: JsonPathSegment): string {
  const seg = JSON.stringify(segment);
  return parentKey === "[]" ? `[${seg}]` : `${parentKey.slice(0, -1)},${seg}]`;
}

/** 行の字下げ。レベルごとに spacing トークン 1 段 (`--space-4`) ずつ下げる。 */
function indentFor(level: number): string {
  return `calc(var(--space-1-5) + ${level} * var(--space-4))`;
}

function scalarColor(node: JsonNode): string {
  switch (node.kind) {
    case "number":
      return "app.cell.number";
    case "boolean":
      return node.value ? "app.cell.boolTrue" : "app.cell.boolFalse";
    case "null":
      return "app.textNull";
    default:
      return "app.text";
  }
}

/**
 * 1 ノード分の行と、展開中ならその子。行は展開ノードの子としてしか描かれない
 * ので、選択/展開状態が変わっても描画コストは「見えている行」ぶんに収まる。
 */
const JsonTreeRow = memo(
  function JsonTreeRow({ node, pkey: key, segment, level, firstFocusable }: RowProps) {
  const t = useT();
  const tree = useContext(TreeContext);
  if (!tree) throw new Error("JsonTreeRow must be rendered inside TreeContext");
  const { store, actions } = tree;
  // 行ごとの購読 (#1321): 自分の開閉・選択・一致・ページ数が変わったときだけ再レンダーする。
  useSyncExternalStore(
    store.subscribe,
    () => rowSnapshot(store.get(), key, !!firstFocusable),
    () => rowSnapshot(store.get(), key, !!firstFocusable),
  );
  const state = store.get();
  const container = isContainer(node);
  const open = container && (state.search?.ancestors.has(key) ? !state.searchCollapsed.has(key) : state.expanded.has(key));
  const count = childCount(node);
  const isSelected = state.selectedKey === key;
  const isMatch = state.search?.matches.has(key) ?? false;
  const focusable = isSelected || (state.selectedKey === null && !!firstFocusable);
  const ctx = { toggle: actions.toggle, showMore: actions.showMore };

  const select = () => actions.onSelect({ path: JSON.parse(key) as JsonPathSegment[], node });
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      select();
      if (container) ctx.toggle(key);
    } else if (e.key === "ArrowRight" && container && !open) {
      e.preventDefault();
      e.stopPropagation();
      ctx.toggle(key);
    } else if (e.key === "ArrowLeft" && container && open) {
      e.preventDefault();
      e.stopPropagation();
      ctx.toggle(key);
    }
  };

  // 表示する子。検索中にこのノードが一致の祖先なら、一致に関わる枝だけに絞る。
  // 子の要素は、表示する子の集合が変わらない限り使い回す (#1321): 行自身の選択・フォーカス
  // 表示が変わって再レンダーされても、子の再レンダーを誘発しない。
  const searchAncestor = open && !!state.search?.ancestors.has(key);
  const pageShown = state.pages.get(key) ?? CHILD_PAGE_SIZE;
  const searchVersion = searchAncestor ? state.searchVersion : 0;
  const { childRows, hidden } = useMemo(() => {
    if (!open) return { childRows: [], hidden: 0 };
    let kids: JsonChild[];
    let hiddenCount = 0;
    const search = store.get().search;
    if (searchAncestor && search) {
      kids = childSlice(node, 0, count).filter((c) => {
        const k = childKey(key, c.segment);
        return search.matches.has(k) || search.ancestors.has(k);
      });
    } else {
      const shown = Math.min(pageShown, count);
      kids = childSlice(node, 0, shown);
      hiddenCount = count - shown;
    }
    return {
      childRows: kids.map((c, idx) => (
        <JsonTreeRow
          // 重複キーを持つオブジェクトもあり得るので位置を併用する。
          key={`${idx}:${String(c.segment)}`}
          node={c.node}
          pkey={childKey(key, c.segment)}
          segment={c.segment}
          level={level + 1}
        />
      )),
      hidden: hiddenCount,
    };
    // searchVersion は検索結果の入れ替わりを知らせる世代番号 (store から読む search 本体の代わり)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, searchAncestor, searchVersion, pageShown, node, key, level, count, store]);

  return (
    <>
      <TreeRow
        role="treeitem"
        aria-level={level + 1}
        aria-expanded={container ? open : undefined}
        aria-selected={isSelected}
        tabIndex={focusable ? 0 : -1}
        onClick={() => {
          select();
          if (container) ctx.toggle(key);
        }}
        onFocus={(e) => {
          if (e.target === e.currentTarget && !isSelected) select();
        }}
        onKeyDown={onKeyDown}
        style={{ paddingLeft: indentFor(level) }}
        fontWeight={400}
        bg={isSelected ? "app.active" : isMatch ? "color-mix(in srgb, var(--accent) 14%, transparent)" : undefined}
        borderLeftColor={isSelected ? "app.accent" : "transparent"}
      >
        <TreeChevron aria-hidden transform={open ? "rotate(90deg)" : undefined}>
          {container ? "▸" : ""}
        </TreeChevron>
        {segment !== null && (
          <>
            <chakra.span
              color={typeof segment === "number" ? "app.textMuted" : "app.keyAccent"}
              flexShrink={0}
              maxW="50%"
              overflow="hidden"
              textOverflow="ellipsis"
            >
              {typeof segment === "number" ? segment : JSON.stringify(segment)}
            </chakra.span>
            <chakra.span color="app.textMuted" flexShrink={0}>
              :
            </chakra.span>
          </>
        )}
        {container ? (
          <chakra.span color="app.textMuted" overflow="hidden" textOverflow="ellipsis">
            {node.kind === "object"
              ? `{ ${t("jsonTreeKeys", { n: count })} }`
              : `[ ${t("jsonTreeItems", { n: count })} ]`}
          </chakra.span>
        ) : (
          <chakra.span color={scalarColor(node)} overflow="hidden" textOverflow="ellipsis">
            {scalarPreview(node)}
          </chakra.span>
        )}
      </TreeRow>
      {container && (
        // 接続ツリー (ConnectionList) と同じ TreeCollapse で開閉する (#1186)。
        // opacity のみを補間するので height 補間のコストは掛からず、深いネスト
        // でも重くならない。非コンテナ行では TreeCollapse 自体を作らない。
        <TreeCollapse open={open}>
          <chakra.div role="group">
            {childRows}
            {hidden > 0 && (
              <TreeRow
                role="treeitem"
                aria-level={level + 2}
                tabIndex={-1}
                onClick={() => ctx.showMore(key)}
                onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    ctx.showMore(key);
                  }
                }}
                style={{ paddingLeft: indentFor(level + 1) }}
                color="app.accent"
                fontWeight={500}
              >
                <TreeChevron aria-hidden />
                {t("jsonTreeShowMore", { n: Math.min(hidden, CHILD_PAGE_SIZE) })}
              </TreeRow>
            )}
          </chakra.div>
        </TreeCollapse>
      )}
    </>
  );
  },
);
