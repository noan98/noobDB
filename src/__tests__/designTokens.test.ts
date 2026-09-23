import { describe, expect, it } from "vitest";
// Vite の `?raw` でソース全文を文字列として取り込む (`windowConfirmGuard.test.ts` /
// `i18n.test.ts` と同じ方式)。Node の fs に依存しないため、frontend の `tsc`
// 型チェックでも追加の型定義が要らない。型宣言は `vite/client` が提供する。
import css from "../App.css?raw";
import themeTs from "../theme.ts?raw";

/**
 * デザイントークン運用のガード (#1111 / Epic #1110 Phase 1)。
 *
 * noobDB の見た目は `App.css` の CSS 変数を単一ソースとし、`theme.ts` がそれを
 * Chakra のトークンへブリッジしている。コンポーネント側が px 直値や色リテラルを
 * 書くと、この単一ソースが機能しなくなり次の実害が出る:
 *
 * 1. **フォント拡大設定が効かなくなる。** `--space-*` / `--text-*` は
 *    `calc(N * var(--font-scale))` なので、トークン経由の余白・文字サイズだけが
 *    設定に追従する (#327/#818)。px 直値の余白は取り残され、フォントを大きくすると
 *    パディングだけ相対的に縮んでテキストがはみ出す。
 * 2. **テーマプリセットで色が破綻する。** 例えば `--status-warning` はライト系で
 *    濃い橙 (#b86409) だがダーク系では明るい黄 (dracula は #f1fa8c)。ベタ塗りの上に
 *    `color="#fff"` と直書きすると、ダーク系プリセットで白文字が明色の上に載って
 *    判読できなくなる (実際に #1111 時点で 5 箇所あった)。
 * 3. **密度・角丸・字間が画面ごとにバラつく。** 同じ意味の余白に 3px / 5px / 7px が
 *    混在すると、後から「統一する」ことができなくなる。
 *
 * ここでは `src/` 配下のソースを静的にスキャンし、トークンで表現すべき値が
 * 直値で書かれていないことを検証する。**新しい px 直値・色ベタ書きを入れると CI が
 * 落ちる**状態を作るのがこのテストの目的で、Phase 2 以降の UI 刷新が Design System
 * の上に積み上がることを機械的に保証する。
 *
 * 運用ルールの文章は `.claude/rules/ui-design-system.md` を参照。
 */

/** `src/` 配下の全ソース (テスト自身は除く)。 */
const modules = import.meta.glob("../**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

// `import.meta.glob` はこのファイルから見た相対パスを返すため、同じ
// `__tests__/` 内のファイルは `./xxx.test.ts`、それ以外は `../xxx.ts` になる。
// テスト自身は「色や px を直接書いて検証する」のが仕事なので除外する。
const sources = Object.entries(modules).filter(
  ([path]) => !path.startsWith("./") && !path.startsWith("../__tests__/"),
);

/**
 * `import.meta.glob` のキー (`../components/Icon.tsx`) を、エディタから辿れる
 * リポジトリ相対パス (`src/components/Icon.tsx`) へ直す。キーは必ず `../` 始まりで、
 * 置き換えるのは**先頭の 1 つだけ**なので、その意図を先頭アンカーで明示する。
 */
function toDisplayPath(globKey: string): string {
  return globKey.replace(/^\.\.\//, "src/");
}

/** `path:line: 該当テキスト` の形で違反を集める。 */
function findViolations(
  pattern: RegExp,
  isViolation: (match: RegExpExecArray) => boolean,
  fileFilter: (path: string) => boolean = () => true,
): string[] {
  const out: string[] = [];
  for (const [path, content] of sources) {
    if (!fileFilter(path)) continue;
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) {
        if (isViolation(m)) out.push(`${toDisplayPath(path)}:${i + 1}: ${m[0]}`);
      }
    });
  }
  return out;
}

