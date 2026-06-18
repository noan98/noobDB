import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import { api, type ServerInfo } from "../api/tauri";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";
import { Button, Input } from "./ui";

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
  padding: "6px 10px",
  textAlign: "left",
  fontSize: "var(--text-sm)",
  fontWeight: 600,
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
};
const tdCss: SystemStyleObject = {
  borderBottom: "1px solid var(--border-subtle, var(--border))",
  padding: "5px 10px",
  fontSize: "var(--text-sm)",
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  verticalAlign: "top",
};
const nameTdCss: SystemStyleObject = { ...tdCss, whiteSpace: "nowrap", color: "var(--text-secondary)" };
const valueTdCss: SystemStyleObject = { ...tdCss, wordBreak: "break-all", maxWidth: "640px" };

export function ServerInfoPanel({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const t = useT();

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
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return variables;
    return variables.filter(
      (v) => v.name.toLowerCase().includes(q) || v.value.toLowerCase().includes(q),
    );
  }, [variables, filter]);

  return (
    <Box flex="1" overflowY="auto" py="5" px="6" display="flex" flexDirection="column" gap="14px">
      <chakra.header
        display="flex"
        alignItems="center"
        justifyContent="space-between"
        gap="3"
        borderBottom="1px solid"
        borderColor="app.border"
        paddingBottom="2.5"
      >
        <chakra.h2 margin={0} fontSize="lg" fontWeight={600} color="app.text">
          {t("serverInfoTitle")}
        </chakra.h2>
        <Button
          minWidth="28px"
          px="2"
          py="1"
          fontSize="base"
          lineHeight={1}
          onClick={onClose}
          aria-label={t("serverInfoClose")}
          title={t("serverInfoClose")}
        >
          <Icon name="close" size={13} />
        </Button>
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
        <Button type="button" onClick={() => void load()} disabled={loading}>
          <Icon name="refresh" size={13} /> {t("serverInfoRefresh")}
        </Button>
        <Input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("serverInfoSearch")}
          aria-label={t("serverInfoSearch")}
          width="auto"
          minWidth="220px"
        />
        {loading && <Spinner size={14} />}
        {info && (
          <chakra.span fontSize="xs" color="app.textMuted">
            {t("serverInfoVarCount", { shown: filtered.length, total: variables.length })}
          </chakra.span>
        )}
      </Flex>

      {error ? (
        <chakra.p margin={0} fontSize="sm" color="var(--status-error)">
          {t("serverInfoLoadError", { error })}
        </chakra.p>
      ) : filtered.length === 0 && !loading ? (
        <chakra.p margin={0} fontSize="sm" color="app.textMuted">
          {t("serverInfoEmpty")}
        </chakra.p>
      ) : (
        <Box overflowX="auto">
          <chakra.table width="100%" borderCollapse="collapse">
            <thead>
              <tr>
                <chakra.th css={thCss} width="40%">
                  {t("serverInfoColName")}
                </chakra.th>
                <chakra.th css={thCss}>{t("serverInfoColValue")}</chakra.th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((v) => (
                <tr key={v.name}>
                  <chakra.td css={nameTdCss}>{v.name}</chakra.td>
                  <chakra.td css={valueTdCss}>{v.value}</chakra.td>
                </tr>
              ))}
            </tbody>
          </chakra.table>
        </Box>
      )}
    </Box>
  );
}
