import { useCallback, useEffect, useState } from "react";
import { api } from "../api/tauri";
import { useT } from "../i18n";

interface Props {
  sessionId: string | null;
  onPickTable: (database: string, table: string) => void;
}

interface NodeState {
  expanded: boolean;
  tables: string[] | null;
}

export function SchemaTree({ sessionId, onPickTable }: Props) {
  const t = useT();
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
    return <div className="tree" style={{ color: "#6b7280" }}>{t("treeNotConnected")}</div>;
  }

  return (
    <div className="tree">
      {error && <div style={{ color: "#b91c1c" }}>{error}</div>}
      {databases.length === 0 && <div style={{ color: "#6b7280" }}>{t("treeNoDatabases")}</div>}
      {databases.map((db) => {
        const node = nodes[db];
        return (
          <div key={db}>
            <div className="db" onClick={() => toggle(db)}>
              {node?.expanded ? "▾" : "▸"} {db}
            </div>
            {node?.expanded && node.tables?.map((tbl) => (
              <div key={tbl} className="table" onDoubleClick={() => onPickTable(db, tbl)} title={t("treeTableTitle")}>
                {tbl}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
