import { invoke as rawInvoke } from "@tauri-apps/api/core";

/**
 * A backend error carrying the structured `AppError.kind` discriminant (#683).
 *
 * Tauri rejects a command's promise with whatever the backend `AppError`
 * serializes to. Since #683 that is a `{ kind, message }` object rather than a
 * bare string, so `invoke` below normalizes it into this class. `toString()`
 * intentionally returns just `message` (not `"BackendError: <message>"`) so the
 * many existing `String(e)` call sites keep showing the raw backend text
 * unchanged, while newer code can read `.kind` for reliable classification.
 */
export class BackendError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = "BackendError";
    this.kind = kind;
    // Restore the prototype chain so `instanceof BackendError` works even when
    // compiled down to older targets (the standard `extends Error` caveat).
    Object.setPrototypeOf(this, BackendError.prototype);
  }
  override toString(): string {
    return this.message;
  }
}

/**
 * Normalizes whatever a rejected IPC promise carries into a {@link BackendError}.
 * Accepts the structured `{ kind, message }` object (current backend), a bare
 * string (legacy/pre-#683 error surfaces and some mocks), or any other value —
 * so every error path ends up with a consistent shape and a usable `.message`.
 */
export function normalizeBackendError(raw: unknown): BackendError {
  if (raw instanceof BackendError) return raw;
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (typeof o.kind === "string" && typeof o.message === "string") {
      return new BackendError(o.kind, o.message);
    }
    if (raw instanceof Error) {
      return new BackendError("unknown", raw.message);
    }
  }
  if (typeof raw === "string") {
    return new BackendError("unknown", raw);
  }
  return new BackendError("unknown", String(raw));
}

/** The structured `kind` of a caught error, or `null` when it isn't a
 *  {@link BackendError} (e.g. a plain string from an older surface). Lets UI
 *  code classify errors without re-implementing the normalization. */
export function errorKindOf(e: unknown): string | null {
  return e instanceof BackendError ? e.kind : null;
}

/**
 * Typed wrapper around Tauri's `invoke` that normalizes any rejection into a
 * {@link BackendError} (#683). All IPC calls in this module go through here, so
 * the whole frontend receives errors in one consistent shape.
 */
export function invoke<T>(
  cmd: string,
  args?: Record<string, unknown> | Uint8Array,
  options?: { headers: Record<string, string> },
): Promise<T> {
  // options (raw ボディのヘッダ) を使わない呼び出しは従来どおり 2 引数で渡す。
  const call = options ? rawInvoke<T>(cmd, args, options) : rawInvoke<T>(cmd, args);
  return call.catch((raw: unknown) => {
    throw normalizeBackendError(raw);
  });
}

/**
 * `tauri::ipc::Response` (生バイト) で返るコマンドの結果を `Uint8Array` へ揃える
 * (#1258)。Tauri は生バイトを `ArrayBuffer` として渡すので、それ以外は契約違反。
 */
export function parseBinaryResponse(value: unknown, command: string): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`IPC レスポンス "${command}" がバイナリではありません`);
}
