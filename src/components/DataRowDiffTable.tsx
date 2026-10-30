import { useMemo, useState } from "react";
import { Box, chakra, Flex } from "@chakra-ui/react";

import type { DataDiff, DiffStatus, RowDiff } from "../api/tauri";
import { useT } from "../i18n";
import { formatCrossCell } from "./CrossDriverVerify";
import { statusColors } from "./diffStatusColors";
import { ActionMark, DiffFilterChip, detailTableCss, monoCellCss, statusLabel } from "./SchemaDiffDetail";
import { Button } from "./ui";

/**
 * 行データの差分を「操作 / キー / 更新先の現在 → 適用後」の表で見せる。スキーマ比較の
 * 行データ同期と、サンドボックスの書き戻し確認で使う。
 *
 * `DataDiff` は「更新先 (target) を基準 (source) に合わせる」向きで読む。行の
 * `source_only` = 追加 / `different` = 変更 / `target_only` = 削除。変更の矢印は
 * スキーマの詳細表と同じく「更新先の現在値 → 適用後 (基準の値)」の向きにそろえる。
 */

/** 一度に描画する行数。差分が数千行あっても重くならないよう、残りは「さらに表示」で足す。 */
export const DATA_ROW_PAGE = 50;
/** 追加 / 削除の行で、主キー以外に並べる列の数。 */
const PREVIEW_COLUMNS = 4;

const ROW_ORDER: readonly RowDiff["status"][] = ["different", "source_only", "target_only"];

export interface DataRowChange {
  column: string;
  current: string;
  next: string;
}

export interface DataRowView {
  status: RowDiff["status"];
  /** 「id=1, tenant=2」のような主キーの表示。 */
  key: string;
  /** 変更行の列ごとの「現在 → 適用後」。 */
  changes: DataRowChange[];
  /** 追加 / 削除の行の中身 (主キー以外の先頭数列)。 */
  preview: string;
}

/** 1 行分の差分を表示用に組み立てる (純関数)。 */
export function dataRowView(diff: DataDiff, row: RowDiff): DataRowView {
  const key = diff.primary_key.map((col, i) => `${col}=${formatCrossCell(row.key[i])}`).join(", ");
  const changes = row.changed_columns.map((column) => {
    const i = diff.columns.indexOf(column);
    return { column, current: formatCrossCell(row.target?.[i]), next: formatCrossCell(row.source?.[i]) };
  });
  const values = row.status === "target_only" ? row.target : row.source;
  const keyCols = new Set(diff.primary_key);
  const rest = diff.columns.map((col, i) => ({ col, i })).filter(({ col }) => !keyCols.has(col));
  const shown = rest.slice(0, PREVIEW_COLUMNS).map(({ col, i }) => `${col}=${formatCrossCell(values?.[i])}`);
  const preview = rest.length > PREVIEW_COLUMNS ? `${shown.join(", ")}, …` : shown.join(", ");
  return { status: row.status, key, changes, preview };
}

/** 操作ごとの行数。 */
export function countDataRows(diff: DataDiff): Record<RowDiff["status"], number> {
  const c = { source_only: 0, target_only: 0, different: 0 };
  for (const r of diff.rows) c[r.status] += 1;
  return c;
}

export function DataRowDiffTable({ diff }: { diff: DataDiff }) {
  const t = useT();
  const [hidden, setHidden] = useState<ReadonlySet<DiffStatus>>(new Set());
  const [limit, setLimit] = useState(DATA_ROW_PAGE);
  const counts = useMemo(() => countDataRows(diff), [diff]);
  const rows = useMemo(() => diff.rows.filter((r) => !hidden.has(r.status)), [diff, hidden]);

  if (diff.rows.length === 0) return null;
  const toggle = (status: DiffStatus) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  return (
    <Flex direction="column" gap="2">
      <Flex gap="1.5" flexWrap="wrap" role="group" aria-label={t("dataRowDiffFilter")}>
        {ROW_ORDER.filter((s) => counts[s] > 0).map((s) => (
          <DiffFilterChip
            key={s}
            status={s}
            count={counts[s]}
            active={!hidden.has(s)}
            onToggle={toggle}
            t={t}
          />
        ))}
      </Flex>
      {rows.length === 0 ? (
        <chakra.p m={0} textStyle="caption">
          {t("dataRowDiffEmpty")}
        </chakra.p>
      ) : (
        <Box maxH="320px" overflowY="auto" border="1px solid" borderColor="app.border" borderRadius="md">
          <chakra.table css={detailTableCss}>
            <thead>
              <tr>
                <th>{t("schemaCompareColOp")}</th>
                <th>{t("dataRowDiffColKey")}</th>
                <th>{t("dataRowDiffColChange")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map((row) => {
                const v = dataRowView(diff, row);
                return (
                  <tr key={`${row.status}:${v.key}`}>
                    <chakra.td whiteSpace="nowrap">
                      <Flex align="center" gap="1.5" css={{ color: statusColors(row.status).color }}>
                        <ActionMark status={row.status} />
                        {statusLabel(row.status, t)}
                      </Flex>
                    </chakra.td>
                    <chakra.td css={monoCellCss} whiteSpace="nowrap">
                      {v.key}
                    </chakra.td>
                    <td>
                      <RowChangeCell view={v} t={t} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </chakra.table>
        </Box>
      )}
      {rows.length > limit && (
        <Flex align="center" gap="2">
          <chakra.span textStyle="caption">
            {t("dataRowDiffShown", { shown: limit, total: rows.length })}
          </chakra.span>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setLimit((n) => n + DATA_ROW_PAGE)}
          >
            {t("dataRowDiffMore", { count: Math.min(DATA_ROW_PAGE, rows.length - limit) })}
          </Button>
        </Flex>
      )}
    </Flex>
  );
}

function RowChangeCell({ view, t }: { view: DataRowView; t: ReturnType<typeof useT> }) {
  if (view.status === "different") {
    return (
      <Flex direction="column" gap="0.5">
        {view.changes.map((c) => (
          <chakra.span key={c.column} css={monoCellCss} data-testid="data-row-change">
            {c.column}:{" "}
            <chakra.s color="app.textMuted" aria-label={t("schemaCompareCurrentValue", { value: c.current })}>
              {c.current}
            </chakra.s>{" "}
            → {c.next}
          </chakra.span>
        ))}
      </Flex>
    );
  }
  if (view.status === "target_only") {
    return (
      <chakra.span css={monoCellCss}>
        {t("dataRowDiffDeleteRow")} <chakra.s color="app.textMuted">{view.preview}</chakra.s>
      </chakra.span>
    );
  }
  return (
    <chakra.span css={monoCellCss}>
      {t("dataRowDiffInsertRow")} {view.preview}
    </chakra.span>
  );
}
