// エディタの AI インライン補完 (#1479) の CodeMirror 拡張。
// 入力が止まったら続きを AI に問い合わせ、カーソル位置に薄い文字 (ウィジェット) で出す。
// Tab で確定、Esc・入力・カーソル移動で破棄する。Tab / Esc は提案が出ているときだけ奪う
// (インデントや補完ポップアップの確定はそのまま働く)。
//
// ストリーミングに `useAiStream` を使わない理由: あのフックは React コンポーネントの
// 1 要求ぶんの状態 (受信中表示・経過秒・二重実行ガード) を持つ作りで、打鍵のたびに
// 要求の破棄と取り直しが起きる CodeMirror のプラグインからは使えない。代わりに同じ
// 既存 IPC (`run_ai_request` / `listenAiStream` / `cancelStream`) を、登録前の中止の取り直しを
// 含めて小さく扱う。IPC は増やしていない。

import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { completionStatus } from "@codemirror/autocomplete";
import { api, listenAiStream, type AiStreamHandlers } from "../api/tauri";
import { recordAiUsage } from "../ai/aiUsageStore";
import type { AiSettingsSnapshot } from "../ai/aiSettings";
import {
  buildInlineRequest,
  cleanInlineCompletion,
  InlineCompleteCache,
  type InlineTable,
  INLINE_AFTER_MAX_CHARS,
  INLINE_BEFORE_MAX_CHARS,
  INLINE_DEBOUNCE_MS,
  INLINE_TIMEOUT_MS,
  shouldShowSuggestion,
  sliceInlineWindow,
  type InlineSuggestion,
} from "../ai/inlineComplete";

/** 送信直前に毎回読む設定 (null = 送らない)。 */
export interface InlineCompleteConfig {
  driver: string;
  maskLiterals: boolean;
  tables: InlineTable[];
  database: string | null;
  settings: AiSettingsSnapshot;
}

/** IPC の差し替え口 (テスト用)。既定は既存の AI IPC。 */
export interface InlineCompleteTransport {
  listen: (streamId: string, handlers: AiStreamHandlers) => Promise<() => void>;
  run: (params: {
    streamId: string;
    systemCached: string;
    prompt: string;
    settings: AiSettingsSnapshot;
  }) => Promise<void>;
  cancel: (streamId: string) => Promise<unknown>;
}

const defaultTransport: InlineCompleteTransport = {
  listen: (id, h) => listenAiStream(id, h),
  run: (p) =>
    api.runAiRequest({
      streamId: p.streamId,
      task: "inlineComplete",
      systemCached: p.systemCached,
      prompt: p.prompt,
      settings: p.settings,
    }),
  cancel: (id) => api.cancelStream(id),
};

export interface InlineCompleteOptions {
  /** 送ってよい状態ならその時点の設定、そうでなければ null。タイマー満了時に毎回呼ぶ。 */
  getConfig: () => InlineCompleteConfig | null;
  transport?: InlineCompleteTransport;
  debounceMs?: number;
  timeoutMs?: number;
}

const setSuggestionEffect = StateEffect.define<InlineSuggestion | null>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-inline-suggest";
    el.textContent = this.text;
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

interface FieldValue {
  suggestion: InlineSuggestion | null;
  deco: DecorationSet;
}
const EMPTY: FieldValue = { suggestion: null, deco: Decoration.none };

const suggestionField = StateField.define<FieldValue>({
  create: () => EMPTY,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setSuggestionEffect)) continue;
      const s = e.value;
      const sel = tr.state.selection.main;
      // 出す位置とカーソルが食い違う提案は捨てる。
      if (!s || !sel.empty || sel.head !== s.pos || s.text === "") return EMPTY;
      return {
        suggestion: s,
        deco: Decoration.set([Decoration.widget({ widget: new GhostWidget(s.text), side: 1 }).range(s.pos)]),
      };
    }
    // 入力の継続・カーソル移動は破棄 (選択の再設定を伴うトランザクションも含む)。
    if (tr.docChanged || tr.selection) return EMPTY;
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** 現在出ている提案 (なければ null)。 */
export function inlineSuggestionOf(state: EditorState): InlineSuggestion | null {
  return state.field(suggestionField, false)?.suggestion ?? null;
}

/** 提案を確定する。出ていなければ false (キーを奪わない)。 */
function acceptSuggestion(view: EditorView): boolean {
  const s = inlineSuggestionOf(view.state);
  if (!s) return false;
  // 補完ポップアップが開いているときはそちらの確定を優先する。
  if (completionStatus(view.state) === "active") {
    view.dispatch({ effects: setSuggestionEffect.of(null) });
    return false;
  }
  view.dispatch({
    changes: { from: s.pos, insert: s.text },
    selection: { anchor: s.pos + s.text.length },
    // `input` で始まらない種別にして、確定が次の問い合わせを起こさないようにする。
    userEvent: "inlineSuggest.accept",
    scrollIntoView: true,
  });
  return true;
}

function dismissSuggestion(view: EditorView): boolean {
  if (!inlineSuggestionOf(view.state)) return false;
  const popupOpen = completionStatus(view.state) === "active";
  view.dispatch({ effects: setSuggestionEffect.of(null) });
  // ポップアップが開いていれば Esc はそちらを閉じさせる。
  return !popupOpen;
}

let streamSeq = 0;

interface InFlight {
  cancel: () => void;
}

