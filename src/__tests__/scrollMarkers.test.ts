// @vitest-environment jsdom
import { setDiagnostics } from "@codemirror/lint";
import { openSearchPanel, search, setSearchQuery, SearchQuery } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMarkerLayer } from "../components/editorMarkers";
import {
  buildScrollTicks,
  eraseLayer,
  firstLine,
  lineFraction,
  lintScrollLayer,
  markerScrollLayer,
  refreshScrollMarkers,
  SCROLL_MARKERS_DEBOUNCE_MS,
  scrollMarkers,
  searchScrollLayer,
  type ScrollMarkSnapshot,
  type ScrollMarkSource,
} from "../components/scrollMarkers";

const src = (
  line: number,
  kind: ScrollMarkSource["kind"],
  label = "",
  pos = line * 10,
): ScrollMarkSource => ({
  pos,
  line,
  kind,
  label,
});

describe("lineFraction", () => {
  it("先頭は 0、末尾は 1、1 行だけの文書は 0", () => {
    expect(lineFraction(1, 101)).toBe(0);
    expect(lineFraction(101, 101)).toBe(1);
    expect(lineFraction(51, 101)).toBe(0.5);
    expect(lineFraction(1, 1)).toBe(0);
    expect(lineFraction(999, 10)).toBe(1);
  });
});

describe("buildScrollTicks", () => {
  it("位置の昇順で、離れた印はそれぞれ別のティックになる", () => {
    const ticks = buildScrollTicks([src(90, "error"), src(1, "warning"), src(50, "search")], 100, 100);
    expect(ticks.map((t) => t.line)).toEqual([1, 50, 90]);
    expect(ticks.map((t) => t.kind)).toEqual(["warning", "search", "error"]);
    expect(ticks.every((t) => t.count === 1)).toBe(true);
  });

  it("同じバケットでは重大度の高い印を代表にし、総数を残す", () => {
    const ticks = buildScrollTicks(
      [src(10, "ok", "a"), src(11, "search"), src(12, "error", "boom"), src(13, "warning")],
      1000,
      10,
    );
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({ kind: "error", label: "boom", line: 12, count: 4, pos: 120 });
  });

  it("重大度が同じなら文書の先頭側を代表にする", () => {
    const ticks = buildScrollTicks([src(12, "error", "b"), src(11, "error", "a")], 1000, 10);
    expect(ticks[0]).toMatchObject({ label: "a", line: 11, count: 2 });
  });

  it("優先度は error > warning > search > ok", () => {
    const pick = (kinds: ScrollMarkSource["kind"][]) =>
      buildScrollTicks(
        kinds.map((k, i) => src(5 + i, k)),
        1000,
        4,
      )[0]?.kind;
    expect(pick(["ok", "search", "warning"])).toBe("warning");
    expect(pick(["ok", "search"])).toBe("search");
    expect(pick(["search", "ok", "error", "warning"])).toBe("error");
  });

  it("バケット数が多ければ近い印も分かれ、末尾の印は最後のバケットに収まる", () => {
    expect(buildScrollTicks([src(10, "error"), src(11, "error")], 1000, 1000)).toHaveLength(2);
    const last = buildScrollTicks([src(1000, "error")], 1000, 10);
    expect(last).toHaveLength(1);
    expect(last[0]?.frac).toBe(1);
  });

  it("印が無ければ空。バケット数が 0 以下でも落ちない", () => {
    expect(buildScrollTicks([], 10, 10)).toEqual([]);
    expect(buildScrollTicks([src(1, "error")], 10, 0)).toHaveLength(1);
  });

  it("1 万件の印でもバケット数以下のティックに収まる", () => {
    const many = Array.from({ length: 10000 }, (_, i) => src(i + 1, i % 2 ? "search" : "ok"));
    expect(buildScrollTicks(many, 10000, 200).length).toBeLessThanOrEqual(200);
  });
});

describe("firstLine", () => {
  it("空行を読み飛ばした 1 行目を返す", () => {
    expect(firstLine("\n  \n Syntax error \nsecond")).toBe("Syntax error");
    expect(firstLine("")).toBe("");
  });
});

