import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, chakra, Flex, Text } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir, join, dirname } from "@tauri-apps/api/path";
import {
  api,
  ConnectionProfile,
  DriverKind,
  ProfileSecretKind,
  SshAuthMethod,
  SslMode,
} from "../api/tauri";
import { useT } from "../i18n";
import { copyToClipboard } from "./clipboard";
import { Icon, ICON_SIZES } from "./Icon";
import { Button, Heading, Input, Select, Switch, Textarea } from "./ui";
import { LoadingButton } from "./LoadingButton";
import { Tooltip } from "./Tooltip";
import { transitions, variants } from "../motion";
import { semanticColorToken } from "../semanticColors";

// Bullet glyphs shown (read-only) to stand in for a secret that is already
// saved in the OS keyring. The real value is not part of the profile payload,
// so this is a fixed-length placeholder whose only job is to make "a password
// is set" visible instead of an empty field. Reading the actual value takes an
// explicit reveal (see `PasswordInput` below, #938).
const STORED_MASK = "•".repeat(10);

/**
 * How long a revealed secret stays on screen before it re-masks itself (#938).
 * Long enough to read a generated password out loud or copy it, short enough
 * that walking away from the machine doesn't leave a password displayed.
 */
const REVEAL_TIMEOUT_MS = 30_000;

interface PasswordInputProps {
  value: string;
  onChange: (value: string) => void;
  /** True when a secret for this field already exists in the keyring. */
  hasStored: boolean;
  /**
   * Profile whose stored secret the reveal button reads (#938). Undefined for
   * unsaved profiles — there is nothing in the keyring yet, so no reveal.
   */
  profileId?: string;
  /** Which keyring entry the reveal button reads. Pairs with `profileId`. */
  secretKind?: ProfileSecretKind;
  /** Associates the visible <label htmlFor> with the inner input (a11y). */
  id?: string;
}

/**
 * Password input with an always-visible show/hide toggle. When a secret is
 * already stored and the user has not typed a replacement, it displays a masked
 * placeholder (read-only) so the saved state is obvious; focusing clears it for
 * editing and leaving it untouched keeps the stored value (empty `value`).
 *
 * In that stored-but-untyped state the toggle does more than flip the input
 * type: it fetches the saved secret from the OS keyring (`revealProfileSecret`)
 * so the user can check a password they forgot without digging through
 * Credential Manager / Keychain / secret-tool (#938). The fetched value lives
 * only in this component's state — it is dropped on re-mask, on unmount, and
 * automatically after {@link REVEAL_TIMEOUT_MS}.
 */
