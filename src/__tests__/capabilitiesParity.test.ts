import { describe, expect, it } from "vitest";
import capabilities from "../../src-tauri/capabilities/default.json";

// Tauri プラグイン / ウィンドウ API の利用と `capabilities/default.json` の `permissions` の
// パリティ (#1587)。
//
// 既存の 3 点コントラクト (`ipcCommandParity` など) は自作 `#[tauri::command]` だけが対象で、
// Tauri v2 で権限 (ACL) が要る**プラグインコマンド / コアのウィンドウ API** は射程外だった。
// 例えば `plugin-dialog` の `ask()` を使い始めたり `updater:default` を消したりしても CI は緑のまま、
// 実行時に権限エラーで無言破綻する。ここでは非テストの全 TS/TSX を `?raw` で舐め、
//   (1) 未許可の利用 (使っているのに permission が無い) と
//   (2) 過剰許可 (permission があるのにどこからも使われない)
// の両方を検出する。**capabilities を増やす前に、本当に必要か確認すること** (CLAUDE.md)。
// 新しいプラグイン API を使うときは、下の `KNOWN_IMPORTS` と `PERMISSION_USAGE` に追記する。

const sourceModules = import.meta.glob(
  ["../**/*.ts", "../**/*.tsx", "!../**/__tests__/**", "!../**/*.test.ts", "!../**/*.test.tsx"],
  {
    eager: true,
    query: "?raw",
    import: "default",
  },
) as Record<string, string>;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

const sources = Object.entries(sourceModules).map(([path, src]) => ({ path, src: stripComments(src) }));

/** 名前を特定できない `@tauri-apps/*` の import (名前空間 / default / 動的 import / re-export)。 */
const unidentifiedImports: { mod: string; where: string }[] = [];

/**
 * 非コメントのコード中の `@tauri-apps/*` からの named import を `module -> 名前集合` で返す。
 * `import * as ns` / `import X from` / `import X, { y } from` / 動的 `import("…")` /
 * `export … from` は使う API 名を静的に特定できないため `unidentifiedImports` に記録し、
 * `KNOWN_IMPORTS` で `"*"` 扱いでないモジュールでは失敗させる (`dialog.ask()` の見逃し防止)。
 * `import type` は実行時に何も呼ばないので対象外。限界: 文字列連結で組み立てた動的 import や
 * 再 export 経由 (自作モジュールが `@tauri-apps/*` を中継) は検出できない。
 */