export function inlineCompleteExtension(options: InlineCompleteOptions): Extension {
  const transport = options.transport ?? defaultTransport;
  const debounceMs = options.debounceMs ?? INLINE_DEBOUNCE_MS;
  const timeoutMs = options.timeoutMs ?? INLINE_TIMEOUT_MS;
  const cache = new InlineCompleteCache();

  const plugin = ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private inflight: InFlight | null = null;
      // 入力・カーソル移動のたびに進める。古い応答が新しい状態へ出るのを防ぐ。
      private gen = 0;

      constructor(private readonly view: EditorView) {
        // 保存済みの state (タブ切替で復元されたもの) に古い提案が残っていたら消す。
        // 構築中は dispatch できないので次のマイクロタスクで。
        if (inlineSuggestionOf(view.state)) {
          queueMicrotask(() => {
            if (inlineSuggestionOf(this.view.state)) this.view.dispatch({ effects: setSuggestionEffect.of(null) });
          });
        }
      }

      update(u: ViewUpdate): void {
        const userTyped = u.transactions.some((tr) => tr.isUserEvent("input.type"));
        if (u.docChanged || u.selectionSet) this.invalidate();
        if (u.docChanged && userTyped) this.schedule();
      }

      destroy(): void {
        this.invalidate();
      }

      private invalidate(): void {
        this.gen += 1;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.inflight?.cancel();
        this.inflight = null;
      }

      private schedule(): void {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.fire();
        }, debounceMs);
      }

      private fire(): void {
        // IME 変換中は未確定のかなを送らず、変換 DOM も乱さない。確定で文書が変わらない
        // (候補がすでに入っている) こともあるので、取りやめずに予約し直す。
        if (this.view.composing || this.view.compositionStarted) {
          this.schedule();
          return;
        }
        const cfg = options.getConfig();
        if (!cfg) return;
        const state = this.view.state;
        const sel = state.selection.main;
        if (state.selection.ranges.length !== 1 || !sel.empty || completionStatus(state) === "active") return;
        const from = Math.max(0, sel.head - INLINE_BEFORE_MAX_CHARS);
        const to = Math.min(state.doc.length, sel.head + INLINE_AFTER_MAX_CHARS);
        const req = buildInlineRequest({
          // 字句状態を保つため、マスクは文頭から掛ける (窓への切り出しは純関数側)。
          doc: state.doc.toString(),
          pos: sel.head,
          driver: cfg.driver,
          maskLiterals: cfg.maskLiterals,
          tables: cfg.tables,
          database: cfg.database,
        });
        if (!req) return;
        const pos = sel.head;
        const doc = state.doc;
        const gen = this.gen;
        const startedAt = Date.now();
        const show = (text: string) => {
          if (this.view.composing || this.view.compositionStarted) return;
          const cur = this.view.state.selection.main;
          if (
            this.view.state.selection.ranges.length !== 1 ||
            this.gen !== gen ||
            !shouldShowSuggestion({
              text,
              requestPos: pos,
              currentPos: cur.head,
              selectionEmpty: cur.empty,
              docVersionUnchanged: this.view.state.doc === doc,
              elapsedMs: Date.now() - startedAt,
            })
          ) {
            return;
          }
          this.view.dispatch({ effects: setSuggestionEffect.of({ pos, text }) });
        };
        const cached = cache.get(req.cacheKey);
        if (cached !== undefined) {
          show(cached);
          return;
        }
        // 整形に使う「カーソル前の窓」(マスクなし。最終行の重複除去にだけ使い、送らない)。
        const beforeWindow = sliceInlineWindow(state.doc.sliceString(from, to), sel.head - from).before;
        this.inflight = this.request(req, cfg.settings, (body) => {
          const text = cleanInlineCompletion(body, beforeWindow);
          cache.set(req.cacheKey, text);
          show(text);
        });
      }

      private request(
        req: { systemCached: string; prompt: string },
        settings: AiSettingsSnapshot,
        onResult: (body: string) => void,
      ): InFlight {
        streamSeq += 1;
        const streamId = `inline_${Date.now().toString(36)}_${streamSeq.toString(36)}`;
        let body = "";
        let finished = false;
        let aborted = false;
        let started = false;
        let unlisten: (() => void) | null = null;
        const cleanup = () => {
          finished = true;
          clearTimeout(timeout);
          unlisten?.();
          unlisten = null;
        };
        const abort = () => {
          if (finished) return;
          aborted = true;
          cleanup();
          if (started) void transport.cancel(streamId).catch(() => undefined);
        };
        const timeout = setTimeout(abort, timeoutMs);
        void (async () => {
          try {
            const un = await transport.listen(streamId, {
              onDelta: (e) => {
                if (!finished) body += e.text;
              },
              onDone: (e) => {
                if (finished) return;
                // `useAiStream` を通らない経路なので、今月の使用量には自前で加算する。
                recordAiUsage(e);
                cleanup();
                onResult(body);
              },
              // 補完は裏の機能なので、失敗はトーストにせず静かに諦める。
              onError: () => {
                if (!finished) cleanup();
              },
              onCancelled: () => {
                if (!finished) cleanup();
              },
            });
            if (finished) {
              un();
              return;
            }
            unlisten = un;
            started = true;
            await transport.run({ streamId, systemCached: req.systemCached, prompt: req.prompt, settings });
            // 登録前に中止されていたら (cancel_stream が空振りしているので) あらためて取り消す。
            if (aborted) void transport.cancel(streamId).catch(() => undefined);
          } catch {
            if (!finished) cleanup();
          }
        })();
        return { cancel: abort };
      }
    },
  );

  return [
    suggestionField,
    plugin,
    // 提案があるときだけ Tab / Esc を奪う。なければ false を返して通常のキー処理へ。
    Prec.highest(
      keymap.of([
        { key: "Tab", run: acceptSuggestion },
        { key: "Escape", run: dismissSuggestion },
      ]),
    ),
  ];
}
