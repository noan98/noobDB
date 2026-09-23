import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
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
import { TreeChevron, TreeRow } from "./tree";
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
  /** 接続ドライバ ("mysql" | "postgres" | "sqlite" | "duckdb" | "mssql")。 */
  driver?: string;
}

interface Selection {
  path: JsonPathSegment[];
  node: JsonNode;
}

interface TreeCtx {
  search: JsonSearchResult | null;
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  shownCount: (key: string) => number;
  showMore: (key: string) => void;
  selectedKey: string | null;
  onSelect: (sel: Selection) => void;
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
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([rootKey]));
  // 検索中に自動展開された祖先をユーザが畳んだ記録。クエリが変わるたびに捨てる。
  const [searchCollapsed, setSearchCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => setSearchCollapsed(new Set()), [deferredQuery]);
  const [pages, setPages] = useState<Map<string, number>>(() => new Map());
  const [selected, setSelected] = useState<Selection | null>(null);

  const ctx: TreeCtx = {
    search,
    isOpen: (key) =>
      search?.ancestors.has(key) ? !searchCollapsed.has(key) : expanded.has(key),
    toggle: (key) => {
      const flip = (prev: Set<string>) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      };
      if (search?.ancestors.has(key)) setSearchCollapsed(flip);
      else setExpanded(flip);
    },
    shownCount: (key) => pages.get(key) ?? CHILD_PAGE_SIZE,
    showMore: (key) =>
      setPages((prev) => new Map(prev).set(key, (prev.get(key) ?? CHILD_PAGE_SIZE) + CHILD_PAGE_SIZE)),
    selectedKey: selected ? pathKey(selected.path) : null,
    onSelect: setSelected,
  };

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
        <JsonTreeRow ctx={ctx} node={root} path={[]} segment={null} level={0} firstFocusable />
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
  ctx: TreeCtx;
  node: JsonNode;
  path: JsonPathSegment[];
  /** 親から見たこのノードのキー / 添字 (ルートは null)。 */
  segment: JsonPathSegment | null;
  level: number;
  /** 何も選択されていないときに Tab で入れる行か (ルート)。 */
  firstFocusable?: boolean;
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
function JsonTreeRow({
  ctx,
  node,
  path,
  segment,
  level,
  firstFocusable,
}: RowProps) {
  const t = useT();
  const key = pathKey(path);
  const container = isContainer(node);
  const open = container && ctx.isOpen(key);
  const count = childCount(node);
  const isSelected = ctx.selectedKey === key;
  const isMatch = ctx.search?.matches.has(key) ?? false;
  const focusable = isSelected || (ctx.selectedKey === null && !!firstFocusable);

  const select = () => ctx.onSelect({ path, node });
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
  let children: JsonChild[] = [];
  let hidden = 0;
  if (open) {
    const search = ctx.search;
    if (search && search.ancestors.has(key)) {
      children = childSlice(node, 0, count).filter((c) => {
        const k = pathKey([...path, c.segment]);
        return search.matches.has(k) || search.ancestors.has(k);
      });
    } else {
      const shown = Math.min(ctx.shownCount(key), count);
      children = childSlice(node, 0, shown);
      hidden = count - shown;
    }
  }

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
      {open && (
        <chakra.div role="group">
          {children.map((c, idx) => (
            <JsonTreeRow
              // 重複キーを持つオブジェクトもあり得るので位置を併用する。
              key={`${idx}:${String(c.segment)}`}
              ctx={ctx}
              node={c.node}
              path={[...path, c.segment]}
              segment={c.segment}
              level={level + 1}
            />
          ))}
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
      )}
    </>
  );
}
