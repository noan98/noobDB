import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import { api, type ServerInfo, type ServerVariable } from "../api/tauri";
import { useT } from "../i18n";
import { EmptyState } from "./EmptyState";
import { errorIllustration } from "./illustrations";
import { Icon, ICON_SIZES } from "./Icon";
import { ErrorNote } from "./modalForm";
import { RevealTbody } from "./RevealTbody";
import { SkeletonTableRows } from "./Skeleton";
import { Spinner } from "./Spinner";
import { Tooltip } from "./Tooltip";
import { copyToClipboard } from "./clipboard";
import { useToast } from "./Toast";
import { Button, Checkbox, Heading, Input } from "./ui";

/**
 * サーバ / 接続情報パネル (#563)。接続中サーバのバージョンと設定変数を読み取り専用で
 * 取得し、検索可能な表で表示する。アクティブ接続はプロセスモニタが担うためここには
 * 含めない。取得は `SHOW VARIABLES` / `pg_settings` / `PRAGMA` など書き込みを伴わない
 * 経路のみなので、read_only セッションでも利用できる。
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
  padding: "var(--space-1-25) var(--space-2-5)",
  fontSize: "var(--text-sm)",
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  verticalAlign: "top",
};
const nameTdCss: SystemStyleObject = { ...tdCss, whiteSpace: "nowrap", color: "var(--text-secondary)" };
const valueTdCss: SystemStyleObject = { ...tdCss, wordBreak: "break-all", maxWidth: "640px" };

/** 既定値から変更された変数か (`source` が `default` 以外)。出どころが分からない変数は変更なし扱いにしない (#1622)。 */
export function isNonDefaultVariable(v: Pick<ServerVariable, "source">): boolean {
  const src = v.source?.trim().toLowerCase();
  return !!src && src !== "default";
}

/** 障害報告へ貼りやすい `name = value` の 1 行。 */
export function variableAsSetting(v: Pick<ServerVariable, "name" | "value">): string {
  return `${v.name} = ${v.value}`;
}

