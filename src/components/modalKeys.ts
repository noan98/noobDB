/**
 * モーダル / フォームのキーボード操作の判定 (#1114)。副作用なしの純関数。
 *
 * noobDB のモーダルは #1114 以前、「Enter で確定」が単一入力欄のモーダルだけに
 * 個別実装され、複数フィールドのモーダル (エクスポート・テーブル作成など) には
 * キーボードで確定する手段が無かった。操作を画面ごとに覚えさせないよう、次で揃える:
 *
 * - **Cmd/Ctrl+Enter** — 主アクション (フッター右端の primary) を実行する。
 *   SQL エディタの「実行」と同じキーで、フォーカスがどのフィールドにあっても効く
 *   (複数行の入力欄では素の Enter が改行なので、修飾キー付きにする)。
 * - **Esc** — 実行せずに閉じる (`Modal` の `closeOnEscape`、Chakra Dialog が処理)。
 * - **破壊的な確認ダイアログには付けない** — 実行はマウスか、実行ボタンへ
 *   フォーカスを移してからの Enter / Space に限る (誤爆で DROP が走らないように)。
 *
 * チートシート / ヘルプの表示は `shortcuts.ts` の `shortcutModalSubmit*`。
 */
export interface ModalKeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
}

/**
 * React のキーボードイベントから判定に要る値だけを抜き出す。IME 変換中かどうかは
 * 合成イベントに無く `nativeEvent.isComposing` にしか無いため、ここで拾う。
 */
export function pickModalKeys(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
  nativeEvent: { isComposing?: boolean };
}): ModalKeyEventLike {
  return {
    key: e.key,
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
    repeat: e.repeat,
    defaultPrevented: e.defaultPrevented,
    isComposing: e.nativeEvent.isComposing,
  };
}

/** 主アクションを実行するキー (Cmd/Ctrl+Enter) か。 */
export function isModalSubmitKey(e: ModalKeyEventLike): boolean {
  if (e.key !== "Enter") return false;
  // IME 変換確定の Enter を横取りしない (日本語入力中の確定で送信しない)。
  if (e.isComposing) return false;
  // 内側のコンポーネント (CodeMirror など) が既に処理したキーは奪わない。
  if (e.defaultPrevented) return false;
  // 押しっぱなしのリピートで二重実行しない。
  if (e.repeat) return false;
  if (e.altKey || e.shiftKey) return false;
  return e.metaKey || e.ctrlKey;
}
