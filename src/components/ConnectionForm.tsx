import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, chakra, Flex, Text } from "@chakra-ui/react";
import { AnimatePresence } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir, join, dirname } from "@tauri-apps/api/path";
import {
  api,
  ConnectionProfile,
  DriverKind,
  ProfileSecretKind,
  SshAuthMethod,
  SsmConfig,
  SslMode,
} from "../api/tauri";
import { useT } from "../i18n";
import { CopyButton } from "./CopyButton";
import { useCopyFeedback } from "./useCopyFeedback";
import { Callout } from "./Callout";
import { keyringReasonKey, useKeyringStatus } from "../keyringStatus";
import { Segmented, type SegmentedOption } from "./Segmented";
import { SettingsInfo, SettingsLabelWithInfo } from "./settingsLayout";
import { Icon, ICON_SIZES } from "./Icon";
import { Button, Heading, Input, Select, Switch, Textarea } from "./ui";
import { LoadingButton } from "./LoadingButton";
import { Tooltip } from "./Tooltip";
import { FieldError, FieldLabel, FormSection } from "./modalForm";
import {
  buildAwsIamConfig,
  effectiveSslModeForIam,
  inferRdsRegion,
  isIamCapableDriver,
  isSslModeAllowedForIam,
  type DbAuthMethod,
} from "./awsIam";
import { ComboSelect } from "./ComboSelect";
import { parseConnectionUrl } from "./connectionUrl";
import { isModalSubmitKey, pickModalKeys } from "./modalKeys";
import { COLOR_INPUT_FALLBACK, DEFAULT_PRODUCTION_COLOR, PROFILE_COLOR_PRESETS } from "../profileIdentity";

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
function PasswordInput({ value, onChange, hasStored, profileId, secretKind, id }: PasswordInputProps) {
  const t = useT();
  const [show, setShow] = useState(false);
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const { copied, copy } = useCopyFeedback();
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    },
    [],
  );

  const hideRevealed = () => {
    clearHideTimer();
    setRevealed(null);
    setShow(false);
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
    await copy(revealed);
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
          <CopyButton
            copied={copied}
            onClick={() => void copyRevealed()}
            label={t("formPasswordCopy")}
            copiedLabel={t("formPasswordCopied")}
            position="absolute"
            right="32px"
            display="inline-flex"
            alignItems="center"
            justifyContent="center"
            p="1"
            border="none"
            bg="transparent"
            borderRadius="sm"
            _hover={{ bg: "app.hover", color: "app.text" }}
            onMouseDown={(e) => e.preventDefault()}
          />
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
        <FieldError display="block" mt="1">
          {revealError}
        </FieldError>
      )}
      {revealed !== null && (
        <Text color="app.textMuted" fontSize="xs" mt="1" mb="0">
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

function defaultPortFor(driver: DriverKind): number {
  switch (driver) {
    case "mysql":
      return 3306;
    case "postgres":
      return 5432;
    case "sqlite":
      return 0;
  }
}

function defaultUserFor(driver: DriverKind): string {
  switch (driver) {
    case "mysql":
      return "root";
    case "postgres":
      return "postgres";
    case "sqlite":
      return "";
  }
}

function normalizeDriver(driver: string | undefined): DriverKind {
  if (driver === "postgres" || driver === "sqlite" || driver === "mysql") {
    return driver;
  }
  return "mysql";
}

type ConnectionRoute = "direct" | "ssh" | "ssm";

/** SSM のインスタンス ID 形式 (`src-tauri/src/ssm/mod.rs::validate_target` と同じ)。 */
function isValidSsmTarget(target: string): boolean {
  return /^(?:i|mi)-[0-9a-f]{8,17}$/.test(target);
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

/**
 * 接続テスト結果のバナー (#1006)。共有の状態バナー `Callout` (#1145) に委ね、
 * 出入りは `AnimatePresence` 配下で `Callout` 既定の `variants.slideUp` が担う
 * (`prefers-reduced-motion` はルートの `MotionConfig` が即時化する)。成功は
 * `role="status"`、失敗は `role="alert"` + `aria-live` で支援技術へ通知される。
 */
function ResultBanner({ tone, children }: { tone: "success" | "danger"; children: ReactNode }) {
  return (
    <Callout
      tone={tone}
      role={tone === "success" ? "status" : "alert"}
      aria-live={tone === "success" ? "polite" : "assertive"}
      gridColumn="span 2"
      px="3"
      fontSize="md"
    >
      {children}
    </Callout>
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
      <Flex display="inline-flex" align="center" gap="1.5" fontSize="sm">
        <Switch checked={checked} onChange={onChange} size="sm" label={label} />
      </Flex>
      <Text color="app.textMuted" fontSize="xs" mt="1" mb="0">
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

  // DB auth method (#734): classic password, or AWS RDS IAM auth. IAM stores
  // only the region and the AWS profile *name*; the backend reads the AWS keys
  // from the environment / ~/.aws/credentials at connect time.
  const [authMethod, setAuthMethod] = useState<DbAuthMethod>(initial?.aws_iam ? "aws_iam" : "password");
  const [awsRegion, setAwsRegion] = useState(initial?.aws_iam?.region ?? "");
  const [awsProfile, setAwsProfile] = useState(initial?.aws_iam?.profile ?? "");

  // 接続経路 (#1684): 直接 / SSH トンネル / SSM (Session Manager)。排他。既存プロファイルは
  // ssh があれば SSH、ssm があれば SSM、どちらも無ければ直接として復元する。
  const [route, setRoute] = useState<ConnectionRoute>(initial?.ssh ? "ssh" : initial?.ssm ? "ssm" : "direct");
  const [ssmTarget, setSsmTarget] = useState(initial?.ssm?.target ?? "");
  const [ssmRegion, setSsmRegion] = useState(initial?.ssm?.region ?? "");
  const [ssmProfile, setSsmProfile] = useState(initial?.ssm?.profile ?? "");
  const [ssmTargetError, setSsmTargetError] = useState<string | null>(null);
  const [ssmRegionError, setSsmRegionError] = useState<string | null>(null);
  const [sshHost, setSshHost] = useState(initial?.ssh?.host ?? "");
  const [sshPort, setSshPort] = useState(String(initial?.ssh?.port ?? 22));
  const [sshUser, setSshUser] = useState(initial?.ssh?.user ?? "");
  const [sshAuthMethod, setSshAuthMethod] = useState<SshAuthMethod>(initial?.ssh?.auth_method ?? "key");
  const [sshKeyPath, setSshKeyPath] = useState(initial?.ssh?.private_key_path ?? "");
  const [sshPassphrase, setSshPassphrase] = useState("");
  const [sshPassword, setSshPassword] = useState("");
  const [loadingSshConfig, setLoadingSshConfig] = useState(false);

  // 接続 URL の取り込み (#1540)。貼り付けた文字列はパスワードを含みうるので、取り込み後は
  // 入力欄ごと消し、URL もその解析結果もログ・保存には出さない。
  const [urlText, setUrlText] = useState("");
  const [urlNote, setUrlNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

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

  const isFileBacked = driver === "sqlite";
  const keyringStatus = useKeyringStatus();
  const useSsh = route === "ssh";
  const useSsm = route === "ssm" && !isFileBacked;
  // AWS IAM auth applies only to network MySQL / PostgreSQL (#734). It forces
  // TLS, so the effective mode shown/sent is at least `require`.
  const iamActive = !isFileBacked && isIamCapableDriver(driver) && authMethod === "aws_iam";
  const effectiveSslMode: SslMode = iamActive ? effectiveSslModeForIam(sslMode) : sslMode;
  const ssmConfig = (): SsmConfig | null =>
    useSsm
      ? { target: ssmTarget.trim(), region: ssmRegion.trim(), profile: ssmProfile.trim() || null }
      : null;
  const awsIamConfig = () =>
    isFileBacked ? null : buildAwsIamConfig(authMethod, driver, awsRegion, awsProfile);
  const inferredRegion = inferRdsRegion(host);

  const routeOptions: SegmentedOption<ConnectionRoute>[] = [
    { value: "direct", label: t("formRouteDirect") },
    { value: "ssh", label: t("formRouteSsh") },
    { value: "ssm", label: t("formRouteSsm") },
  ];

  const handleDriverChange = (next: DriverKind) => {
    if (next === driver) return;
    // Reset port/user defaults when the user has not customised them; this
    // keeps freshly opened forms sensible without overwriting deliberate
    // overrides on an in-progress edit.
    if (port === String(defaultPortFor(driver))) setPort(String(defaultPortFor(next)));
    if (user === defaultUserFor(driver)) setUser(defaultUserFor(next));
    setDriver(next);
  };

  // 接続 URL (mysql:// postgres:// sqlite: またはファイルパス) をフォームへ反映する。
  // パスワードは keyring 保存対象のパスワード欄 (state) に入れるだけで、profiles.json
  // には書かれない。URL に無い項目は現在の値を残す (ポートだけはドライバ既定へ戻す)。
  const handleImportUrl = () => {
    const result = parseConnectionUrl(urlText);
    if (!result.ok) {
      const key = {
        empty: "formUrlErrEmpty",
        unsupported_scheme: "formUrlErrScheme",
        invalid_port: "formUrlErrPort",
        multiple_hosts: "formUrlErrMultiHost",
        malformed: "formUrlErrMalformed",
      } as const;
      setUrlNote({ tone: "error", text: t(key[result.error]) });
      return;
    }
    const v = result.value;
    setDriver(v.driver);
    if (v.driver === "sqlite") {
      setFilePath(v.filePath ?? "");
    } else {
      if (v.host !== undefined) setHost(v.host);
      // URL に無い項目は現在の値を残す。ただしドライバが変わるときのポートは新ドライバの既定にする。
      if (v.port !== undefined) setPort(String(v.port));
      else if (v.driver !== driver) setPort(String(defaultPortFor(v.driver)));
      setPortError(null);
      // ドライバが変わったとき、前ドライバの既定ユーザーを持ち越さない。
      setUser(v.user ?? (user === defaultUserFor(driver) ? defaultUserFor(v.driver) : user));
      if (v.database !== undefined) setDatabase(v.database);
      if (v.password !== undefined) {
        setPassword(v.password);
        setAuthMethod("password");
      }
      if (v.sslMode !== undefined) setSslMode(v.sslMode);
      if (v.sslRootCert !== undefined) setSslRootCert(v.sslRootCert);
      if (v.sslClientCert !== undefined) setSslClientCert(v.sslClientCert);
      if (v.sslClientKey !== undefined) setSslClientKey(v.sslClientKey);
    }
    setUrlText("");
    setUrlNote({
      tone: "ok",
      text:
        v.ignoredParams.length > 0
          ? t("formUrlImportedIgnored", { params: v.ignoredParams.join(", ") })
          : t("formUrlImported"),
    });
  };

  const pickKeyFile = async () => {
    // Open the picker in a small, relevant directory. Without a defaultPath the
    // native Windows dialog lands on "This PC"/Quick Access and enumerates every
    // drive (including disconnected network mounts), making it slow to appear and
    // briefly spiking CPU/disk. SSH keys live under ~/.ssh, so start there (or in
    // the directory of an already-entered path).
    let defaultPath: string | undefined;
    try {
      defaultPath = sshKeyPath.trim() ? await dirname(sshKeyPath) : await join(await homeDir(), ".ssh");
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
    ssl_mode: effectiveSslMode,
    ssl_root_cert: sslRootCert.trim() || null,
    ssl_client_cert: sslClientCert.trim() || null,
    ssl_client_key: sslClientKey.trim() || null,
  });

  const pickDbFile = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      title: t("formPickDbFileTitle"),
      filters: [
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
        ssm: null,
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
      // IAM auth never sends a password: the backend signs a token instead.
      password: iamActive ? "" : password,
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
      ssm: ssmConfig(),
      file_path: null,
      read_only: readOnly,
      skip_history: skipHistory,
      ...tlsSettings(),
      init_sql: initSql.trim() || null,
      aws_iam: awsIamConfig(),
    };
  };

  const toggleProduction = (checked: boolean) => {
    setIsProduction(checked);
    if (checked && !color) setColor(DEFAULT_PRODUCTION_COLOR);
    // The write-approval option is a child of "production"; clear it when the
    // parent is unchecked so a hidden, stale value can't be persisted.
    if (!checked) setConfirmWrites(false);
  };

  const parsePort = (value: string): number | null => {
    if (!/^\d+$/.test(value)) return null;
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
  };

  // 入力欄の検証 (ポート / SSM のインスタンス ID・リージョン)。ネットワーク型ドライバ
  // だけが対象で、SQLite (ファイル型) は何も検証しない。
  // Each invalid field gets its own message (shown inline under the field with
  // `aria-invalid`, #1006) rather than a single aggregated string, since the
  // aggregated `error` box is now reserved for the connection test result.
  const validateFields = (): boolean => {
    setPortError(null);
    setSshPortError(null);
    setSshJumpPortError(null);
    setSsmTargetError(null);
    setSsmRegionError(null);
    if (isFileBacked) return true;
    let ok = true;
    if (useSsm && !isValidSsmTarget(ssmTarget.trim())) {
      setSsmTargetError(t("formInvalidSsmTarget"));
      ok = false;
    }
    if (parsePort(port) === null) {
      setPortError(t("formInvalidPort"));
      ok = false;
    }
    if (useSsm && ssmRegion.trim() !== "" && !/^[a-z0-9-]+$/.test(ssmRegion.trim())) {
      setSsmRegionError(t("formInvalidSsmRegion"));
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

  // 接続テストに成功したときの入力内容。以後に接続先 / 認証 / SSH などが書き換わったら、
  // 古い成功バナーを消す (テストしていない接続先が検証済みに見えて保存されるのを防ぐ)。
  const testedSigRef = useRef<string | null>(null);
  const requestSig = JSON.stringify(buildRequest());
  // 非同期の完了後に「現在の」入力を読むため、毎レンダーで最新の関数を保持する。
  const buildRequestRef = useRef(buildRequest);
  buildRequestRef.current = buildRequest;
  useEffect(() => {
    if (testedSigRef.current !== null && testedSigRef.current !== requestSig) {
      testedSigRef.current = null;
      setMessage(null);
    }
  }, [requestSig]);

  const handleTest = async () => {
    setError(null);
    setMessage(null);
    testedSigRef.current = null;
    if (!validateFields()) return;
    setTesting(true);
    try {
      const req = buildRequest();
      await api.testConnection(req);
      // await 中に入力が変わっていたら、古い結果のバナーは出さない。
      if (JSON.stringify(buildRequestRef.current()) === JSON.stringify(req)) {
        testedSigRef.current = JSON.stringify(req);
        setMessage(t("formConnectionOk"));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setError(null);
    setMessage(null);
    if (name.trim() === "") {
      setError(t("formNameRequired"));
      return;
    }
    if (!validateFields()) return;
    setSaving(true);
    try {
      await api.saveProfile({
        id: initial?.id,
        name,
        driver,
        host: isFileBacked ? "" : host,
        port: isFileBacked ? 0 : Number(port),
        user: isFileBacked ? "" : user,
        database: isFileBacked ? null : database || null,
        ssh:
          !isFileBacked && useSsh
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
        ssm: ssmConfig(),
        db_password: isFileBacked || iamActive || password === "" ? undefined : password,
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
        file_path: isFileBacked ? filePath || null : null,
        // SQLite is file-backed and never negotiates TLS; persist null so a
        // driver switch can't leave stale TLS settings on the profile.
        // IAM で引き上げた値ではなく利用者が選んだ値を保存する (IAM を後で外したときに
        // 元の選択を失わないため)。接続時のバックエンドが IAM では TLS を強制する。
        ssl_mode: isFileBacked ? null : sslMode,
        ssl_root_cert: isFileBacked ? null : sslRootCert.trim() || null,
        ssl_client_cert: isFileBacked ? null : sslClientCert.trim() || null,
        ssl_client_key: isFileBacked ? null : sslClientKey.trim() || null,
        // Init SQL applies to all drivers (SQLite via PRAGMA).
        init_sql: initSql.trim() || null,
        // AWS IAM auth (#734): region + AWS profile name only (no AWS keys).
        aws_iam: awsIamConfig(),
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
      // モーダルと同じく Cmd/Ctrl+Enter で主アクション (保存) を実行する (#1114)。
      onKeyDown={(e) => {
        if (saving || testing) return;
        if (!isModalSubmitKey(pickModalKeys(e))) return;
        e.preventDefault();
        void handleSave();
      }}
    >
      <Heading gridColumn="span 2">
        {initial?.id ? t("formEditTitle", { name: initial.name }) : t("formNewTitle")}
      </Heading>

      <Box gridColumn="span 2">
        <FieldLabel htmlFor={`${fid}-url`}>{t("formUrlImport")}</FieldLabel>
        <Flex gap="2" align="end">
          <Input
            id={`${fid}-url`}
            data-testid="connection-form-url"
            value={urlText}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setUrlText(e.target.value);
              if (urlNote) setUrlNote(null);
            }}
            onKeyDown={(e) => {
              // Enter は取り込み。フォーム全体の Cmd/Ctrl+Enter (保存) とは分ける。
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleImportUrl();
              }
            }}
            placeholder={t("formUrlImportPlaceholder")}
          />
          <Button
            type="button"
            data-testid="connection-form-url-import"
            onClick={handleImportUrl}
            disabled={urlText.trim() === ""}
          >
            {t("formUrlImportButton")}
          </Button>
        </Flex>
        {urlNote?.tone === "error" ? (
          <FieldError display="block" mt="1">
            {urlNote.text}
          </FieldError>
        ) : (
          <Text
            color={urlNote ? "app.textSuccess" : "app.textMuted"}
            fontSize="xs"
            mt="1"
            mb="0"
            role={urlNote ? "status" : undefined}
          >
            {urlNote ? urlNote.text : t("formUrlImportHelp")}
          </Text>
        )}
      </Box>

      <Box gridColumn="span 2">
        <FieldLabel htmlFor={`${fid}-name`}>{t("formName")}</FieldLabel>
        <Input
          id={`${fid}-name`}
          data-testid="connection-form-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("formNamePlaceholder")}
        />
      </Box>

      <Box gridColumn="span 2">
        <FieldLabel htmlFor={`${fid}-driver`}>{t("formDriver")}</FieldLabel>
        <Select
          id={`${fid}-driver`}
          data-testid="connection-form-driver"
          value={driver}
          onChange={(e) => handleDriverChange(e.target.value as DriverKind)}
        >
          <option value="mysql">{t("formDriverMysql")}</option>
          <option value="postgres">{t("formDriverPostgres")}</option>
          <option value="sqlite">{t("formDriverSqlite")}</option>
        </Select>
      </Box>

      {isFileBacked ? (
        <Fieldset>
          <Legend>{t("formSqliteLegend")}</Legend>
          <Box>
            <FieldLabel htmlFor={`${fid}-sqlite-path`}>{t("formSqliteFilePath")}</FieldLabel>
            <Flex gap="2" align="end">
              <Input
                id={`${fid}-sqlite-path`}
                data-testid="connection-form-sqlite-path"
                value={filePath}
                onChange={(e) => setFilePath(e.target.value)}
                placeholder={t("formSqliteFilePathPlaceholder")}
              />
              <Button type="button" onClick={pickDbFile}>
                {t("formBrowse")}
              </Button>
            </Flex>
            <Text color="app.textMuted" fontSize="xs" mt="1" mb="0">
              {t("formSqliteFilePathHelp")}
            </Text>
          </Box>
        </Fieldset>
      ) : (
        <Fieldset>
          <Legend>{driver === "postgres" ? t("formPostgresLegend") : t("formMysqlLegend")}</Legend>
          <Box display="grid" gridTemplateColumns="1fr 120px" gap="3">
            <Box>
              <FieldLabel htmlFor={`${fid}-host`}>{t("formHost")}</FieldLabel>
              <Input id={`${fid}-host`} value={host} onChange={(e) => setHost(e.target.value)} />
            </Box>
            <Box>
              <FieldLabel htmlFor={`${fid}-port`}>{t("formPort")}</FieldLabel>
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
                <FieldError display="block" mt="1">
                  {portError}
                </FieldError>
              )}
            </Box>
          </Box>
          <Box display="grid" gridTemplateColumns="1fr 1fr" gap="3" mt="2">
            <Box>
              <FieldLabel htmlFor={`${fid}-user`}>{t("formUser")}</FieldLabel>
              <Input id={`${fid}-user`} value={user} onChange={(e) => setUser(e.target.value)} />
            </Box>
            <Box>
              <FieldLabel htmlFor={`${fid}-database`}>{t("formDatabase")}</FieldLabel>
              <Input id={`${fid}-database`} value={database} onChange={(e) => setDatabase(e.target.value)} />
            </Box>
          </Box>
          {isIamCapableDriver(driver) && (
            <FormSection mt="2">
              <FieldLabel htmlFor={`${fid}-auth-method`}>{t("formAuthMethod")}</FieldLabel>
              <Select
                id={`${fid}-auth-method`}
                value={authMethod}
                onChange={(e) => setAuthMethod(e.target.value as DbAuthMethod)}
              >
                <option value="password">{t("formAuthMethodPassword")}</option>
                <option value="aws_iam">{t("formAuthMethodAwsIam")}</option>
              </Select>
            </FormSection>
          )}
          {iamActive ? (
            <FormSection mt="2" data-testid="aws-iam-settings">
              <Box display="grid" gridTemplateColumns="1fr 1fr" gap="3">
                <FormSection>
                  <FieldLabel htmlFor={`${fid}-aws-region`}>{t("formAwsRegion")}</FieldLabel>
                  <Input
                    id={`${fid}-aws-region`}
                    value={awsRegion}
                    onChange={(e) => setAwsRegion(e.target.value)}
                    placeholder={inferredRegion ?? t("formAwsRegionPlaceholder")}
                  />
                </FormSection>
                <FormSection>
                  <FieldLabel htmlFor={`${fid}-aws-profile`}>{t("formAwsProfile")}</FieldLabel>
                  <Input
                    id={`${fid}-aws-profile`}
                    value={awsProfile}
                    onChange={(e) => setAwsProfile(e.target.value)}
                    placeholder={t("formAwsProfilePlaceholder")}
                  />
                </FormSection>
              </Box>
              {awsRegion.trim() === "" &&
                (inferredRegion ? (
                  <Text color="app.textMuted" fontSize="xs" m="0">
                    {t("formAwsRegionInferred", { region: inferredRegion })}
                  </Text>
                ) : (
                  <FieldError tone="warning">{t("formAwsRegionMissing")}</FieldError>
                ))}
              <Text color="app.textMuted" fontSize="xs" m="0">
                {t("formAwsIamHelp")}
              </Text>
              <Text color="app.textMuted" fontSize="xs" m="0">
                {t("formAwsIamExpiryHelp")}
              </Text>
              {(useSsh || useSsm) && (
                <Text color="app.textMuted" fontSize="xs" m="0">
                  {t("formAwsIamSshHint")}
                </Text>
              )}
            </FormSection>
          ) : (
            <Box mt="2">
              {/* keyring が使えない端末ではパスワードを保存できない (#1622)。秘密は返さず理由コードだけを見せる。 */}
              {keyringStatus && !keyringStatus.available && (
                <Callout
                  tone="warning"
                  title={t("keyringUnavailableTitle")}
                  mb="2"
                  data-testid="keyring-unavailable"
                >
                  {t("keyringUnavailableBody")} {t(keyringReasonKey(keyringStatus.reason))}
                </Callout>
              )}
              <FieldLabel htmlFor={`${fid}-db-password`}>{t("formDbPassword")}</FieldLabel>
              <PasswordInput
                id={`${fid}-db-password`}
                value={password}
                onChange={setPassword}
                hasStored={!!initial?.has_db_password}
                profileId={initial?.id}
                secretKind="db_password"
              />
            </Box>
          )}
        </Fieldset>
      )}

      {!isFileBacked && (
        <Fieldset>
          <Legend>{t("formTlsLegend")}</Legend>
          <Box>
            <FieldLabel htmlFor={`${fid}-tls-mode`}>{t("formTlsMode")}</FieldLabel>
            <Select
              id={`${fid}-tls-mode`}
              value={effectiveSslMode}
              onChange={(e) => setSslMode(e.target.value as SslMode)}
            >
              {/* IAM auth (#734) is TLS-only: plaintext-capable modes are not selectable. */}
              <option value="disable" disabled={iamActive && !isSslModeAllowedForIam("disable")}>
                {t("formTlsModeDisable")}
              </option>
              <option value="prefer" disabled={iamActive && !isSslModeAllowedForIam("prefer")}>
                {t("formTlsModePrefer")}
              </option>
              <option value="require">{t("formTlsModeRequire")}</option>
              <option value="verify_ca">{t("formTlsModeVerifyCa")}</option>
              <option value="verify_full">{t("formTlsModeVerifyFull")}</option>
            </Select>
            <Text color="app.textMuted" fontSize="xs" mt="1" mb="0">
              {t("formTlsModeHelp")}
            </Text>
            {iamActive && (
              <Text color="app.textMuted" fontSize="xs" mt="1" mb="0" data-testid="aws-iam-tls-note">
                {t("formAwsIamTlsNote")}
              </Text>
            )}
          </Box>
          {isProduction &&
            (effectiveSslMode === "disable" ||
              effectiveSslMode === "prefer" ||
              effectiveSslMode === "require") && (
              <Text color="app.textWarning" fontSize="xs" mt="2" mb="0">
                {t("formTlsProductionHint")}
              </Text>
            )}
          <Box mt="2">
            <FieldLabel htmlFor={`${fid}-tls-root-cert`}>{t("formTlsRootCert")}</FieldLabel>
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
            <Text color="app.textMuted" fontSize="xs" mt="1" mb="0">
              {t("formTlsRootCertHelp")}
            </Text>
          </Box>
          <Box mt="2">
            <FieldLabel htmlFor={`${fid}-tls-client-cert`}>{t("formTlsClientCert")}</FieldLabel>
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
            <FieldLabel htmlFor={`${fid}-tls-client-key`}>{t("formTlsClientKey")}</FieldLabel>
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
            <Text color="app.textMuted" fontSize="xs" mt="1" mb="0">
              {t("formTlsClientHelp")}
            </Text>
          </Box>
          {(useSsh || useSsm) && (
            <Text color="app.textMuted" fontSize="xs" mt="2" mb="0">
              {t("formTlsSshHint")}
            </Text>
          )}
        </Fieldset>
      )}

      <Fieldset>
        <Legend>{t("formGroup")}</Legend>
        <Box>
          <ComboSelect
            value={group}
            onChange={setGroup}
            options={groupSuggestions.map((g) => ({ value: g }))}
            placeholder={t("formGroupPlaceholder")}
          />
          <Text color="app.textMuted" fontSize="xs" mt="1" mb="0">
            {t("formGroupHelp")}
          </Text>
        </Box>
      </Fieldset>

      <Fieldset>
        <Legend>{t("formDisplay")}</Legend>
        <Flex direction="column" gap="3">
          <Box>
            <FieldLabel htmlFor={`${fid}-color`}>{t("formColor")}</FieldLabel>
            <Flex align="center" gap="2" flexWrap="wrap">
              {PROFILE_COLOR_PRESETS.map((c) => (
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
                value={color ?? COLOR_INPUT_FALLBACK}
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
              <Box ml="5.5" mt="2">
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
          <Legend>{t("formRoute")}</Legend>
          <Box mb="2">
            <Segmented value={route} options={routeOptions} onChange={setRoute} ariaLabel={t("formRoute")} />
          </Box>
          {useSsm && (
            <>
              <Box>
                <FieldLabel htmlFor={`${fid}-ssm-target`}>{t("formSsmTarget")}</FieldLabel>
                <Input
                  id={`${fid}-ssm-target`}
                  value={ssmTarget}
                  aria-invalid={ssmTargetError ? true : undefined}
                  placeholder="i-0123456789abcdef0"
                  onChange={(e) => {
                    setSsmTarget(e.target.value);
                    if (ssmTargetError) setSsmTargetError(null);
                  }}
                />
                {ssmTargetError && (
                  <FieldError display="block" mt="1">
                    {ssmTargetError}
                  </FieldError>
                )}
              </Box>
              <Box mt="2">
                <FieldLabel htmlFor={`${fid}-ssm-region`}>{t("formSsmRegion")}</FieldLabel>
                <Input
                  id={`${fid}-ssm-region`}
                  value={ssmRegion}
                  placeholder={t("formSsmRegionPlaceholder")}
                  aria-invalid={ssmRegionError ? true : undefined}
                  onChange={(e) => {
                    setSsmRegion(e.target.value);
                    if (ssmRegionError) setSsmRegionError(null);
                  }}
                />
                {ssmRegionError && (
                  <FieldError display="block" mt="1">
                    {ssmRegionError}
                  </FieldError>
                )}
              </Box>
              <Box mt="2">
                <SettingsLabelWithInfo>
                  <FieldLabel htmlFor={`${fid}-ssm-profile`}>{t("formSsmProfile")}</FieldLabel>
                  <SettingsInfo>{t("formSsmProfileHelp")}</SettingsInfo>
                </SettingsLabelWithInfo>
                <Input
                  id={`${fid}-ssm-profile`}
                  value={ssmProfile}
                  placeholder={t("formAwsProfilePlaceholder")}
                  onChange={(e) => setSsmProfile(e.target.value)}
                />
              </Box>
              <Text textStyle="caption" mt="2" mb="0">
                {t("formSsmHelp")}
              </Text>
            </>
          )}
          {useSsh && (
            <>
              <Box display="grid" gridTemplateColumns="1fr 120px" gap="3">
                <Box>
                  <FieldLabel htmlFor={`${fid}-ssh-host`}>{t("formSshHost")}</FieldLabel>
                  <Flex gap="2" align="end">
                    <Input
                      id={`${fid}-ssh-host`}
                      value={sshHost}
                      onChange={(e) => setSshHost(e.target.value)}
                    />
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
                  <FieldLabel htmlFor={`${fid}-ssh-port`}>{t("formPort")}</FieldLabel>
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
                    <FieldError display="block" mt="1">
                      {sshPortError}
                    </FieldError>
                  )}
                </Box>
              </Box>
              <Box mt="2">
                <FieldLabel htmlFor={`${fid}-ssh-user`}>{t("formSshUser")}</FieldLabel>
                <Input id={`${fid}-ssh-user`} value={sshUser} onChange={(e) => setSshUser(e.target.value)} />
              </Box>
              <Box mt="2">
                <FieldLabel htmlFor={`${fid}-ssh-auth`}>{t("formSshAuthMethod")}</FieldLabel>
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
                    <FieldLabel htmlFor={`${fid}-ssh-key-path`}>{t("formPrivateKeyPath")}</FieldLabel>
                    <Flex gap="2" align="end">
                      <Input
                        id={`${fid}-ssh-key-path`}
                        value={sshKeyPath}
                        onChange={(e) => setSshKeyPath(e.target.value)}
                        placeholder="C:\\Users\\you\\.ssh\\id_ed25519"
                      />
                      <Button type="button" onClick={pickKeyFile}>
                        {t("formBrowse")}
                      </Button>
                    </Flex>
                  </Box>
                  <Box mt="2">
                    <FieldLabel htmlFor={`${fid}-ssh-passphrase`}>{t("formSshPassphrase")}</FieldLabel>
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
                  <FieldLabel htmlFor={`${fid}-ssh-password`}>{t("formSshPassword")}</FieldLabel>
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
                <Text color="app.textMuted" fontSize="xs" mt="2" mb="0">
                  {t("formSshAgentHelp")}
                </Text>
              )}

              <Box mt="3" pt="3" borderTop="1px solid" borderColor="app.border">
                <Flex display="inline-flex" align="center" gap="1.5" fontSize="sm">
                  <Switch
                    checked={useSshJump}
                    onChange={setUseSshJump}
                    size="sm"
                    label={t("formUseSshJump")}
                  />
                </Flex>
                <Text color="app.textMuted" fontSize="xs" mt="1" mb="0">
                  {t("formSshJumpHelp")}
                </Text>
                {useSshJump && (
                  <Box mt="2">
                    <Box display="grid" gridTemplateColumns="1fr 120px" gap="3">
                      <Box>
                        <FieldLabel htmlFor={`${fid}-ssh-jump-host`}>{t("formSshJumpHost")}</FieldLabel>
                        <Input
                          id={`${fid}-ssh-jump-host`}
                          value={sshJumpHost}
                          onChange={(e) => setSshJumpHost(e.target.value)}
                        />
                      </Box>
                      <Box>
                        <FieldLabel htmlFor={`${fid}-ssh-jump-port`}>{t("formPort")}</FieldLabel>
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
                          <FieldError display="block" mt="1">
                            {sshJumpPortError}
                          </FieldError>
                        )}
                      </Box>
                    </Box>
                    <Box mt="2">
                      <FieldLabel htmlFor={`${fid}-ssh-jump-user`}>{t("formSshJumpUser")}</FieldLabel>
                      <Input
                        id={`${fid}-ssh-jump-user`}
                        value={sshJumpUser}
                        onChange={(e) => setSshJumpUser(e.target.value)}
                      />
                    </Box>
                    <Box mt="2">
                      <FieldLabel htmlFor={`${fid}-ssh-jump-auth`}>{t("formSshJumpAuthMethod")}</FieldLabel>
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
                          <FieldLabel htmlFor={`${fid}-ssh-jump-key-path`}>
                            {t("formPrivateKeyPath")}
                          </FieldLabel>
                          <Flex gap="2" align="end">
                            <Input
                              id={`${fid}-ssh-jump-key-path`}
                              value={sshJumpKeyPath}
                              onChange={(e) => setSshJumpKeyPath(e.target.value)}
                              placeholder="C:\\Users\\you\\.ssh\\id_ed25519"
                            />
                            <Button type="button" onClick={pickJumpKeyFile}>
                              {t("formBrowse")}
                            </Button>
                          </Flex>
                        </Box>
                        <Box mt="2">
                          <FieldLabel htmlFor={`${fid}-ssh-jump-passphrase`}>
                            {t("formSshJumpPassphrase")}
                          </FieldLabel>
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
                        <FieldLabel htmlFor={`${fid}-ssh-jump-password`}>
                          {t("formSshJumpPassword")}
                        </FieldLabel>
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
                      <Text color="app.textMuted" fontSize="xs" mt="2" mb="0">
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
              driver === "sqlite" ? t("formInitSqlPlaceholderSqlite") : t("formInitSqlPlaceholder")
            }
            rows={3}
            css={{ fontFamily: "var(--font-mono)", resize: "vertical", width: "100%" }}
          />
          <Text color="app.textMuted" fontSize="xs" mt="1" mb="0">
            {t("formInitSqlHelp")}
          </Text>
        </Box>
      </Fieldset>

      <AnimatePresence initial={false}>
        {message && (
          <ResultBanner key="test-message" tone="success">
            {message}
          </ResultBanner>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {error && (
          <ResultBanner key="test-error" tone="danger">
            {error}
          </ResultBanner>
        )}
      </AnimatePresence>

      {/* フッター配置はモーダルの通常パターン (#1114) と同じ: 補助操作 (接続テスト)
          を左、spacer を挟んで右端にキャンセル → 主アクション (保存)。 */}
      <Flex gridColumn="span 2" gap="2" align="center">
        <LoadingButton type="button" loading={testing} onClick={handleTest} disabled={saving}>
          {testing ? t("formTesting") : t("formTest")}
        </LoadingButton>
        <Box flex="1" />
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving || testing}>
          {t("formCancel")}
        </Button>
        <LoadingButton
          pressable
          type="button"
          variant="primary"
          loading={saving}
          onClick={handleSave}
          disabled={testing}
          data-testid="connection-form-save"
        >
          {t("formSave")}
        </LoadingButton>
      </Flex>
    </Box>
  );
}
