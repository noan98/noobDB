import { useCallback, useEffect, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api, type KnownHost } from "../api/tauri";
import { useT } from "../i18n";
import { useConfirm } from "./ConfirmDialog";
import { SettingsHelp, SettingsSection, SettingsSectionHeader } from "./settingsLayout";
import { useToast } from "./Toast";
import { Button } from "./ui";

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
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setHosts(await api.listKnownHosts());
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
        message: t("knownHostsDesc"),
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

  return (
    <SettingsSection>
      {dialog}
      <SettingsSectionHeader>
        <chakra.h3>{t("knownHostsTitle")}</chakra.h3>
        <Button type="button" variant="secondary" size="sm" onClick={reload} disabled={loading}>
          {t("knownHostsRefresh")}
        </Button>
      </SettingsSectionHeader>
      <SettingsHelp>{t("knownHostsDesc")}</SettingsHelp>
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
                <chakra.code
                  fontFamily="var(--font-mono)"
                  fontSize="xs"
                  opacity={0.8}
                  wordBreak="break-all"
                >
                  {h.fingerprint}
                </chakra.code>
              </Flex>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => handleForget(h)}
              >
                {t("knownHostsForget")}
              </Button>
            </Flex>
          ))}
        </Flex>
      )}
    </SettingsSection>
  );
}
