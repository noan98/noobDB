import { useMemo, useState } from "react";
import { Box, Flex, chakra } from "@chakra-ui/react";
import type { ConnectionProfile, Snippet } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import type { PlanWatchState } from "../planWatch";
import {
  type PlanChange,
  comparePlans,
  opsFromSnapshot,
  resultFromSnapshot,
} from "./planDiff";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Select } from "./ui";
import { ExplainViewer } from "./ExplainViewer";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";

/**
 * 実行計画ウォッチ (#743) の閲覧・比較パネル。ウォッチ登録済みスニペットの
 * 計画世代一覧を表示し、任意の 2 世代を `ExplainViewer` の並置 + 変化点リストで
 * 比較する。EXPLAIN の実行 (更新) は親 (`App.tsx`) が `onRefresh` で担い、
 * ここは保存済み世代の表示に徹する — 未接続でも過去の世代を閲覧できる。
 */

interface Props {
  profile: ConnectionProfile;
  snippets: Snippet[];
  state: PlanWatchState;
  /** ウォッチ更新 (EXPLAIN 再取得) が進行中。 */
  refreshing: boolean;
  /** このプロファイルの接続がアクティブで、更新を実行できるか。 */
  canRefresh: boolean;
  onRefresh: () => void;
  onUnwatch: (snippetId: string) => void;
  onClose: () => void;
}

const CHANGE_KEY: Record<PlanChange["kind"], I18nKey> = {
  access: "planWatchChangeAccess",
  index: "planWatchChangeIndex",
  join: "planWatchChangeJoin",
  estRows: "planWatchChangeRows",
  opAdded: "planWatchChangeAdded",
  opRemoved: "planWatchChangeRemoved",
};

