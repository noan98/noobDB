import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, ConnectionProfile } from "../api/tauri";
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

export function ConnectionForm({ initial, profiles, onSaved, onCancel }: Props) {
  const t = useT();
  const groupSuggestions = useMemo(() => {
    const set = new Set<string>();
    for (const p of profiles) {
      if (p.group && p.group.trim()) set.add(p.group);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [profiles]);
  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "127.0.0.1");
  const [port, setPort] = useState(initial?.port ?? 3306);
  const [user, setUser] = useState(initial?.user ?? "root");
  const [database, setDatabase] = useState(initial?.database ?? "");
  const [password, setPassword] = useState("");
  const [group, setGroup] = useState(initial?.group ?? "");
  const [color, setColor] = useState<string | null>(initial?.color ?? null);
  const [isProduction, setIsProduction] = useState<boolean>(initial?.is_production ?? false);

  const [useSsh, setUseSsh] = useState(!!initial?.ssh);
  const [sshHost, setSshHost] = useState(initial?.ssh?.host ?? "");
  const [sshPort, setSshPort] = useState(initial?.ssh?.port ?? 22);
  const [sshUser, setSshUser] = useState(initial?.ssh?.user ?? "");
  const [sshKeyPath, setSshKeyPath] = useState(initial?.ssh?.private_key_path ?? "");
  const [sshPassphrase, setSshPassphrase] = useState("");

  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pickKeyFile = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      title: t("formPickKeyTitle"),
    });
    if (typeof selected === "string") setSshKeyPath(selected);
  };

  const buildRequest = () => ({
    profile_id: initial?.id,
    driver: "mysql" as const,
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
          private_key_path: sshKeyPath,
          passphrase: sshPassphrase,
        }
      : null,
  });

  const toggleProduction = (checked: boolean) => {
    setIsProduction(checked);
    if (checked && !color) setColor(DEFAULT_PROD_COLOR);
  };

  const handleTest = async () => {
    setError(null); setMessage(null); setTesting(true);
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
    try {
      await api.saveProfile({
        id: initial?.id,
        name,
        driver: "mysql",
        host,
        port: Number(port),
        user,
        database: database || null,
        ssh: useSsh
          ? { host: sshHost, port: Number(sshPort), user: sshUser, private_key_path: sshKeyPath }
          : null,
        db_password: password === "" ? undefined : password,
        ssh_passphrase: useSsh && sshPassphrase !== "" ? sshPassphrase : undefined,
        group: group.trim() || null,
        color: color || null,
        is_production: isProduction,
      });
      onSaved();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="form">
      <h2 className="full" style={{ margin: 0 }}>{initial ? t("formEditTitle", { name: initial.name }) : t("formNewTitle")}</h2>

      <div className="full">
        <label>{t("formName")}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("formNamePlaceholder")} />
      </div>

      <fieldset>
        <legend>{t("formMysqlLegend")}</legend>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 12 }}>
          <div>
            <label>{t("formHost")}</label>
            <input value={host} onChange={(e) => setHost(e.target.value)} />
          </div>
          <div>
            <label>{t("formPort")}</label>
            <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
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
          </div>
        </div>
      </fieldset>

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
                <input type="number" value={sshPort} onChange={(e) => setSshPort(Number(e.target.value))} />
              </div>
            </div>
            <div style={{ marginTop: 8 }}>
              <label>{t("formSshUser")}</label>
              <input value={sshUser} onChange={(e) => setSshUser(e.target.value)} />
            </div>
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
      </fieldset>

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