function collectImports(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const addNames = (mod: string, clause: string) => {
    const names = out.get(mod) ?? new Set<string>();
    for (const part of clause.split(",")) {
      const n = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        .trim();
      if (n) names.add(n);
    }
    out.set(mod, names);
  };
  const stmt = /\b(import|export)\s+(type\s+)?([^;"'`]*?)\s*from\s*["'](@tauri-apps\/[^"']+)["']/g;
  const dynamic = /\b(?:import|require)\s*\(\s*["'`](@tauri-apps\/[^"'`]+)["'`]\s*\)/g;
  for (const { path, src } of sources) {
    for (const m of src.matchAll(stmt)) {
      const [, kind, typeOnly, clause, mod] = m;
      if (typeOnly && kind === "import") continue;
      const braces = clause.match(/\{([^}]*)\}/);
      const outside = clause
        .replace(/\{[^}]*\}/, "")
        .replace(/[,\s]+/g, " ")
        .trim();
      addNames(mod, braces?.[1] ?? "");
      if (kind === "export") unidentifiedImports.push({ mod, where: `${path}: export … from` });
      else if (/\*/.test(outside)) unidentifiedImports.push({ mod, where: `${path}: import * as …` });
      else if (outside) unidentifiedImports.push({ mod, where: `${path}: default import` });
    }
    for (const m of src.matchAll(dynamic)) {
      out.set(m[1], out.get(m[1]) ?? new Set());
      unidentifiedImports.push({ mod: m[1], where: `${path}: 動的 import()` });
    }
  }
  return out;
}

/** 使ってよい `@tauri-apps/*` の import と名前 (`"*"` = 名前を問わない = コア IPC/イベント/パス)。 */
const KNOWN_IMPORTS: Record<string, string[]> = {
  "@tauri-apps/api/core": ["*"],
  "@tauri-apps/api/event": ["*"],
  "@tauri-apps/api/path": ["*"],
  "@tauri-apps/api/app": ["getVersion"],
  "@tauri-apps/api/window": ["getCurrentWindow"],
  "@tauri-apps/api/webview": ["getCurrentWebview"],
  // dialog の `ask` / `confirm` / `message` を使い始めたら `dialog:allow-message` (ask / confirm は
  // 対応する `dialog:allow-ask` / `dialog:allow-confirm`) の追加が要る。ここに足すだけでは足りない。
  "@tauri-apps/plugin-dialog": ["open", "save"],
  "@tauri-apps/plugin-process": ["relaunch"],
  "@tauri-apps/plugin-updater": ["check", "Update"],
  "@tauri-apps/plugin-notification": [
    "isPermissionGranted",
    "onAction",
    "requestPermission",
    "sendNotification",
  ],
};

const importsFrom = collectImports();
const importedNames = (mod: string): Set<string> => importsFrom.get(mod) ?? new Set();
const imports = (mod: string, name?: string): boolean =>
  importsFrom.has(mod) && (name === undefined || importedNames(mod).has(name));

/**
 * `getCurrentWindow` を使うファイルで呼ばれているウィンドウメソッド名の集合。
 * 限界: ファイル単位の文字列一致なので、同じファイル内の別オブジェクトの同名メソッドも拾う
 * (過剰許可の検出が甘くなる方向)。`getCurrentWindow` を別ファイルへ渡して呼ぶ経路は検出できない。
 */
function windowMethodsUsed(): Set<string> {
  const used = new Set<string>();
  for (const { src } of sources) {
    if (!/getCurrentWindow/.test(src)) continue;
    for (const m of src.matchAll(/\.\s*(\w+)\s*\(/g)) used.add(m[1]);
  }
  return used;
}

/** 許可が要るウィンドウメソッド → 必要な permission。 */
const WINDOW_METHOD_PERMISSIONS: Record<string, string[]> = {
  minimize: ["core:window:allow-minimize"],
  toggleMaximize: ["core:window:allow-toggle-maximize"],
  close: ["core:window:allow-close"],
  startDragging: ["core:window:allow-start-dragging"],
  isMaximized: ["core:window:allow-is-maximized"],
  isFocused: ["core:window:allow-is-focused"],
  setFocus: ["core:window:allow-set-focus"],
  unminimize: ["core:window:allow-unminimize"],
  // 以下は現状未使用。使い始めたら対応する permission を足す必要があるので表に載せて検出する。
  maximize: ["core:window:allow-maximize"],
  unmaximize: ["core:window:allow-unmaximize"],
  destroy: ["core:window:allow-destroy"],
  hide: ["core:window:allow-hide"],
  show: ["core:window:allow-show"],
  setTitle: ["core:window:allow-set-title"],
  setSize: ["core:window:allow-set-size"],
  setPosition: ["core:window:allow-set-position"],
  center: ["core:window:allow-center"],
  setFullscreen: ["core:window:allow-set-fullscreen"],
  setAlwaysOnTop: ["core:window:allow-set-always-on-top"],
  requestUserAttention: ["core:window:allow-request-user-attention"],
};

/**
 * permission → 「それを必要とする利用」の判定。`null` を返す permission は無い。
 * 過剰許可の検出 (全 permission がここに載っていること) と未許可の検出の両方に使う。
 */
const PERMISSION_USAGE: Record<string, () => boolean> = {
  "core:default": () => imports("@tauri-apps/api/core") || imports("@tauri-apps/api/webview"),
  "core:event:default": () => imports("@tauri-apps/api/event"),
  "core:path:default": () => imports("@tauri-apps/api/path"),
  "core:app:default": () => imports("@tauri-apps/api/app", "getVersion"),
  "core:window:default": () => imports("@tauri-apps/api/window", "getCurrentWindow"),
  "dialog:allow-open": () => imports("@tauri-apps/plugin-dialog", "open"),
  "dialog:allow-save": () => imports("@tauri-apps/plugin-dialog", "save"),
  "notification:default": () => imports("@tauri-apps/plugin-notification"),
  "updater:default": () => imports("@tauri-apps/plugin-updater", "check"),
  "process:allow-restart": () => imports("@tauri-apps/plugin-process", "relaunch"),
  // `internal-toggle-maximize` は `toggleMaximize()` ではなく、`data-tauri-drag-region` の
  // ダブルクリックで Tauri 本体が呼ぶ内部コマンド。
  "core:window:allow-start-dragging": () => sources.some(({ src }) => /data-tauri-drag-region/.test(src)),
  "core:window:allow-internal-toggle-maximize": () =>
    sources.some(({ src }) => /data-tauri-drag-region/.test(src)),
};
for (const [method, perms] of Object.entries(WINDOW_METHOD_PERMISSIONS)) {
  for (const p of perms) {
    const prev = PERMISSION_USAGE[p];
    const here = () => windowMethodsUsed().has(method);
    PERMISSION_USAGE[p] = prev ? () => prev() || here() : here;
  }
}

const granted: string[] = capabilities.permissions.map((p) =>
  typeof p === "string" ? p : (p as { identifier: string }).identifier,
);

describe("Tauri capabilities とフロントのプラグイン API 利用のパリティ (#1587)", () => {
  it("capabilities と利用箇所が読み込めている", () => {
    expect(granted.length).toBeGreaterThan(0);
    expect(sources.length).toBeGreaterThan(50);
    expect(importsFrom.size).toBeGreaterThan(0);
  });

  it("@tauri-apps/* の import は既知の名前だけ (新規は KNOWN_IMPORTS と permission を追記)", () => {
    const unknown: string[] = [];
    for (const [mod, names] of importsFrom) {
      const allowed = KNOWN_IMPORTS[mod];
      if (!allowed) {
        unknown.push(`${mod} (未登録のモジュール)`);
        continue;
      }
      if (allowed.includes("*")) continue;
      for (const n of names) if (!allowed.includes(n)) unknown.push(`${mod}: ${n}`);
    }
    expect(unknown, "権限が要るかもしれない未登録のプラグイン / ウィンドウ API の利用").toEqual([]);
  });

  it("名前を特定できない import (名前空間 / default / 動的 / re-export) がない", () => {
    const bad = unidentifiedImports
      .filter(({ mod }) => !KNOWN_IMPORTS[mod]?.includes("*"))
      .map(({ where }) => where);
    expect(bad, "named import に書き換えて KNOWN_IMPORTS / PERMISSION_USAGE に追記してください").toEqual([]);
  });

  it("使っているウィンドウメソッドは全て表にある or 許可不要 (未登録メソッドの検出)", () => {
    const risky = [
      "maximize",
      "unmaximize",
      "destroy",
      "hide",
      "show",
      "setTitle",
      "setSize",
      "setPosition",
      "center",
      "setFullscreen",
      "setAlwaysOnTop",
      "requestUserAttention",
      "setDecorations",
      "setResizable",
      "setMinSize",
      "setMaxSize",
      "setSkipTaskbar",
      "setIcon",
      "setCursorGrab",
      "setIgnoreCursorEvents",
    ];
    const used = windowMethodsUsed();
    const unmapped = risky.filter((m) => used.has(m) && !(m in WINDOW_METHOD_PERMISSIONS));
    expect(unmapped, "WINDOW_METHOD_PERMISSIONS に追記してください").toEqual([]);
  });

  describe("未許可の利用がない", () => {
    for (const [perm, used] of Object.entries(PERMISSION_USAGE)) {
      it(`${perm}: 使われているなら許可されている`, () => {
        if (used())
          expect(granted, `${perm} を使う API があるのに capabilities/default.json に無い`).toContain(perm);
      });
    }
  });

  describe("過剰許可がない", () => {
    it.each(granted)("%s は表にあり、実際に使われている", (perm) => {
      expect(
        PERMISSION_USAGE,
        `${perm} は PERMISSION_USAGE に未登録 (増やす前に必要性を確認し、表に追記)`,
      ).toHaveProperty(perm);
      expect(PERMISSION_USAGE[perm]?.(), `${perm} を使う API がどこにも無い (過剰な権限なので削除する)`).toBe(
        true,
      );
    });
  });

  it("permissions に重複がない", () => {
    expect(new Set(granted).size).toBe(granted.length);
  });
});