describe("スキャン範囲の健全性", () => {
  // 退行検知: glob やパスフィルタを壊すと全チェックが「違反 0 件」で素通りしてしまう。
  // 実際に主要なコンポーネントを読めていることを固定する
  // (`themeContrast.test.ts` のプリセット自動検出に対する同種のガードと同じ趣旨)。
  it("主要なソースを実際にスキャンしている", () => {
    expect(sources.length).toBeGreaterThan(100);
    const paths = sources.map(([p]) => p);
    expect(paths).toEqual(
      expect.arrayContaining([
        "../App.tsx",
        "../theme.ts",
        "../components/ResultGrid.tsx",
        "../components/ConnectionList.tsx",
      ]),
    );
    // テスト自身は除外されている (色や px を直接書くのが仕事のため)。
    expect(paths.filter((p) => p.includes("__tests__") || p.startsWith("./"))).toEqual([]);
  });
});

describe("design tokens: 余白 (spacing)", () => {
  // Chakra の余白系スタイル props。サイズ (w/h/minW/maxH...) や位置 (top/left...) は
  // レイアウトの実寸であってリズムではないため対象外 —「4px リズムに乗る値」だけを
  // トークン強制する。
  const SPACING_PROPS =
    "p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|rowGap|columnGap";

  /** 余白を表す CSS プロパティ名 (`style` / `css` / recipe の `base` オブジェクト用)。 */
  const SPACING_CSS_PROPS =
    "(?:padding|margin|gap|rowGap|columnGap)(?:Top|Bottom|Left|Right|Block|Inline|Start|End)?";

  const HINT =
    "余白は App.css の --space-* (theme.ts の spacing トークン) を使う。" +
    "px 直値は --font-scale に追従しないため、フォント拡大設定でレイアウトが崩れる。";

  it("スタイル props に px 直値を書かない", () => {
    const offenders = findViolations(
      new RegExp(`\\b(?:${SPACING_PROPS})=\\{?"(-?[0-9.]+)px"`),
      () => true,
    );
    expect(offenders, HINT).toEqual([]);
  });

  it("スタイル props の式 (三項演算子など) にも px 直値を書かない", () => {
    // `py={compact ? "1px" : "0.5"}` のように JSX 式の中へ隠れた px 直値。
    // 前段の props 検査は `="..."` の形しか見ないため、こちらで別に拾う。
    const offenders = findViolations(
      new RegExp(`\\b(?:${SPACING_PROPS})=\\{[^}]*"-?[0-9.]+px"`),
      () => true,
    );
    expect(offenders, HINT).toEqual([]);
  });

  it("style / css / recipe のスタイルオブジェクトにも px 直値を書かない", () => {
    // `chakra(...)` の recipe `base`、`SystemStyleObject`、`css={{...}}`、
    // 素の `style={{...}}` はいずれも CSS プロパティ名で書くため、上の props 検査に
    // 掛からない。ここでは `var(--space-*)` へ寄せる (これらの文脈では Chakra の
    // トークン名ではなく CSS 変数参照が確実に効く)。
    const offenders = findViolations(
      new RegExp(`\\b${SPACING_CSS_PROPS}\\s*:\\s*"[^"]*[0-9]px`),
      () => true,
    );
    expect(offenders, HINT).toEqual([]);
  });
});

