import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir, join, dirname } from "@tauri-apps/api/path";
import { api, ConnectionProfile, DriverKind, SshAuthMethod } from "../api/tauri";
import { useT } from "../i18n";

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
    <div className="form">
      <h2 className="full" style={{ margin: 0 }}>{initial?.id ? t("formEditTitle", { name: initial.name }) : t("formNewTitle")}</h2>

      <div className="full">
        <label>{t("formName")}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("formNamePlaceholder")} />
      </div>

      <div className="full">
        <label>{t("formDriver")}</label>
        <select
          value={driver}
          onChange={(e) => handleDriverChange(e.target.value as DriverKind)}
        >
          <option value="mysql">{t("formDriverMysql")}</option>
          <option value="postgres">{t("formDriverPostgres")}</option>
          <option value="sqlite">{t("formDriverSqlite")}</option>
        </select>
      </div>

      {isFileBacked ? (
        <fieldset>
          <legend>{t("formSqliteLegend")}</legend>
          <div>
            <label>{t("formSqliteFilePath")}</label>
            <div className="row">
              <input
                value={filePath}
                onChange={(e) => setFilePath(e.target.value)}
                placeholder={t("formSqliteFilePathPlaceholder")}
              />
              <button onClick={pickDbFile}>{t("formBrowse")}</button>
            </div>
            <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>
              {t("formSqliteFilePathHelp")}
            </p>
          </div>
        </fieldset>
      ) : (
        <fieldset>
          <legend>{driver === "postgres" ? t("formPostgresLegend") : t("formMysqlLegend")}</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 12 }}>
            <div>
              <label>{t("formHost")}</label>
              <input value={host} onChange={(e) => setHost(e.target.value)} />
            </div>
            <div>
              <label>{t("formPort")}</label>
              <input
                type="text"
                inputMode="numeric"
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
              />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 8 }}>
            <div>
              <label>{t("formUser")}</label>
              <input value={user} onChange={(e) => setUser(e.target.value)} />
            </div>
            <div>
              <label>{t("formDatabase")}</label>
              <input value={database} onChange={(e) => setDatabase(e.target.value)} />
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            <label>{t("formDbPassword")}</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        </fieldset>
      )}

      <fieldset>
        <legend>{t("formGroup")}</legend>
        <div>
          <input
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
          <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>
            {t("formGroupHelp")}
          </p>
        </div>
      </fieldset>

      <fieldset>
        <legend>{t("formDisplay")}</legend>
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
          <div>
            <label>{t("formColor")}</label>
            <div className="row" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
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
                <button type="button" onClick={() => setColor(null)}>
                  {t("formColorClear")}
                </button>
              )}
            </div>
          </div>
          <div>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                checked={isProduction}
                onChange={(e) => toggleProduction(e.target.checked)}
              />
              {t("formIsProduction")}
            </label>
            <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>
              {t("formIsProductionHelp")}
            </p>
            {isProduction && (
              <div style={{ marginLeft: 22, marginTop: 8 }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    style={{ width: "auto" }}
                    checked={confirmWrites}
                    onChange={(e) => setConfirmWrites(e.target.checked)}
                  />
                  {t("formConfirmWrites")}
                </label>
                <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>
                  {t("formConfirmWritesHelp")}
                </p>
              </div>
            )}
          </div>
          <div>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                checked={readOnly}
                onChange={(e) => setReadOnly(e.target.checked)}
              />
              {t("formReadOnly")}
            </label>
            <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>
              {t("formReadOnlyHelp")}
            </p>
          </div>
          <div>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                checked={skipHistory}
                onChange={(e) => setSkipHistory(e.target.checked)}
              />
              {t("formSkipHistory")}
            </label>
            <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>
              {t("formSkipHistoryHelp")}
            </p>
          </div>
        </div>
      </fieldset>

      {!isFileBacked && (
        <fieldset>
          <legend>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={useSsh} onChange={(e) => setUseSsh(e.target.checked)} />
              {t("formUseSsh")}
            </label>
          </legend>
          {useSsh && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 12 }}>
                <div>
                  <label>{t("formSshHost")}</label>
                  <input value={sshHost} onChange={(e) => setSshHost(e.target.value)} />
                </div>
                <div>
                  <label>{t("formPort")}</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={sshPort}
                    onChange={(e) => setSshPort(e.target.value.replace(/[^0-9]/g, ""))}
                  />
                </div>
              </div>
              <div style={{ marginTop: 8 }}>
                <label>{t("formSshUser")}</label>
                <input value={sshUser} onChange={(e) => setSshUser(e.target.value)} />
              </div>
              <div style={{ marginTop: 8 }}>
                <label>{t("formSshAuthMethod")}</label>
                <select
                  value={sshAuthMethod}
                  onChange={(e) => setSshAuthMethod(e.target.value as SshAuthMethod)}
                >
                  <option value="key">{t("formSshAuthKey")}</option>
                  <option value="agent">{t("formSshAuthAgent")}</option>
                  <option value="password">{t("formSshAuthPassword")}</option>
                </select>
              </div>
              {sshAuthMethod === "key" && (
                <>
                  <div style={{ marginTop: 8 }}>
                    <label>{t("formPrivateKeyPath")}</label>
                    <div className="row">
                      <input value={sshKeyPath} onChange={(e) => setSshKeyPath(e.target.value)} placeholder="C:\\Users\\you\\.ssh\\id_ed25519" />
                      <button onClick={pickKeyFile}>{t("formBrowse")}</button>
                    </div>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <label>{t("formSshPassphrase")}</label>
                    <input type="password" value={sshPassphrase} onChange={(e) => setSshPassphrase(e.target.value)} />
                  </div>
                </>
              )}
              {sshAuthMethod === "password" && (
                <div style={{ marginTop: 8 }}>
                  <label>{t("formSshPassword")}</label>
                  <input type="password" value={sshPassword} onChange={(e) => setSshPassword(e.target.value)} />
                </div>
              )}
              {sshAuthMethod === "agent" && (
                <p className="muted" style={{ fontSize: 11, margin: "8px 0 0" }}>
                  {t("formSshAgentHelp")}
                </p>
              )}
            </>
          )}
        </fieldset>
      )}

      {message && <div className="full text-success">{message}</div>}
      {error && <div className="full text-error">{error}</div>}

      <div className="actions">
        <button onClick={onCancel}>{t("formCancel")}</button>
        <button onClick={handleTest} disabled={testing}>{testing ? t("formTesting") : t("formTest")}</button>
        <button className="primary" onClick={handleSave}>{t("formSave")}</button>
      </div>
    </div>
  );
}
