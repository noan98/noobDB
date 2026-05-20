import { useState } from "react";
import { ConnectionProfile } from "../api/tauri";

interface Props {
  profiles: ConnectionProfile[];
  activeId: string | null;
  onConnect: (profile: ConnectionProfile, password: string, passphrase: string) => void;
  onEdit: (profile: ConnectionProfile) => void;
  onDelete: (id: string) => void;
}

export function ConnectionList({ profiles, activeId, onConnect, onEdit, onDelete }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");

  if (profiles.length === 0) {
    return <p className="muted" style={{ padding: 12 }}>No saved connections yet.</p>;
  }

  return (
    <ul>
      {profiles.map((p) => (
        <li key={p.id} className={activeId === p.id ? "active" : ""}>
          <div onClick={() => setExpanded(expanded === p.id ? null : p.id)} style={{ cursor: "pointer" }}>
            <div className="name">{p.name}</div>
            <div className="meta">
              {p.user}@{p.host}:{p.port}{p.database ? `/${p.database}` : ""}
              {p.ssh ? ` via SSH ${p.ssh.host}` : ""}
            </div>
          </div>
          {expanded === p.id && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              <input
                type="password"
                placeholder="DB password (blank = use saved)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {p.ssh && (
                <input
                  type="password"
                  placeholder="SSH passphrase (blank = use saved)"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              )}
              <div style={{ display: "flex", gap: 4 }}>
                <button className="primary" onClick={() => { onConnect(p, password, passphrase); setPassword(""); setPassphrase(""); }}>Connect</button>
                <button onClick={() => onEdit(p)}>Edit</button>
                <button onClick={() => { if (confirm(`Delete "${p.name}"?`)) onDelete(p.id); }}>Delete</button>
              </div>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
