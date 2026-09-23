import { useCallback, useEffect, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import { api, type IndexInfo, type TableColumnInfo } from "../api/tauri";
import { useT } from "../i18n";
import { foreignKeysOf, foreignKeyTargetLabel, type ExplorerForeignKey } from "./explorerTree";
import { EmptyState } from "./EmptyState";
import { errorIllustration } from "./illustrations";
import { Icon, ICON_SIZES } from "./Icon";
import { Spinner } from "./Spinner";
import { Tooltip } from "./Tooltip";
import { Button } from "./ui";
import {
  indexKind,
  sortIndexes,
  structureColumnRows,
  structureTargetLabel,
  type StructureKeyKind,
  type StructureTarget,
} from "./tableStructure";

/**
 * テーブル構造 (Structure) のボトムパネル (#1112 / Epic #1110 Phase 2)。
 *
 * Database Explorer でテーブルを選んだあと、**データ (Data) と構造 (Structure) の
 * どちらへも 1 手で行ける**ようにするための構造側。列・インデックス・外部キーを
 * 表で並べ、「データを開く」で同じテーブルのデータタブへ、外部キーの参照先で
 * 参照先テーブルの構造へ移れる。
 *
 * SQL を書きながら参照する情報なので ui-design-system.md §7.1 に従い Bottom Panel
 * に置く (エディタと結果を消さない)。見出しと閉じるボタンはシェル (`BottomPanel`)
 * が持つ。取得は既存の読み取り IPC (`describe_table` / `list_indexes`) だけで、
 * DB への書き込み経路は持たない。整形ロジックは `tableStructure.ts`。
 */

const thCss: SystemStyleObject = {
  position: "sticky",
  top: 0,
  background: "var(--bg-muted)",
  borderBottom: "1px solid var(--border)",
  padding: "var(--space-1) var(--space-2)",
  textAlign: "left",
  textStyle: "overline",
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
};
const tdCss: SystemStyleObject = {
  borderBottom: "1px solid var(--border-subtle, var(--border))",
  padding: "var(--space-1) var(--space-2)",
  fontSize: "var(--text-sm)",
  color: "var(--text)",
  verticalAlign: "top",
};

const KEY_COLOR: Record<StructureKeyKind, string> = {
  pk: "app.keyAccent",
  fk: "app.accent",
  unique: "app.textSecondary",
};

function KeyBadge({ kind, label }: { kind: StructureKeyKind; label: string }) {
  return (
    <chakra.span
      display="inline-flex"
      alignItems="center"
      gap="0.5"
      px="1.5"
      py="0.25"
      borderRadius="pill"
      borderWidth="1px"
      borderColor="app.border"
      fontSize="2xs"
      fontWeight={600}
      letterSpacing="wide"
      color={KEY_COLOR[kind]}
      whiteSpace="nowrap"
    >
      {kind === "pk" && <Icon name="key" size={ICON_SIZES.sm} />}
      {kind === "fk" && <Icon name="link" size={ICON_SIZES.sm} />}
      {label}
    </chakra.span>
  );
}

/** 外部キーの参照先。押すと参照先テーブルの構造へ移る。 */
function ForeignKeyLink({
  fk,
  onSelect,
  hint,
}: {
  fk: ExplorerForeignKey;
  onSelect: (table: string) => void;
  hint: string;
}) {
  return (
    <Tooltip label={hint}>
      <chakra.button
        type="button"
        display="inline-flex"
        alignItems="center"
        gap="1"
        p="0"
        bg="transparent"
        border="none"
        cursor="pointer"
        fontFamily="var(--font-mono)"
        fontSize="sm"
        color="app.accent"
        _hover={{ textDecoration: "underline" }}
        onClick={() => onSelect(fk.referencedTable)}
      >
        <Icon name="link" size={ICON_SIZES.sm} />
        {foreignKeyTargetLabel(fk)}
      </chakra.button>
    </Tooltip>
  );
}

function SectionCaption({ label, count }: { label: string; count: number }) {
  return (
    <chakra.caption textAlign="left" textStyle="overline" color="app.textMuted" paddingBottom="1">
      {label} <chakra.span textStyle="numeric">({count})</chakra.span>
    </chakra.caption>
  );
}

export function TableStructurePanel({
  sessionId,
  driver,
  target,
  onOpenData,
  onSelectTable,
}: {
  sessionId: string;
  driver: string;
  target: StructureTarget;
  /** 同じテーブルのデータタブを開く (ツリーのダブルクリックと同じ `handleOpenTable`)。 */
  onOpenData: (database: string, table: string) => void;
  /** 構造パネルの対象を切り替える (外部キーの参照先へ移るとき)。 */
  onSelectTable: (target: StructureTarget) => void;
}) {
  const t = useT();
  const [columns, setColumns] = useState<TableColumnInfo[] | null>(null);
  const [indexes, setIndexes] = useState<IndexInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const { database, table } = target;

  useEffect(() => {
    let cancelled = false;
    setColumns(null);
    setIndexes(null);
    setError(null);
    api
      .describeTable(sessionId, database, table)
      .then((cols) => {
        if (!cancelled) setColumns(cols);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    // インデックスはベストエフォート (ツリーと同じ): 権限などで取れなくても列は出す。
    api
      .listIndexes(sessionId, database, table)
      .then((idx) => {
        if (!cancelled) setIndexes(idx);
      })
      .catch(() => {
        if (!cancelled) setIndexes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database, table, reloadKey]);

  const reload = useCallback(() => setReloadKey((n) => n + 1), []);
  const selectReferenced = useCallback(
    (refTable: string) => onSelectTable({ database, table: refTable }),
    [database, onSelectTable],
  );

  const keyLabel: Record<StructureKeyKind, string> = {
    pk: t("indexBadgePk"),
    fk: t("structureKeyFk"),
    unique: t("indexBadgeUnique"),
  };
  const rows = columns ? structureColumnRows(columns) : null;
  const fks = columns ? foreignKeysOf(columns) : [];
  const sortedIndexes = indexes ? sortIndexes(indexes) : null;
  const fkHint = t("structureOpenReferencedHint");

  return (
    <Box flex="1" overflowY="auto" py="3" px="4" display="flex" flexDirection="column" gap="3">
      <Flex align="center" gap="3" flexWrap="wrap">
        <Flex align="center" gap="1.5" minW={0}>
          <Icon name="table" size={ICON_SIZES.md} />
          <chakra.span
            fontFamily="var(--font-mono)"
            fontSize="sm"
            color="app.text"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
          >
            {structureTargetLabel(driver, target)}
          </chakra.span>
        </Flex>
        <Button type="button" variant="primary" size="sm" onClick={() => onOpenData(database, table)}>
          <Icon name="table" size={ICON_SIZES.sm} />
          <chakra.span marginLeft="1.5">{t("structureOpenData")}</chakra.span>
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={reload} disabled={!rows && !error}>
          <Icon name="refresh" size={ICON_SIZES.sm} />
          <chakra.span marginLeft="1.5">{t("structureReload")}</chakra.span>
        </Button>
      </Flex>

      {error ? (
        <EmptyState
          illustration={errorIllustration(error)}
          icon="warning"
          title={t("structureLoadError", { error })}
          action={{ label: t("structureReload"), onClick: reload }}
        />
      ) : !rows ? (
        <Flex align="center" gap="2">
          <Spinner size={14} />
          <chakra.span fontSize="sm" color="app.textMuted">
            {t("structureLoading")}
          </chakra.span>
        </Flex>
      ) : (
        <>
          <chakra.table width="100%" style={{ borderCollapse: "collapse" }}>
            <SectionCaption label={t("structureColumns")} count={rows.length} />
            <chakra.thead>
              <chakra.tr>
                <chakra.th css={thCss} textAlign="right">#</chakra.th>
                <chakra.th css={thCss}>{t("structureColName")}</chakra.th>
                <chakra.th css={thCss}>{t("structureColType")}</chakra.th>
                <chakra.th css={thCss}>{t("structureColNullable")}</chakra.th>
                <chakra.th css={thCss}>{t("structureColDefault")}</chakra.th>
                <chakra.th css={thCss}>{t("structureColKeys")}</chakra.th>
              </chakra.tr>
            </chakra.thead>
            <chakra.tbody>
              {rows.map((r) => (
                <chakra.tr key={r.name}>
                  <chakra.td css={tdCss} textAlign="right" textStyle="numeric" color="app.textMuted">
                    {r.position}
                  </chakra.td>
                  <chakra.td css={tdCss}>
                    <chakra.div fontFamily="var(--font-mono)">{r.name}</chakra.div>
                    {r.comment && (
                      <chakra.div fontSize="xs" color="app.textMuted">
                        {r.comment}
                      </chakra.div>
                    )}
                  </chakra.td>
                  <chakra.td css={tdCss} fontFamily="var(--font-mono)" color="app.textSecondary">
                    {r.dataType}
                  </chakra.td>
                  <chakra.td css={tdCss} color={r.nullable ? "app.textMuted" : "app.text"}>
                    {r.nullable ? t("structureNullableYes") : t("structureNullableNo")}
                  </chakra.td>
                  <chakra.td
                    css={tdCss}
                    fontFamily="var(--font-mono)"
                    color="app.textMuted"
                    maxW="240px"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                  >
                    {r.defaultValue ?? ""}
                  </chakra.td>
                  <chakra.td css={tdCss}>
                    <Flex gap="1" align="center" flexWrap="wrap">
                      {r.keys.map((k) => (
                        <KeyBadge key={k} kind={k} label={keyLabel[k]} />
                      ))}
                      {r.foreignKey && (
                        <ForeignKeyLink fk={r.foreignKey} onSelect={selectReferenced} hint={fkHint} />
                      )}
                      {r.extra && (
                        <chakra.span fontSize="xs" color="app.textMuted" fontFamily="var(--font-mono)">
                          {r.extra}
                        </chakra.span>
                      )}
                    </Flex>
                  </chakra.td>
                </chakra.tr>
              ))}
            </chakra.tbody>
          </chakra.table>

          <chakra.table width="100%" style={{ borderCollapse: "collapse" }}>
            <SectionCaption label={t("indexesLabel")} count={sortedIndexes?.length ?? 0} />
            {sortedIndexes === null ? null : sortedIndexes.length === 0 ? (
              <chakra.tbody>
                <chakra.tr>
                  <chakra.td css={tdCss} color="app.textMuted">
                    {t("structureNoIndexes")}
                  </chakra.td>
                </chakra.tr>
              </chakra.tbody>
            ) : (
              <>
                <chakra.thead>
                  <chakra.tr>
                    <chakra.th css={thCss}>{t("structureIndexName")}</chakra.th>
                    <chakra.th css={thCss}>{t("structureIndexColumns")}</chakra.th>
                    <chakra.th css={thCss}>{t("structureIndexKind")}</chakra.th>
                  </chakra.tr>
                </chakra.thead>
                <chakra.tbody>
                  {sortedIndexes.map((idx) => {
                    const kind = indexKind(idx);
                    return (
                      <chakra.tr key={idx.name}>
                        <chakra.td css={tdCss} fontFamily="var(--font-mono)">
                          {idx.name}
                        </chakra.td>
                        <chakra.td css={tdCss} fontFamily="var(--font-mono)" color="app.textSecondary">
                          {idx.columns.join(", ")}
                        </chakra.td>
                        <chakra.td css={tdCss}>
                          <Flex gap="1" align="center">
                            {kind === "primary" ? (
                              <KeyBadge kind="pk" label={keyLabel.pk} />
                            ) : kind === "unique" ? (
                              <KeyBadge kind="unique" label={keyLabel.unique} />
                            ) : null}
                            {idx.method && (
                              <chakra.span fontSize="xs" color="app.textMuted" fontFamily="var(--font-mono)">
                                {idx.method}
                              </chakra.span>
                            )}
                          </Flex>
                        </chakra.td>
                      </chakra.tr>
                    );
                  })}
                </chakra.tbody>
              </>
            )}
          </chakra.table>

          <chakra.table width="100%" style={{ borderCollapse: "collapse" }}>
            <SectionCaption label={t("structureForeignKeys")} count={fks.length} />
            {fks.length === 0 ? (
              <chakra.tbody>
                <chakra.tr>
                  <chakra.td css={tdCss} color="app.textMuted">
                    {t("structureNoForeignKeys")}
                  </chakra.td>
                </chakra.tr>
              </chakra.tbody>
            ) : (
              <>
                <chakra.thead>
                  <chakra.tr>
                    <chakra.th css={thCss}>{t("structureColName")}</chakra.th>
                    <chakra.th css={thCss}>{t("structureFkReferences")}</chakra.th>
                  </chakra.tr>
                </chakra.thead>
                <chakra.tbody>
                  {fks.map((fk) => (
                    <chakra.tr key={fk.column}>
                      <chakra.td css={tdCss} fontFamily="var(--font-mono)">
                        {fk.column}
                      </chakra.td>
                      <chakra.td css={tdCss}>
                        <ForeignKeyLink fk={fk} onSelect={selectReferenced} hint={fkHint} />
                      </chakra.td>
                    </chakra.tr>
                  ))}
                </chakra.tbody>
              </>
            )}
          </chakra.table>
        </>
      )}
    </Box>
  );
}