export function ServerInfoPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const [onlyChanged, setOnlyChanged] = useState(false);

  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  // リクエスト世代カウンタ: セッション切替や連打で複数の取得が走っても、最新の
  // 要求の応答だけを反映する (in-flight ブロックだと旧セッションの結果が残りうる)。
  const requestSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    try {
      const result = await api.serverInfo(sessionId);
      if (seq !== requestSeqRef.current) return;
      setInfo(result);
      setError(null);
    } catch (e) {
      if (seq !== requestSeqRef.current) return;
      setError(String(e));
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setInfo(null);
    setError(null);
    void load();
  }, [load]);

  const variables = info?.variables ?? [];
  // 出どころ (source) が分かる変数が 1 つでもあるときだけ「既定値以外のみ」を出す (#1622)。
  const hasSource = useMemo(() => variables.some((v) => !!v.source), [variables]);
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return variables.filter(
      (v) =>
        (!onlyChanged || isNonDefaultVariable(v)) &&
        (!q || v.name.toLowerCase().includes(q) || v.value.toLowerCase().includes(q)),
    );
  }, [variables, filter, onlyChanged]);

  const copyVariable = useCallback(
    async (text: string) => {
      if (await copyToClipboard(text)) toast.success(t("serverInfoCopied"));
      else toast.error(t("serverInfoCopyFailed"));
    },
    [toast, t],
  );

  return (
    <Box flex="1" overflowY="auto" py="5" px="6" display="flex" flexDirection="column" gap="3.5">
      <chakra.header
        display="flex"
        alignItems="center"
        justifyContent="space-between"
        gap="3"
        borderBottom="1px solid"
        borderColor="app.border"
        paddingBottom="2.5"
      >
        <Heading>{t("serverInfoTitle")}</Heading>
        <Tooltip label={t("serverInfoClose")}>
          <Button
            minWidth="28px"
            px="2"
            py="1"
            fontSize="base"
            lineHeight={1}
            onClick={onClose}
            aria-label={t("serverInfoClose")}
          >
            <Icon name="close" size={ICON_SIZES.sm} />
          </Button>
        </Tooltip>
      </chakra.header>

      <chakra.p margin={0} fontSize="sm" color="app.textMuted">
        {t("serverInfoDesc")}
      </chakra.p>

      {info && (
        <chakra.p margin={0} fontSize="sm" color="app.text">
          <chakra.strong color="app.textSecondary">{t("serverInfoVersion")}: </chakra.strong>
          <chakra.span fontFamily="var(--font-mono)">{info.version}</chakra.span>
        </chakra.p>
      )}

      <Flex align="center" gap="3" flexWrap="wrap">
        <Tooltip label={t("serverInfoRefresh")} focusableWrapper={loading}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t("serverInfoRefresh")}
            onClick={() => void load()}
            disabled={loading}
          >
            <Icon name="refresh" size={ICON_SIZES.md} />
          </Button>
        </Tooltip>
        <Input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("serverInfoSearch")}
          aria-label={t("serverInfoSearch")}
          width="auto"
          minWidth="220px"
        />
        {hasSource && (
          <chakra.label
            display="inline-flex"
            alignItems="center"
            gap="1.5"
            fontSize="sm"
            color="app.textSecondary"
          >
            <Checkbox checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />
            {t("serverInfoOnlyChanged")}
          </chakra.label>
        )}
        {loading && <Spinner size={14} />}
        {info && (
          <chakra.span fontSize="xs" color="app.textMuted" role="status">
            {t("serverInfoVarCount", { shown: filtered.length, total: variables.length })}
          </chakra.span>
        )}
      </Flex>

      {error && info && (
        // 再取得の失敗: 取得済みの一覧は消さず、表の上の帯でエラーを伝える (#1529)。
        <ErrorNote role="alert">{t("serverInfoLoadError", { error })}</ErrorNote>
      )}
      {error && !info ? (
        // 取得失敗: errorHints の分類結果から共有イラストを割り当て、再取得導線を
        // 添える (#848)。
        <EmptyState
          illustration={errorIllustration(error)}
          icon="warning"
          title={t("serverInfoLoadError", { error })}
          action={{ label: t("serverInfoRetry"), onClick: () => void load() }}
        />
      ) : filtered.length === 0 && !loading ? (
        // 検索フィルタで 0 件になったケース (variables 自体が空になることは通常
        // ない) のため、共有 EmptyState の compact レイアウトを「検索一致なし」の
        // 軽量アイコン (icon="search") で使う (#847)。
        <EmptyState compact icon="search" title={t("serverInfoEmpty")} />
      ) : (
        <Box overflowX="auto">
          <chakra.table width="100%" borderCollapse="collapse">
            <thead>
              <tr>
                <chakra.th css={thCss} width="40%">
                  {t("serverInfoColName")}
                </chakra.th>
                <chakra.th css={thCss}>{t("serverInfoColValue")}</chakra.th>
                <chakra.th css={thCss} width="1%">
                  <chakra.span srOnly>{t("serverInfoColCopy")}</chakra.span>
                </chakra.th>
              </tr>
            </thead>
            {loading && variables.length === 0 ? (
              // 初回ロード中 (まだ 1 件も取得していない): 「値」列が埋まる前の
              // 裸のヘッダのみ表示を避け、行の構造をシマーで予兆表示する (#846)。
              <tbody>
                <SkeletonTableRows columns={3} />
              </tbody>
            ) : (
              // 実データはスケルトンと別要素にして、着弾の 1 回だけリビールする (#1886)。
              <RevealTbody>
                {filtered.map((v) => (
                  <tr key={v.name}>
                    <chakra.td css={nameTdCss}>{v.name}</chakra.td>
                    <chakra.td css={valueTdCss}>
                      {v.value}
                      {isNonDefaultVariable(v) && (
                        <Tooltip
                          label={t("serverInfoChangedHint", { source: v.source ?? "" })}
                          focusableWrapper
                        >
                          <chakra.span
                            marginLeft="2"
                            px="1.5"
                            fontSize="var(--text-xs)"
                            fontFamily="var(--font-sans)"
                            color="app.textWarning"
                            border="1px solid currentColor"
                            borderRadius="var(--radius-sm)"
                          >
                            {t("serverInfoChangedBadge")}
                          </chakra.span>
                        </Tooltip>
                      )}
                    </chakra.td>
                    <chakra.td css={tdCss}>
                      <Tooltip label={t("serverInfoCopyValue")}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={t("serverInfoCopyValueAria", { name: v.name })}
                          onClick={() => void copyVariable(variableAsSetting(v))}
                        >
                          <Icon name="copy" size={ICON_SIZES.sm} />
                        </Button>
                      </Tooltip>
                    </chakra.td>
                  </tr>
                ))}
              </RevealTbody>
            )}
          </chakra.table>
        </Box>
      )}
    </Box>
  );
}
