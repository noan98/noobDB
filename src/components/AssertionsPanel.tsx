import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import {
  api,
  type Assertion,
  type ConnectionProfile,
  type DriverKind,
  type SaveAssertionRequest,
} from "../api/tauri";
import { useT } from "../i18n";
import { semanticColorToken, type SemanticRole } from "../semanticColors";
import { AssertionEditorModal } from "./AssertionEditorModal";
import {
  describeRule,
  draftFromAssertion,
  emptyAssertionDraft,
  observedText,
  runAssertionsSequentially,
  summarizeRuns,
  RULE_KIND_LABEL_KEY,
  type AssertionDraft,
  type AssertionRunState,
} from "./assertions";
import { useConfirm } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { errorIllustration } from "./illustrations";
import { scopeMatches } from "./SnippetList";
import { Spinner } from "./Spinner";
import { Tooltip } from "./Tooltip";
import { Button } from "./ui";
import { useToast } from "./Toast";

/**
 * データ品質アサーション (#742) のボトムパネル。
 *
 * 「この列は NULL であってはならない」のような業務上の期待をルールとして登録し、
 * 「すべて検証」で一括実行して pass / fail (違反件数) を一覧する。fail からは
 * 違反行を表示するクエリを**実行せずに**新規タブで開く (SQL を見てから実行する)。
 *
 * - **置き場所**: 検証結果を見ながら SQL を書いて原因を追う参照情報なので、
 *   全画面ではなくボトムパネル (`ui-design-system.md` §7.1)。追加・編集は
 *   「開いて決めて閉じる」操作なので `AssertionEditorModal`。
 * - **実行**: `run_assertion` を 1 件ずつ順に呼ぶ (`runAssertionsSequentially`)。
 *   バックエンドは値ピッカーと同じ裏方経路で実行するため、read_only セッションでも
 *   動き、クエリ履歴を汚さず、ルールごとに設定の「クエリタイムアウト」が効く。
 *   1 件の失敗は残りを止めず、「中止」は次のルールの前で効く。
 * - **スコープ**: スニペットと同じ `SnippetScope` で、接続中のプロファイルに合う
 *   ものだけを出す (`scopeMatches` を共有)。
 */

const thCss: SystemStyleObject = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  background: "var(--bg-muted)",
  borderBottom: "1px solid var(--border)",
  padding: "var(--space-1-5) var(--space-2-5)",
  textAlign: "left",
  textStyle: "overline",
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
};
const tdCss: SystemStyleObject = {
  borderBottom: "1px solid var(--border-subtle, var(--border))",
  padding: "var(--space-2) var(--space-2-5)",
  fontSize: "var(--text-sm)",
  color: "var(--text)",
  verticalAlign: "top",
};

function statusRole(state: AssertionRunState | undefined): SemanticRole | null {
  switch (state?.status) {
    case "passed":
      return "success";
    case "failed":
      return "danger";
    case "error":
      return "warning";
    default:
      return null;
  }
}

function StatusBadge({ state }: { state: AssertionRunState | undefined }) {
  const t = useT();
  if (state?.status === "running") return <Spinner size={14} />;
  const role = statusRole(state);
  const label =
    state?.status === "passed"
      ? t("assertStatusPass")
      : state?.status === "failed"
        ? t("assertStatusFail")
        : state?.status === "error"
          ? t("assertStatusError")
          : state?.status === "cancelled"
            ? t("assertStatusCancelled")
            : t("assertStatusPending");
  return (
    <chakra.span
      display="inline-block"
      px="2"
      py="0.5"
      textStyle="overline"
      borderRadius="sm"
      whiteSpace="nowrap"
      bg={role ? semanticColorToken(role, "subtle") : "app.surfaceMuted"}
      color={role ? semanticColorToken(role, "text") : "app.textMuted"}
      border="1px solid"
      borderColor={role ? semanticColorToken(role, "border") : "app.border"}
    >
      {label}
    </chakra.span>
  );
}

interface Props {
  sessionId: string;
  driver: DriverKind;
  profile: ConnectionProfile | null;
  /** 検証を実行するデータベース (アクティブタブ → プロファイル既定)。 */
  database: string | null | undefined;
  /** 設定の「クエリタイムアウト」(秒、0 = なし)。ルールごとに効く。 */
  queryTimeoutSecs: number;
  /** 違反行を表示するクエリを新規タブで開く (実行はしない)。 */
  onOpenSql: (sql: string, title: string) => void;
}