describe("design tokens: タイポグラフィ", () => {
  it("fontSize は px 直値ではなくタイプスケール (3xs〜xl) を使う", () => {
    const offenders = findViolations(/\bfontSize=\{?"[0-9.]+(?:px|pt)"/, () => true);
    expect(
      offenders,
      "文字サイズは App.css の --text-* (theme.ts の fontSizes トークン) を使う。",
    ).toEqual([]);
  });

  it("スタイルオブジェクトの fontSize も px 直値を使わない", () => {
    const offenders = findViolations(/\bfontSize\s*:\s*"[^"]*[0-9](?:px|pt)/, () => true);
    expect(
      offenders,
      "スタイルオブジェクトでは var(--text-*) を参照する。",
    ).toEqual([]);
  });

  it("letterSpacing / lineHeight は直値ではなくリズムトークンを使う", () => {
    const offenders = findViolations(
      /\b(?:letterSpacing|lineHeight)\s*(?:=\{?|:\s*)"-?[0-9.]+(?:px|em|rem)"/,
      () => true,
    );
    expect(
      offenders,
      "字間は --tracking-* (tight/normal/wide/wider)、行間は --leading-* " +
        "(tight/snug/normal/relaxed) を使う。",
    ).toEqual([]);
  });
});

describe("design tokens: 等幅数字 (#1072)", () => {
  it("font-variant-numeric は直書きせず textStyle=\"numeric\" を使う", () => {
    const offenders = findViolations(
      /fontVariantNumeric|font-variant-numeric/,
      () => true,
      (path) => path !== "../theme.ts",
    );
    expect(
      offenders,
      "等幅数字は theme.ts の textStyles.numeric が単一ソース。コンポーネントでは " +
        "textStyle=\"numeric\" (スタイルオブジェクト内は textStyle: \"numeric\") を使う。",
    ).toEqual([]);
    expect(themeTs).toMatch(/numeric:\s*\{\s*value:\s*\{\s*fontVariantNumeric:\s*"tabular-nums"/);
  });

  it("App.css にも font-variant-numeric を置かない (トークンと二重定義しない)", () => {
    expect(css).not.toMatch(/font-variant-numeric/);
  });
});

describe("design tokens: 角丸 (radius)", () => {
  it("borderRadius は px 直値ではなく radii トークン (xs/sm/md/lg/pill) を使う", () => {
    const offenders = findViolations(
      /\b(?:borderRadius|rounded)\s*(?:=\{?|:\s*)"[^"]*[0-9]px/,
      () => true,
    );
    expect(
      offenders,
      "角丸は App.css の --radius-* (theme.ts の radii トークン) を使う。",
    ).toEqual([]);
  });
});

describe("design tokens: 色", () => {
  /**
   * 色の**値そのもの**を持つことが役割であるモジュール (= 単一ソース側)。
   * ここ以外に色リテラルを置かないことで、「色を変えたいときに触る場所」が
   * 常に一意になる。
   */
  const COLOR_SOURCE_MODULES = new Set([
    // テーマプリセットのスウォッチ見本 (設定画面のプレビュー)。
    "../themePresetPreview.ts",
    // Chakra のカラー付きボタンだけは CSS 変数を介さずライト/ダークで固定色を持つ。
    "../theme.ts",
    // ブランドカラー定数 (App.css の --brand-* / favicon と parity テストで一致固定)。
    "../brand.tsx",
    // データ値を色へ写像するスケール (ヒートマップ等)。
    "../colorScale.ts",
    // アクセント色の演算とプリセット。
    "../accent.ts",
    // SQL エディタのシンタックスハイライト配色 (ユーザが設定で上書きできるデータ)。
    "../settings.ts",
    // ドライバのブランド色・プロファイル識別色 (profiles.json に保存されるデータ値)。
    "../profileIdentity.ts",
    // サンドボックスの帯色 (TitleBar のインラインスタイルが参照する単一ソース)。
    "../sandbox.ts",
    // 画像書き出しの背景フォールバック。getComputedStyle が使えない環境
    // (テスト/非 DOM) 用で、UI のスタイル指定ではない。
    "../components/imageExport.ts",
  ]);

  it("コンポーネントに色リテラル (hex / rgb / hsl) を書かない", () => {
    const offenders = findViolations(
      /"(?:#[0-9a-fA-F]{3,8}|rgba?\([0-9.,%\s]*\)|hsla?\([0-9.,%\s/]*\))"/,
      () => true,
      (path) => !COLOR_SOURCE_MODULES.has(path),
    );
    expect(
      offenders,
      "色は App.css の CSS 変数 (theme.ts の app.* トークン / semanticColors.ts の " +
        "semanticColorToken) 経由で参照する。ベタ塗りの上の前景色は app.onSolid を使う " +
        "(ダーク系プリセットでは solid が明色になるため #fff 直書きは判読できない)。",
    ).toEqual([]);
  });
});

describe("design tokens: theme.ts ⇔ App.css のパリティ", () => {
  /**
   * `theme.ts` が `var(--x)` で参照する CSS 変数が `App.css` に実在することを検証する。
   * トークン名のタイプミスは TypeScript を素通りし、実行時に「色が付かない/余白が
   * 効かない」という静かな崩れになるため、ここで機械的に潰す
   * (`semanticColors.test.ts` が意味色に対して行っている検査の全トークン版)。
   */
  it("theme.ts が参照する CSS 変数はすべて App.css に定義されている", () => {
    const referenced = new Set<string>();
    const re = /var\(\s*(--[\w-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(themeTs))) referenced.add(m[1]);

    const missing = [...referenced]
      .filter((name) => !new RegExp(`\\${name}\\s*:`).test(css))
      .sort();
    expect(missing, "theme.ts が参照する CSS 変数が App.css に無い").toEqual([]);
  });
});

describe("design tokens: ベタ塗り専用の前景色", () => {
  /**
   * `app.dangerFg` / `app.warningFg` / `app.successFg` / `app.infoFg` は
   * **同名のベタ塗り (`app.*Bg`) の上に載せるための前景色**で、テーマに追従しない
   * 固定値を持つ (danger/info は常に白、warning は常に濃茶)。面 (`app.surface` 等)
   * の上のテキストに使うと次の実害が出る:
   *
   * - `app.dangerFg` (= 白) をライトテーマの面に置く → **白地に白文字で完全に消える**
   * - `app.warningFg` (= 濃茶) をダークテーマの面に置く → 暗地に暗文字で読めない
   *
   * 面の上の意味色テキストは `app.textError` / `app.textWarning` /
   * `app.textSuccess` (テーマごとにコントラストを取った文字色) を使う。
   * #1114 時点で 10 箇所がこの取り違えをしていた (エラー文・警告文・削除ボタンの
   * ホバー色)。
   *
   * 判定は「同じ要素の指定」を近傍 3 行で近似する (JSX の属性は複数行に分かれるが、
   * `bg` と `color` が 3 行以上離れることは実際には無い)。コメント行は除外する。
   */
  const PAIRED_WINDOW = 3;

  it("意味色の前景トークンは同名のベタ塗り指定とセットでのみ使う", () => {
    const offenders: string[] = [];
    for (const [path, content] of sources) {
      if (path === "../theme.ts") continue; // トークン定義そのもの
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        // コメント行 (説明文でトークン名に言及するだけ) は対象外。
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
        const m = /app\.(danger|warning|success|info)Fg/.exec(line);
        if (!m) return;
        const solid = `app.${m[1]}Bg`;
        const window = lines
          .slice(Math.max(0, i - PAIRED_WINDOW), i + PAIRED_WINDOW + 1)
          .join("\n");
        if (!window.includes(solid)) {
          offenders.push(`${toDisplayPath(path)}:${i + 1}: ${m[0]}`);
        }
      });
    }
    expect(
      offenders,
      "app.*Fg はベタ塗り app.*Bg の上の前景色。面の上の意味色テキストは " +
        "app.textError / app.textWarning / app.textSuccess を使う " +
        "(app.dangerFg は常に白のため、ライトテーマで白地に白文字になる)。",
    ).toEqual([]);
  });
});

describe("フォーム / モーダルの共通プリミティブ", () => {
  /** モーダルとダイアログ (= `modalForm.tsx` のプリミティブを使う画面)。 */
  const isModalSource = (path: string) =>
    /^\.\.\/components\/\w+(?:Modal|Dialog)\.tsx$/.test(path);

  it("モーダル内のコード / SQL プレビューは CodePreview を使う", () => {
    // 手書きの `<pre>` は #1114 以前、地の色 (surface / bgInput / toolbar)・角丸
    // (md / lg)・文字サイズ (xs / sm) が 3 通りに割れたまま 8 箇所へ複製されていた。
    const offenders = findViolations(
      /<chakra\.pre|\bas="pre"/,
      () => true,
      isModalSource,
    );
    expect(
      offenders,
      "読み取り専用のコード表示は modalForm.tsx の <CodePreview> を使う " +
        "(折り返したい場合は wrap、高さは minH / maxH で渡す)。",
    ).toEqual([]);
  });

  it("モーダル内のフィールドラベルは FieldLabel を使う", () => {
    // 入力欄の見出しを `<chakra.label fontSize=... color="app.textSecondary">` と
    // 手書きすると、同じ役割のラベルがモーダルごとに別の文字サイズ・色で出る。
    // チェックボックス/ラジオを包む `<label>` (本文サイズが正しい) は
    // `app.textSecondary` を指定しないため、この条件では拾われない。
    const offenders = findViolations(
      /<chakra\.label[^>]*color="app\.textSecondary"/,
      () => true,
      isModalSource,
    );
    expect(
      offenders,
      "入力欄の見出しは modalForm.tsx の <FieldLabel> (textStyle=\"overline\") を使う。",
    ).toEqual([]);
  });
});

describe("フォーム / パネルの共通プリミティブ (#1114 でモーダル外へ拡大)", () => {
  const isComponent = (path: string) => /^\.\.\/components\/\w+\.tsx$/.test(path) || path === "../App.tsx";
  /** 行が (JSDoc / 行) コメントかどうか。ルールの説明文で名前を挙げるのは違反ではない。 */
  const isCommentLine = (line: string) => /^\s*(?:\/\/|\*|\/\*|\{\/\*)/.test(line);

  function scan(pattern: RegExp, fileFilter: (path: string) => boolean, allowLine: (line: string) => boolean) {
    const out: string[] = [];
    for (const [path, content] of sources) {
      if (!fileFilter(path)) continue;
      content.split("\n").forEach((line, i) => {
        if (isCommentLine(line) || allowLine(line)) return;
        if (pattern.test(line)) out.push(`${toDisplayPath(path)}:${i + 1}: ${line.trim()}`);
      });
    }
    return out;
  }

  it("SQL / 生成コードのプレビューはモーダル外 (パネル・確認文) でも CodePreview を使う", () => {
    // #1114 時点で UsersPanel (4 箇所)・AdvisorPanel・FlightRecorderPanel が、地の色・
    // 角丸・余白の違う手書き <pre> を持っていた (AdvisorPanel は padding を px 直値)。
    // 例外は「生成した SQL ではなく値そのものを見せるビューア」だけ。
    const VALUE_VIEWERS = new Set([
      "../components/CellValueViewer.tsx", // セル値 (JSON / テキスト) の閲覧・編集
      "../components/RowInspector.tsx", // 行のセル値
      "../components/ExplainViewer.tsx", // 実行計画の生テキスト
      "../components/updatePrompt.tsx", // リリースノート本文
      "../components/LocalTablesPanel.tsx", // 一覧行の SQL 抜粋 (3 行で切る要約表示)
      "../components/modalForm.tsx", // CodePreview 自身の定義元 (JSDoc での言及)
    ]);
    const offenders = findViolations(
      /<chakra\.pre|\bas="pre"/,
      () => true,
      (path) => isComponent(path) && !VALUE_VIEWERS.has(path),
    );
    expect(
      offenders,
      "SQL / 生成コードの表示は modalForm.tsx の <CodePreview> を使う。値そのものを見せる " +
        "ビューアを新設する場合だけ、このテストの VALUE_VIEWERS に理由付きで足す。",
    ).toEqual([]);
  });

  it('エラー表示の role="alert" を手書きしない (FieldError / ErrorNote を使う)', () => {
    // 同じ「入力が拒否された理由」が画面ごとに別の文字サイズ・色・余白で出ていた
    // (ConnectionForm のポート / SSH ポート、WhereUsedPanel の入力エラー等)。
    // 例外は結果グリッドのセル近傍エラー (modalForm.tsx の方針どおりセル内に出す)。
    const offenders = scan(
      /role="alert"/,
      (path) => isComponent(path) && path !== "../components/ResultGrid.tsx" && path !== "../components/modalForm.tsx",
      (line) => /<(?:ErrorNote|FieldError)\b/.test(line),
    );
    expect(
      offenders,
      'フィールドのエラーは <FieldError> (role="alert" 込み)、操作を止める持続的エラーは ' +
        '<ErrorNote role="alert"> を使う (modalForm.tsx)。',
    ).toEqual([]);
  });
});

describe("モーダルのフッター配置とキーボード (#1114)", () => {
  /** `<ModalFooter>` … `</ModalFooter>` の中身をすべて取り出す。 */
  function footers(): { path: string; body: string }[] {
    const out: { path: string; body: string }[] = [];
    for (const [path, content] of sources) {
      const re = /<ModalFooter[\s>][\s\S]*?<\/ModalFooter>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content))) out.push({ path: toDisplayPath(path), body: m[0] });
    }
    return out;
  }
  const SPACER = /flex:\s*1\s*\}|flex="1"|flex=\{1\}/;

  it("スキャン範囲の健全性: 主要なモーダルのフッターを実際に読めている", () => {
    const paths = new Set(footers().map((f) => f.path));
    expect(paths.size).toBeGreaterThan(25);
    expect(paths).toContain("src/components/ConfirmDialog.tsx");
    expect(paths).toContain("src/components/ExportModal.tsx");
  });

  it("フッターには spacer があり、閉じる / キャンセルは spacer より右に置く", () => {
    // 通常パターン: 補助 → spacer → キャンセル → 主アクション。
    // 破壊的パターン: 実行 (非強調) → spacer → キャンセル (primary)。
    // どちらでもキャンセルは spacer の右。#1114 時点で 7 つのモーダルがキャンセルを
    // 左端に置き、主アクションと画面の両端に離れていた。
    const offenders: string[] = [];
    for (const { path, body } of footers()) {
      const spacer = body.search(SPACER);
      if (spacer < 0) {
        offenders.push(`${path}: spacer が無い`);
        continue;
      }
      const cancel = body.search(/onClick=\{(?:onClose|onCancel|handleClose)\}/);
      if (cancel >= 0 && cancel < spacer) offenders.push(`${path}: 閉じる / キャンセルが spacer より左`);
    }
    expect(offenders, "Modal.tsx の ModalFooter の JSDoc にある 2 パターンに従う。").toEqual([]);
  });

  it("フッターに solid の danger ボタンを置かない (破壊的操作は左の dangerOutline)", () => {
    const offenders = footers()
      .filter(({ body }) => /variant="danger"/.test(body))
      .map(({ path }) => path);
    expect(
      offenders,
      "破壊的な実行は dangerOutline で左に置き、右端のキャンセルを primary + 初期フォーカスにする。",
    ).toEqual([]);
  });

  it("Modal は主アクションを onSubmit で渡す (Cmd/Ctrl+Enter)。渡さないなら理由を書く", () => {
    // キーボードでの確定手段がモーダルごとにバラバラだった (単一入力欄だけ Enter)。
    // 確定操作が無い閲覧画面・破壊的な確認は `// no-submit: 理由` を開始タグに書く。
    const offenders: string[] = [];
    for (const [path, content] of sources) {
      const re = /<Modal[\s>]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content))) {
        const rest = content.slice(m.index);
        const next = rest.search(/\n\s*</);
        const tag = next >= 0 ? rest.slice(0, next) : rest;
        if (/onSubmit=/.test(tag) || /\/\/ no-submit: \S/.test(tag)) continue;
        const line = content.slice(0, m.index).split("\n").length;
        offenders.push(`${toDisplayPath(path)}:${line}`);
      }
    }
    expect(
      offenders,
      "<Modal onSubmit={主アクション} submitDisabled={無効条件}> を渡すか、開始タグに " +
        "`// no-submit: 理由` を書く (破壊的な確認・閲覧のみの画面など)。",
    ).toEqual([]);
  });
});

describe("共通コンポーネントの迂回", () => {
  it("アイコンは Icon.tsx 以外から @tabler/icons-react を直接 import しない", () => {
    const offenders = findViolations(
      /from\s+"@tabler\/icons-react"/,
      () => true,
      (path) => path !== "../components/Icon.tsx",
    );
    expect(
      offenders,
      "アイコンは components/Icon.tsx の <Icon name=... /> 経由で使う。直接 import すると " +
        "同じ意味に別グリフが割り当たり、ICON_SIZES / ICON_STROKE のトークン規約も崩れる。",
    ).toEqual([]);
  });
});
