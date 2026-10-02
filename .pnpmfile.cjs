// typescript-eslint は TypeScript の JS API (typescript@<6.1) を必要とするが、
// 本体の型チェックは TypeScript 7 (ネイティブ版・JS API なし) を使う。
// typescript-eslint 系パッケージだけ、peer の typescript を TS 6 互換パッケージ
// (@typescript/typescript6) の実体に差し替えて並走させる。
// typescript-eslint が TS 7.1 以降に対応したら (typescript-eslint#10940) このファイルは削除する。
const TS6 = "npm:@typescript/typescript6@^6.0.2";

function readPackage(pkg) {
  if (pkg.name === "typescript-eslint" || pkg.name.startsWith("@typescript-eslint/")) {
    if (pkg.peerDependencies && pkg.peerDependencies.typescript) {
      delete pkg.peerDependencies.typescript;
      if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta.typescript;
      pkg.dependencies = { ...pkg.dependencies, typescript: TS6 };
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