describe("scrollMarkers 拡張", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
    vi.useRealTimers();
  });

  const mount = (doc: string, enabled = { on: true }) => {
    vi.useFakeTimers();
    const errors = createMarkerLayer<{ error: string }>({
      markClass: "t-err",
      gutterClass: "t-err-g",
      onEdit: "drop",
    });
    const snaps: (ScrollMarkSnapshot | null)[] = [];
    const hosts: (HTMLElement | null)[] = [];
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    view = new EditorView({
      doc,
      parent,
      extensions: [
        search(),
        errors.extension,
        scrollMarkers({
          layers: [
            eraseLayer(markerScrollLayer(errors, (m) => ({ kind: "error", label: m.data?.error ?? "" }))),
            eraseLayer(lintScrollLayer()),
            eraseLayer(searchScrollLayer()),
          ],
          isEnabled: () => enabled.on,
          onHost: (el) => hosts.push(el),
          onSnapshot: (s) => snaps.push(s),
        }),
      ],
    });
    const flush = () => vi.advanceTimersByTime(SCROLL_MARKERS_DEBOUNCE_MS + 1);
    const last = () => snaps[snaps.length - 1];
    return { v: view, errors, snaps, hosts, enabled, flush, last };
  };
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `SELECT ${i};`).join("\n");

  it("マーカーが無ければ帯は出ない (クラスが付かない)", () => {
    const { v, flush, last } = mount(lines(20));
    flush();
    expect(v.dom.classList.contains("cm-has-scroll-markers")).toBe(false);
    expect(last()?.sources ?? []).toEqual([]);
  });

  it("実行エラーの位置が error の印として載り、直すと消える", () => {
    const { v, errors, flush, last } = mount(lines(20));
    const pos = v.state.doc.line(7).from;
    v.dispatch({ effects: errors.set([{ from: pos, to: pos + 5, kind: "error", data: { error: "boom" } }]) });
    flush();
    expect(v.dom.classList.contains("cm-has-scroll-markers")).toBe(true);
    expect(last()?.sources).toEqual([{ pos, line: 7, kind: "error", label: "boom" }]);
    // 波線の箇所を編集するとエラー層が捨てられ、帯からも消える。
    v.dispatch({ changes: { from: pos, insert: "X" } });
    flush();
    expect(last()?.sources).toEqual([]);
    expect(v.dom.classList.contains("cm-scroll-markers-empty")).toBe(true);
  });

  it("構文チェックの診断が載る (info / hint は載らない)", () => {
    const { v, flush, last } = mount(lines(20));
    const at = (n: number) => v.state.doc.line(n).from;
    v.dispatch(
      setDiagnostics(v.state, [
        { from: at(3), to: at(3) + 2, severity: "error", message: "bad\nmore" },
        { from: at(9), to: at(9) + 2, severity: "warning", message: "careful" },
        { from: at(12), to: at(12) + 2, severity: "info", message: "fyi" },
      ]),
    );
    flush();
    expect(last()?.sources.map((s) => [s.line, s.kind, s.label])).toEqual([
      [3, "error", "bad"],
      [9, "warning", "careful"],
    ]);
  });

  it("検索パネルが開いている間だけ、ヒット位置が載る", () => {
    const { v, flush, last } = mount(`${lines(20)}\nSELECT 5;`);
    v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "SELECT 5;" })) });
    flush();
    expect(last()?.sources ?? []).toEqual([]);
    openSearchPanel(v);
    flush();
    expect(last()?.sources.map((s) => [s.line, s.kind])).toEqual([
      [6, "search"],
      [21, "search"],
    ]);
  });

  it("無効のあいだは何も載せず、設定を戻して refresh すると載り直す", () => {
    const enabled = { on: false };
    const { v, errors, flush, last } = mount(lines(10), enabled);
    v.dispatch({ effects: errors.set([{ from: 0, to: 3, kind: "error", data: { error: "x" } }]) });
    flush();
    expect(v.dom.classList.contains("cm-has-scroll-markers")).toBe(false);
    enabled.on = true;
    v.dispatch({ effects: refreshScrollMarkers.of(null) });
    flush();
    expect(last()?.sources).toHaveLength(1);
    enabled.on = false;
    v.dispatch({ effects: refreshScrollMarkers.of(null) });
    flush();
    expect(last()).toBeNull();
    expect(v.dom.classList.contains("cm-has-scroll-markers")).toBe(false);
  });

  it("入力中の再計算は 1 回にまとまる", () => {
    const { v, errors, snaps, flush } = mount(lines(50));
    v.dispatch({ effects: errors.set([{ from: 0, to: 3, kind: "error", data: { error: "x" } }]) });
    flush();
    const before = snaps.length;
    const end = v.state.doc.length;
    for (let i = 0; i < 20; i++) v.dispatch({ changes: { from: end + i, insert: "\n" } });
    flush();
    expect(snaps.length - before).toBe(1);
  });

  it("一度帯が出たら、印が 0 件になっても幅は確保し続け (透明にする)、設定オフで解放する", () => {
    const enabled = { on: true };
    const { v, errors, flush } = mount(lines(10), enabled);
    v.dispatch({ effects: errors.set([{ from: 0, to: 3, kind: "error", data: { error: "x" } }]) });
    flush();
    expect(v.dom.classList.contains("cm-scroll-markers-empty")).toBe(false);
    v.dispatch({ effects: errors.set([]) });
    flush();
    expect(v.dom.classList.contains("cm-has-scroll-markers")).toBe(true);
    expect(v.dom.classList.contains("cm-scroll-markers-empty")).toBe(true);
    enabled.on = false;
    v.dispatch({ effects: refreshScrollMarkers.of(null) });
    flush();
    expect(v.dom.classList.contains("cm-has-scroll-markers")).toBe(false);
  });

  it("印が無いままの変更では onSnapshot を呼ばない", () => {
    const { v, snaps, flush } = mount(lines(10));
    flush();
    const before = snaps.length;
    v.dispatch({ changes: { from: v.state.doc.length, insert: "\n" } });
    flush();
    expect(snaps.length).toBe(before);
  });

  it("帯の縦範囲を scrollDOM に合わせる (検索パネルを開いてもずれない)", () => {
    const { v, hosts } = mount(lines(20));
    const sd = v.scrollDOM;
    let top = 0;
    Object.defineProperty(sd, "offsetTop", { get: () => top, configurable: true });
    Object.defineProperty(sd, "offsetHeight", { get: () => 300, configurable: true });
    top = 40; // 検索パネルが上に出て、スクロール領域が下へ押し下げられた状態
    openSearchPanel(v);
    vi.advanceTimersByTime(50);
    const host = hosts[0] as HTMLElement;
    expect(host.style.getPropertyValue("--scroll-marker-top")).toBe("40px");
    expect(host.style.getPropertyValue("--scroll-marker-height")).toBe("300px");
  });

  it("設定オフの間は層の build を呼ばない", () => {
    vi.useFakeTimers();
    const build = vi.fn(() => []);
    const read = vi.fn(() => 1);
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    view = new EditorView({
      doc: "a\nb",
      parent,
      extensions: [
        scrollMarkers({
          layers: [{ read, build }],
          isEnabled: () => false,
          onHost: () => {},
          onSnapshot: () => {},
        }),
      ],
    });
    view.dispatch({ changes: { from: 0, insert: "x" } });
    vi.advanceTimersByTime(SCROLL_MARKERS_DEBOUNCE_MS + 1);
    expect(build).not.toHaveBeenCalled();
  });

  it("破棄すると host を null で返し、DOM を取り除く", () => {
    const { v, hosts, snaps } = mount(lines(3));
    expect(hosts[0]?.className).toBe("cm-scroll-markers");
    v.destroy();
    view = null;
    expect(hosts[hosts.length - 1]).toBeNull();
    expect(snaps[snaps.length - 1]).toBeNull();
    expect(document.querySelector(".cm-scroll-markers")).toBeNull();
  });
});
