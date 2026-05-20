import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, ConnectionProfile } from "../api/tauri";

interface Props {
  initial: ConnectionProfile | null;
  onSaved: () => void;
  onCancel: () => void;
}

export function ConnectionForm({ initial, onSaved, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "127.0.0.1");
  const [port, setPort] = useState(initial?.port ?? 3306);
  const [user, setUser] = useState(initial?.user ?? "root");
  const [database, setDatabase] = useState(initial?.database ?? "");
  const [password, setPassword] = useState("");

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
      title: "Select SSH private key",
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

  const handleTest = async () => {
    setError(null); setMessage(null); setTesting(true);
    try {
      await api.testConnection(buildRequest());
      setMessage("Connection OK.");
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
      });
      onSaved();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="form">
      <h2 className="full" style={{ margin: 0 }}>{initial ? `Edit "${initial.name}"` : "New Connection"}</h2>

      <div className="full">
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My DB" />
      </div>

      <fieldset>
        <legend>MySQL</legend>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 12 }}>
          <div>
            <label>Host</label>
            <input value={host} onChange={(e) => setHost(e.target.value)} />
          </div>
          <div>
            <label>Port</label>
            <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 8 }}>
          <div>
            <label>User</label>
            <input value={user} onChange={(e) => setUser(e.target.value)} />
          </div>
          <div>
            <label>Database (optional)</label>
            <input value={database} onChange={(e) => setDatabase(e.target.value)} />
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <label>Password (saved to OS keyring; leave blank to keep existing)</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      </fieldset>

      <fieldset>
        <legend>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <input type="checkbox" style={{ width: "auto" }} checked={useSsh} onChange={(e) => setUseSsh(e.target.checked)} />
            Use SSH tunnel
          </label>
        </legend>
        {useSsh && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 12 }}>
              <div>
                <label>SSH Host</label>
                <input value={sshHost} onChange={(e) => setSshHost(e.target.value)} />
              </div>
              <div>
                <label>Port</label>
                <input type="number" value={sshPort} onChange={(e) => setSshPort(Number(e.target.value))} />
              </div>
            </div>
            <div style={{ marginTop: 8 }}>
              <label>SSH User</label>
              <input value={sshUser} onChange={(e) => setSshUser(e.target.value)} />
            </div>
            <div style={{ marginTop: 8 }}>
              <label>Private key path</label>
              <div className="row">
                <input value={sshKeyPath} onChange={(e) => setSshKeyPath(e.target.value)} placeholder="C:\\Users\\you\\.ssh\\id_ed25519" />
                <button onClick={pickKeyFile}>Browse...</button>
              </div>
            </div>
            <div style={{ marginTop: 8 }}>
              <label>Key passphrase (saved to keyring; leave blank to keep existing)</label>
              <input type="password" value={sshPassphrase} onChange={(e) => setSshPassphrase(e.target.value)} />
            </div>
          </>
        )}
      </fieldset>

      {message && <div className="full text-success">{message}</div>}
      {error && <div className="full text-error">{error}</div>}

      <div className="actions">
        <button onClick={onCancel}>Cancel</button>
        <button onClick={handleTest} disabled={testing}>{testing ? "Testing..." : "Test"}</button>
        <button className="primary" onClick={handleSave}>Save</button>
      </div>
    </div>
  );
}
