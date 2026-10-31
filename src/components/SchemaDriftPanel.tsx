import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Flex, VisuallyHidden, chakra } from "@chakra-ui/react";
import { api } from "../api/tauri";
import type { ConnectionProfile, SchemaDriftGeneration, SchemaDriftSummary } from "../api/tauri";
import { useT } from "../i18n";
import { useRovingFocus } from "../keyboardNav";
import { canDiff } from "../schemaDrift";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Tooltip } from "./Tooltip";
import { Button, Input, Select } from "./ui";
import { useToast } from "./Toast";
import { SchemaDriftRevert } from "./SchemaDriftRevert";
import { Icon, ICON_SIZES } from "./Icon";
import { RevealList } from "./RevealTbody";
import { SkeletonRow } from "./Skeleton";
import { EmptyState } from "./EmptyState";
import { errorIllustration } from "./illustrations";

/**
 * スキーマドリフト・タイムライン (#736) の閲覧パネル。プロファイルごとに Rust の
 * SQLite ストア (#1260) へ自動記録されたスキーマスナップショットの世代一覧を表示し、
 * 任意の 2 世代間の差分 (テーブル/列/インデックスの追加・削除・変更) を一覧
 * 表示する。スナップショットの取得 (接続時の自動検知) は親 (`App.tsx`) が担い、
 * ここは保存済み世代の閲覧と差分表示に徹する — 閲覧・検知専用で書き込みは
 * 一切行わないため、読み取り専用セッションでも全機能が動作する。
 *
 * 差分計算は Rust 側 (`schema_drift_compare`、セッション不要) が保存済みの 2 世代から
 * 行い、サマリだけを返す — `PlanWatchPanel` の実行計画比較 (フロント純ロジックのみで
 * 同期計算) とは異なり、選択世代が変わるたびの非同期呼び出しになる点に注意。
 */

interface Props {
  profile: ConnectionProfile;
  /** 保存済み世代のメタデータ (新しい順)。 */
  generations: SchemaDriftGeneration[];
  /** この接続で今すぐスナップショットを取得できるか (アクティブ接続がこの
   *  プロファイルであること)。 */
  canCapture: boolean;
  capturing: boolean;
  onCapture: () => void;
  onClose: () => void;
  /**
   * 変化したテーブルの「構造」タブ / 「データ」を開く (#1537)。指定されると、差分リストの各行に
   * 開くボタンを出す。開いたあとはパネルを閉じて作業画面へ戻す。
   */
  onOpenStructure?: (database: string, table: string) => void;
  onOpenData?: (database: string, table: string) => void;
  /** ラベルを付け替えた (null = 外した) ので、親が保持する世代一覧へ反映する (#1621)。 */
  onLabelChanged?: (id: string, label: string | null) => void;
  /** 巻き戻し DDL (#1621) をエディタへ挿入する。指定されると「エディタに挿入」を出す。 */
  onInsertSql?: (sql: string) => void;
}

