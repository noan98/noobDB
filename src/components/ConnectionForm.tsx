import { useMemo, useState, type ReactNode } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir, join, dirname } from "@tauri-apps/api/path";
import { api, ConnectionProfile, DriverKind, SshAuthMethod } from "../api/tauri";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { Button, Checkbox, Input, Select } from "./ui";

// Bullet glyphs shown (read-only) to stand in for a secret that is already
// saved in the OS keyring. The real value never reaches the frontend, so this
// is a fixed-length placeholder whose only job is to make "a password is set"
// visible instead of an empty field.
const STORED_MASK = "•".repeat(10);

interface PasswordInputProps {
  value: string;
  onChange: (value: string) => void;
  /** True when a secret for this field already exists in the keyring. */
  hasStored: boolean;
}

/**
 * Password input with an always-visible show/hide toggle. When a secret is
 * already stored and the user has not typed a replacement, it displays a masked
 * placeholder (read-only) so the saved state is obvious; focusing clears it for
 * editing and leaving it untouched keeps the stored value (empty `value`).
 */
function PasswordInput({ value, onChange, hasStored }: PasswordInputProps) {
  const t = useT();
  const [show, setShow] = useState(false);
  const [focused, setFocused] = useState(false);

  const showingMask = hasStored && value === "" && !focused;

  return (
    <div className="password-field">
      <Input
        type={show ? "text" : "password"}
        value={showingMask ? STORED_MASK : value}
        readOnly={showingMask}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      <button
        type="button"
        className="password-toggle"
        // Keep the input focused so the toggle works while typing.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setShow((s) => !s)}
        aria-pressed={show}
        aria-label={show ? t("formPasswordHide") : t("formPasswordShow")}
        title={show ? t("formPasswordHide") : t("formPasswordShow")}
      >
        <Icon name={show ? "eye-off" : "eye"} size={16} />
      </button>
    </div>
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
  }
}

function defaultUserFor(driver: DriverKind): string {
  switch (driver) {
    case "mysql": return "root";
    case "postgres": return "postgres";
    case "sqlite": return "";
  }
}

function normalizeDriver(driver: string | undefined): DriverKind {
  if (driver === "postgres" || driver === "sqlite" || driver === "mysql") return driver;
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
      p="var(--space-3)"
    >
      {children}
    </Box>
  );
}

function Legend({ children }: { children: ReactNode }) {
  return (
    <Box as="legend" fontWeight="600" fontSize="sm" px="6px">
      {children}
    </Box>
  );
}

/** Inline checkbox toggle with a muted help line underneath. */
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
      <Flex as="label" display="inline-flex" align="center" gap="6px" fontSize="12px">
        <Checkbox checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </Flex>
      <Text color="app.textMuted" fontSize="11px" mt="4px" mb="0">
        {help}
      </Text>
    </Box>
  );
}

