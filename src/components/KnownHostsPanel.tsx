import { useCallback, useEffect, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api, type ImportScan, type KnownHost, type KnownHostEvent } from "../api/tauri";
import { useT } from "../i18n";
import { useConfirm } from "./ConfirmDialog";
import { Icon, ICON_SIZES } from "./Icon";
import {
  SettingsInfo,
  SettingsLabelWithInfo,
  SettingsSection,
  SettingsSectionHeader,
} from "./settingsLayout";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { Callout } from "./Callout";
import { Button, Checkbox } from "./ui";

const HISTORY_PREVIEW = 10;

const HISTORY_ACTION_KEY = {
  trust: "knownHostsActionTrust",
  forget: "knownHostsActionForget",
  import: "knownHostsActionImport",
} as const;

const IMPORT_STATUS_KEY = {
  new: "knownHostsImportStatusNew",
  same: "knownHostsImportStatusSame",
  conflict: "knownHostsImportStatusConflict",
} as const;

/**
 * Settings panel for managing the SSH known_hosts file (#682). Lists the host
 * keys trusted on first connect (TOFU) and lets the user forget an entry so the
 * next connection re-trusts the server's key — the in-app recovery path for a
 * legitimate key rotation, replacing hand-editing the file.
 */
export function KnownHostsPanel() {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [hosts, setHosts] = useState<KnownHost[]>([]);
  const [history, setHistory] = useState<KnownHostEvent[]>([]);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [scan, setScan] = useState<ImportScan | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [list, events] = await Promise.all([api.listKnownHosts(), api.listKnownHostsHistory()]);
      setHosts(list);
      setHistory(events);
    } catch (e) {
      toast.error(t("knownHostsLoadError", { error: String(e) }));
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleForget = useCallback(
    async (host: KnownHost) => {
      const ok = await confirm({
        title: t("knownHostsForget"),
        // どのホストの信頼を取り消すのかを明示する (行の取り違えに気付けるように, #1534)。
        message: t("knownHostsForgetConfirm", {
          host: `${host.host}:${host.port}`,
          fingerprint: host.fingerprint,
        }),
        confirmLabel: t("knownHostsForget"),
        tone: "warning",
      });
      if (!ok) return;
      try {
        await api.forgetHostKey(host.host, host.port);
        toast.success(t("knownHostsForgottenToast", { host: `${host.host}:${host.port}` }));
        await reload();
      } catch (e) {
        toast.error(String(e));
      }
    },
    [confirm, reload, t, toast],
  );

  const handleScan = useCallback(async () => {
    try {
      const result = await api.scanOpensshKnownHosts();
      setScan(result);
      // 新規だけ初期選択にする。既存と食い違うもの (置き換え) は明示的に選ばせる。
      setPicked(
        new Set(result.candidates.filter((c) => c.status === "new").map((c) => `${c.host}:${c.port}`)),
      );
    } catch (e) {
      toast.error(t("knownHostsImportScanError", { error: String(e) }));
    }
  }, [t, toast]);

  const handleImport = useCallback(async () => {
    if (!scan) return;
    const chosen = scan.candidates.filter((c) => c.status !== "same" && picked.has(`${c.host}:${c.port}`));
    if (chosen.length === 0) return;
    const replacing = chosen.filter((c) => c.status === "conflict");
    if (replacing.length > 0) {
      const ok = await confirm({
        title: t("knownHostsImportConflictTitle"),
        message: t("knownHostsImportConflictConfirm", {
          count: replacing.length,
          hosts: replacing.map((c) => `${c.host}:${c.port}`).join(", "),
        }),
        confirmLabel: t("knownHostsImportRun"),
        tone: "warning",
      });
      if (!ok) return;
    }
    setImporting(true);
    try {
      const n = await api.importKnownHosts(
        chosen.map((c) => ({ host: c.host, port: c.port, fingerprint: c.fingerprint })),
      );
      toast.success(t("knownHostsImportedToast", { count: n }));
      setScan(null);
      await reload();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setImporting(false);
    }
  }, [confirm, picked, reload, scan, t, toast]);

  const togglePicked = useCallback((key: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const visibleHistory = showAllHistory ? history : history.slice(0, HISTORY_PREVIEW);

  return (
    <SettingsSection>
      {dialog}
      <SettingsSectionHeader>
        <SettingsLabelWithInfo>
          <chakra.h3>{t("knownHostsTitle")}</chakra.h3>
          <SettingsInfo>{t("knownHostsDesc")}</SettingsInfo>
        </SettingsLabelWithInfo>
        <Button type="button" variant="ghost" size="sm" onClick={handleScan}>
          {t("knownHostsImportOpen")}
        </Button>
        <Tooltip label={t("knownHostsRefresh")} focusableWrapper={loading}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t("knownHostsRefresh")}
            onClick={reload}
            disabled={loading}
          >
            <Icon name="refresh" size={ICON_SIZES.md} />
          </Button>
        </Tooltip>
      </SettingsSectionHeader>
      {hosts.length === 0 ? (
        <chakra.p fontSize="sm" color="app.textMuted" py="1">
          {t("knownHostsEmpty")}
        </chakra.p>
      ) : (
        <Flex direction="column" gap="1">
          {hosts.map((h) => (
            <Flex
              key={`${h.host}:${h.port}`}
              align="center"
              gap="3"
              px="2"
              py="1.5"
              borderRadius="sm"
              bg="app.surfaceMuted"
            >
              <Flex direction="column" gap="0.5" flex="1" minW="0">
                <chakra.span fontSize="sm" fontWeight={500}>
                  {h.host}:{h.port}
                </chakra.span>
                <chakra.code fontFamily="var(--font-mono)" fontSize="xs" opacity={0.8} wordBreak="break-all">
                  {h.fingerprint}
                </chakra.code>
              </Flex>
              <Button type="button" variant="dangerOutline" size="sm" onClick={() => handleForget(h)}>
                {t("knownHostsForget")}
              </Button>
            </Flex>
          ))}
        </Flex>
      )}
      {scan && (
        <Flex direction="column" gap="2" mt="3" data-testid="known-hosts-import">
          <chakra.h4 fontSize="sm" fontWeight={600}>
            {t("knownHostsImportTitle")}
          </chakra.h4>
          {!scan.found && <Callout tone="info">{t("knownHostsImportNoFile")}</Callout>}
          {scan.found && scan.candidates.length === 0 && (
            <Callout tone="info">{t("knownHostsImportNone")}</Callout>
          )}
          {scan.candidates.map((c) => {
            const key = `${c.host}:${c.port}`;
            return (
              <Flex
                key={key}
                as="label"
                align="center"
                gap="3"
                px="2"
                py="1.5"
                borderRadius="sm"
                bg="app.surfaceMuted"
              >
                <Checkbox
                  checked={c.status !== "same" && picked.has(key)}
                  disabled={c.status === "same"}
                  onChange={() => togglePicked(key)}
                  aria-label={key}
                />
                <Flex direction="column" gap="0.5" flex="1" minW="0">
                  <chakra.span fontSize="sm" fontWeight={500}>
                    {key} <chakra.span color="app.textMuted">({c.key_type})</chakra.span>
                  </chakra.span>
                  <chakra.code
                    fontFamily="var(--font-mono)"
                    fontSize="xs"
                    opacity={0.8}
                    wordBreak="break-all"
                  >
                    {c.fingerprint}
                  </chakra.code>
                </Flex>
                <chakra.span
                  fontSize="xs"
                  color={c.status === "conflict" ? "app.textWarning" : "app.textMuted"}
                >
                  {t(IMPORT_STATUS_KEY[c.status])}
                </chakra.span>
              </Flex>
            );
          })}
          {scan.hashed_skipped > 0 && (
            <Callout tone="info">{t("knownHostsImportHashed", { count: scan.hashed_skipped })}</Callout>
          )}
          <Flex gap="2" justify="flex-end">
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={picked.size === 0 || importing}
              onClick={handleImport}
            >
              {t("knownHostsImportRun")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setScan(null)}>
              {t("knownHostsImportClose")}
            </Button>
          </Flex>
        </Flex>
      )}
      <Flex direction="column" gap="1" mt="3" data-testid="known-hosts-history">
        <chakra.h4 fontSize="sm" fontWeight={600}>
          {t("knownHostsHistoryTitle")}
        </chakra.h4>
        {history.length === 0 ? (
          <chakra.p fontSize="sm" color="app.textMuted">
            {t("knownHostsHistoryEmpty")}
          </chakra.p>
        ) : (
          <>
            {visibleHistory.map((e, i) => (
              <Flex
                key={`${e.at}:${e.host}:${e.port}:${i}`}
                direction="column"
                gap="0.5"
                px="2"
                py="1.5"
                borderRadius="sm"
                bg="app.surfaceMuted"
              >
                <Flex gap="2" align="baseline" wrap="wrap">
                  <chakra.span textStyle="caption">{new Date(e.at).toLocaleString()}</chakra.span>
                  <chakra.span fontSize="xs" fontWeight={600}>
                    {t(HISTORY_ACTION_KEY[e.action])}
                  </chakra.span>
                  <chakra.span fontSize="sm" fontWeight={500}>
                    {e.host}:{e.port}
                  </chakra.span>
                </Flex>
                <chakra.code fontFamily="var(--font-mono)" fontSize="xs" opacity={0.8} wordBreak="break-all">
                  {e.fingerprint}
                </chakra.code>
                {e.previous_fingerprint && (
                  <chakra.span fontSize="xs" color="app.textWarning" wordBreak="break-all">
                    {t("knownHostsHistoryPrevious", { fingerprint: e.previous_fingerprint })}
                  </chakra.span>
                )}
              </Flex>
            ))}
            {history.length > HISTORY_PREVIEW && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowAllHistory((v) => !v)}>
                {showAllHistory
                  ? t("knownHostsHistoryLess")
                  : t("knownHostsHistoryMore", { count: history.length })}
              </Button>
            )}
          </>
        )}
      </Flex>
    </SettingsSection>
  );
}
