import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, chakra, Flex, VisuallyHidden, type SystemStyleObject } from "@chakra-ui/react";

import {
  api,
  type IndexInfo,
  type TableColumnInfo,
  type TableExtrasInfo,
  type TablePartition,
  type TablePartitions,
  type TableTrigger,
} from "../api/tauri";
import { type I18nKey, useT } from "../i18n";
import { type IncomingFk, incomingFkTableName } from "../fkNavigation";
import { foreignKeysOf, foreignKeyTargetLabel, type ExplorerForeignKey } from "./explorerTree";
import { EmptyState } from "./EmptyState";
import { errorIllustration } from "./illustrations";
import { Icon, ICON_SIZES } from "./Icon";
import { RevealTbody } from "./RevealTbody";
import { SkeletonTableRows } from "./Skeleton";
import { Tooltip } from "./Tooltip";
import { kindOfDataType, TypeGlyph } from "./TypeGlyph";
import { Button } from "./ui";
import { CopyButton } from "./CopyButton";
import { AddPartitionModal } from "./AddPartitionModal";
import { addPartitionKind, isMultiColumnList, rangeKeyKinds } from "./partitionAdd";
import { AttachPartitionModal } from "./AttachPartitionModal";
import { PartitionRibbon } from "./PartitionRibbon";
import {
  buildRibbon,
  HOT_FACTOR,
  partitionId,
  partitionShares,
  type PartitionShare,
} from "./partitionRibbon";
import { FieldError } from "./modalForm";
import { SqlPreview } from "./SqlPreview";
import { useCopyFeedback } from "./useCopyFeedback";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import {
  MAINTENANCE_LABEL_KEYS,
  partitionMaintenanceCommands,
  type MaintenanceCommand,
} from "./maintenanceCommands";
import { formatBytes, formatRowCount } from "./tableSize";
import {
  attachBoundKind,
  buildPartitionOpSql,
  formatPartitionBound,
  partitionDestructiveOps,
  type PartitionDestructiveOp,
} from "./tablePartitions";
import { isSynthesizedTableDdl, TABLE_DDL_KIND } from "./tableDdl";
import {
  indexKind,
  sortIndexes,
  structureColumnRows,
  structureIncomingRows,
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

/** NULL 可否の状態ピル。NOT NULL は強調し、NULL 可は淡色にする (#2125)。 */
function NullablePill({ nullable, label }: { nullable: boolean; label: string }) {
  return (
    <chakra.span
      display="inline-flex"
      alignItems="center"
      px="1.5"
      py="0.25"
      borderRadius="pill"
      borderWidth="1px"
      borderColor={nullable ? "app.borderSubtle" : "app.border"}
      bg={nullable ? "transparent" : "app.surfaceMuted"}
      fontSize="2xs"
      fontWeight={nullable ? 400 : 700}
      letterSpacing="wide"
      color={nullable ? "app.textMuted" : "app.text"}
      whiteSpace="nowrap"
    >
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

/** サイズ / 行数の列に添える、合計に対する割合のインラインバー (#2238)。偏りには warning の印を付ける。 */
function ShareBar({ share, hot, ratio }: { share: number | null; hot: boolean; ratio: number | null }) {
  const t = useT();
  if (share === null) return null;
  const percent = Math.round(share * 100);
  return (
    <Flex align="center" gap="1" justify="flex-end" data-testid="partition-share-bar">
      {hot && (
        <Tooltip label={t("partitionBarHot", { factor: HOT_FACTOR })}>
          <chakra.span color="app.textWarning" textStyle="caption">
            <VisuallyHidden>{t("partitionBarHot", { factor: HOT_FACTOR })}</VisuallyHidden>
            <span aria-hidden="true">▲{ratio !== null ? ` ${ratio.toFixed(1)}x` : ""}</span>
          </chakra.span>
        </Tooltip>
      )}
      <chakra.div className="pr-bar" data-hot={hot} w="16" aria-hidden="true">
        <div className="pr-bar-fill" style={{ width: `${Math.max(2, percent)}%` }} />
      </chakra.div>
      <chakra.span textStyle="caption" color="app.textMuted" minW="8" textAlign="right">
        <VisuallyHidden>{t("partitionBarShare", { percent })}</VisuallyHidden>
        <span aria-hidden="true">{percent}%</span>
      </chakra.span>
    </Flex>
  );
}

function SectionCaption({ label, count }: { label: string; count: number }) {
  return (
    <chakra.caption textAlign="left" textStyle="overline" color="app.textMuted" paddingBottom="1">
      {label} <chakra.span textStyle="numeric">({count})</chakra.span>
    </chakra.caption>
  );
}

type DdlState =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "ready"; ddl: string }
  | { kind: "error"; message: string };

/** パーティション行の操作ボタン (保守 / 破壊的操作のメニューを開く, #1868)。 */
function PartitionActions({
  label,
  items,
  disabledTitle,
}: {
  label: string;
  items: ContextMenuEntry[];
  /** 無効のときの理由 (read_only)。 */
  disabledTitle?: string;
}) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const open = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setMenu({ x: r.left, y: r.bottom + 2 });
  };
  return (
    <>
      <Tooltip label={disabledTitle ?? label} focusableWrapper={!!disabledTitle}>
        <Button
          ref={btnRef}
          type="button"
          variant="secondary"
          size="sm"
          aria-label={label}
          aria-haspopup="menu"
          disabled={!!disabledTitle}
          onClick={open}
        >
          <Icon name="more" size={ICON_SIZES.md} />
        </Button>
      </Tooltip>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </>
  );
}

