import { describe, expect, it } from "vitest";
import {
  sqlEditorMenuSpec,
  type SqlEditorMenuContext,
  type SqlEditorMenuItemSpec,
} from "../components/sqlEditorMenu";

/**
 * SQL エディタの右クリックメニュー (#1113) の項目決定。選択の有無・接続状態・
 * EXPLAIN タブといった文脈で項目とラベル・有効状態が切り替わることを固定する。
 */

const base: SqlEditorMenuContext = {
  hasSelection: false,
  hasContent: true,
  disabled: false,
  explainMode: false,
  canPreview: true,
  canExplain: true,
  canSaveSnippet: true,
};

const items = (ctx: SqlEditorMenuContext) =>
  sqlEditorMenuSpec(ctx).filter((e): e is SqlEditorMenuItemSpec => !("separator" in e));
const actions = (ctx: SqlEditorMenuContext) => items(ctx).map((i) => i.action);
const find = (ctx: SqlEditorMenuContext, action: string) =>
  items(ctx).find((i) => i.action === action);

describe("sqlEditorMenuSpec", () => {
  it("実行系を先頭に、整形・クリップボード・スニペット保存を並べる", () => {
    expect(actions(base)).toEqual([
      "run",
      "runStatement",
      "preview",
      "explain",
      "format",
      "toggleComment",
      "cut",
      "copy",
      "selectAll",
      "saveSnippet",
    ]);
  });

  it("選択が無ければ全体実行 + カーソル位置の文、コピー/切り取りは理由付きで無効", () => {
    expect(find(base, "run")?.labelKey).toBe("editorMenuRunAll");
    expect(find(base, "format")?.labelKey).toBe("editorMenuFormatAll");
    expect(find(base, "copy")?.disabled).toBe(true);
    expect(find(base, "copy")?.disabledReasonKey).toBe("editorMenuNeedsSelection");
    expect(find(base, "cut")?.disabled).toBe(true);
  });

  it("選択中は「選択範囲を実行」になり、重複するカーソル位置実行は出さない", () => {
    const ctx = { ...base, hasSelection: true };
    expect(find(ctx, "run")?.labelKey).toBe("editorMenuRunSelection");
    expect(find(ctx, "format")?.labelKey).toBe("editorMenuFormatSelection");
    expect(actions(ctx)).not.toContain("runStatement");
    expect(find(ctx, "copy")?.disabled).toBe(false);
  });

  it("未接続では実行系が無効 (理由付き) だが、整形はエディタ内で完結するので使える", () => {
    const ctx = { ...base, disabled: true };
    expect(find(ctx, "run")?.disabled).toBe(true);
    expect(find(ctx, "run")?.disabledReasonKey).toBe("editorHintDisabled");
    expect(find(ctx, "explain")?.disabled).toBe(true);
    expect(find(ctx, "format")?.disabled).toBe(false);
  });

  it("空の文書では実行・整形が無効", () => {
    const ctx = { ...base, hasContent: false };
    expect(find(ctx, "run")?.disabledReasonKey).toBe("editorHintEmpty");
    expect(find(ctx, "format")?.disabled).toBe(true);
  });

  it("EXPLAIN タブでは主要アクションが EXPLAIN になり、Dry Run / EXPLAIN / 文実行を出さない", () => {
    const ctx = { ...base, explainMode: true };
    expect(find(ctx, "run")?.labelKey).toBe("editorMenuExplainRun");
    expect(actions(ctx)).not.toContain("preview");
    expect(actions(ctx)).not.toContain("explain");
    expect(actions(ctx)).not.toContain("runStatement");
  });

  it("機能が渡されていない項目は出さず、セパレータが連続・末尾に残らない", () => {
    const spec = sqlEditorMenuSpec({
      ...base,
      canPreview: false,
      canExplain: false,
      canSaveSnippet: false,
    });
    expect(spec.map((e) => ("separator" in e ? "|" : e.action))).toEqual([
      "run",
      "runStatement",
      "|",
      "format",
      "toggleComment",
      "|",
      "cut",
      "copy",
      "selectAll",
    ]);
  });

  it("ショートカット表記は shortcuts.ts の id で持つ (再割り当てに追従)", () => {
    expect(find(base, "run")?.shortcutId).toBe("run");
    expect(find(base, "runStatement")?.shortcutId).toBe("runStatement");
    expect(find(base, "preview")?.shortcutId).toBe("preview");
    expect(find(base, "explain")?.shortcutId).toBe("explain");
    expect(find(base, "format")?.shortcutId).toBe("format");
  });
});