export function AssertionsPanel({
  sessionId,
  driver,
  profile,
  database,
  queryTimeoutSecs,
  onOpenSql,
}: Props) {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();

  const [assertions, setAssertions] = useState<Assertion[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [states, setStates] = useState<Map<string, AssertionRunState>>(() => new Map());
  const [runningAll, setRunningAll] = useState(false);
  const [editing, setEditing] = useState<AssertionDraft | null>(null);
  const cancelRef = useRef(false);
  // アンマウント後 (パネルを閉じた・切断) に結果を書き込まない。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRef.current = true;
    };
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const list = await api.listAssertions();
      if (mountedRef.current) setAssertions(list);
    } catch (e) {
      if (mountedRef.current) setLoadError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () => (assertions ?? []).filter((a) => scopeMatches(a, profile)),
    [assertions, profile],
  );
  const visibleIds = useMemo(() => visible.map((a) => a.id), [visible]);
  const summary = summarizeRuns(visibleIds, states);

  const update = useCallback((id: string, state: AssertionRunState) => {
    if (!mountedRef.current) return;
    setStates((prev) => new Map(prev).set(id, state));
  }, []);

  const runOne = useCallback(
    (id: string) =>
      api.runAssertion({
        sessionId,
        id,
        database: database ?? null,
        queryTimeoutSecs: queryTimeoutSecs > 0 ? queryTimeoutSecs : null,
      }),
    [sessionId, database, queryTimeoutSecs],
  );

  const runAll = useCallback(
    async (ids: readonly string[]) => {
      cancelRef.current = false;
      setRunningAll(true);
      try {
        await runAssertionsSequentially(ids, runOne, update, () => cancelRef.current);
      } finally {
        if (mountedRef.current) setRunningAll(false);
      }
    },
    [runOne, update],
  );

  const handleSave = useCallback(
    async (req: SaveAssertionRequest) => {
      const saved = await api.saveAssertion(req);
      if (!mountedRef.current) return;
      setAssertions((prev) => {
        const list = prev ?? [];
        return list.some((a) => a.id === saved.id)
          ? list.map((a) => (a.id === saved.id ? saved : a))
          : [...list, saved];
      });
      // 定義が変わったら古い結果は意味を失うので消す。
      setStates((prev) => {
        const next = new Map(prev);
        next.delete(saved.id);
        return next;
      });
      setEditing(null);
      toast.success(t("assertSaved"));
    },
    [toast, t],
  );

  const handleDelete = useCallback(
    async (a: Assertion) => {
      const ok = await confirm({
        title: t("assertDeleteTitle"),
        message: t("assertDeleteMessage", { name: a.name }),
        confirmLabel: t("assertDelete"),
        tone: "danger",
      });
      if (!ok) return;
      try {
        await api.deleteAssertion(a.id);
        if (!mountedRef.current) return;
        setAssertions((prev) => (prev ?? []).filter((x) => x.id !== a.id));
      } catch (e) {
        toast.error(t("assertDeleteError", { error: String(e) }));
      }
    },
    [confirm, toast, t],
  );

  const openAdd = () => setEditing(emptyAssertionDraft());

  return (
    <Box flex="1" overflowY="auto" py="3.5" px="4" display="flex" flexDirection="column" gap="3">
      <chakra.p margin={0} fontSize="sm" color="app.textMuted">
        {t("assertDesc")}
      </chakra.p>

      <Flex align="center" gap="2" flexWrap="wrap">
        {runningAll ? (
          <Button type="button" variant="secondary" onClick={() => (cancelRef.current = true)}>
            <Icon name="close" size={ICON_SIZES.sm} />
            <chakra.span marginLeft="1.5">{t("assertCancelRun")}</chakra.span>
          </Button>
        ) : (
          <Button
            type="button"
            variant="primary"
            disabled={visible.length === 0}
            onClick={() => void runAll(visibleIds)}
          >
            <Icon name="check" size={ICON_SIZES.sm} />
            <chakra.span marginLeft="1.5">{t("assertRunAll")}</chakra.span>
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={openAdd} disabled={runningAll}>
          <Icon name="plus" size={ICON_SIZES.sm} />
          <chakra.span marginLeft="1.5">{t("assertAdd")}</chakra.span>
        </Button>
        {summary.passed + summary.failed + summary.errored > 0 && (
          <chakra.span fontSize="sm" color="app.textMuted" textStyle="numeric">
            {t("assertSummary", {
              passed: String(summary.passed),
              failed: String(summary.failed),
              errored: String(summary.errored),
              total: String(summary.total),
            })}
          </chakra.span>
        )}
      </Flex>

      {loadError ? (
        <EmptyState
          illustration={errorIllustration(loadError)}
          icon="warning"
          title={t("assertLoadError", { error: loadError })}
          action={{ label: t("assertRetry"), onClick: () => void load() }}
        />
      ) : assertions === null ? (
        <Flex justify="center" py="4">
          <Spinner size={20} />
        </Flex>
      ) : visible.length === 0 ? (
        <EmptyState
          compact
          icon="check"
          title={t("assertEmptyTitle")}
          description={t("assertEmptyDesc")}
          action={{ label: t("assertAdd"), onClick: openAdd }}
        />
      ) : (
        <chakra.table width="100%" style={{ borderCollapse: "collapse" }}>
          <chakra.thead>
            <chakra.tr>
              <chakra.th css={thCss}>{t("assertColStatus")}</chakra.th>
              <chakra.th css={thCss}>{t("assertColName")}</chakra.th>
              <chakra.th css={thCss}>{t("assertColRule")}</chakra.th>
              <chakra.th css={thCss}>{t("assertColResult")}</chakra.th>
              <chakra.th css={thCss} />
            </chakra.tr>
          </chakra.thead>
          <chakra.tbody>
            {visible.map((a) => {
              const state = states.get(a.id);
              const desc = describeRule(a);
              const outcome =
                state?.status === "passed" || state?.status === "failed" ? state.outcome : null;
              const result = outcome ? observedText(a.rule, outcome) : null;
              return (
                <chakra.tr key={a.id} data-assertion-id={a.id}>
                  <chakra.td css={tdCss}>
                    <StatusBadge state={state} />
                  </chakra.td>
                  <chakra.td css={tdCss} fontWeight={600}>
                    {a.name}
                  </chakra.td>
                  <chakra.td css={tdCss}>
                    <chakra.div fontSize="xs" color="app.textMuted" textStyle="overline">
                      {t(RULE_KIND_LABEL_KEY[a.rule.kind])}
                    </chakra.div>
                    <chakra.div fontFamily="mono" fontSize="xs" wordBreak="break-word">
                      {t(desc.key, desc.params)}
                    </chakra.div>
                  </chakra.td>
                  <chakra.td css={tdCss}>
                    {result && (
                      <chakra.span textStyle="numeric" whiteSpace="nowrap">
                        {t(result.key, result.params)}
                      </chakra.span>
                    )}
                    {state?.status === "error" && (
                      <chakra.div fontSize="xs" color="app.textError" wordBreak="break-word">
                        {state.error}
                      </chakra.div>
                    )}
                  </chakra.td>
                  <chakra.td css={tdCss}>
                    <Flex gap="1" justify="flex-end" flexWrap="wrap">
                      {state?.status === "failed" && (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => onOpenSql(state.outcome.violations_sql, a.name)}
                        >
                          {t("assertShowViolations")}
                        </Button>
                      )}
                      <Tooltip label={t("assertRunOne")}>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={t("assertRunOne")}
                          disabled={runningAll || state?.status === "running"}
                          onClick={() => void runAll([a.id])}
                        >
                          <Icon name="refresh" size={ICON_SIZES.sm} />
                        </Button>
                      </Tooltip>
                      <Tooltip label={t("assertEdit")}>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={t("assertEdit")}
                          disabled={runningAll}
                          onClick={() => setEditing(draftFromAssertion(a))}
                        >
                          <Icon name="settings" size={ICON_SIZES.sm} />
                        </Button>
                      </Tooltip>
                      <Tooltip label={t("assertDelete")}>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={t("assertDelete")}
                          disabled={runningAll}
                          onClick={() => void handleDelete(a)}
                        >
                          <Icon name="close" size={ICON_SIZES.sm} />
                        </Button>
                      </Tooltip>
                    </Flex>
                  </chakra.td>
                </chakra.tr>
              );
            })}
          </chakra.tbody>
        </chakra.table>
      )}

      <AnimatePresence>
        {editing && (
          <AssertionEditorModal
            initial={editing}
            driver={driver}
            profile={profile}
            onSave={handleSave}
            onClose={() => setEditing(null)}
          />
        )}
      </AnimatePresence>
      {dialog}
    </Box>
  );
}
