import { describe, expect, test } from "bun:test";
import { type Model, renderHtml } from "./html";

function model(): Model {
  const empty = { opened: [0, 0, 0], closed: [0, 0, 0], stock: [0, 0, 0] };
  return {
    generatedAt: "2026-08-31 12:00",
    repo: "ArcBlock/arc",
    source: "github:ArcBlock/arc",
    types: ["bug"],
    mode: "all",
    capabilities: {
      pushdown: false,
      incremental: false,
      writableClassification: false,
      neighborhood: false,
    },
    totals: { all: 2, candidates: 2, selected: 2, skipped: 0 },
    items: [],
    epics: [],
    overlaps: [],
    overview: {
      total: 2,
      byType: {
        bug: { open: 1, closed: 1 },
        feature: { open: 1, closed: 0 },
        idea: { open: 0, closed: 0 },
        research: { open: 0, closed: 0 },
        symptom: { open: 0, closed: 0 },
        report: { open: 0, closed: 0 },
        untyped: { open: 0, closed: 0 },
      },
      unknownTypes: [],
      series: {
        day: {
          labels: ["08-29", "08-30", "08-31"],
          opened: [3, 1, 2],
          closed: [1, 2, 2],
          stock: [10, 9, 9],
          byType: {
            bug: { opened: [2, 0, 1], closed: [1, 1, 1], stock: [6, 5, 5] },
            feature: { opened: [1, 1, 1], closed: [0, 1, 1], stock: [4, 4, 4] },
            idea: empty,
            research: empty,
            symptom: empty,
            report: empty,
            untyped: empty,
          },
        },
      },
      windowNote: "test window",
    },
  };
}

