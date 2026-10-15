import { useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api, type ConnectionProfile } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { semanticColorToken } from "../semanticColors";
import {
  buildMetricRows,
  baselineIndex,
  buildTopValueRows,
  compareExportTable,
  countMetricDifferences,
  topValueCellDiffers,
  topValueRowDiffers,
  type CompareEntry,
  type MetricId,
} from "./columnProfileCompare";
import { formatPercent, profileTargetLabel, type ProfileTarget } from "./columnProfile";
import type { ConfirmOptions } from "./ConfirmDialog";
import { Callout } from "./Callout";
import { ErrorNote } from "./modalForm";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { ProductionBadge, ProfileColorChip } from "./ProfileBadge";
import { Spinner } from "./Spinner";
import { TextExportButton } from "./TextExportButton";
import { tableToCsv, tableToMarkdown } from "./tabularText";
import { Button, Checkbox, Input } from "./ui";

/**
 * 同じ列の分布を複数の接続で並べて比べる (#1539)。移行・同期の検証で「本番と検証環境で
 * 列の分布が一致するか」を確かめる。接続の選び方は環境横断ブロードキャスト
 * (`BroadcastModal`) と同じ発想で、現在の接続を基準に、開いている他の接続を選ぶ。
 * 各接続で既存の `profile_column` を呼ぶだけで新しい SQL は無い (全件集計なので、
 * 本番接続を含めるときは確認を挟む)。差の判定と整形は `columnProfileCompare.ts`。
 *
 * 置き場は Modal: 「接続を選んで、比べて、閉じる」一時的な操作で、SQL を書きながら
 * 見続ける情報ではないため。既存の列プロファイルパネルは変更せず、入口のボタンだけを足す。
 */

export interface CompareCandidate {
  sessionId: string;
  profile: ConnectionProfile;
}

interface Props {
  baseline: CompareCandidate;
  candidates: CompareCandidate[];
  driver: string;
  target: ProfileTarget & { column: string };
  approximate: boolean;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  onClose: () => void;
}

const METRIC_LABEL: Record<MetricId, I18nKey> = {
  type: "profileType",
  total: "profileTotal",
  nulls: "profileNulls",
  nullPct: "profileCompareNullPct",
  distinct: "profileDistinct",
  min: "profileMin",
  max: "profileMax",
};

const diffBg = semanticColorToken("warning", "subtle");
const diffFg = semanticColorToken("warning", "text");

function ConnHeader({
  c,
  isBaseline,
  database,
}: {
  c: CompareCandidate;
  isBaseline: boolean;
  database: string;
}) {
  const t = useT();
  return (
    <chakra.th textAlign="left" px="2.5" py="1.5" verticalAlign="bottom" minW="160px">
      <Flex align="center" gap="1.5" fontWeight={600}>
        {c.profile.color && <ProfileColorChip color={c.profile.color} size={12} />}
        <chakra.span>{c.profile.name}</chakra.span>
        {c.profile.is_production && <ProductionBadge compact />}
      </Flex>
      <chakra.div textStyle="caption" fontWeight={400}>
        {database}
        {isBaseline ? ` · ${t("profileCompareBaseline")}` : ""}
      </chakra.div>
    </chakra.th>
  );
}

