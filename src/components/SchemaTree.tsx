import { useCallback, useEffect, useState } from "react";
import { api } from "../api/tauri";

interface Props {
  sessionId: string | null;
  onPickTable: (database: string, table: string) => void;
}

interface NodeState {
  expanded: boolean;
  tables: string[] | null;
}

export function SchemaTree({ sessionId, onPickTable }: Props) {
  const [databases, setDatabases] = useState<string[]>([]);
  const [nodes, setNodes] = useState<Record<string, NodeState>>({});
  const [error, setError] = useState<string | null>(null);

  const loadDbs = useCallback(async () => {
    if (!sessionId) return;
    try {
      const dbs = await api.listDatabases(sessionId);
      setDatabases(dbs);
    } catch (e) {
      setError(String(e));
    }
  }, [sessionId]);

  useEffect(() => {
    loadDbs();
  }, [loadDbs]);

  const toggle = async (db: string) => {
    if (!sessionId) return;
    const cur = nodes[db];
    if (cur?.expanded) {
      setNodes({ ...nodes, [db]: { ...cur, expanded: false } });
      return;
    }
    if (cur?.tables) {
      setNodes({ ...nodes, [db]: { ...cur, expanded: true } });
      return;
    }
    try {
      const tables = await api.listTables(sessionId, db);
      setNodes({ ...nodes, [db]: { expanded: true, tables } });
    } catch (e) {
      setError(String(e));
    }
  };

  if (!sessionId) {
    return <div className="tree empty">Not connected.</div>;
  }

  return (
    <div className="tree">
      {error && <div className="text-error">{error}</div>}
      {databases.length === 0 && <div className="empty">(no databases)</div>}
      {databases.map((db) => {
        const node = nodes[db];
        return (
          <div key={db}>
            <div className="db" onClick={() => toggle(db)}>
              {node?.expanded ? "▾" : "▸"} {db}
            </div>
            {node?.expanded && node.tables?.map((t) => (
              <div key={t} className="table" onDoubleClick={() => onPickTable(db, t)} title="Double-click to SELECT * LIMIT 100">
                {t}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