export function ConnectionForm({ initial, profiles, onSaved, onCancel }: Props) {
  const t = useT();
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

  const [useSsh, setUseSsh] = useState(!!initial?.ssh);
  const [sshHost, setSshHost] = useState(initial?.ssh?.host ?? "");
  const [sshPort, setSshPort] = useState(String(initial?.ssh?.port ?? 22));
  const [sshUser, setSshUser] = useState(initial?.ssh?.user ?? "");
  const [sshAuthMethod, setSshAuthMethod] = useState<SshAuthMethod>(initial?.ssh?.auth_method ?? "key");
  const [sshKeyPath, setSshKeyPath] = useState(initial?.ssh?.private_key_path ?? "");
  const [sshPassphrase, setSshPassphrase] = useState("");
  const [sshPassword, setSshPassword] = useState("");

  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isFileBacked = driver === "sqlite";

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
        file_path: filePath || null,
        read_only: readOnly,
        skip_history: skipHistory,
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
          }
        : null,
      file_path: null,
      read_only: readOnly,
      skip_history: skipHistory,
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
  const validatePorts = (): boolean => {
    if (isFileBacked) return true;
    if (parsePort(port) === null) {
      setError(t("formInvalidPort"));
      return false;
    }
    if (useSsh && parsePort(sshPort) === null) {
      setError(t("formInvalidSshPort"));
      return false;
    }
    return true;
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
        group: group.trim() || null,
        color: color || null,
        is_production: isProduction,
        confirm_writes: confirmWrites,
        read_only: readOnly,
        skip_history: skipHistory,
        file_path: isFileBacked ? (filePath || null) : null,
      });
      onSaved();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Box
      display="grid"
      gridTemplateColumns="1fr 1fr"
      gap="var(--space-3)"
      p="var(--space-4)"
      overflowY="auto"
    >
      <Box as="h2" gridColumn="span 2" m="0">
        {initial?.id ? t("formEditTitle", { name: initial.name }) : t("formNewTitle")}
      </Box>

      <Box gridColumn="span 2">
        <label>{t("formName")}</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("formNamePlaceholder")} />
      </Box>

      <Box gridColumn="span 2">
        <label>{t("formDriver")}</label>
        <Select
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
            <label>{t("formSqliteFilePath")}</label>
            <Flex gap="var(--space-2)" align="end">
              <Input
                value={filePath}
                onChange={(e) => setFilePath(e.target.value)}
                placeholder={t("formSqliteFilePathPlaceholder")}
              />
              <Button type="button" onClick={pickDbFile}>{t("formBrowse")}</Button>
            </Flex>
            <Text color="app.textMuted" fontSize="11px" mt="4px" mb="0">
              {t("formSqliteFilePathHelp")}
            </Text>
          </Box>
        </Fieldset>
      ) : (
        <Fieldset>
          <Legend>{driver === "postgres" ? t("formPostgresLegend") : t("formMysqlLegend")}</Legend>
          <Box display="grid" gridTemplateColumns="1fr 120px" gap="12px">
            <Box>
              <label>{t("formHost")}</label>
              <Input value={host} onChange={(e) => setHost(e.target.value)} />
            </Box>
            <Box>
              <label>{t("formPort")}</label>
              <Input
                type="text"
                inputMode="numeric"
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
              />
            </Box>
          </Box>
          <Box display="grid" gridTemplateColumns="1fr 1fr" gap="12px" mt="8px">
            <Box>
              <label>{t("formUser")}</label>
              <Input value={user} onChange={(e) => setUser(e.target.value)} />
            </Box>
            <Box>
              <label>{t("formDatabase")}</label>
              <Input value={database} onChange={(e) => setDatabase(e.target.value)} />
            </Box>
          </Box>
          <Box mt="8px">
            <label>{t("formDbPassword")}</label>
            <PasswordInput
              value={password}
              onChange={setPassword}
              hasStored={!!initial?.has_db_password}
            />
          </Box>
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
          <Text color="app.textMuted" fontSize="11px" mt="4px" mb="0">
            {t("formGroupHelp")}
          </Text>
        </Box>
      </Fieldset>

      <Fieldset>
        <Legend>{t("formDisplay")}</Legend>
        <Flex direction="column" gap="12px">
          <Box>
            <label>{t("formColor")}</label>
            <Flex align="center" gap="8px" flexWrap="wrap">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`color-swatch ${color === c ? "selected" : ""}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  aria-label={c}
                  title={c}
                />
              ))}
              <input
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
              <Box ml="22px" mt="8px">
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
            <Flex as="label" display="inline-flex" align="center" gap="6px" fontSize="12px">
              <Checkbox checked={useSsh} onChange={(e) => setUseSsh(e.target.checked)} />
              {t("formUseSsh")}
            </Flex>
          </Legend>
          {useSsh && (
            <>
              <Box display="grid" gridTemplateColumns="1fr 120px" gap="12px">
                <Box>
                  <label>{t("formSshHost")}</label>
                  <Input value={sshHost} onChange={(e) => setSshHost(e.target.value)} />
                </Box>
                <Box>
                  <label>{t("formPort")}</label>
                  <Input
                    type="text"
                    inputMode="numeric"
                    value={sshPort}
                    onChange={(e) => setSshPort(e.target.value.replace(/[^0-9]/g, ""))}
                  />
                </Box>
              </Box>
              <Box mt="8px">
                <label>{t("formSshUser")}</label>
                <Input value={sshUser} onChange={(e) => setSshUser(e.target.value)} />
              </Box>
              <Box mt="8px">
                <label>{t("formSshAuthMethod")}</label>
                <Select
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
                  <Box mt="8px">
                    <label>{t("formPrivateKeyPath")}</label>
                    <Flex gap="var(--space-2)" align="end">
                      <Input value={sshKeyPath} onChange={(e) => setSshKeyPath(e.target.value)} placeholder="C:\\Users\\you\\.ssh\\id_ed25519" />
                      <Button type="button" onClick={pickKeyFile}>{t("formBrowse")}</Button>
                    </Flex>
                  </Box>
                  <Box mt="8px">
                    <label>{t("formSshPassphrase")}</label>
                    <PasswordInput
                      value={sshPassphrase}
                      onChange={setSshPassphrase}
                      hasStored={!!initial?.has_ssh_passphrase}
                    />
                  </Box>
                </>
              )}
              {sshAuthMethod === "password" && (
                <Box mt="8px">
                  <label>{t("formSshPassword")}</label>
                  <PasswordInput
                    value={sshPassword}
                    onChange={setSshPassword}
                    hasStored={!!initial?.has_ssh_password}
                  />
                </Box>
              )}
              {sshAuthMethod === "agent" && (
                <Text color="app.textMuted" fontSize="11px" mt="8px" mb="0">
                  {t("formSshAgentHelp")}
                </Text>
              )}
            </>
          )}
        </Fieldset>
      )}

      {message && <Box gridColumn="span 2" color="app.textSuccess">{message}</Box>}
      {error && <Box gridColumn="span 2" color="app.textError">{error}</Box>}

      <Flex gridColumn="span 2" gap="var(--space-2)" justify="flex-end">
        <Button type="button" onClick={onCancel}>{t("formCancel")}</Button>
        <Button type="button" onClick={handleTest} disabled={testing}>{testing ? t("formTesting") : t("formTest")}</Button>
        <Button type="button" variant="primary" onClick={handleSave}>{t("formSave")}</Button>
      </Flex>
    </Box>
  );
}