export function ColumnProfileCompareModal({
  baseline,
  candidates,
  driver,
  target,
  approximate,
  confirm,
  onClose,
}: Props) {
  const t = useT();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [databases, setDatabases] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<"pick" | "result">("pick");
  const [entries, setEntries] = useState<CompareEntry[]>([]);
  const [running, setRunning] = useState(false);
  const runSeq = useRef(0);
  const dbOf = (c: CompareCandidate) => databases[c.sessionId] ?? target.database;

  // 閉じた後に遅れて返った結果で state を更新しない。
  useEffect(
    () => () => {
      runSeq.current++;
    },
    [],
  );

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const targets = useMemo(
    () => [baseline, ...candidates.filter((c) => selected.has(c.sessionId))],
    [baseline, candidates, selected],
  );

  const run = async () => {
    if (selected.size === 0 || running) return;
    // 基準 (今の接続) も `profile_column` でもう一度集計する (全件走査) ので、基準が本番接続の
    // ときも含めて、本番接続があれば実行前に確認する。
    const prod = targets.filter((c) => c.profile.is_production);
    if (prod.length > 0) {
      const ok = await confirm({
        title: t("profileCompareProdTitle"),
        message: t("profileCompareProdMessage", { names: prod.map((c) => c.profile.name).join(", ") }),
        confirmLabel: t("profileCompareRun"),
        tone: "warning",
      });
      if (!ok) return;
    }
    const seq = ++runSeq.current;
    const dbs = targets.map((c) => (c === baseline ? target.database : dbOf(c)));
    setEntries(
      targets.map((c, i) => ({
        id: c.sessionId,
        label: `${c.profile.name} (${dbs[i]})`,
        profile: null,
        error: null,
      })),
    );
    setPhase("result");
    setRunning(true);
    await Promise.all(
      targets.map(async (c, i) => {
        try {
          const p = await api.profileColumn(c.sessionId, dbs[i], target.table, target.column, approximate);
          if (seq === runSeq.current)
            setEntries((prev) => prev.map((e, j) => (j === i ? { ...e, profile: p } : e)));
        } catch (e) {
          if (seq === runSeq.current)
            setEntries((prev) => prev.map((x, j) => (j === i ? { ...x, error: String(e) } : x)));
        }
      }),
    );
    if (seq === runSeq.current) setRunning(false);
  };

  const metricRows = useMemo(() => buildMetricRows(entries), [entries]);
  const topRows = useMemo(() => buildTopValueRows(entries), [entries]);
  const diffCount =
    countMetricDifferences(metricRows) + topRows.filter((r) => topValueRowDiffers(r, entries)).length;
  const fetched = entries.filter((e) => e.profile).length;
  /** 画面と同じ判定・表記の書き出し表。クリック時にだけ組む (#1624)。 */
  const buildExportTable = () =>
    compareExportTable(entries, {
      section: t("profileCompareExportSection"),
      item: t("profileCompareExportItem"),
      differs: t("profileCompareExportDiffers"),
      sectionMetric: t("profileCompareExportMetric"),
      sectionTop: t("profileCompareExportTop"),
      metric: Object.fromEntries(
        (Object.keys(METRIC_LABEL) as MetricId[]).map((k) => [k, t(METRIC_LABEL[k])]),
      ) as Record<MetricId, string>,
      absent: t("profileCompareAbsent"),
    });
  // 基準は「取得できた最初の接続」(columnProfileCompare.baselineIndex)。今の接続の取得に失敗した
  // ときは次の接続が基準になるので、見出しの「基準」表示もそれに合わせる。まだ何も取れていない間は先頭。
  const baseHeaderIdx = Math.max(0, baselineIndex(entries));

  if (phase === "pick") {
    return (
      <Modal onSubmit={() => void run()} submitDisabled={selected.size === 0} onClose={onClose} width="560px">
        <ModalHeader onClose={onClose} closeLabel={t("profileCompareClose")}>
          {t("profileCompareTitle")}
        </ModalHeader>
        <ModalBody display="flex" flexDirection="column" gap="3">
          <chakra.p textStyle="caption">
            {t("profileCompareDesc", { column: profileTargetLabel(driver, target) })}
          </chakra.p>
          <Flex align="center" gap="2" fontSize="sm" fontWeight={600}>
            {baseline.profile.color && <ProfileColorChip color={baseline.profile.color} size={12} />}
            <chakra.span>{baseline.profile.name}</chakra.span>
            {baseline.profile.is_production && <ProductionBadge compact />}
            <chakra.span color="app.textMuted" fontWeight={400}>
              ({t("profileCompareBaseline")})
            </chakra.span>
          </Flex>
          {candidates.length === 0 ? (
            <chakra.span fontSize="sm" color="app.textMuted">
              {t("profileComparePickerEmpty")}
            </chakra.span>
          ) : (
            candidates.map((c) => (
              <Flex key={c.sessionId} align="center" gap="2" fontSize="sm">
                <chakra.label display="flex" alignItems="center" gap="2" cursor="pointer" flex="1" minW={0}>
                  <Checkbox checked={selected.has(c.sessionId)} onChange={() => toggle(c.sessionId)} />
                  {c.profile.color && <ProfileColorChip color={c.profile.color} size={12} />}
                  <chakra.span>{c.profile.name}</chakra.span>
                  {c.profile.is_production && <ProductionBadge compact />}
                </chakra.label>
                <Input
                  width="180px"
                  aria-label={t("profileCompareDatabaseAria", { name: c.profile.name })}
                  value={dbOf(c)}
                  onChange={(e) => setDatabases((prev) => ({ ...prev, [c.sessionId]: e.target.value }))}
                  disabled={!selected.has(c.sessionId)}
                />
              </Flex>
            ))
          )}
          {candidates.length > 0 && (
            <chakra.p textStyle="caption">{t("profileCompareDatabaseHint")}</chakra.p>
          )}
        </ModalBody>
        <ModalFooter>
          <chakra.span flex="1" />
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("profileCompareCancel")}
          </Button>
          <Button type="button" variant="primary" onClick={() => void run()} disabled={selected.size === 0}>
            {t("profileCompareRun")}
          </Button>
        </ModalFooter>
      </Modal>
    );
  }

  return (
    <Modal
      // no-submit: 比較結果の閲覧画面で、確定する主アクションが無い (閉じるのみ)
      onClose={onClose}
      width="min(1120px, 95vw)"
    >
      <ModalHeader onClose={onClose} closeLabel={t("profileCompareClose")}>
        {t("profileCompareResultTitle", { column: profileTargetLabel(driver, target) })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="3">
        <Flex align="center" gap="2" minH="28px">
          {running ? (
            <>
              <Spinner size={14} />
              <chakra.span fontSize="sm" color="app.textMuted">
                {t("profileRunning")}
              </chakra.span>
            </>
          ) : fetched >= 2 ? (
            <chakra.span fontSize="sm" color={diffCount > 0 ? diffFg : "app.textSuccess"}>
              {diffCount > 0 ? t("profileCompareDiffCount", { count: diffCount }) : t("profileCompareNoDiff")}
            </chakra.span>
          ) : null}
        </Flex>
        {entries.map(
          (e) =>
            e.error && (
              <ErrorNote key={e.id} role="alert">
                {t("profileCompareEntryError", { name: e.label, error: e.error })}
              </ErrorNote>
            ),
        )}
        <chakra.div overflowX="auto">
          <chakra.table
            style={{ borderCollapse: "collapse" }}
            width="100%"
            aria-label={t("profileCompareTableAria")}
          >
            <thead>
              <chakra.tr borderBottom="1px solid" borderColor="app.border">
                <chakra.th />
                {targets.map((c, i) => (
                  <ConnHeader
                    key={c.sessionId}
                    c={c}
                    isBaseline={i === baseHeaderIdx}
                    database={i === 0 ? target.database : dbOf(c)}
                  />
                ))}
              </chakra.tr>
            </thead>
            <tbody>
              {metricRows.map((row) => (
                <chakra.tr key={row.id} borderBottom="1px solid" borderColor="app.borderSubtle">
                  <chakra.th
                    scope="row"
                    textAlign="left"
                    fontWeight={500}
                    color="app.textSecondary"
                    px="2.5"
                    py="1.5"
                    fontSize="sm"
                  >
                    {t(METRIC_LABEL[row.id])}
                  </chakra.th>
                  {row.cells.map((cell, i) => (
                    <chakra.td
                      key={entries[i]?.id ?? i}
                      px="2.5"
                      py="1.5"
                      fontSize="sm"
                      fontFamily="var(--font-mono)"
                      bg={cell?.differs ? diffBg : undefined}
                      color={cell?.differs ? diffFg : undefined}
                    >
                      {cell ? cell.text : "—"}
                    </chakra.td>
                  ))}
                </chakra.tr>
              ))}
              {topRows.length > 0 && (
                <chakra.tr>
                  <chakra.th
                    colSpan={targets.length + 1}
                    textAlign="left"
                    textStyle="overline"
                    color="app.textMuted"
                    px="2.5"
                    pt="3"
                    pb="1"
                  >
                    {t("profileTopValues")}
                  </chakra.th>
                </chakra.tr>
              )}
              {topRows.map((row) => (
                <chakra.tr key={row.key} borderBottom="1px solid" borderColor="app.borderSubtle">
                  <chakra.th
                    scope="row"
                    textAlign="left"
                    fontWeight={500}
                    fontFamily="var(--font-mono)"
                    fontSize="sm"
                    px="2.5"
                    py="1.5"
                    maxW="240px"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                    color={row.isNull ? "app.textMuted" : "app.text"}
                  >
                    {row.label}
                  </chakra.th>
                  {row.cells.map((cell, i) => {
                    const differs = topValueCellDiffers(row, i, entries);
                    return (
                      <chakra.td
                        key={entries[i]?.id ?? i}
                        px="2.5"
                        py="1.5"
                        fontSize="sm"
                        fontFamily="var(--font-mono)"
                        bg={differs ? diffBg : undefined}
                        color={differs ? diffFg : undefined}
                      >
                        {cell
                          ? `${cell.count} (${formatPercent(cell.share)})`
                          : entries[i]?.profile
                            ? t("profileCompareAbsent")
                            : "—"}
                      </chakra.td>
                    );
                  })}
                </chakra.tr>
              ))}
            </tbody>
          </chakra.table>
        </chakra.div>
        {!running && fetched >= 2 && <Callout tone="info">{t("profileCompareTopNote")}</Callout>}
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="secondary" onClick={() => setPhase("pick")} disabled={running}>
          {t("profileCompareBack")}
        </Button>
        <TextExportButton
          formats={[
            {
              id: "csv",
              label: "CSV",
              build: () => {
                const x = buildExportTable();
                return tableToCsv(x.header, x.rows);
              },
            },
            {
              id: "markdown",
              label: "Markdown",
              build: () => {
                const x = buildExportTable();
                return tableToMarkdown(x.header, x.rows);
              },
            },
          ]}
          filenameBase="column-profile-compare"
          disabled={running || fetched === 0}
        />
        <chakra.span flex="1" />
        <Button type="button" variant="primary" onClick={onClose}>
          {t("profileCompareClose")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