const PARTITION_OP_LABEL_KEYS = {
  truncate: "partitionOpTruncate",
  detach: "partitionOpDetach",
  drop: "partitionOpDrop",
} as const satisfies Record<PartitionDestructiveOp, I18nKey>;

export function TableStructurePanel({
  sessionId,
  driver,
  target,
  readOnly = false,
  onOpenData,
  onSelectTable,
  onRunPartitionMaintenance,
  onPartitionOp,
  onAttachPartition,
  onAddPartitions,
}: {
  sessionId: string;
  driver: string;
  target: StructureTarget;
  /** 同じテーブルのデータタブを開く (ツリーのダブルクリックと同じ `handleOpenTable`)。 */
  onOpenData: (database: string, table: string) => void;
  /** 構造パネルの対象を切り替える (外部キーの参照先へ移るとき)。 */
  onSelectTable: (target: StructureTarget) => void;
  /** 読み取り専用接続では、パーティションの保守 / 削除メニューを無効にする。 */
  readOnly?: boolean;
  /**
   * パーティションの保守コマンド (ANALYZE 等) を確認のうえ実行する (App の既存保守経路)。
   * 実行できたら true — パネルは一覧を取り直す。
   */
  onRunPartitionMaintenance?: (
    database: string,
    table: string,
    partition: TablePartition,
    command: MaintenanceCommand,
  ) => Promise<boolean>;
  /** TRUNCATE / DETACH / DROP を強確認 (本番では型入力) のうえ実行する。実行できたら true。 */
  onPartitionOp?: (
    database: string,
    table: string,
    partition: TablePartition,
    op: PartitionDestructiveOp,
    sql: string,
  ) => Promise<boolean>;
  /** 既存のテーブルを ATTACH PARTITION する (PostgreSQL)。確認のうえ実行し、実行できたら true (#1929)。 */
  onAttachPartition?: (database: string, table: string, child: string, sql: string) => Promise<boolean>;
  /** 次のパーティションを追加する (PostgreSQL の PARTITION OF / MySQL の ADD・REORGANIZE PARTITION)。確認と DDL ゲートのうえ実行し、実行できたら true (#2211)。 */
  onAddPartitions?: (
    database: string,
    table: string,
    statements: string[],
    count: number,
  ) => Promise<boolean>;
}) {
  const t = useT();
  const [columns, setColumns] = useState<TableColumnInfo[] | null>(null);
  const [indexes, setIndexes] = useState<IndexInfo[] | null>(null);
  // CHECK 制約と生成列の式 (#1837)。ベストエフォート: 取れなければ節ごと出さない。
  const [extras, setExtras] = useState<TableExtrasInfo | null>(null);
  // このテーブルで発火するトリガー (#1867)。ベストエフォート: 取れなければ節ごと出さない。
  const [triggers, setTriggers] = useState<TableTrigger[] | null>(null);
  const [triggersFailed, setTriggersFailed] = useState(false);
  // パーティション表の子パーティション (#1868)。ベストエフォート。SQLite は非対応なので呼ばず節も出さない。
  const [partitions, setPartitions] = useState<TablePartitions | null>(null);
  const [partitionsFailed, setPartitionsFailed] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // 帯のセグメントと一覧の行の相互ハイライト (#2238)。`partitionId` のキー。
  const [activePartition, setActivePartition] = useState<string | null>(null);
  // このテーブルを参照している他テーブルの外部キー (逆方向, #1628)。ベストエフォート。
  const [incoming, setIncoming] = useState<IncomingFk[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // CREATE TABLE の DDL (#1540)。見るまで取得しない (get_object_definition は
  // 構造パネルを開くたびに要るものではないため)。テーブルや再読み込みで破棄する。
  const [ddl, setDdl] = useState<DdlState>({ kind: "hidden" });
  const { copied: ddlCopied, copy: copyDdl } = useCopyFeedback();
  // DDL 取得の世代。テーブル切替・再読み込み・再取得のたびに進め、古い応答を捨てる
  // (A の応答が B を表示中に届いて、B の欄に A の DDL が出るのを防ぐ)。
  const ddlSeq = useRef(0);

  const { database, table } = target;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey は本体では使わず、再読み込みボタンで同じテーブルを取り直すためのトリガー
  useEffect(() => {
    let cancelled = false;
    setColumns(null);
    setIndexes(null);
    setExtras(null);
    setTriggers(null);
    setTriggersFailed(false);
    setPartitions(null);
    setPartitionsFailed(false);
    setIncoming(null);
    setError(null);
    ddlSeq.current += 1;
    setDdl({ kind: "hidden" });
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
    // CHECK 制約・生成式もベストエフォート (古い MySQL など取れない環境では節ごと出さない)。
    Promise.resolve()
      .then(() => api.describeTableExtras(sessionId, database, table))
      .then((e) => {
        if (!cancelled) setExtras(e);
      })
      .catch(() => {
        if (!cancelled) setExtras(null);
      });
    // トリガーもベストエフォート: 副作用の把握用なので、取れなければ節を出さない。
    Promise.resolve()
      .then(() => api.listTableTriggers(sessionId, database, table))
      .then((list) => {
        if (!cancelled) setTriggers(list);
      })
      .catch(() => {
        if (!cancelled) setTriggersFailed(true);
      });
    // パーティション表なら子の一覧 (#1868)。SQLite はパーティション非対応なので問い合わせない。
    if (driver !== "sqlite") {
      Promise.resolve()
        .then(() => api.listTablePartitions(sessionId, database, table))
        .then((list) => {
          if (!cancelled) setPartitions(list);
        })
        .catch(() => {
          if (!cancelled) setPartitionsFailed(true);
        });
    }
    // 逆方向の外部キーもベストエフォート: 取れなくても構造は出す。
    api
      .incomingForeignKeys(sessionId, database, table)
      .then((list) => {
        if (!cancelled) setIncoming(list);
      })
      .catch(() => {
        if (!cancelled) setIncoming([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, driver, database, table, reloadKey]);

  const showDdl = useCallback(() => {
    const seq = ++ddlSeq.current;
    setDdl({ kind: "loading" });
    api
      .getObjectDefinition(sessionId, database, TABLE_DDL_KIND, table, null)
      .then((text) => {
        if (seq === ddlSeq.current) setDdl({ kind: "ready", ddl: text });
      })
      .catch((e) => {
        if (seq === ddlSeq.current) setDdl({ kind: "error", message: String(e) });
      });
  }, [sessionId, database, table]);

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
  const incomingRows = incoming ? structureIncomingRows(incoming) : null;

  // パーティション表の見出し行 (例: `RANGE (created_at)` / MySQL のサブパーティション付きは `... / HASH (id)`)。
  // 既存のテーブルを付け直せる分割方式か (PostgreSQL の RANGE / LIST / HASH, #1929)。
  const attachKind = partitions && onAttachPartition ? attachBoundKind(driver, partitions) : null;
  // 次のパーティションを追加できる分割方式か (PostgreSQL の RANGE / LIST / HASH、MySQL の RANGE / LIST / HASH / KEY, #2211)。
  const addKind = partitions && onAddPartitions ? addPartitionKind(driver, partitions) : null;
  // 複数列の LIST はタプル入力に未対応なので、導線を無効にして理由を見せる。
  const addMultiList =
    addKind === null &&
    !!partitions &&
    !!onAddPartitions &&
    (driver === "postgres" || (driver === "mysql" && !partitions.sub_method)) &&
    isMultiColumnList(partitions);
  const addKeyKinds = useMemo(
    () => (partitions ? rangeKeyKinds(driver, partitions, columns) : undefined),
    [driver, partitions, columns],
  );
  const ribbon = useMemo(
    () =>
      partitions && partitions.partitions.length > 0 && partitions.method !== ""
        ? buildRibbon(driver, partitions, addKeyKinds)
        : null,
    [driver, partitions, addKeyKinds],
  );
  const shares = useMemo(
    () => (partitions ? partitionShares(partitions.partitions) : new Map<string, PartitionShare>()),
    [partitions],
  );

  const partitionSummary = (info: TablePartitions) =>
    t("structurePartitionedBy", {
      method: info.method,
      key: info.key,
    }) + (info.sub_method ? ` / ${info.sub_method} (${info.sub_key ?? ""})` : "");

  // 行ごとの操作メニュー: 保守 (確認 → 実行) と破壊的操作 (強確認 → 実行)。成功したら一覧を取り直す。
  const partitionMenuItems = (p: TablePartition): ContextMenuEntry[] => {
    // MySQL のサブパーティションは操作を出さない (未検証)。
    if (!partitions || (driver === "mysql" && p.depth > 0)) return [];
    const items: ContextMenuEntry[] = [];
    if (onRunPartitionMaintenance) {
      for (const command of partitionMaintenanceCommands(driver, database, table, p)) {
        items.push({
          label: t(MAINTENANCE_LABEL_KEYS[command.kind]),
          onSelect: () => {
            void onRunPartitionMaintenance(database, table, p, command).then((ok) => {
              if (ok) reload();
            });
          },
        });
      }
    }
    const ops = onPartitionOp ? partitionDestructiveOps(driver, partitions, p) : [];
    if (ops.length > 0) {
      if (items.length > 0) items.push({ separator: true });
      for (const op of ops) {
        items.push({
          label: t(PARTITION_OP_LABEL_KEYS[op]),
          danger: true,
          onSelect: () => {
            void onPartitionOp?.(
              database,
              table,
              p,
              op,
              buildPartitionOpSql(op, driver, database, table, p),
            ).then((ok) => {
              if (ok) reload();
            });
          },
        });
      }
    }
    return items;
  };

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
        <Tooltip label={t("structureReload")} focusableWrapper={!rows && !error}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-label={t("structureReload")}
            onClick={reload}
            disabled={!rows && !error}
          >
            <Icon name="refresh" size={ICON_SIZES.md} />
          </Button>
        </Tooltip>
      </Flex>

      {error ? (
        <EmptyState
          illustration={errorIllustration(error)}
          icon="warning"
          title={t("structureLoadError", { error })}
          action={{ label: t("structureReload"), onClick: reload }}
        />
      ) : (
        <>
          {!rows && (
            // シマーは aria-hidden なので、読み込み中であることは別途告知する (#1174)。
            <VisuallyHidden role="status" aria-live="polite">
              {t("structureLoading")}
            </VisuallyHidden>
          )}
          <chakra.table width="100%" style={{ borderCollapse: "collapse" }}>
            <SectionCaption label={t("structureColumns")} count={rows?.length ?? 0} />
            <chakra.thead>
              <chakra.tr>
                <chakra.th css={thCss} textAlign="right">
                  #
                </chakra.th>
                <chakra.th css={thCss}>{t("structureColName")}</chakra.th>
                <chakra.th css={thCss}>{t("structureColType")}</chakra.th>
                <chakra.th css={thCss}>{t("structureColNullable")}</chakra.th>
                <chakra.th css={thCss}>{t("structureColDefault")}</chakra.th>
                <chakra.th css={thCss}>{t("structureColKeys")}</chakra.th>
              </chakra.tr>
            </chakra.thead>
            {!rows ? (
              // 初回ロード中 (まだ 1 件も取得していない): 裸のヘッダのみ表示を
              // 避け、6 列の構造をシマーで予兆表示する (#846 の横展開、#1174)。
              <chakra.tbody>
                <SkeletonTableRows columns={6} />
              </chakra.tbody>
            ) : (
              // 実データの行はスケルトンと別要素にして、着弾の 1 回だけリビールする (#1886)。
              <RevealTbody>
                {rows.map((r) => (
                  <chakra.tr key={r.name}>
                    <chakra.td css={tdCss} textAlign="right" textStyle="numeric" color="app.textMuted">
                      {r.position}
                    </chakra.td>
                    <chakra.td css={tdCss}>
                      <chakra.div fontFamily="var(--font-mono)">{r.name}</chakra.div>
                      {r.comment && <chakra.div textStyle="caption">{r.comment}</chakra.div>}
                    </chakra.td>
                    <chakra.td css={tdCss} fontFamily="var(--font-mono)" color="app.textSecondary">
                      <Flex align="center" gap="1.5">
                        <TypeGlyph kind={kindOfDataType(r.dataType)} tooltip />
                        {r.dataType}
                      </Flex>
                    </chakra.td>
                    <chakra.td css={tdCss}>
                      <NullablePill
                        nullable={r.nullable}
                        label={r.nullable ? t("structureNullableYes") : t("structureNullableNo")}
                      />
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
              </RevealTbody>
            )}
          </chakra.table>

          {rows && (
            <>
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
                    <RevealTbody>
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
                                  <chakra.span
                                    fontSize="xs"
                                    color="app.textMuted"
                                    fontFamily="var(--font-mono)"
                                  >
                                    {idx.method}
                                  </chakra.span>
                                )}
                              </Flex>
                            </chakra.td>
                          </chakra.tr>
                        );
                      })}
                    </RevealTbody>
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
                    <RevealTbody>
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
                    </RevealTbody>
                  </>
                )}
              </chakra.table>

              {extras && extras.checks.length > 0 && (
                <chakra.table width="100%" style={{ borderCollapse: "collapse" }}>
                  <SectionCaption label={t("structureChecks")} count={extras.checks.length} />
                  <chakra.thead>
                    <chakra.tr>
                      <chakra.th css={thCss}>{t("structureCheckName")}</chakra.th>
                      <chakra.th css={thCss}>{t("structureCheckDefinition")}</chakra.th>
                    </chakra.tr>
                  </chakra.thead>
                  <RevealTbody>
                    {extras.checks.map((c, i) => (
                      <chakra.tr key={`${c.name}:${i}`}>
                        <chakra.td css={tdCss} fontFamily="var(--font-mono)">
                          {c.name === "" ? "—" : c.name}
                        </chakra.td>
                        <chakra.td css={tdCss} fontFamily="var(--font-mono)" color="app.textSecondary">
                          {c.definition}
                        </chakra.td>
                      </chakra.tr>
                    ))}
                  </RevealTbody>
                </chakra.table>
              )}

              {extras && extras.generated.length > 0 && (
                <chakra.table width="100%" style={{ borderCollapse: "collapse" }}>
                  <SectionCaption label={t("structureGeneratedColumns")} count={extras.generated.length} />
                  <chakra.thead>
                    <chakra.tr>
                      <chakra.th css={thCss}>{t("structureColName")}</chakra.th>
                      <chakra.th css={thCss}>{t("structureGeneratedExpression")}</chakra.th>
                      <chakra.th css={thCss}>{t("structureGeneratedStorage")}</chakra.th>
                    </chakra.tr>
                  </chakra.thead>
                  <RevealTbody>
                    {extras.generated.map((g) => (
                      <chakra.tr key={g.column}>
                        <chakra.td css={tdCss} fontFamily="var(--font-mono)">
                          {g.column}
                        </chakra.td>
                        <chakra.td css={tdCss} fontFamily="var(--font-mono)" color="app.textSecondary">
                          {g.expression}
                        </chakra.td>
                        <chakra.td css={tdCss} fontFamily="var(--font-mono)" color="app.textMuted">
                          {g.is_virtual ? "VIRTUAL" : "STORED"}
                        </chakra.td>
                      </chakra.tr>
                    ))}
                  </RevealTbody>
                </chakra.table>
              )}

              {triggers && triggers.length > 0 && (
                <chakra.table width="100%" style={{ borderCollapse: "collapse" }}>
                  <SectionCaption label={t("structureTriggers")} count={triggers.length} />
                  <chakra.thead>
                    <chakra.tr>
                      <chakra.th css={thCss}>{t("structureTriggerName")}</chakra.th>
                      <chakra.th css={thCss}>{t("structureTriggerTiming")}</chakra.th>
                      <chakra.th css={thCss}>{t("structureTriggerEvent")}</chakra.th>
                      <chakra.th css={thCss}>{t("structureTriggerDefinition")}</chakra.th>
                    </chakra.tr>
                  </chakra.thead>
                  <chakra.tbody>
                    {triggers.map((tr) => (
                      <chakra.tr key={tr.name}>
                        <chakra.td css={tdCss} fontFamily="var(--font-mono)">
                          {tr.name}
                          {!tr.enabled && (
                            <chakra.span color="app.textMuted"> {t("structureTriggerDisabled")}</chakra.span>
                          )}
                        </chakra.td>
                        <chakra.td css={tdCss} fontFamily="var(--font-mono)">
                          {tr.timing}
                        </chakra.td>
                        <chakra.td css={tdCss} fontFamily="var(--font-mono)">
                          {tr.event}
                        </chakra.td>
                        <chakra.td css={tdCss} fontFamily="var(--font-mono)" color="app.textSecondary">
                          {tr.definition !== "" && (
                            <details>
                              <summary style={{ cursor: "pointer" }}>
                                {t("structureTriggerShowDefinition")}
                              </summary>
                              <SqlPreview
                                sql={tr.definition}
                                driver={driver}
                                maxH="160px"
                                aria-label={tr.name}
                              />
                            </details>
                          )}
                        </chakra.td>
                      </chakra.tr>
                    ))}
                  </chakra.tbody>
                  <chakra.tfoot>
                    <chakra.tr>
                      <chakra.td css={tdCss} colSpan={4} color="app.textMuted">
                        {t("structureTriggerNote")}
                      </chakra.td>
                    </chakra.tr>
                  </chakra.tfoot>
                </chakra.table>
              )}

              {triggersFailed && (
                <chakra.div textStyle="caption" color="app.textMuted">
                  {t("structureTriggers")}: {t("structureTriggersFailed")}
                </chakra.div>
              )}

              {partitions &&
                (partitions.partitions.length > 0 ||
                  attachKind !== null ||
                  addKind !== null ||
                  addMultiList) && (
                  <>
                    {ribbon && ribbon.segments.length > 0 && (
                      <PartitionRibbon
                        ribbon={ribbon}
                        ariaLabel={t("partitionRibbonAria", { method: partitions.method })}
                        activeId={activePartition}
                        onActive={setActivePartition}
                      />
                    )}
                    <chakra.table width="100%" style={{ borderCollapse: "collapse" }}>
                      <SectionCaption label={t("structurePartitions")} count={partitions.partitions.length} />
                      <chakra.thead>
                        <chakra.tr>
                          <chakra.th css={thCss}>{t("structurePartitionName")}</chakra.th>
                          <chakra.th css={thCss}>{t("structurePartitionBound")}</chakra.th>
                          <chakra.th css={thCss} textAlign="right">
                            {t("structurePartitionSize")}
                          </chakra.th>
                          <chakra.th css={thCss} textAlign="right">
                            {t("structurePartitionRows")}
                          </chakra.th>
                          <chakra.th css={thCss}>
                            <VisuallyHidden>{t("structurePartitionActions")}</VisuallyHidden>
                          </chakra.th>
                        </chakra.tr>
                      </chakra.thead>
                      <chakra.tbody>
                        <chakra.tr>
                          <chakra.td
                            css={tdCss}
                            colSpan={attachKind !== null || addKind !== null || addMultiList ? 4 : 5}
                            color="app.textMuted"
                            fontFamily="var(--font-mono)"
                          >
                            {partitionSummary(partitions)}
                          </chakra.td>
                          {(attachKind !== null || addKind !== null || addMultiList) && (
                            <chakra.td css={tdCss} textAlign="right">
                              <Flex justify="flex-end" gap="2">
                                {addMultiList && (
                                  <Tooltip label={t("partitionAddMultiListUnsupported")} focusableWrapper>
                                    <Button type="button" variant="secondary" size="sm" disabled>
                                      {t("partitionAddOpen")}
                                    </Button>
                                  </Tooltip>
                                )}
                                {addKind !== null && (
                                  <Tooltip
                                    label={readOnly ? t("listReadOnlyTitle") : t("partitionAddOpen")}
                                    focusableWrapper={readOnly}
                                  >
                                    <Button
                                      type="button"
                                      variant="secondary"
                                      size="sm"
                                      disabled={readOnly}
                                      onClick={() => setAddOpen(true)}
                                    >
                                      {t("partitionAddOpen")}
                                    </Button>
                                  </Tooltip>
                                )}
                                {attachKind !== null && (
                                  <Tooltip
                                    label={readOnly ? t("listReadOnlyTitle") : t("attachPartitionOpen")}
                                    focusableWrapper={readOnly}
                                  >
                                    <Button
                                      type="button"
                                      variant="secondary"
                                      size="sm"
                                      disabled={readOnly}
                                      onClick={() => setAttachOpen(true)}
                                    >
                                      {t("attachPartitionOpen")}
                                    </Button>
                                  </Tooltip>
                                )}
                              </Flex>
                            </chakra.td>
                          )}
                        </chakra.tr>
                        {partitions.partitions.map((p) => {
                          const pid = partitionId(p);
                          const sh = shares.get(pid);
                          return (
                            <chakra.tr
                              key={pid}
                              className="pr-row"
                              data-active={activePartition === pid}
                              onMouseEnter={() => setActivePartition(pid)}
                              onMouseLeave={() => setActivePartition(null)}
                              onFocus={() => setActivePartition(pid)}
                              onBlur={() => setActivePartition(null)}
                            >
                              <chakra.td
                                css={tdCss}
                                fontFamily="var(--font-mono)"
                                paddingLeft={`calc(var(--space-2) + ${p.depth} * var(--space-4))`}
                              >
                                {p.name}
                                {p.is_default && (
                                  <chakra.span color="app.textMuted">
                                    {" "}
                                    {t("structurePartitionDefault")}
                                  </chakra.span>
                                )}
                                {p.sub_partition_key && (
                                  <chakra.span color="app.textMuted"> [{p.sub_partition_key}]</chakra.span>
                                )}
                              </chakra.td>
                              <chakra.td css={tdCss} fontFamily="var(--font-mono)" color="app.textSecondary">
                                {formatPartitionBound(p.bound)}
                              </chakra.td>
                              <chakra.td css={tdCss} textStyle="numeric" textAlign="right">
                                {formatBytes(p.size_bytes)}
                                <ShareBar
                                  share={sh?.sizeShare ?? null}
                                  hot={sh?.sizeHot ?? false}
                                  ratio={sh?.sizeRatio ?? null}
                                />
                              </chakra.td>
                              <chakra.td css={tdCss} textStyle="numeric" textAlign="right">
                                {formatRowCount(p.row_estimate)}
                                <ShareBar
                                  share={sh?.rowShare ?? null}
                                  hot={sh?.rowHot ?? false}
                                  ratio={sh?.rowRatio ?? null}
                                />
                              </chakra.td>
                              <chakra.td css={tdCss} textAlign="right">
                                {(onRunPartitionMaintenance || onPartitionOp) &&
                                  partitionMenuItems(p).length > 0 && (
                                    <PartitionActions
                                      label={t("structurePartitionActionsFor", { partition: p.name })}
                                      items={partitionMenuItems(p)}
                                      disabledTitle={readOnly ? t("listReadOnlyTitle") : undefined}
                                    />
                                  )}
                              </chakra.td>
                            </chakra.tr>
                          );
                        })}
                      </chakra.tbody>
                    </chakra.table>
                  </>
                )}

              {partitionsFailed && (
                <chakra.div textStyle="caption" color="app.textMuted">
                  {t("structurePartitions")}: {t("structurePartitionsFailed")}
                </chakra.div>
              )}

              <chakra.table width="100%" style={{ borderCollapse: "collapse" }}>
                <SectionCaption label={t("structureIncomingForeignKeys")} count={incomingRows?.length ?? 0} />
                {incomingRows === null ? null : incomingRows.length === 0 ? (
                  <chakra.tbody>
                    <chakra.tr>
                      <chakra.td css={tdCss} color="app.textMuted">
                        {t("structureNoIncomingForeignKeys")}
                      </chakra.td>
                    </chakra.tr>
                  </chakra.tbody>
                ) : (
                  <>
                    <chakra.thead>
                      <chakra.tr>
                        <chakra.th css={thCss}>{t("structureIncomingFrom")}</chakra.th>
                        <chakra.th css={thCss}>{t("structureFkReferences")}</chakra.th>
                      </chakra.tr>
                    </chakra.thead>
                    <RevealTbody>
                      {incomingRows.map((fk) => (
                        <chakra.tr key={`${fk.schema ?? ""}.${fk.table}.${fk.column}.${fk.referencedColumn}`}>
                          <chakra.td css={tdCss}>
                            <ForeignKeyLink
                              fk={{
                                column: fk.column,
                                referencedTable: incomingFkTableName(fk),
                                referencedColumn: fk.column,
                              }}
                              // 別スキーマの子 (#1786) はそのスキーマのテーブルとして開く。
                              onSelect={() =>
                                onSelectTable({ database: fk.schema ?? database, table: fk.table })
                              }
                              hint={t("structureOpenReferencingHint")}
                            />
                          </chakra.td>
                          <chakra.td css={tdCss} fontFamily="var(--font-mono)" color="app.textSecondary">
                            {table}.{fk.referencedColumn}
                          </chakra.td>
                        </chakra.tr>
                      ))}
                    </RevealTbody>
                  </>
                )}
              </chakra.table>

              <chakra.section display="flex" flexDirection="column" gap="1.5" aria-label={t("structureDdl")}>
                <Flex align="center" gap="2">
                  <chakra.span textStyle="overline" color="app.textMuted">
                    {t("structureDdl")}
                  </chakra.span>
                  {ddl.kind === "hidden" || ddl.kind === "error" ? (
                    <Button type="button" variant="secondary" size="sm" onClick={showDdl}>
                      {t("structureDdlShow")}
                    </Button>
                  ) : null}
                  {ddl.kind === "ready" && (
                    <CopyButton
                      copied={ddlCopied}
                      onClick={() => void copyDdl(ddl.ddl)}
                      label={t("structureDdlCopy")}
                      copiedLabel={t("gridCopied")}
                    />
                  )}
                </Flex>
                {ddl.kind === "loading" && (
                  <chakra.div role="status" textStyle="caption">
                    {t("structureDdlLoading")}
                  </chakra.div>
                )}
                {ddl.kind === "error" && (
                  <FieldError>{t("structureDdlError", { error: ddl.message })}</FieldError>
                )}
                {ddl.kind === "ready" && (
                  <>
                    <SqlPreview sql={ddl.ddl} driver={driver} maxH="320px" aria-label={t("structureDdl")} />
                    {isSynthesizedTableDdl(driver) && (
                      <chakra.div textStyle="caption">{t("tableDdlSynthesizedHint")}</chakra.div>
                    )}
                  </>
                )}
              </chakra.section>
            </>
          )}
        </>
      )}
      {addOpen && partitions && addKind !== null && (
        <AddPartitionModal
          database={database}
          table={table}
          driver={driver}
          info={partitions}
          kind={addKind}
          keyKinds={addKeyKinds}
          onClose={() => setAddOpen(false)}
          onConfirm={(statements, count) => {
            setAddOpen(false);
            void onAddPartitions?.(database, table, statements, count).then((ok) => {
              if (ok) reload();
            });
          }}
        />
      )}
      {attachOpen && partitions && attachKind !== null && (
        <AttachPartitionModal
          sessionId={sessionId}
          database={database}
          table={table}
          info={partitions}
          kind={attachKind}
          onClose={() => setAttachOpen(false)}
          onConfirm={(child, sql) => {
            setAttachOpen(false);
            void onAttachPartition?.(database, table, child, sql).then((ok) => {
              if (ok) reload();
            });
          }}
        />
      )}
    </Box>
  );
}
