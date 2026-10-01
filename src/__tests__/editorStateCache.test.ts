import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  EditorStateCache,
  sqlConfigChanged,
  type AppliedEditorConfig,
  type CachedEditorState,
} from "../components/editorStateCache";

const applied: AppliedEditorConfig = {
  driver: "mysql",
  schemaKey: "",
  databaseSchema: null,
  defaultDatabase: null,
  lint: "1",
  keymap: "k",
};

function entry(doc: string): CachedEditorState {
  return { state: EditorState.create({ doc }), applied, scrollTop: 0, hostScrollTop: 0 };
}

describe("EditorStateCache (#1308)", () => {
  it("take は取り出して削除する", () => {
    const c = new EditorStateCache();
    c.set("a", entry("SELECT 1"));
    expect(c.take("a")?.state.doc.toString()).toBe("SELECT 1");
    expect(c.has("a")).toBe(false);
    expect(c.take("a")).toBeUndefined();
  });

  it("上限を超えたら最も古い (使われていない) タブから捨てる", () => {
    const c = new EditorStateCache(2);
    c.set("a", entry("a"));
    c.set("b", entry("b"));
    c.set("c", entry("c"));
    expect(c.size).toBe(2);
    expect(c.has("a")).toBe(false);
    expect(c.has("b")).toBe(true);
    expect(c.has("c")).toBe(true);
  });

  it("同じタブを再保存すると最新扱いになり、重複しない", () => {
    const c = new EditorStateCache(2);
    c.set("a", entry("a"));
    c.set("b", entry("b"));
    c.set("a", entry("a2"));
    c.set("c", entry("c"));
    expect(c.has("a")).toBe(true);
    expect(c.has("b")).toBe(false);
    expect(c.size).toBe(2);
  });

  it("sqlConfigChanged は補完に効く項目だけを見る", () => {
    expect(sqlConfigChanged(applied, { ...applied, lint: "0", keymap: "x" })).toBe(false);
    expect(sqlConfigChanged(applied, { ...applied, driver: "postgres" })).toBe(true);
    expect(sqlConfigChanged(applied, { ...applied, schemaKey: "db.t|id" })).toBe(true);
    expect(sqlConfigChanged(applied, { ...applied, defaultDatabase: "app" })).toBe(true);
    expect(sqlConfigChanged(applied, { ...applied, databaseSchema: [] })).toBe(true);
  });
});