describe("renderHtml 把这些约定写进页面脚本", () => {
  const html = renderHtml(model());

  test("legend 用 data-ct 过滤本图，不用 data-type（data-type 会跳到全局页）", () => {
    expect(html).toContain("data-ct=");
    expect(html).toContain('data-ct=""');
    expect(html).not.toMatch(/class="lg"[^>]*data-type="/);
  });

  test("点 legend 只改 chartType，不把 view 切到 global", () => {
    expect(html).toContain("chartType");
    const handler =
      html.match(/if \(t\.dataset\.ct !== undefined\) \{[\s\S]*?return;\n {2}\}/)?.[0] ?? "";
    expect(handler.length).toBeGreaterThan(40);
    expect(handler).toContain("chartType");
    expect(handler).not.toContain("view = 'global'");
  });

  test("id 保持字符串，点击不把 data-id 强制转成 number", () => {
    expect(html).toContain("sel = t.dataset.id");
    expect(html).toContain("sel = t.dataset.trace");
    expect(html).not.toMatch(/sel = \+t\.dataset\.id/);
    expect(html).not.toMatch(/sel = \+t\.dataset\.trace/);
  });

  test("流量与存量在同一个 chartbox 里，共用 xOf", () => {
    expect(html).toContain("chartbox pair");
    expect(html).toContain("function xOf");
    expect(html).toMatch(/function bars\([\s\S]*xOf\(/);
    expect(html).toMatch(/function line\([\s\S]*xOf\(/);
  });

  test("流量图按零轴上下对称（mid - ho / 从 mid 往下）", () => {
    expect(html).toContain("mid -");
    expect(html).toMatch(/y1="' \+ mid/);
  });

  test("delta 为 0 也画出来，并用 deltaFill 上色", () => {
    expect(html).toContain("function deltaFill");
    expect(html).not.toContain("▲+");
    expect(html).toMatch(/deltaFill\(net\)/);
    // 不再因为 net===0 就跳过
    expect(html).not.toMatch(/if \(net !== 0 && n <= 32\)/);
  });
});

/**
 * 执行页面自己产出的脚本，验证棒槌 / 共用 X / legend 过滤。
 * 这是 accept-path：单测搜源码字符串看不出「点了之后 view 还在不在概览」。
 */
describe("执行页面脚本后的概览图", () => {
  async function mount() {
    const { existsSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    let parseHTML: ((html: string) => { window: unknown; document: Document }) | undefined;
    // 先从**插件自己**的目录往上找，再从宿主仓库的 cwd 往上找（#5773）。
    // 插件用 `package.json` 声明了 linkedom，所以装过依赖的消费仓库在第一轮就命中；
    // 第二轮只是让 arc 这种「祖先 node_modules 里恰好有」的情况继续工作。
    const roots = [import.meta.dir, process.cwd()];
    for (const root of roots) {
      for (let d = root; d !== "/" && !parseHTML; d = join(d, "..")) {
        const direct = join(d, "node_modules", "linkedom", "esm", "index.js");
        const pnpm = join(d, "node_modules", ".pnpm");
        let hit: string | undefined;
        if (existsSync(direct)) hit = direct;
        else if (existsSync(pnpm)) {
          const pkg = readdirSync(pnpm).find((x) => x.startsWith("linkedom@"));
          if (pkg) hit = join(pnpm, pkg, "node_modules", "linkedom", "esm", "index.js");
        }
        if (hit) ({ parseHTML } = await import(hit));
      }
      if (parseHTML) break;
    }
    if (!parseHTML) {
      // 「没有跑成」必须与「通过」不同色 —— 所以这里是 throw，不是 skip。
      // 但补救办法必须是**任何仓库都能执行**的一条命令，不能是「请在 arc 里跑」（#5773）。
      throw new Error(
        "解析不到 linkedom。没有跑成 ≠ 通过。\n" +
          "linkedom 由本插件的 .claude/plugins/agentloop/package.json 声明；" +
          "在该目录下跑一次 `bun install`（或 `pnpm install`）后重试。",
      );
    }
    const { window, document } = parseHTML(renderHtml(model())) as {
      window: { Event: typeof Event };
      document: Document;
    };
    const srcs = [...document.querySelectorAll("script")].map((s) => s.textContent ?? "");
    new Function("window", "document", srcs.join("\n;\n"))(window, document);
    const click = (el: Element) =>
      el.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
    return { document, click };
  }

  test("legend 有全部 + 类型，点 bug 只筛图不跳页，全部可恢复", async () => {
    const { document, click } = await mount();
    const chips = () => [...document.querySelectorAll(".legend2 .lg[data-ct]")];
    expect(chips().length).toBeGreaterThan(0);
    expect(
      chips().some((el) => el.getAttribute("data-ct") === "" && el.textContent?.includes("全部")),
    ).toBe(true);
    // legend 必须真的改变**数据**，不只是把 chip 点亮。把 seriesView 整个改成
    // `return s`（过滤彻底失效）时，本测试原有的每一条 chrome 断言都照样通过。
    const flowTypes = () =>
      new Set(
        [...document.querySelectorAll(".chartbox.pair svg.chart")[0].querySelectorAll("rect")].map(
          (r) => (r.querySelector("title")?.textContent ?? "").split(" · ")[1],
        ),
      );
    const beforeTypes = flowTypes();
    // ★ 正控：过滤前必须真的不止一个类型，否则「筛完只剩 bug」是恒真的
    expect(beforeTypes.has("bug")).toBe(true);
    expect(beforeTypes.has("feature")).toBe(true);

    const bug = chips().find((el) => el.getAttribute("data-ct") === "bug");
    expect(bug).toBeTruthy();
    click(bug!);
    expect([...flowTypes()]).toEqual(["bug"]);
    expect(document.querySelector(".tab.on")?.getAttribute("data-v")).toBe("overview");
    expect(document.querySelector('.legend2 .lg[data-ct="bug"]')?.classList.contains("on")).toBe(
      true,
    );
    expect(document.querySelectorAll(".chartbox.pair .legend2").length).toBe(1);
    const all = document.querySelector('.legend2 .lg[data-ct=""]');
    expect(all).toBeTruthy();
    click(all!);
    expect(
      [...document.querySelectorAll(".legend2 .lg.on")].some(
        (el) => el.getAttribute("data-ct") === "",
      ),
    ).toBe(true);
    expect([...flowTypes()].sort()).toEqual([...beforeTypes].sort());
  });

  test("流量柱中心与存量点落在同一个 x 上，viewBox 等宽", async () => {
    const { document } = await mount();
    const svgs = [...document.querySelectorAll(".chartbox.pair svg.chart")];
    expect(svgs.length).toBe(2);
    expect(svgs[0].getAttribute("viewBox")?.split(" ")[2]).toBe(
      svgs[1].getAttribute("viewBox")?.split(" ")[2],
    );
    const flowXs = [
      ...new Set(
        [...svgs[0].querySelectorAll("rect")].map((r) =>
          (Number(r.getAttribute("x")) + Number(r.getAttribute("width")) / 2).toFixed(1),
        ),
      ),
    ];
    const pts = svgs[1].querySelector("polygon")?.getAttribute("points") ?? "";
    const stockXs = new Set(
      pts
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((p) => Number(p.split(",")[0]).toFixed(1)),
    );
    expect(flowXs.length).toBeGreaterThan(0);
    expect(stockXs.size).toBeGreaterThan(0);
    expect(flowXs.every((x) => stockXs.has(x))).toBe(true);
  });

  test("棒槌落在桶心，整根都在 viewBox 内", async () => {
    // #5772：桶心这条性质原先只钉在导出的 `chartX` 上，而页面跑的是自己的 `xOf`。
    // 把 `xOf` 从 (i+0.5)*bw 改成 i*bw，导出副本的测试照样绿，页面却把第 0 根
    // 棒槌画到 viewBox 外面去了。所以要钉的是**渲染出来的 rect**。
    const { document } = await mount();
    const svg = [...document.querySelectorAll(".chartbox.pair svg.chart")][0];
    const W = Number(svg.getAttribute("viewBox")?.split(" ")[2]);
    expect(W).toBeGreaterThan(0);
    const rects = [...svg.querySelectorAll("rect")];
    // ★ 正控：真的取到了 rect，否则下面两条 every() 对空集恒真
    expect(rects.length).toBeGreaterThan(0);
    const x = (r: Element) => Number(r.getAttribute("x"));
    const w = (r: Element) => Number(r.getAttribute("width"));
    // 整根棒槌都在画布内 —— 左边不出界、右边不出界
    expect(rects.every((r) => x(r) >= -0.01)).toBe(true);
    expect(rects.every((r) => x(r) + w(r) <= W + 0.01)).toBe(true);
    // 中心落在桶心 (i+0.5)·W/n，而不是桶的左沿
    const n = model().overview.series.day.labels.length;
    const centers = [...new Set(rects.map((r) => Number((x(r) + w(r) / 2).toFixed(3))))].sort(
      (a, b) => a - b,
    );
    expect(centers).toEqual(
      Array.from({ length: n }, (_, i) => Number((((i + 0.5) * W) / n).toFixed(3))),
    );
  });

  test("delta=0 也画出来，颜色是墨色而不是红绿", async () => {
    const { document } = await mount();
    const svg = document.querySelector(".chartbox.pair svg.chart");
    const zeros = [...svg!.querySelectorAll("text")].filter((t) => t.textContent === "0");
    expect(zeros.length).toBeGreaterThan(0);
    expect(zeros.every((t) => t.getAttribute("fill") === "var(--fg)")).toBe(true);
    const plus = [...svg!.querySelectorAll("text")].filter((t) => t.textContent === "+2");
    expect(plus.length).toBeGreaterThan(0);
    expect(plus.every((t) => t.getAttribute("fill") === "#f85149")).toBe(true);
    const minus = [...svg!.querySelectorAll("text")].filter((t) => t.textContent === "-1");
    expect(minus.length).toBeGreaterThan(0);
    expect(minus.every((t) => t.getAttribute("fill") === "#3fb950")).toBe(true);
  });

  test("棒槌：开的 rect 在零轴上方，关的 rect 在零轴下方", async () => {
    const { document } = await mount();
    const svg = document.querySelector(".chartbox.pair svg.chart");
    expect(svg).toBeTruthy();
    const zero = svg!.querySelector("line");
    expect(zero).toBeTruthy();
    const mid = Number(zero!.getAttribute("y1"));
    const rects = [...svg!.querySelectorAll("rect")];
    expect(rects.length).toBeGreaterThan(0);
    // 只断言「有的在上、有的在下」是不够的：把开/关整体对调，那个断言照样成立。
    // 必须按 rect 自己的 <title> 认出它是开还是关，再钉住它在哪一侧。
    const side = (kw: string) =>
      rects.filter((r) => (r.querySelector("title")?.textContent ?? "").includes(` · ${kw} `));
    const opened = side("开");
    const closed = side("关");
    // ★ 正控：两侧都必须真的取到 rect，否则 every() 对空集恒真，闸就瞎了
    expect(opened.length).toBeGreaterThan(0);
    expect(closed.length).toBeGreaterThan(0);
    expect(opened.length + closed.length).toBe(rects.length);
    const y = (r: Element) => Number(r.getAttribute("y"));
    const h = (r: Element) => Number(r.getAttribute("height"));
    expect(opened.every((r) => y(r) + h(r) <= mid + 0.01)).toBe(true);
    expect(closed.every((r) => y(r) >= mid - 0.01)).toBe(true);
  });
});