function formatCaptured(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function PlanWatchPanel({
  profile,
  snippets,
  state,
  refreshing,
  canRefresh,
  onRefresh,
  onUnwatch,
  onClose,
}: Props) {
  const t = useT();
  const watched = useMemo(
    () =>
      Object.keys(state.watches).map((id) => ({
        id,
        snippet: snippets.find((s) => s.id === id) ?? null,
        generations: state.watches[id],
      })),
    [state, snippets],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const active =
    watched.find((w) => w.id === selectedId) ?? (watched.length > 0 ? watched[0] : null);

  // 比較対象の 2 世代。B (比較先) は既定で最新、A (比較元) はその 1 つ前。
  // 世代 ID で保持し、選択中スニペットが変わったら既定へ戻す。
  const [pickA, setPickA] = useState<string | null>(null);
  const [pickB, setPickB] = useState<string | null>(null);
  const gens = active?.generations ?? [];
  const genB = gens.find((g) => g.id === pickB) ?? (gens.length > 0 ? gens[0] : null);
  const genA =
    gens.find((g) => g.id === pickA) ?? (gens.length > 1 ? gens[1] : genB);

  const changes = useMemo(() => {
    if (!genA || !genB || genA.id === genB.id) return [];
    return comparePlans(opsFromSnapshot(genA), opsFromSnapshot(genB)).changes;
  }, [genA, genB]);

  const resultA = useMemo(() => (genA ? resultFromSnapshot(genA) : null), [genA]);
  const resultB = useMemo(() => (genB ? resultFromSnapshot(genB) : null), [genB]);

  const selectSnippet = (id: string) => {
    setSelectedId(id);
    setPickA(null);
    setPickB(null);
  };

  return (
    <Modal onClose={onClose} width="1180px">
      <ModalHeader onClose={onClose} closeLabel={t("planWatchClose")}>
        {t("planWatchTitle", { name: profile.name })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="3" minHeight="60vh">
        {watched.length === 0 ? (
          <EmptyState
            icon="explain"
            title={t("planWatchEmptyTitle")}
            description={t("planWatchEmpty")}
          />
        ) : (
          <Flex flex="1" minHeight={0} gap="3" align="stretch">
            {/* 左: ウォッチ済みスニペット一覧 */}
            <Box
              width="240px"
              flexShrink={0}
              overflowY="auto"
              border="1px solid"
              borderColor="app.border"
              borderRadius="md"
            >
              {watched.map((w) => {
                const isActive = active?.id === w.id;
                return (
                  <Flex
                    key={w.id}
                    role="button"
                    tabIndex={0}
                    px="2.5"
                    py="2"
                    gap="2"
                    align="center"
                    cursor="pointer"
                    bg={isActive ? "app.active" : undefined}
                    _hover={{ bg: isActive ? "app.active" : "app.hover" }}
                    onClick={() => selectSnippet(w.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        selectSnippet(w.id);
                      }
                    }}
                  >
                    <Icon name="explain" size={13} />
                    <Box flex="1" minWidth={0}>
                      <chakra.div
                        fontSize="sm"
                        fontWeight={600}
                        color="app.text"
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                        title={w.snippet?.sql}
                      >
                        {w.snippet?.name ?? t("planWatchSnippetMissing")}
                      </chakra.div>
                      <chakra.div fontSize="xs" color="app.textMuted">
                        {t("planWatchGenerationCount", { count: w.generations.length })}
                      </chakra.div>
                    </Box>
                  </Flex>
                );
              })}
            </Box>

            {/* 右: 世代選択 + 変化点 + 2 面比較 */}
            <Flex flex="1" minWidth={0} direction="column" gap="2.5">
              {gens.length === 0 ? (
                <chakra.p color="app.textMuted" m={0}>
                  {t("planWatchNoGenerations")}
                </chakra.p>
              ) : (
                <>
                  <Flex gap="2.5" align="center" wrap="wrap">
                    <chakra.label fontSize="sm" color="app.textSecondary" display="flex" alignItems="center" gap="1.5">
                      {t("planWatchCompareFrom")}
                      <Select
                        value={genA?.id ?? ""}
                        onChange={(e) => setPickA(e.target.value)}
                      >
                        {gens.map((g, i) => (
                          <option key={g.id} value={g.id}>
                            {i === 0
                              ? t("planWatchLatestOption", { time: formatCaptured(g.capturedAt) })
                              : formatCaptured(g.capturedAt)}
                          </option>
                        ))}
                      </Select>
                    </chakra.label>
                    <chakra.span color="app.textMuted" aria-hidden>
                      →
                    </chakra.span>
                    <chakra.label fontSize="sm" color="app.textSecondary" display="flex" alignItems="center" gap="1.5">
                      {t("planWatchCompareTo")}
                      <Select
                        value={genB?.id ?? ""}
                        onChange={(e) => setPickB(e.target.value)}
                      >
                        {gens.map((g, i) => (
                          <option key={g.id} value={g.id}>
                            {i === 0
                              ? t("planWatchLatestOption", { time: formatCaptured(g.capturedAt) })
                              : formatCaptured(g.capturedAt)}
                          </option>
                        ))}
                      </Select>
                    </chakra.label>
                    <Box flex="1" />
                    {active && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onUnwatch(active.id)}
                        title={t("planWatchUnwatchHint")}
                      >
                        {t("planWatchUnwatch")}
                      </Button>
                    )}
                  </Flex>

                  {/* 変化点リスト。同一世代を選んだとき/変化なしのときは静かに知らせる。 */}
                  {genA && genB && genA.id !== genB.id && (
                    <Box
                      border="1px solid"
                      borderColor="app.border"
                      borderRadius="md"
                      px="3"
                      py="2"
                      maxHeight="140px"
                      overflowY="auto"
                    >
                      {changes.length === 0 ? (
                        <chakra.p m={0} fontSize="sm" color="app.textMuted">
                          {t("planWatchNoChanges")}
                        </chakra.p>
                      ) : (
                        <chakra.ul m={0} p={0} listStyleType="none" display="flex" flexDirection="column" gap="1">
                          {changes.map((c, i) => (
                            <chakra.li
                              key={`${c.path}-${c.kind}-${i}`}
                              fontSize="sm"
                              display="flex"
                              alignItems="center"
                              gap="1.5"
                              color={c.severity === "warning" ? "app.textError" : "app.text"}
                            >
                              {c.severity === "warning" && <Icon name="warning" size={13} />}
                              {t(CHANGE_KEY[c.kind], {
                                object: c.object,
                                before: c.before ?? "—",
                                after: c.after ?? "—",
                              })}
                            </chakra.li>
                          ))}
                        </chakra.ul>
                      )}
                    </Box>
                  )}

                  {/* 2 世代の計画を並置。左 = 比較元 (A)、右 = 比較先 (B)。 */}
                  <Flex flex="1" minHeight="360px" gap="2.5">
                    {[
                      { gen: genA, result: resultA, label: t("planWatchPaneFrom") },
                      { gen: genB, result: resultB, label: t("planWatchPaneTo") },
                    ].map((pane, i) => (
                      <Flex
                        key={i}
                        flex="1"
                        minWidth={0}
                        direction="column"
                        border="1px solid"
                        borderColor="app.border"
                        borderRadius="md"
                        overflow="hidden"
                      >
                        <Flex
                          px="2.5"
                          py="1.5"
                          gap="2"
                          align="center"
                          fontSize="xs"
                          color="app.textSecondary"
                          bg="app.toolbar"
                          borderBottom="1px solid"
                          borderBottomColor="app.borderSubtle"
                        >
                          <chakra.span fontWeight={600}>{pane.label}</chakra.span>
                          {pane.gen && <chakra.span>{formatCaptured(pane.gen.capturedAt)}</chakra.span>}
                        </Flex>
                        <Flex flex="1" minHeight={0} direction="column">
                          <ExplainViewer
                            result={pane.result}
                            driver={pane.gen?.driver ?? profile.driver}
                          />
                        </Flex>
                      </Flex>
                    ))}
                  </Flex>
                </>
              )}
            </Flex>
          </Flex>
        )}
      </ModalBody>
      <ModalFooter>
        <chakra.span fontSize="xs" color="app.textMuted">
          {t("planWatchLocalOnlyNote")}
        </chakra.span>
        <Box flex="1" />
        <Button
          variant="secondary"
          disabled={!canRefresh || refreshing || watched.length === 0}
          onClick={onRefresh}
          title={canRefresh ? t("planWatchRefreshHint") : t("planWatchNeedConnection")}
        >
          <Icon name="refresh" size={13} />{" "}
          {refreshing ? t("planWatchRefreshing") : t("planWatchRefresh")}
        </Button>
        <Button variant="primary" onClick={onClose}>
          {t("planWatchClose")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
