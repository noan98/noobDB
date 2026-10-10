import { describe, expect, it } from "vitest";
import modelsRs from "../../src-tauri/src/ai/models.rs?raw";
import requestRs from "../../src-tauri/src/ai/request.rs?raw";
import {
  AI_EFFORTS,
  AI_MODEL_IDS,
  AI_TASK_DEFS,
  AI_TASK_KINDS,
} from "../ai/aiModels";

// AI 基盤 (#690) のモデル / エフォート / タスク種別は Rust (`ai/models.rs`) とフロント
// (`ai/aiModels.ts`) の二重定義。ソースを読んで集合と推奨値の一致を固定する。

const rustModelIds = [...modelsRs.matchAll(/#\[serde\(rename = "(claude-[a-z0-9-]+)"\)\]/g)].map((m) => m[1]);

function rustMatchBody(fn: string): string {
  const start = modelsRs.indexOf(`pub fn ${fn}(self)`);
  expect(start).toBeGreaterThan(-1);
  return modelsRs.slice(start, modelsRs.indexOf("\n    }\n", start));
}

describe("AI 定義の Rust ⇔ フロント パリティ (#690)", () => {
  it("モデル ID の集合と順序が一致する", () => {
    expect(rustModelIds).toEqual([...AI_MODEL_IDS]);
  });

  it("エフォート段階が一致する", () => {
    const body = modelsRs.slice(modelsRs.indexOf("pub enum AiEffort"));
    const variants = [...body.slice(0, body.indexOf("}")).matchAll(/^\s+([A-Z][a-z]+),$/gm)].map((m) =>
      m[1].toLowerCase(),
    );
    expect(variants).toEqual([...AI_EFFORTS]);
  });

  it("タスク種別が一致する", () => {
    const body = modelsRs.slice(modelsRs.indexOf("pub enum AiTaskKind"));
    const variants = [...body.slice(0, body.indexOf("}")).matchAll(/^\s+([A-Z][A-Za-z0-9]+),$/gm)].map(
      (m) => m[1][0].toLowerCase() + m[1].slice(1),
    );
    expect(variants).toEqual([...AI_TASK_KINDS]);
  });

  it("タスク種別ごとの推奨エフォートが一致する", () => {
    const body = rustMatchBody("recommended_effort");
    for (const kind of AI_TASK_KINDS) {
      const variant = kind[0].toUpperCase() + kind.slice(1);
      const eff = AI_TASK_DEFS[kind].recommendedEffort;
      const effVariant = eff[0].toUpperCase() + eff.slice(1);
      expect(body).toMatch(new RegExp(`AiTaskKind::${variant}\\s*=>\\s*AiEffort::${effVariant}`));
    }
  });

  it("タスク種別ごとの推奨モデルが一致する", () => {
    const body = rustMatchBody("recommended_model");
    const modelVariant: Record<string, string> = {
      "claude-opus-5-5": "Opus55",
      "claude-sonnet-5-5": "Sonnet55",
      "claude-haiku-5-5": "Haiku55",
      "claude-fable-5-1": "Fable51",
    };
    for (const kind of AI_TASK_KINDS) {
      const variant = kind[0].toUpperCase() + kind.slice(1);
      const model = modelVariant[AI_TASK_DEFS[kind].recommendedModel];
      expect(body).toMatch(new RegExp(`AiTaskKind::${variant}\\s*=>\\s*AiModel::${model}\\b`));
    }
  });

  it("リクエストは thinking / サンプリング系 / tool_choice を送らず fallbacks を付ける", () => {
    const body = requestRs.slice(requestRs.indexOf("pub fn build_body"), requestRs.indexOf("#[cfg(test)]"));
    for (const k of ["thinking", "temperature", "top_p", "top_k", "tool_choice"]) {
      expect(body).not.toContain(`"${k}"`);
    }
    expect(body).toContain('body["fallbacks"] = json!("default")');
    expect(body).toContain("AiModel::Haiku55"); // Haiku はサーバー側フォールバック無しで送らない
    expect(requestRs).toContain('"server-side-fallback-2026-07-01"');
  });
});
