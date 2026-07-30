import { useEffect, useMemo, useState } from "react";
import { Box, Flex, chakra } from "@chakra-ui/react";
import { api } from "../api/tauri";
import type { ConnectionProfile } from "../api/tauri";
import { useT } from "../i18n";
import {
  canDiff,
  diffIndexes,
  summarizeDrift,
  toDiffInput,
  type DriftSummary,
  type SchemaDriftState,
  type SchemaGeneration,
} from "../schemaDrift";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Select } from "./ui";
import { Icon, ICON_SIZES } from "./Icon";
import { Spinner } from "./Spinner";
import { EmptyState } from "./EmptyState";

/**
 * スキーマドリフト・タイムライン (#736) の閲覧パネル。プロファイルごとに
 * localStorage へ自動記録されたスキーマスナップショットの世代一覧を表示し、
 * 任意の 2 世代間の差分 (テーブル/列/インデックスの追加・削除・変更) を一覧
 * 表示する。スナップショットの取得 (接続時の自動検知) は親 (`App.tsx`) が担い、
 * ここは保存済み世代の閲覧と差分表示に徹する — 閲覧・検知専用で書き込みは
 * 一切行わないため、読み取り専用セッションでも全機能が動作する。
 *
 * 差分計算は `db::diff::compute_schema_diff` を流用する `diffSchemaSnapshots`
 * IPC (セッション不要) を都度呼ぶ — `PlanWatchPanel` の実行計画比較 (フロント
 * 純ロジックのみで同期計算) とは異なり、選択世代が変わるたびの非同期呼び出しに
 * なる点に注意。
 */

interface Props {
  profile: ConnectionProfile;
  state: SchemaDriftState;
  /** この接続で今すぐスナップショットを取得できるか (アクティブ接続がこの
   *  プロファイルであること)。 */
  canCapture: boolean;
  capturing: boolean;
  onCapture: () => void;
  onClose: () => void;
}