function PasswordInput({
  value,
  onChange,
  hasStored,
  profileId,
  secretKind,
  id,
}: PasswordInputProps) {
  const t = useT();
  const [show, setShow] = useState(false);
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showingMask = hasStored && value === "" && !focused && revealed === null;
  const canReveal = hasStored && value === "" && !!profileId && !!secretKind;

  const clearHideTimer = () => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  // Drop the plaintext (and any pending timer) when the field unmounts — e.g.
  // switching the SSH auth method away from "password" while it is revealed.
  useEffect(
    () => () => {
      clearHideTimer();
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const hideRevealed = () => {
    clearHideTimer();
    setRevealed(null);
    setShow(false);
    setCopied(false);
    setRevealError(null);
  };

  const revealStored = async () => {
    if (!profileId || !secretKind) return;
    setRevealing(true);
    setRevealError(null);
    try {
      const secret = await api.revealProfileSecret(profileId, secretKind);
      if (secret === null) {
        // The `has_*` flag said there was one; the entry is gone (deleted from
        // the OS keyring behind our back). Say so instead of showing "".
        setRevealError(t("formPasswordRevealMissing"));
        return;
      }
      setRevealed(secret);
      setShow(true);
      clearHideTimer();
      hideTimer.current = setTimeout(hideRevealed, REVEAL_TIMEOUT_MS);
    } catch (e) {
      setRevealError(`${t("formPasswordRevealFailed")}: ${String(e)}`);
    } finally {
      setRevealing(false);
    }
  };

  const onToggle = () => {
    if (revealed !== null) {
      hideRevealed();
      return;
    }
    if (canReveal) {
      void revealStored();
      return;
    }
    setShow((s) => !s);
  };

  const copyRevealed = async () => {
    if (revealed === null) return;
    if (await copyToClipboard(revealed)) {
      setCopied(true);
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    }
  };

  const showing = show || revealed !== null;
  const toggleLabel = showing
    ? t("formPasswordHide")
    : canReveal
      ? t("formPasswordReveal")
      : t("formPasswordShow");
  // Room for the toggle, plus the copy button while a secret is revealed.
  const inputPadding = revealed !== null ? "62px" : "34px";

  return (
    <Box>
      <Box position="relative" display="flex" alignItems="center">
        <Input
          id={id}
          type={showing ? "text" : "password"}
          value={showingMask ? STORED_MASK : (revealed ?? value)}
          readOnly={showingMask || revealed !== null}
          autoComplete="off"
          pr={inputPadding}
          // Hide the WebView2/Edge native password reveal & clear controls so they
          // don't render a second eye icon alongside our own toggle button.
          css={{ "&::-ms-reveal": { display: "none" }, "&::-ms-clear": { display: "none" } }}
          onChange={(e) => {
            // 入力を始めた時点で、前回の読み出し失敗の文言は用済み。
            setRevealError(null);
            onChange(e.target.value);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {revealed !== null && (
          <Tooltip label={copied ? t("formPasswordCopied") : t("formPasswordCopy")}>
            <chakra.button
              type="button"
              position="absolute"
              right="32px"
              display="inline-flex"
              alignItems="center"
              justifyContent="center"
              p="1"
              border="none"
              bg="transparent"
              color={copied ? "app.textSuccess" : "app.textMuted"}
              borderRadius="sm"
              _hover={{ bg: "app.hover", color: copied ? "app.textSuccess" : "app.text" }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void copyRevealed()}
              aria-label={copied ? t("formPasswordCopied") : t("formPasswordCopy")}
            >
              <Icon name={copied ? "check" : "copy"} size={ICON_SIZES.md} />
            </chakra.button>
          </Tooltip>
        )}
        <Tooltip label={toggleLabel}>
          <chakra.button
            type="button"
            position="absolute"
            right="4px"
            display="inline-flex"
            alignItems="center"
            justifyContent="center"
            p="1"
            border="none"
            bg="transparent"
            color="app.textMuted"
            borderRadius="sm"
            _hover={{ bg: "app.hover", color: "app.text" }}
            // Keep the input focused so the toggle works while typing.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onToggle}
            disabled={revealing}
            aria-pressed={showing}
            aria-label={toggleLabel}
          >
            <Icon name={showing ? "eye-off" : "eye"} size={ICON_SIZES.md} />
          </chakra.button>
        </Tooltip>
      </Box>
      {revealError && (
        // クリック後に非同期で現れるため、支援技術へ通知する (role="alert")。
        <Text role="alert" color="app.textError" fontSize="11px" mt="1" mb="0">
          {revealError}
        </Text>
      )}
      {revealed !== null && (
        <Text color="app.textMuted" fontSize="11px" mt="1" mb="0">
          {t("formPasswordRevealNote", { seconds: REVEAL_TIMEOUT_MS / 1000 })}
        </Text>
      )}
    </Box>
  );
}

interface Props {
  initial: ConnectionProfile | null;
  profiles: ConnectionProfile[];
  onSaved: () => void;
  onCancel: () => void;
}

const DEFAULT_PROD_COLOR = "#dc2626";
const COLOR_PRESETS = [
  "#dc2626", // red — production
  "#ea580c", // orange — staging
  "#ca8a04", // yellow — sandbox
  "#16a34a", // green — development
  "#2563eb", // blue — read replica
  "#7c3aed", // purple — misc
];

function defaultPortFor(driver: DriverKind): number {
  switch (driver) {
    case "mysql": return 3306;
    case "postgres": return 5432;
    case "sqlite": return 0;
    case "duckdb": return 0;
    case "mssql": return 1433;
  }
}

function defaultUserFor(driver: DriverKind): string {
  switch (driver) {
    case "mysql": return "root";
    case "postgres": return "postgres";
    case "sqlite": return "";
    case "duckdb": return "";
    case "mssql": return "sa";
  }
}

function normalizeDriver(driver: string | undefined): DriverKind {
  if (
    driver === "postgres" ||
    driver === "sqlite" ||
    driver === "mysql" ||
    driver === "duckdb" ||
    driver === "mssql"
  ) {
    return driver;
  }
  return "mysql";
}

/** Bordered field group, spanning both columns of the form grid. */
function Fieldset({ children }: { children: ReactNode }) {
  return (
    <Box
      as="fieldset"
      gridColumn="span 2"
      border="1px solid"
      borderColor="app.border"
      borderRadius="md"
      p="3"
    >
      {children}
    </Box>
  );
}

function Legend({ children }: { children: ReactNode }) {
  return (
    <Heading as="legend" role="subheading" px="1.5">
      {children}
    </Heading>
  );
}

// motion 用 props は Chakra のスタイルプロップに飲まれないよう forwardProps で
// 素通しする (`ActivityCenter` / `MultiStateBadge` と同じパターン)。
const MotionBanner = chakra(motion.div, {}, {
  forwardProps: ["initial", "animate", "exit", "transition"],
});

/**
 * 接続テスト結果のバナー (#1006)。成功/失敗を `AnimatePresence` +
 * `variants.slideUp` (`motion.ts`) で出入りさせ、`prefers-reduced-motion` /
 * `settings.motionPreference="reduced"` はルートの `MotionConfig` が自動で
 * 即時化する (個別分岐は不要)。色は意味色トークン (`semanticColors.ts`) 経由で
 * 解決し、色値を直書きしない。成功は `role="status"`、失敗は `role="alert"` +
 * `aria-live` で支援技術へ通知される。
 */
function ResultBanner({ tone, children }: { tone: "success" | "danger"; children: ReactNode }) {
  return (
    <MotionBanner
      role={tone === "success" ? "status" : "alert"}
      aria-live={tone === "success" ? "polite" : "assertive"}
      initial={variants.slideUp.initial}
      animate={variants.slideUp.animate}
      exit={variants.slideUp.exit}
      transition={transitions.enter}
      gridColumn="span 2"
      display="flex"
      alignItems="center"
      gap="2"
      px="3"
      py="2"
      border="1px solid"
      borderColor={semanticColorToken(tone, "border")}
      bg={semanticColorToken(tone, "subtle")}
      color={semanticColorToken(tone, "text")}
      borderRadius="md"
      fontSize="13px"
    >
      <Icon name={tone === "success" ? "check" : "warning"} size={ICON_SIZES.md} />
      <Box as="span">{children}</Box>
    </MotionBanner>
  );
}

/** Inline switch toggle with a muted help line underneath. */
function CheckboxRow({
  checked,
  onChange,
  label,
  help,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  help: string;
}) {
  return (
    <Box>
      <Flex display="inline-flex" align="center" gap="1.5" fontSize="12px">
        <Switch checked={checked} onChange={onChange} size="sm" label={label} />
      </Flex>
      <Text color="app.textMuted" fontSize="11px" mt="1" mb="0">
        {help}
      </Text>
    </Box>
  );
}

export function ConnectionForm({ initial, profiles, onSaved, onCancel }: Props) {
  const t = useT();
  // 可視ラベル (<label>) と入力コントロールを `htmlFor`/`id` で関連付けるための
  // 一意な ID プレフィックス (a11y: axe の label / select-name ルール対応)。
  const fid = useId();
  const groupSuggestions = useMemo(() => {
    const set = new Set<string>();
    for (const p of profiles) {
      if (p.group && p.group.trim()) set.add(p.group);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [profiles]);

  const initialDriver = normalizeDriver(initial?.driver);
  const [driver, setDriver] = useState<DriverKind>(initialDriver);
  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "127.0.0.1");
  const [port, setPort] = useState(String(initial?.port ?? defaultPortFor(initialDriver)));
  const [user, setUser] = useState(initial?.user ?? defaultUserFor(initialDriver));
  const [database, setDatabase] = useState(initial?.database ?? "");
  const [password, setPassword] = useState("");
  const [filePath, setFilePath] = useState(initial?.file_path ?? "");
  const [group, setGroup] = useState(initial?.group ?? "");
  const [color, setColor] = useState<string | null>(initial?.color ?? null);
  const [isProduction, setIsProduction] = useState<boolean>(initial?.is_production ?? false);
  const [confirmWrites, setConfirmWrites] = useState<boolean>(initial?.confirm_writes ?? false);
  const [readOnly, setReadOnly] = useState<boolean>(initial?.read_only ?? false);
  const [skipHistory, setSkipHistory] = useState<boolean>(initial?.skip_history ?? false);

  // TLS / SSL. `prefer` matches the sqlx default (TLS when offered, no
  // verification), so an untouched form keeps the pre-TLS connection behavior.
  const [sslMode, setSslMode] = useState<SslMode>(initial?.ssl_mode ?? "prefer");
  const [sslRootCert, setSslRootCert] = useState(initial?.ssl_root_cert ?? "");
  const [sslClientCert, setSslClientCert] = useState(initial?.ssl_client_cert ?? "");
  const [sslClientKey, setSslClientKey] = useState(initial?.ssl_client_key ?? "");

  // Session-initialization SQL run on every new connection (#522).
  const [initSql, setInitSql] = useState(initial?.init_sql ?? "");

  const [useSsh, setUseSsh] = useState(!!initial?.ssh);
  const [sshHost, setSshHost] = useState(initial?.ssh?.host ?? "");
  const [sshPort, setSshPort] = useState(String(initial?.ssh?.port ?? 22));
  const [sshUser, setSshUser] = useState(initial?.ssh?.user ?? "");
  const [sshAuthMethod, setSshAuthMethod] = useState<SshAuthMethod>(initial?.ssh?.auth_method ?? "key");
  const [sshKeyPath, setSshKeyPath] = useState(initial?.ssh?.private_key_path ?? "");
  const [sshPassphrase, setSshPassphrase] = useState("");
  const [sshPassword, setSshPassword] = useState("");
  const [loadingSshConfig, setLoadingSshConfig] = useState(false);

  // Bastion/jump hop (#708 multi-hop tunnel — capped at one jump hop, 2 SSH
  // hops total). Mirrors the main SSH fields above; only the auth-method-
  // specific secret fields differ (their own keyring kind, `_hop0`).
  const [useSshJump, setUseSshJump] = useState(!!initial?.ssh?.jump);
  const [sshJumpHost, setSshJumpHost] = useState(initial?.ssh?.jump?.host ?? "");
  const [sshJumpPort, setSshJumpPort] = useState(String(initial?.ssh?.jump?.port ?? 22));
  const [sshJumpUser, setSshJumpUser] = useState(initial?.ssh?.jump?.user ?? "");
  const [sshJumpAuthMethod, setSshJumpAuthMethod] = useState<SshAuthMethod>(
    initial?.ssh?.jump?.auth_method ?? "key",
  );
  const [sshJumpKeyPath, setSshJumpKeyPath] = useState(initial?.ssh?.jump?.private_key_path ?? "");
  const [sshJumpPassphrase, setSshJumpPassphrase] = useState("");
  const [sshJumpPassword, setSshJumpPassword] = useState("");

  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  // `error`/`message` は「接続テスト結果」専用のバナーに整理する (#1006)。
  // ポートのバリデーション失敗はどのフィールドが不正かを示せないため、フィールド
  // 直下の専用エラー (下記 3 種) へ分離する。
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [portError, setPortError] = useState<string | null>(null);
  const [sshPortError, setSshPortError] = useState<string | null>(null);
  const [sshJumpPortError, setSshJumpPortError] = useState<string | null>(null);

  // DuckDB (#709) is file-backed exactly like SQLite: same `file_path`
  // requirement, no host/port/user/password, no SSH tunnel, no TLS.
  const isFileBacked = driver === "sqlite" || driver === "duckdb";

  const handleDriverChange = (next: DriverKind) => {
    if (next === driver) return;
    // Reset port/user defaults when the user has not customised them; this
    // keeps freshly opened forms sensible without overwriting deliberate
    // overrides on an in-progress edit.
    if (port === String(defaultPortFor(driver))) setPort(String(defaultPortFor(next)));
    if (user === defaultUserFor(driver)) setUser(defaultUserFor(next));
    setDriver(next);
  };

  const pickKeyFile = async () => {
    // Open the picker in a small, relevant directory. Without a defaultPath the
    // native Windows dialog lands on "This PC"/Quick Access and enumerates every
    // drive (including disconnected network mounts), making it slow to appear and
    // briefly spiking CPU/disk. SSH keys live under ~/.ssh, so start there (or in
    // the directory of an already-entered path).
    let defaultPath: string | undefined;
    try {
      defaultPath = sshKeyPath.trim()
        ? await dirname(sshKeyPath)
        : await join(await homeDir(), ".ssh");
    } catch {
      defaultPath = undefined;
    }
    const selected = await open({
      multiple: false,
      directory: false,
      title: t("formPickKeyTitle"),
      defaultPath,
    });
    if (typeof selected === "string") setSshKeyPath(selected);
  };

  const pickJumpKeyFile = async () => {
    let defaultPath: string | undefined;
    try {
      defaultPath = sshJumpKeyPath.trim()
        ? await dirname(sshJumpKeyPath)
        : await join(await homeDir(), ".ssh");
    } catch {
      defaultPath = undefined;
    }
    const selected = await open({
      multiple: false,
      directory: false,
      title: t("formPickKeyTitle"),
      defaultPath,
    });
    if (typeof selected === "string") setSshJumpKeyPath(selected);
  };

  // Resolves the alias currently typed into the SSH Host field against
  // ~/.ssh/config (#708) and prefills HostName / Port / User / IdentityFile,
  // plus the jump-host section when a ProxyJump directive was found. Values
  // are copied once — later edits to ~/.ssh/config have no effect on the
  // saved profile.
  const handleLoadSshConfig = async () => {
    setError(null);
    setMessage(null);
    const alias = sshHost.trim();
    if (!alias) return;
    setLoadingSshConfig(true);
    try {
      const resolved = await api.resolveSshConfigHost(alias);
      if (!resolved) {
        setError(t("formSshConfigNoMatch", { alias }));
        return;
      }
      if (resolved.host_name) setSshHost(resolved.host_name);
      if (resolved.port !== null) setSshPort(String(resolved.port));
      if (resolved.user) setSshUser(resolved.user);
      if (resolved.identity_file) {
        setSshAuthMethod("key");
        setSshKeyPath(resolved.identity_file);
      }
      if (resolved.jump_host) {
        setUseSshJump(true);
        setSshJumpHost(resolved.jump_host);
        if (resolved.jump_port !== null) setSshJumpPort(String(resolved.jump_port));
        if (resolved.jump_user) setSshJumpUser(resolved.jump_user);
      }
      setMessage(t("formSshConfigLoaded", { alias }));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingSshConfig(false);
    }
  };

  const pickCertFile = async (set: (path: string) => void, current: string) => {
    let defaultPath: string | undefined;
    try {
      defaultPath = current.trim() ? await dirname(current) : undefined;
    } catch {
      defaultPath = undefined;
    }
    const selected = await open({
      multiple: false,
      directory: false,
      title: t("formPickCertTitle"),
      defaultPath,
      filters: [
        { name: t("formCertFileFilter"), extensions: ["pem", "crt", "cert", "key", "ca"] },
        { name: t("formAnyFileFilter"), extensions: ["*"] },
      ],
    });
    if (typeof selected === "string") set(selected);
  };

  // Non-secret TLS fields included in both connect and save requests. Empty
  // paths are sent as null so the backend treats them as unset.
  const tlsSettings = () => ({
    ssl_mode: sslMode,
    ssl_root_cert: sslRootCert.trim() || null,
    ssl_client_cert: sslClientCert.trim() || null,
    ssl_client_key: sslClientKey.trim() || null,
  });

  const pickDbFile = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      title: t("formPickDbFileTitle"),
      filters:
        driver === "duckdb"
          ? [
              { name: t("formDuckDbFileFilter"), extensions: ["duckdb", "db"] },
              { name: t("formAnyFileFilter"), extensions: ["*"] },
            ]
          : [
              { name: t("formSqliteFileFilter"), extensions: ["db", "sqlite", "sqlite3"] },
              { name: t("formAnyFileFilter"), extensions: ["*"] },
            ],
    });
    if (typeof selected === "string") setFilePath(selected);
  };

  const buildRequest = () => {
    if (isFileBacked) {
      return {
        profile_id: initial?.id,
        driver,
        host: "",
        port: 0,
        user: "",
        password: "",
        database: null,
        ssh: null,
        file_path: filePath || null,
        read_only: readOnly,
        skip_history: skipHistory,
        init_sql: initSql.trim() || null,
      };
    }
    return {
      profile_id: initial?.id,
      driver,
      host,
      port: Number(port),
      user,
      password,
      database: database || null,
      ssh: useSsh
        ? {
            host: sshHost,
            port: Number(sshPort),
            user: sshUser,
            auth_method: sshAuthMethod,
            private_key_path: sshAuthMethod === "key" ? sshKeyPath : "",
            passphrase: sshAuthMethod === "key" ? sshPassphrase : "",
            password: sshAuthMethod === "password" ? sshPassword : "",
            jump: useSshJump
              ? {
                  host: sshJumpHost,
                  port: Number(sshJumpPort),
                  user: sshJumpUser,
                  auth_method: sshJumpAuthMethod,
                  private_key_path: sshJumpAuthMethod === "key" ? sshJumpKeyPath : "",
                  passphrase: sshJumpAuthMethod === "key" ? sshJumpPassphrase : "",
                  password: sshJumpAuthMethod === "password" ? sshJumpPassword : "",
                }
              : null,
          }
        : null,
      file_path: null,
      read_only: readOnly,
      skip_history: skipHistory,
      ...tlsSettings(),
      init_sql: initSql.trim() || null,
    };
  };

  const toggleProduction = (checked: boolean) => {
    setIsProduction(checked);
    if (checked && !color) setColor(DEFAULT_PROD_COLOR);
    // The write-approval option is a child of "production"; clear it when the
    // parent is unchecked so a hidden, stale value can't be persisted.
    if (!checked) setConfirmWrites(false);
  };

  const parsePort = (value: string): number | null => {
    if (!/^\d+$/.test(value)) return null;
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
  };

  // Network-backed drivers need a valid port; SQLite is file-backed and skips it.
  // Each invalid field gets its own message (shown inline under the field with
  // `aria-invalid`, #1006) rather than a single aggregated string, since the
  // aggregated `error` box is now reserved for the connection test result.
  const validatePorts = (): boolean => {
    setPortError(null);
    setSshPortError(null);
    setSshJumpPortError(null);
    if (isFileBacked) return true;
    let ok = true;
    if (parsePort(port) === null) {
      setPortError(t("formInvalidPort"));
      ok = false;
    }
    if (useSsh && parsePort(sshPort) === null) {
      setSshPortError(t("formInvalidSshPort"));
      ok = false;
    }
    if (useSsh && useSshJump && parsePort(sshJumpPort) === null) {
      setSshJumpPortError(t("formInvalidSshJumpPort"));
      ok = false;
    }
    return ok;
  };

  const handleTest = async () => {
    setError(null); setMessage(null);
    if (!validatePorts()) return;
    setTesting(true);
    try {
      await api.testConnection(buildRequest());
      setMessage(t("formConnectionOk"));
    } catch (e) {
      setError(String(e));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setError(null); setMessage(null);
    if (!validatePorts()) return;
    setSaving(true);
    try {
      await api.saveProfile({
        id: initial?.id,
        name,
        driver,
        host: isFileBacked ? "" : host,
        port: isFileBacked ? 0 : Number(port),
        user: isFileBacked ? "" : user,
        database: isFileBacked ? null : (database || null),
        ssh: !isFileBacked && useSsh
          ? {
              host: sshHost,
              port: Number(sshPort),
              user: sshUser,
              auth_method: sshAuthMethod,
              private_key_path: sshAuthMethod === "key" ? sshKeyPath : "",
              jump: useSshJump
                ? {
                    host: sshJumpHost,
                    port: Number(sshJumpPort),
                    user: sshJumpUser,
                    auth_method: sshJumpAuthMethod,
                    private_key_path: sshJumpAuthMethod === "key" ? sshJumpKeyPath : "",
                  }
                : null,
            }
          : null,
        db_password: isFileBacked || password === "" ? undefined : password,
        ssh_passphrase:
          !isFileBacked && useSsh && sshAuthMethod === "key" && sshPassphrase !== ""
            ? sshPassphrase
            : undefined,
        ssh_password:
          !isFileBacked && useSsh && sshAuthMethod === "password" && sshPassword !== ""
            ? sshPassword
            : undefined,
        ssh_jump_passphrase:
          !isFileBacked && useSsh && useSshJump && sshJumpAuthMethod === "key" && sshJumpPassphrase !== ""
            ? sshJumpPassphrase
            : undefined,
        ssh_jump_password:
          !isFileBacked && useSsh && useSshJump && sshJumpAuthMethod === "password" && sshJumpPassword !== ""
            ? sshJumpPassword
            : undefined,
        group: group.trim() || null,
        color: color || null,
        is_production: isProduction,
        confirm_writes: confirmWrites,
        read_only: readOnly,
        skip_history: skipHistory,
        file_path: isFileBacked ? (filePath || null) : null,
        // SQLite is file-backed and never negotiates TLS; persist null so a
        // driver switch can't leave stale TLS settings on the profile.
        ssl_mode: isFileBacked ? null : sslMode,
        ssl_root_cert: isFileBacked ? null : (sslRootCert.trim() || null),
        ssl_client_cert: isFileBacked ? null : (sslClientCert.trim() || null),
        ssl_client_key: isFileBacked ? null : (sslClientKey.trim() || null),
        // Init SQL applies to all drivers (SQLite via PRAGMA).
        init_sql: initSql.trim() || null,
      });
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box
      display="grid"
      gridTemplateColumns="1fr 1fr"
      gap="3"
      p="4"
      overflowY="auto"
    >
      <Heading gridColumn="span 2">
        {initial?.id ? t("formEditTitle", { name: initial.name }) : t("formNewTitle")}
      </Heading>

      <Box gridColumn="span 2">
        <label htmlFor={`${fid}-name`}>{t("formName")}</label>
        <Input id={`${fid}-name`} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("formNamePlaceholder")} />
      </Box>

      <Box gridColumn="span 2">
        <label htmlFor={`${fid}-driver`}>{t("formDriver")}</label>
        <Select
          id={`${fid}-driver`}
          value={driver}
          onChange={(e) => handleDriverChange(e.target.value as DriverKind)}
        >
          <option value="mysql">{t("formDriverMysql")}</option>
          <option value="postgres">{t("formDriverPostgres")}</option>
          <option value="sqlite">{t("formDriverSqlite")}</option>
          <option value="duckdb">{t("formDriverDuckDb")}</option>
          <option value="mssql">{t("formDriverMssql")}</option>
        </Select>
      </Box>

      {isFileBacked ? (
        <Fieldset>
          <Legend>{driver === "duckdb" ? t("formDuckDbLegend") : t("formSqliteLegend")}</Legend>
          <Box>
            <label htmlFor={`${fid}-sqlite-path`}>
              {driver === "duckdb" ? t("formDuckDbFilePath") : t("formSqliteFilePath")}
            </label>
            <Flex gap="2" align="end">
              <Input
                id={`${fid}-sqlite-path`}
                value={filePath}
                onChange={(e) => setFilePath(e.target.value)}
                placeholder={
                  driver === "duckdb"
                    ? t("formDuckDbFilePathPlaceholder")
                    : t("formSqliteFilePathPlaceholder")
                }
              />
              <Button type="button" onClick={pickDbFile}>{t("formBrowse")}</Button>
            </Flex>
            <Text color="app.textMuted" fontSize="11px" mt="1" mb="0">
              {driver === "duckdb" ? t("formDuckDbFilePathHelp") : t("formSqliteFilePathHelp")}
            </Text>
          </Box>
        </Fieldset>
      ) : (
        <Fieldset>
          <Legend>
            {driver === "postgres"
              ? t("formPostgresLegend")
              : driver === "mssql"
                ? t("formMssqlLegend")
                : t("formMysqlLegend")}
          </Legend>
          <Box display="grid" gridTemplateColumns="1fr 120px" gap="3">
            <Box>
              <label htmlFor={`${fid}-host`}>{t("formHost")}</label>
              <Input id={`${fid}-host`} value={host} onChange={(e) => setHost(e.target.value)} />
            </Box>
            <Box>
              <label htmlFor={`${fid}-port`}>{t("formPort")}</label>
              <Input
                id={`${fid}-port`}
                type="text"
                inputMode="numeric"
                value={port}
                aria-invalid={portError ? true : undefined}
                onChange={(e) => {
                  setPort(e.target.value.replace(/[^0-9]/g, ""));
                  if (portError) setPortError(null);
                }}
              />
              {portError && (
                <Text role="alert" color="app.textError" fontSize="11px" mt="1" mb="0">
                  {portError}
                </Text>
              )}
            </Box>
          </Box>
          <Box display="grid" gridTemplateColumns="1fr 1fr" gap="3" mt="2">
            <Box>
              <label htmlFor={`${fid}-user`}>{t("formUser")}</label>
              <Input id={`${fid}-user`} value={user} onChange={(e) => setUser(e.target.value)} />
            </Box>
            <Box>
              <label htmlFor={`${fid}-database`}>{t("formDatabase")}</label>
              <Input id={`${fid}-database`} value={database} onChange={(e) => setDatabase(e.target.value)} />
            </Box>
          </Box>
          <Box mt="2">
            <label htmlFor={`${fid}-db-password`}>{t("formDbPassword")}</label>
            <PasswordInput
              id={`${fid}-db-password`}
              value={password}
              onChange={setPassword}
              hasStored={!!initial?.has_db_password}
              profileId={initial?.id}
              secretKind="db_password"
            />
          </Box>
        </Fieldset>
      )}

      {!isFileBacked && (
        <Fieldset>
          <Legend>{t("formTlsLegend")}</Legend>
          <Box>
            <label htmlFor={`${fid}-tls-mode`}>{t("formTlsMode")}</label>
            <Select id={`${fid}-tls-mode`} value={sslMode} onChange={(e) => setSslMode(e.target.value as SslMode)}>
              <option value="disable">{t("formTlsModeDisable")}</option>
              <option value="prefer">{t("formTlsModePrefer")}</option>
              <option value="require">{t("formTlsModeRequire")}</option>
              <option value="verify_ca">{t("formTlsModeVerifyCa")}</option>
              <option value="verify_full">{t("formTlsModeVerifyFull")}</option>
            </Select>
            <Text color="app.textMuted" fontSize="11px" mt="1" mb="0">
              {t("formTlsModeHelp")}
            </Text>
          </Box>
          {isProduction &&
            (sslMode === "disable" || sslMode === "prefer" || sslMode === "require") && (
              <Text color="app.textWarning" fontSize="11px" mt="2" mb="0">
                {t("formTlsProductionHint")}
              </Text>
            )}
          <Box mt="2">
            <label htmlFor={`${fid}-tls-root-cert`}>{t("formTlsRootCert")}</label>
            <Flex gap="2" align="end">
              <Input
                id={`${fid}-tls-root-cert`}
                value={sslRootCert}
                onChange={(e) => setSslRootCert(e.target.value)}
                placeholder={t("formTlsRootCertPlaceholder")}
              />
              <Button type="button" onClick={() => pickCertFile(setSslRootCert, sslRootCert)}>
                {t("formBrowse")}
              </Button>
            </Flex>
            <Text color="app.textMuted" fontSize="11px" mt="1" mb="0">
              {t("formTlsRootCertHelp")}
            </Text>
          </Box>
          <Box mt="2">
            <label htmlFor={`${fid}-tls-client-cert`}>{t("formTlsClientCert")}</label>
            <Flex gap="2" align="end">
              <Input
                id={`${fid}-tls-client-cert`}
                value={sslClientCert}
                onChange={(e) => setSslClientCert(e.target.value)}
                placeholder={t("formTlsClientCertPlaceholder")}
              />
              <Button type="button" onClick={() => pickCertFile(setSslClientCert, sslClientCert)}>
                {t("formBrowse")}
              </Button>
            </Flex>
          </Box>
          <Box mt="2">
            <label htmlFor={`${fid}-tls-client-key`}>{t("formTlsClientKey")}</label>
            <Flex gap="2" align="end">
              <Input
                id={`${fid}-tls-client-key`}
                value={sslClientKey}
                onChange={(e) => setSslClientKey(e.target.value)}
                placeholder={t("formTlsClientKeyPlaceholder")}
              />
              <Button type="button" onClick={() => pickCertFile(setSslClientKey, sslClientKey)}>
                {t("formBrowse")}
              </Button>
            </Flex>
            <Text color="app.textMuted" fontSize="11px" mt="1" mb="0">
              {t("formTlsClientHelp")}
            </Text>
          </Box>
          {useSsh && (
            <Text color="app.textMuted" fontSize="11px" mt="2" mb="0">
              {t("formTlsSshHint")}
            </Text>
          )}
        </Fieldset>
      )}

      <Fieldset>
        <Legend>{t("formGroup")}</Legend>
        <Box>
          <Input
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            placeholder={t("formGroupPlaceholder")}
            list="form-group-suggestions"
          />
          <datalist id="form-group-suggestions">
            {groupSuggestions.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          <Text color="app.textMuted" fontSize="11px" mt="1" mb="0">
            {t("formGroupHelp")}
          </Text>
        </Box>
      </Fieldset>

      <Fieldset>
        <Legend>{t("formDisplay")}</Legend>
        <Flex direction="column" gap="3">
          <Box>
            <label htmlFor={`${fid}-color`}>{t("formColor")}</label>
            <Flex align="center" gap="2" flexWrap="wrap">
              {COLOR_PRESETS.map((c) => (
                <Tooltip key={c} label={c}>
                  <chakra.button
                    type="button"
                    width="24px"
                    height="24px"
                    borderRadius="sm"
                    border="2px solid"
                    borderColor={color === c ? "app.text" : "transparent"}
                    p={0}
                    cursor="pointer"
                    boxShadow="0 0 0 1px var(--border-strong)"
                    bg={c}
                    transitionProperty="background, color, border-color, box-shadow"
                    transitionDuration="var(--dur-fast)"
                    transitionTimingFunction="var(--ease)"
                    onClick={() => setColor(c)}
                    aria-label={c}
                  />
                </Tooltip>
              ))}
              <input
                id={`${fid}-color`}
                type="color"
                value={color ?? "#888888"}
                onChange={(e) => setColor(e.target.value)}
                style={{ width: 42, padding: 0, height: 28 }}
              />
              {color && (
                <Button type="button" onClick={() => setColor(null)}>
                  {t("formColorClear")}
                </Button>
              )}
            </Flex>
          </Box>
          <Box>
            <CheckboxRow
              checked={isProduction}
              onChange={toggleProduction}
              label={t("formIsProduction")}
              help={t("formIsProductionHelp")}
            />
            {isProduction && (
              <Box ml="22px" mt="2">
                <CheckboxRow
                  checked={confirmWrites}
                  onChange={setConfirmWrites}
                  label={t("formConfirmWrites")}
                  help={t("formConfirmWritesHelp")}
                />
              </Box>
            )}
          </Box>
          <CheckboxRow
            checked={readOnly}
            onChange={setReadOnly}
            label={t("formReadOnly")}
            help={t("formReadOnlyHelp")}
          />
          <CheckboxRow
            checked={skipHistory}
            onChange={setSkipHistory}
            label={t("formSkipHistory")}
            help={t("formSkipHistoryHelp")}
          />
        </Flex>
      </Fieldset>

      {!isFileBacked && (
        <Fieldset>
          <Legend>
            <Flex display="inline-flex" align="center" gap="1.5" fontSize="12px">
              <Switch checked={useSsh} onChange={setUseSsh} size="sm" label={t("formUseSsh")} />
            </Flex>
          </Legend>
          {useSsh && (
            <>
              <Box display="grid" gridTemplateColumns="1fr 120px" gap="3">
                <Box>
                  <label htmlFor={`${fid}-ssh-host`}>{t("formSshHost")}</label>
                  <Flex gap="2" align="end">
                    <Input id={`${fid}-ssh-host`} value={sshHost} onChange={(e) => setSshHost(e.target.value)} />
                    <Tooltip label={t("formSshLoadFromConfigHelp")}>
                      <LoadingButton
                        type="button"
                        loading={loadingSshConfig}
                        onClick={handleLoadSshConfig}
                        disabled={!sshHost.trim()}
                      >
                        {t("formSshLoadFromConfig")}
                      </LoadingButton>
                    </Tooltip>
                  </Flex>
                </Box>
                <Box>
                  <label htmlFor={`${fid}-ssh-port`}>{t("formPort")}</label>
                  <Input
                    id={`${fid}-ssh-port`}
                    type="text"
                    inputMode="numeric"
                    value={sshPort}
                    aria-invalid={sshPortError ? true : undefined}
                    onChange={(e) => {
                      setSshPort(e.target.value.replace(/[^0-9]/g, ""));
                      if (sshPortError) setSshPortError(null);
                    }}
                  />
                  {sshPortError && (
                    <Text role="alert" color="app.textError" fontSize="11px" mt="1" mb="0">
                      {sshPortError}
                    </Text>
                  )}
                </Box>
              </Box>
              <Box mt="2">
                <label htmlFor={`${fid}-ssh-user`}>{t("formSshUser")}</label>
                <Input id={`${fid}-ssh-user`} value={sshUser} onChange={(e) => setSshUser(e.target.value)} />
              </Box>
              <Box mt="2">
                <label htmlFor={`${fid}-ssh-auth`}>{t("formSshAuthMethod")}</label>
                <Select
                  id={`${fid}-ssh-auth`}
                  value={sshAuthMethod}
                  onChange={(e) => setSshAuthMethod(e.target.value as SshAuthMethod)}
                >
                  <option value="key">{t("formSshAuthKey")}</option>
                  <option value="agent">{t("formSshAuthAgent")}</option>
                  <option value="password">{t("formSshAuthPassword")}</option>
                </Select>
              </Box>
              {sshAuthMethod === "key" && (
                <>
                  <Box mt="2">
                    <label htmlFor={`${fid}-ssh-key-path`}>{t("formPrivateKeyPath")}</label>
                    <Flex gap="2" align="end">
                      <Input id={`${fid}-ssh-key-path`} value={sshKeyPath} onChange={(e) => setSshKeyPath(e.target.value)} placeholder="C:\\Users\\you\\.ssh\\id_ed25519" />
                      <Button type="button" onClick={pickKeyFile}>{t("formBrowse")}</Button>
                    </Flex>
                  </Box>
                  <Box mt="2">
                    <label htmlFor={`${fid}-ssh-passphrase`}>{t("formSshPassphrase")}</label>
                    <PasswordInput
                      id={`${fid}-ssh-passphrase`}
                      value={sshPassphrase}
                      onChange={setSshPassphrase}
                      hasStored={!!initial?.has_ssh_passphrase}
                      profileId={initial?.id}
                      secretKind="ssh_passphrase"
                    />
                  </Box>
                </>
              )}
              {sshAuthMethod === "password" && (
                <Box mt="2">
                  <label htmlFor={`${fid}-ssh-password`}>{t("formSshPassword")}</label>
                  <PasswordInput
                    id={`${fid}-ssh-password`}
                    value={sshPassword}
                    onChange={setSshPassword}
                    hasStored={!!initial?.has_ssh_password}
                    profileId={initial?.id}
                    secretKind="ssh_password"
                  />
                </Box>
              )}
              {sshAuthMethod === "agent" && (
                <Text color="app.textMuted" fontSize="11px" mt="2" mb="0">
                  {t("formSshAgentHelp")}
                </Text>
              )}

              <Box mt="3" pt="3" borderTop="1px solid" borderColor="app.border">
                <Flex display="inline-flex" align="center" gap="1.5" fontSize="12px">
                  <Switch checked={useSshJump} onChange={setUseSshJump} size="sm" label={t("formUseSshJump")} />
                </Flex>
                <Text color="app.textMuted" fontSize="11px" mt="1" mb="0">
                  {t("formSshJumpHelp")}
                </Text>
                {useSshJump && (
                  <Box mt="2">
                    <Box display="grid" gridTemplateColumns="1fr 120px" gap="3">
                      <Box>
                        <label htmlFor={`${fid}-ssh-jump-host`}>{t("formSshJumpHost")}</label>
                        <Input
                          id={`${fid}-ssh-jump-host`}
                          value={sshJumpHost}
                          onChange={(e) => setSshJumpHost(e.target.value)}
                        />
                      </Box>
                      <Box>
                        <label htmlFor={`${fid}-ssh-jump-port`}>{t("formPort")}</label>
                        <Input
                          id={`${fid}-ssh-jump-port`}
                          type="text"
                          inputMode="numeric"
                          value={sshJumpPort}
                          aria-invalid={sshJumpPortError ? true : undefined}
                          onChange={(e) => {
                            setSshJumpPort(e.target.value.replace(/[^0-9]/g, ""));
                            if (sshJumpPortError) setSshJumpPortError(null);
                          }}
                        />
                        {sshJumpPortError && (
                          <Text role="alert" color="app.textError" fontSize="11px" mt="1" mb="0">
                            {sshJumpPortError}
                          </Text>
                        )}
                      </Box>
                    </Box>
                    <Box mt="2">
                      <label htmlFor={`${fid}-ssh-jump-user`}>{t("formSshJumpUser")}</label>
                      <Input
                        id={`${fid}-ssh-jump-user`}
                        value={sshJumpUser}
                        onChange={(e) => setSshJumpUser(e.target.value)}
                      />
                    </Box>
                    <Box mt="2">
                      <label htmlFor={`${fid}-ssh-jump-auth`}>{t("formSshJumpAuthMethod")}</label>
                      <Select
                        id={`${fid}-ssh-jump-auth`}
                        value={sshJumpAuthMethod}
                        onChange={(e) => setSshJumpAuthMethod(e.target.value as SshAuthMethod)}
                      >
                        <option value="key">{t("formSshAuthKey")}</option>
                        <option value="agent">{t("formSshAuthAgent")}</option>
                        <option value="password">{t("formSshAuthPassword")}</option>
                      </Select>
                    </Box>
                    {sshJumpAuthMethod === "key" && (
                      <>
                        <Box mt="2">
                          <label htmlFor={`${fid}-ssh-jump-key-path`}>{t("formPrivateKeyPath")}</label>
                          <Flex gap="2" align="end">
                            <Input
                              id={`${fid}-ssh-jump-key-path`}
                              value={sshJumpKeyPath}
                              onChange={(e) => setSshJumpKeyPath(e.target.value)}
                              placeholder="C:\\Users\\you\\.ssh\\id_ed25519"
                            />
                            <Button type="button" onClick={pickJumpKeyFile}>{t("formBrowse")}</Button>
                          </Flex>
                        </Box>
                        <Box mt="2">
                          <label htmlFor={`${fid}-ssh-jump-passphrase`}>{t("formSshJumpPassphrase")}</label>
                          <PasswordInput
                            id={`${fid}-ssh-jump-passphrase`}
                            value={sshJumpPassphrase}
                            onChange={setSshJumpPassphrase}
                            hasStored={!!initial?.has_ssh_jump_passphrase}
                            profileId={initial?.id}
                            secretKind="ssh_jump_passphrase"
                          />
                        </Box>
                      </>
                    )}
                    {sshJumpAuthMethod === "password" && (
                      <Box mt="2">
                        <label htmlFor={`${fid}-ssh-jump-password`}>{t("formSshJumpPassword")}</label>
                        <PasswordInput
                          id={`${fid}-ssh-jump-password`}
                          value={sshJumpPassword}
                          onChange={setSshJumpPassword}
                          hasStored={!!initial?.has_ssh_jump_password}
                          profileId={initial?.id}
                          secretKind="ssh_jump_password"
                        />
                      </Box>
                    )}
                    {sshJumpAuthMethod === "agent" && (
                      <Text color="app.textMuted" fontSize="11px" mt="2" mb="0">
                        {t("formSshAgentHelp")}
                      </Text>
                    )}
                  </Box>
                )}
              </Box>
            </>
          )}
        </Fieldset>
      )}

      <Fieldset>
        <Legend>{t("formInitSqlLegend")}</Legend>
        <Box>
          <Textarea
            value={initSql}
            onChange={(e) => setInitSql(e.target.value)}
            placeholder={
              driver === "sqlite"
                ? t("formInitSqlPlaceholderSqlite")
                : driver === "duckdb"
                  ? t("formInitSqlPlaceholderDuckDb")
                  : t("formInitSqlPlaceholder")
            }
            rows={3}
            css={{ fontFamily: "var(--font-mono)", resize: "vertical", width: "100%" }}
          />
          <Text color="app.textMuted" fontSize="11px" mt="1" mb="0">
            {t("formInitSqlHelp")}
          </Text>
        </Box>
      </Fieldset>

      <AnimatePresence initial={false}>
        {message && <ResultBanner key="test-message" tone="success">{message}</ResultBanner>}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {error && <ResultBanner key="test-error" tone="danger">{error}</ResultBanner>}
      </AnimatePresence>

      <Flex gridColumn="span 2" gap="2" justify="flex-end">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving || testing}>
          {t("formCancel")}
        </Button>
        <LoadingButton type="button" loading={testing} onClick={handleTest} disabled={saving}>
          {testing ? t("formTesting") : t("formTest")}
        </LoadingButton>
        <LoadingButton pressable type="button" variant="primary" loading={saving} onClick={handleSave} disabled={testing}>
          {t("formSave")}
        </LoadingButton>
      </Flex>
    </Box>
  );
}
