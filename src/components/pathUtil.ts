/**
 * 絶対パスか。POSIX (`/…`)・ホーム展開 (`~/…`)・Windows のドライブ (`C:\…` / `C:/…`)・
 * UNC (`\\server\share`) を絶対とみなす。相対名のまま Rust へ渡すと GUI プロセスの
 * カレントディレクトリ基準で書かれ、出力先が利用者の想定とずれるため、保存前の判定に使う。
 */
export function isAbsolutePath(path: string): boolean {
  const p = path.trim();
  return /^([A-Za-z]:[\\/]|\\\\|\/|~[\\/])/.test(p);
}