function formatCaptured(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function SchemaDriftPanel({ profile, state, canCapture, capturing, onCapture, onClose }: Props) {
  const t = useT();
  const gens = state.generations;

  const [pickA, setPickA] = useState<string | null>(null);
  const [pickB, setPickB] = useState<string | null>(null);
  const genB = gens.find((g) => g.id === pickB) ?? (gens.length > 0 ? gens[0] : null);
  const genA = gens.find((g) => g.id === pickA) ?? (gens.length > 1 ? gens[1] : genB);

  const [summary, setSummary] = useState<DriftSummary | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  const bothDiffable = useMemo(
    () => !!genA && !!genB && genA.id !== genB.id && canDiff(genA) && canDiff(genB),
    [genA, genB],
  );

  useEffect(() => {
    if (!genA || !genB || genA.id === genB.id || !canDiff(genA) || !canDiff(genB)) {
      setSummary(null);
      setCompareError(null);
      return;
    }
    let cancelled = false;
    setComparing(true);
    setCompareError(null);
    const source = toDiffInput(genA as SchemaGeneration);
    const target = toDiffInput(genB as SchemaGeneration);
    if (!source || !target) {
      setComparing(false);
      return;
    }
    api
      .diffSchemaSnapshots({
        sourceDriver: genA.driver,
        targetDriver: genB.driver,
        source,
        target,
      })
      .then((diff) => {
        if (cancelled) return;
        const indexDrift = diffIndexes(genA, genB);
        setSummary(summarizeDrift(diff, indexDrift));
      })
      .catch((e) => {
        if (!cancelled) setCompareError(String(e));
      })
      .finally(() => {
        if (!cancelled) setComparing(false);
      });
    return () => {
      cancelled = true;
    };
    // 世代オブジェクト自体ではなく id だけを依存にする — `gens` (延いては genA/genB)
    // は state から毎回新しい参照で渡ってくるため、オブジェクト全体を依存にすると
    // 同じ世代を選び続けていても再計算してしまう。
  }, [genA?.id, genB?.id]);

  return (
    <Modal onClose={onClose} width="980px">
      <ModalHeader onClose={onClose} closeLabel={t("schemaDriftClose")}>
        {t("schemaDriftTitle", { name: profile.name })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="3" minHeight="55vh">
        {gens.length === 0 ? (
          <EmptyState icon="clock" title={t("schemaDriftEmptyTitle")} description={t("schemaDriftEmpty")} />
        ) : (
          <Flex flex="1" minHeight={0} gap="3" align="stretch">
            {/* 左: 世代タイムライン */}
            <Box
              width="260px"
              flexShrink={0}
              overflowY="auto"
              border="1px solid"
              borderColor="app.border"
              borderRadius="md"
            >
              {gens.map((g, i) => {
                const selected = g.id === genA?.id || g.id === genB?.id;
                return (
                  <Flex
                    key={g.id}
                    px="2.5"
                    py="2"
                    gap="2"
                    align="center"
                    bg={selected ? "app.active" : undefined}
                  >
                    <Icon name="clock" size={ICON_SIZES.sm} />
                    <Box flex="1" minWidth={0}>
                      <chakra.div fontSize="sm" fontWeight={600} color="app.text">
                        {formatCaptured(g.capturedAt)}
                        {i === 0 && ` ${t("schemaDriftLatestSuffix")}`}
                      </chakra.div>
                      <chakra.div fontSize="xs" color="app.textMuted">
                        {t("schemaDriftGenerationTables", { count: g.tableCount })}
                        {g.omitted && ` · ${t("schemaDriftOmittedBadge")}`}
                      </chakra.div>
                    </Box>
                  </Flex>
                );
              })}
            </Box>

            {/* 右: 世代選択 + 差分リスト */}
            <Flex flex="1" minWidth={0} direction="column" gap="2.5">
              <Flex gap="2.5" align="center" wrap="wrap">
                <chakra.label fontSize="sm" color="app.textSecondary" display="flex" alignItems="center" gap="1.5">
                  {t("schemaDriftCompareFrom")}
                  <Select value={genA?.id ?? ""} onChange={(e) => setPickA(e.target.value)}>
                    {gens.map((g, i) => (
                      <option key={g.id} value={g.id}>
                        {i === 0
                          ? t("schemaDriftLatestOption", { time: formatCaptured(g.capturedAt) })
                          : formatCaptured(g.capturedAt)}
                      </option>
                    ))}
                  </Select>
                </chakra.label>
                <chakra.span color="app.textMuted" aria-hidden>
                  →
                </chakra.span>
                <chakra.label fontSize="sm" color="app.textSecondary" display="flex" alignItems="center" gap="1.5">
                  {t("schemaDriftCompareTo")}
                  <Select value={genB?.id ?? ""} onChange={(e) => setPickB(e.target.value)}>
                    {gens.map((g, i) => (
                      <option key={g.id} value={g.id}>
                        {i === 0
                          ? t("schemaDriftLatestOption", { time: formatCaptured(g.capturedAt) })
                          : formatCaptured(g.capturedAt)}
                      </option>
                    ))}
                  </Select>
                </chakra.label>
              </Flex>

              <Box flex="1" minHeight={0} overflowY="auto" border="1px solid" borderColor="app.border" borderRadius="md" px="3" py="2">
                {!genA || !genB || genA.id === genB.id ? (
                  <chakra.p m={0} fontSize="sm" color="app.textMuted">
                    {t("schemaDriftPickTwo")}
                  </chakra.p>
                ) : !bothDiffable ? (
                  <chakra.p m={0} fontSize="sm" color="app.textMuted">
                    {t("schemaDriftOmittedNote")}
                  </chakra.p>
                ) : comparing ? (
                  <Flex align="center" gap="2" color="app.textMuted" fontSize="sm">
                    <Spinner size={14} />
                    {t("schemaDriftComparing")}
                  </Flex>
                ) : compareError ? (
                  <chakra.p m={0} fontSize="sm" color="app.textError">
                    {compareError}
                  </chakra.p>
                ) : summary && summary.tables.length === 0 ? (
                  <chakra.p m={0} fontSize="sm" color="app.textMuted">
                    {t("schemaDriftNoChanges")}
                  </chakra.p>
                ) : summary ? (
                  <chakra.ul m={0} p={0} listStyleType="none" display="flex" flexDirection="column" gap="1.5">
                    {summary.tables.map((c) => {
                      const fragments: string[] = [];
                      if (c.tableStatus === "added") {
                        fragments.push(t("schemaDriftTableAddedLabel"));
                      } else if (c.tableStatus === "removed") {
                        fragments.push(t("schemaDriftTableRemovedLabel"));
                      } else {
                        if (c.columnsAdded > 0) fragments.push(t("schemaDriftColAdded", { count: c.columnsAdded }));
                        if (c.columnsRemoved > 0) fragments.push(t("schemaDriftColRemoved", { count: c.columnsRemoved }));
                        if (c.columnsChanged > 0) fragments.push(t("schemaDriftColChanged", { count: c.columnsChanged }));
                        if (c.indexesAdded > 0) fragments.push(t("schemaDriftIdxAdded", { count: c.indexesAdded }));
                        if (c.indexesRemoved > 0) fragments.push(t("schemaDriftIdxRemoved", { count: c.indexesRemoved }));
                        if (c.indexesChanged > 0) fragments.push(t("schemaDriftIdxChanged", { count: c.indexesChanged }));
                      }
                      return (
                        <chakra.li key={c.table} fontSize="sm" color="app.text">
                          <chakra.span fontWeight={600}>{c.table}</chakra.span>
                          {": "}
                          {fragments.join(", ")}
                        </chakra.li>
                      );
                    })}
                  </chakra.ul>
                ) : null}
              </Box>
            </Flex>
          </Flex>
        )}
      </ModalBody>
      <ModalFooter>
        <chakra.span fontSize="xs" color="app.textMuted">
          {t("schemaDriftLocalOnlyNote")}
        </chakra.span>
        <Box flex="1" />
        <Button
          variant="secondary"
          disabled={!canCapture || capturing}
          onClick={onCapture}
          title={canCapture ? t("schemaDriftCaptureHint") : t("schemaDriftNeedConnection")}
        >
          <Icon name="refresh" size={ICON_SIZES.sm} /> {capturing ? t("schemaDriftCapturing") : t("schemaDriftCaptureNow")}
        </Button>
        <Button variant="primary" onClick={onClose}>
          {t("schemaDriftClose")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