function formatCaptured(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function SchemaDriftPanel({
  profile,
  generations: gens,
  canCapture,
  capturing,
  onCapture,
  onClose,
  onOpenStructure,
  onOpenData,
  onLabelChanged,
  onInsertSql,
}: Props) {
  const t = useT();
  const toast = useToast();

  const timelineRef = useRef<HTMLDivElement>(null);
  const { onKeyDown: onTimelineKeyDown } = useRovingFocus(timelineRef, "[data-generation-item]");
  const [pickA, setPickA] = useState<string | null>(null);
  const [pickB, setPickB] = useState<string | null>(null);
  const genB = gens.find((g) => g.id === pickB) ?? (gens.length > 0 ? gens[0] : null);
  const genA = gens.find((g) => g.id === pickA) ?? (gens.length > 1 ? gens[1] : genB);

  // 世代へのラベル (#1621): 比較先 (B) の世代に付ける。編集中の文字列は世代を切り替えたら取り直す。
  const [labelDraft, setLabelDraft] = useState("");
  const [labelSaving, setLabelSaving] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 世代 id と保存済みラベルが変わったときだけ下書きを取り直す
  useEffect(() => {
    setLabelDraft(genB?.label ?? "");
  }, [genB?.id, genB?.label]);
  const saveLabel = async () => {
    if (!genB) return;
    const next = labelDraft.trim() === "" ? null : labelDraft.trim();
    setLabelSaving(true);
    try {
      const ok = await api.schemaDriftSetLabel(profile.id, genB.id, next);
      if (ok) onLabelChanged?.(genB.id, next);
    } catch (e) {
      toast.notify({ message: String(e), tone: "error" });
    } finally {
      setLabelSaving(false);
    }
  };

  // 巻き戻し DDL (#1621)。比較する世代が変わったら閉じる。
  const [revertOpen, setRevertOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 比較する 2 世代の id が変わったときだけ閉じる
  useEffect(() => {
    setRevertOpen(false);
  }, [pickA, pickB]);

  const [summary, setSummary] = useState<SchemaDriftSummary | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  // 再取得ボタン用のカウンタ。genA/genB は変えずに同じ比較をやり直したいだけなので、
  // これを依存に含めてインクリメントすることで下の effect を再実行させる (#848)。
  const [compareAttempt, setCompareAttempt] = useState(0);
  const retryCompare = () => setCompareAttempt((n) => n + 1);

  const bothDiffable = useMemo(
    () => !!genA && !!genB && genA.id !== genB.id && canDiff(genA) && canDiff(genB),
    [genA, genB],
  );
  // 対象 (DB / スキーマ) が違う世代どうしは比べない (全テーブルが増減したように見えるため)。
  const differentTarget = !!genA && !!genB && genA.database !== genB.database;

  // biome-ignore lint/correctness/useExhaustiveDependencies: genA / genB は state から毎回新しい参照で渡るため id だけを依存にする。compareAttempt は再取得ボタン専用のトリガー (下のコメント参照)
  useEffect(() => {
    if (
      !genA ||
      !genB ||
      genA.id === genB.id ||
      !canDiff(genA) ||
      !canDiff(genB) ||
      genA.database !== genB.database
    ) {
      setSummary(null);
      setCompareError(null);
      return;
    }
    let cancelled = false;
    setComparing(true);
    setCompareError(null);
    api
      .schemaDriftCompare(profile.id, genA.id, genB.id)
      .then((result) => {
        if (cancelled) return;
        setSummary(result);
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
    // 同じ世代を選び続けていても再計算してしまう。compareAttempt は再取得ボタン
    // 専用の依存で、同じ id のまま比較をやり直すために使う (#848)。
  }, [genA?.id, genB?.id, compareAttempt, profile.id]);

  return (
    <Modal
      // no-submit: 一覧の閲覧画面で、確定する主アクションが無い
      onClose={onClose}
      width="980px"
    >
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
              <chakra.div textStyle="caption" color="app.textMuted" px="2.5" py="1.5">
                {t("schemaDriftTimelineHint")}
              </chakra.div>
              <div ref={timelineRef} onKeyDown={onTimelineKeyDown}>
                {gens.map((g, i) => {
                  const selected = g.id === genA?.id || g.id === genB?.id;
                  return (
                    <chakra.button
                      key={g.id}
                      type="button"
                      data-generation-item
                      aria-pressed={selected}
                      // クリックで比較先 (B)、Shift / Alt + クリックで比較元 (A) に設定する (#1612)。
                      onClick={(e) => (e.shiftKey || e.altKey ? setPickA(g.id) : setPickB(g.id))}
                      display="flex"
                      width="100%"
                      textAlign="left"
                      px="2.5"
                      py="2"
                      gap="2"
                      alignItems="center"
                      cursor="pointer"
                      bg={selected ? "app.active" : undefined}
                      _hover={{ bg: "app.hover" }}
                      _focusVisible={{ outline: "none", boxShadow: "inset var(--focus-ring)" }}
                    >
                      <Icon name="clock" size={ICON_SIZES.sm} />
                      <Box flex="1" minWidth={0}>
                        <chakra.div textStyle="subheading">
                          {formatCaptured(g.capturedAt)}
                          {i === 0 && ` ${t("schemaDriftLatestSuffix")}`}
                        </chakra.div>
                        {g.label && (
                          <chakra.div
                            textStyle="caption"
                            color="app.accent"
                            fontWeight={600}
                            overflow="hidden"
                            textOverflow="ellipsis"
                            whiteSpace="nowrap"
                            data-testid="schema-drift-label"
                          >
                            {g.label}
                          </chakra.div>
                        )}
                        <chakra.div textStyle="caption">
                          {t("schemaDriftGenerationTables", { count: g.tableCount })}
                          {g.omitted && ` · ${t("schemaDriftOmittedBadge")}`}
                        </chakra.div>
                        {/* DDL の成功をきっかけに自動取得した世代は、そのときの SQL を残している (#1537)。 */}
                        {g.triggerSql && (
                          <Tooltip label={g.triggerSql}>
                            <chakra.div
                              textStyle="caption"
                              color="app.textMuted"
                              fontFamily="var(--font-mono)"
                              overflow="hidden"
                              textOverflow="ellipsis"
                              whiteSpace="nowrap"
                            >
                              {t("schemaDriftTriggerSql", { sql: g.triggerSql.replace(/\s+/g, " ") })}
                            </chakra.div>
                          </Tooltip>
                        )}
                      </Box>
                    </chakra.button>
                  );
                })}
              </div>
            </Box>

            {/* 右: 世代選択 + 差分リスト */}
            <Flex flex="1" minWidth={0} direction="column" gap="2.5">
              <Flex gap="2.5" align="center" wrap="wrap">
                <chakra.label
                  fontSize="sm"
                  color="app.textSecondary"
                  display="flex"
                  alignItems="center"
                  gap="1.5"
                >
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
                <chakra.label
                  fontSize="sm"
                  color="app.textSecondary"
                  display="flex"
                  alignItems="center"
                  gap="1.5"
                >
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

              {genB && (
                <Flex gap="2" align="center" wrap="wrap">
                  <Input
                    maxW="320px"
                    value={labelDraft}
                    maxLength={80}
                    placeholder={t("schemaDriftLabelPlaceholder")}
                    aria-label={t("schemaDriftLabelAria", { time: formatCaptured(genB.capturedAt) })}
                    onChange={(e) => setLabelDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveLabel();
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={labelSaving || labelDraft.trim() === (genB.label ?? "")}
                    onClick={() => void saveLabel()}
                  >
                    {t("schemaDriftLabelSave")}
                  </Button>
                  <chakra.span textStyle="caption" color="app.textMuted">
                    {t("schemaDriftLabelHint")}
                  </chakra.span>
                </Flex>
              )}

              <Box
                flex="1"
                minHeight={0}
                overflowY="auto"
                border="1px solid"
                borderColor="app.border"
                borderRadius="md"
                px="3"
                py="2"
              >
                {!genA || !genB || genA.id === genB.id ? (
                  <chakra.p m={0} textStyle="body" color="app.textMuted">
                    {t("schemaDriftPickTwo")}
                  </chakra.p>
                ) : !bothDiffable ? (
                  <chakra.p m={0} textStyle="body" color="app.textMuted">
                    {t("schemaDriftOmittedNote")}
                  </chakra.p>
                ) : differentTarget ? (
                  <chakra.p m={0} textStyle="body" color="app.textMuted">
                    {t("schemaDriftDifferentTarget")}
                  </chakra.p>
                ) : comparing ? (
                  // 差分計算中: 裸のスピナーではなく差分リストの構造 (行の予兆) を
                  // シマーで示す (#846)。ロード状態自体は role="status" +
                  // 視覚的に隠したテキストで支援技術へ伝える。
                  <Box role="status" aria-live="polite">
                    <VisuallyHidden>{t("schemaDriftComparing")}</VisuallyHidden>
                    <Box aria-hidden display="flex" flexDirection="column" gap="1">
                      {[82, 58, 70, 45].map((w, i) => (
                        <SkeletonRow
                          key={i}
                          style={{ width: `${w}%`, animationDelay: `${i * 0.08}s`, opacity: 1 - i * 0.15 }}
                        />
                      ))}
                    </Box>
                  </Box>
                ) : compareError ? (
                  // 差分計算失敗: 隣接する世代タイムライン/セレクタは表示したまま
                  // 保つため、この枠内だけを compact な EmptyState + 再取得導線に
                  // 置き換える (#848)。
                  <EmptyState
                    compact
                    illustration={errorIllustration(compareError)}
                    icon="warning"
                    title={compareError}
                    action={{ label: t("schemaDriftRetry"), onClick: retryCompare }}
                  />
                ) : summary && summary.tables.length === 0 ? (
                  <chakra.p m={0} textStyle="body" color="app.textMuted">
                    {t("schemaDriftNoChanges")}
                  </chakra.p>
                ) : summary ? (
                  <RevealList
                    m={0}
                    p={0}
                    listStyleType="none"
                    display="flex"
                    flexDirection="column"
                    gap="1.5"
                  >
                    {summary.tables.map((c) => {
                      const fragments: string[] = [];
                      if (c.tableStatus === "added") {
                        fragments.push(t("schemaDriftTableAddedLabel"));
                      } else if (c.tableStatus === "removed") {
                        fragments.push(t("schemaDriftTableRemovedLabel"));
                      } else {
                        if (c.columnsAdded > 0)
                          fragments.push(t("schemaDriftColAdded", { count: c.columnsAdded }));
                        if (c.columnsRemoved > 0)
                          fragments.push(t("schemaDriftColRemoved", { count: c.columnsRemoved }));
                        if (c.columnsChanged > 0)
                          fragments.push(t("schemaDriftColChanged", { count: c.columnsChanged }));
                        if (c.indexesAdded > 0)
                          fragments.push(t("schemaDriftIdxAdded", { count: c.indexesAdded }));
                        if (c.indexesRemoved > 0)
                          fragments.push(t("schemaDriftIdxRemoved", { count: c.indexesRemoved }));
                        if (c.indexesChanged > 0)
                          fragments.push(t("schemaDriftIdxChanged", { count: c.indexesChanged }));
                      }
                      // 削除されたテーブルは開けない。比較先の世代のデータベースで開く (#1537)。
                      const canOpen = c.tableStatus !== "removed" && !!genB;
                      return (
                        <chakra.li
                          key={c.table}
                          fontSize="sm"
                          color="app.text"
                          display="flex"
                          alignItems="center"
                          gap="2"
                          flexWrap="wrap"
                        >
                          <chakra.span flex="1" minWidth={0}>
                            <chakra.span fontWeight={600}>{c.table}</chakra.span>
                            {": "}
                            {fragments.join(", ")}
                          </chakra.span>
                          {canOpen && onOpenStructure && (
                            <Button
                              type="button"
                              size="sm"
                              aria-label={t("schemaDriftOpenStructureAria", { table: c.table })}
                              onClick={() => {
                                onOpenStructure(genB.database, c.table);
                                onClose();
                              }}
                            >
                              <Icon name="columns" size={ICON_SIZES.sm} /> {t("schemaDriftOpenStructure")}
                            </Button>
                          )}
                          {canOpen && onOpenData && (
                            <Button
                              type="button"
                              size="sm"
                              aria-label={t("schemaDriftOpenDataAria", { table: c.table })}
                              onClick={() => {
                                onOpenData(genB.database, c.table);
                                onClose();
                              }}
                            >
                              <Icon name="table" size={ICON_SIZES.sm} /> {t("schemaDriftOpenData")}
                            </Button>
                          )}
                        </chakra.li>
                      );
                    })}
                  </RevealList>
                ) : null}
              </Box>
              {genA && genB && bothDiffable && !differentTarget && (
                <>
                  <Flex justify="flex-end">
                    <Button
                      type="button"
                      size="sm"
                      aria-expanded={revertOpen}
                      onClick={() => setRevertOpen((v) => !v)}
                    >
                      <Icon name="refresh" size={ICON_SIZES.sm} /> {t("schemaDriftRevertButton")}
                    </Button>
                  </Flex>
                  {revertOpen && (
                    <SchemaDriftRevert
                      profileId={profile.id}
                      fromId={genA.id}
                      toId={genB.id}
                      onInsertSql={onInsertSql}
                      onClose={onClose}
                    />
                  )}
                </>
              )}
            </Flex>
          </Flex>
        )}
      </ModalBody>
      <ModalFooter>
        <chakra.span fontSize="xs" color="app.textMuted">
          {t("schemaDriftLocalOnlyNote")}
        </chakra.span>
        <Box flex="1" />
        {/* 無効時は「なぜ押せないか」を出すため、`focusableWrapper` でキーボード
            からも読めるようにする (無効ボタンはタブ順序から外れる)。 */}
        <Tooltip
          label={
            capturing
              ? t("schemaDriftCapturing")
              : canCapture
                ? t("schemaDriftCaptureHint")
                : t("schemaDriftNeedConnection")
          }
          focusableWrapper={!canCapture || capturing}
        >
          <Button variant="secondary" disabled={!canCapture || capturing} onClick={onCapture}>
            <Icon name="refresh" size={ICON_SIZES.sm} />{" "}
            {capturing ? t("schemaDriftCapturing") : t("schemaDriftCaptureNow")}
          </Button>
        </Tooltip>
        <Button variant="primary" onClick={onClose}>
          {t("schemaDriftClose")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
