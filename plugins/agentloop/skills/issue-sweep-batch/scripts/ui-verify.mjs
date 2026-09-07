#!/usr/bin/env bun
/**
 * 年龄柱可点的 accept-path 检查 —— **柱子上写的数，必须等于点开后得到的那批**。
 *
 * 断言打在五份手写 Model 的 `renderHtml()` 产物上，不编码「这个仓库这一轮长什么样」。
 * 活数据那一轮保留但降级为结构性检查（能渲染、能点开、不崩），不含任何数字/库存断言。
 *
 * 五种形态各走不同分支：
 *   full         多档有数 + 空档占位 + 点开对账 + 色板映射
 *   empty        一条都没有 → 「这个筛选下没有工作项」+ 七根零柱，不是「未采集」
 *   single-bin   全落在 <1d，冷色合法（「最老非空必须热色」在这里必须红）
 *   all-zero     有工作项，选零存量类型后 bars()[0] 为空而不是崩，不是「未采集」
 *   uncollected  有工作项但 ageBucket=null → 「未采集」，不画七根零柱
 *
 *   bun scripts/ui-verify.mjs                  # 五份 fixture
 *   bun scripts/ui-verify.mjs --shape empty    # 单形态
 *   bun scripts/ui-verify.mjs /tmp/s.html      # fixture + 活数据结构性一轮
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allZero } from "./fixtures/all-zero.ts";
import { empty } from "./fixtures/empty.ts";
import { full } from "./fixtures/full.ts";
import { singleBin } from "./fixtures/single-bin.ts";
import { uncollected } from "./fixtures/uncollected.ts";
import { AGE_BUCKETS } from "./health.ts";
import { renderHtml } from "./html.ts";

export const MODELS = {
  full,
  empty,
  "single-bin": singleBin,
  "all-zero": allZero,
  uncollected,
};

const HOT = ["--a4", "--a5", "--a6"];

/** linkedom：先插件自己的目录，再宿主 cwd（#5773）。解析不到是失败，不是 skip。 */
export async function loadParseHTML() {
  const roots = [import.meta.dir, process.cwd()];
  let parseHTML;
  for (const root of roots) {
    for (let d = root; d !== "/" && !parseHTML; d = join(d, "..")) {
      const direct = join(d, "node_modules", "linkedom", "esm", "index.js");
      const pnpm = join(d, "node_modules", ".pnpm");
      let hit;
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
    throw new Error(
      "解析不到 linkedom。没有跑成 ≠ 通过。\n" +
        "linkedom 由本插件的 .claude/plugins/agentloop/package.json 声明；" +
        "在该目录下跑一次 `bun install`（或 `pnpm install`）后重试。",
    );
  }
  return parseHTML;
}

export function makeChecker() {
  let fails = 0;
  const check = (name, got, want) => {
    const ok = Object.is(got, want);
    if (!ok) fails++;
    console.log(`${ok ? "✓" : "✗"} ${name}: got=${got} want=${want}`);
  };
  return { check, fails: () => fails };
}

export function mount(html, parseHTML) {
  const { window, document } = parseHTML(html);
  const srcs = [...document.querySelectorAll("script")].map((s) => s.textContent ?? "");
  new Function("window", "document", srcs.join("\n;\n"))(window, document);
  const click = (el) => {
    if (!el) {
      throw new Error("click(undefined) —— 全零/空档时必须先判空，不能 bars()[0].el");
    }
    el.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  };
  const cols = () =>
    [...document.querySelectorAll(".agecol")].map((c) => ({
      key: c.getAttribute("data-age") ?? c.querySelector(".agek")?.textContent,
      n: Number(c.querySelector(".agev")?.textContent),
      on: c.classList.contains("on"),
      zero: c.classList.contains("zero"),
      clickable: c.hasAttribute("data-age"),
      barStyle: c.querySelector(".agebar")?.getAttribute("style") || "",
      el: c,
    }));
  const bars = () => cols().filter((c) => c.clickable);
  const at = (key) => cols().find((c) => c.key === key);
  const cards = () =>
    new Set([...document.querySelectorAll("#view .card")].map((c) => c.getAttribute("data-id")))
      .size;
  const recon = () =>
    document.querySelector("#view .recon")?.textContent.replace(/\s+/g, " ").trim() ?? "";
  const chip = (t) =>
    [...document.querySelectorAll(".tchip")].find((c) => c.getAttribute("data-ftype") === t);
  const viewText = () => document.getElementById("view")?.textContent ?? "";
  const notes = () => [...document.querySelectorAll("#view .note")].map((n) => n.textContent ?? "");
  const tab = (v) =>
    [...document.querySelectorAll(".tab")].find((t) => t.getAttribute("data-v") === v);
  const show = (label) =>
    console.log(
      " ",
      label,
      cols()
        .map((b) => `${b.key}:${b.n}${b.zero ? "(空)" : ""}`)
        .join("  ") || "(无年龄柱)",
    );
  return {
    window,
    document,
    click,
    cols,
    bars,
    at,
    cards,
    recon,
    chip,
    viewText,
    notes,
    tab,
    show,
  };
}

function assertClickMatches(api, check) {
  const { click, bars, cards, recon, at, cols } = api;
  const keys = bars().map((b) => b.key);
  check("★ 正控：有可点档（否则点开对账是空的）", keys.length > 0, true);
  for (const key of keys) {
    const declared = at(key).n;
    click(at(key).el);
    check(`点「${key}」的条数`, cards(), declared);
    check(`「${key}」页面自己也报出这个数`, recon().includes(String(declared)), true);
    check(`「${key}」高亮`, at(key).on, true);
    click(at(key).el);
    check(
      `「${key}」再点取消`,
      cols().some((x) => x.on),
      false,
    );
  }
}

function assertEmptyBins(api, check) {
  const { click, cards, cols } = api;
  const zs = cols().filter((c) => c.zero);
  check("确实存在空档（否则这一臂是空的，等于没测）", zs.length > 0, true);
  for (const z of zs) {
    check(`空档「${z.key}」仍写出 0（不是藏起来）`, z.n, 0);
    check(`空档「${z.key}」不可点`, z.clickable, false);
    check(`空档「${z.key}」高度为 0`, /height:\s*0/.test(z.barStyle), true);
    const before = cards();
    click(z.el);
    check(`点空档「${z.key}」什么都不发生`, cards(), before);
  }
}

function assertSearchOverlay(api, check) {
  const { click, bars, cards, document, window: w } = api;
  const candidate = [...bars()].reverse().find((b) => b.n >= 2);
  check("★ 正控：有一个 n≥2 的档可以叠搜索", !!candidate, true);
  if (!candidate) return;
  click(candidate.el);
  const before = cards();
  const seed = document.querySelector("#view .card")?.getAttribute("data-id") ?? "";
  check("★ 正控：拿到了一个真实存在的搜索种子", seed.length > 0, true);
  check("搜索种子来自卡片 id，不是写死的仓库字面量", /^\d+$/.test(seed), true);
  const inp = document.getElementById("q");
  inp.value = seed;
  inp.dispatchEvent(new w.Event("input", { bubbles: true }));
  const after = cards();
  check(`${candidate.key} 叠 #${seed} 后条数变少但非空`, after < before && after > 0, true);
  check(
    "结果仍是合法卡片（每张都挂着 data-id）",
    [...document.querySelectorAll("#view .card")].every((c) =>
      Number.isFinite(Number(c.getAttribute("data-id"))),
    ),
    true,
  );
  console.log(`  ${candidate.key} 全部 ${before} 条 → 叠 "${seed}" 后 ${after} 条`);
  inp.value = "";
  inp.dispatchEvent(new w.Event("input", { bubbles: true }));
  click(candidate.el);
}

function assertLegendAndCharts(api, check) {
  const { click, document, tab } = api;
  click(tab("overview"));
  const legendTypes = () => [...document.querySelectorAll(".legend2 .lg[data-ct]")];
  check("★ 正控：legend 用 data-ct（不是 data-type）", legendTypes().length > 0, true);
  check(
    "有「全部」",
    legendTypes().some(
      (el) => el.getAttribute("data-ct") === "" && el.textContent.includes("全部"),
    ),
    true,
  );
  const bugLg = legendTypes().find((el) => el.getAttribute("data-ct") === "bug");
  check("有 bug", !!bugLg, true);
  click(bugLg);
  check(
    "点 bug 仍在概览页",
    [...document.querySelectorAll(".tab")]
      .find((t) => t.classList.contains("on"))
      ?.getAttribute("data-v"),
    "overview",
  );
  check(
    "bug 高亮",
    [...document.querySelectorAll('.legend2 .lg[data-ct="bug"]')][0]?.classList.contains("on"),
    true,
  );
  check("两张图共用一份 legend", document.querySelectorAll(".chartbox.pair .legend2").length, 1);
  const allLg = [...document.querySelectorAll('.legend2 .lg[data-ct=""]')][0];
  click(allLg);
  check(
    "全部恢复",
    [...document.querySelectorAll(".legend2 .lg.on")].some(
      (el) => el.getAttribute("data-ct") === "",
    ),
    true,
  );

  const svgs = [...document.querySelectorAll(".chartbox.pair svg.chart")];
  check("一对图在同一个 chartbox 里", svgs.length, 2);
  const w0 = svgs[0]?.getAttribute("viewBox")?.split(" ")[2];
  const w1 = svgs[1]?.getAttribute("viewBox")?.split(" ")[2];
  check("viewBox 宽度相同", w0, w1);
  const flowXs = [
    ...new Set(
      [...(svgs[0]?.querySelectorAll("rect") ?? [])].map((r) =>
        (Number(r.getAttribute("x")) + Number(r.getAttribute("width")) / 2).toFixed(1),
      ),
    ),
  ];
  const pts = svgs[1]?.querySelector("polygon")?.getAttribute("points") ?? "";
  const stockXs = [
    ...new Set(
      pts
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((p) => Number(p.split(",")[0]).toFixed(1)),
    ),
  ];
  const stockSet = new Set(stockXs);
  check("★ 正控：两边都有点", flowXs.length > 0 && stockXs.length > 0, true);
  check(
    "每个流量柱的中心都能在存量线上找到",
    flowXs.length > 0 && flowXs.every((x) => stockSet.has(x)),
    true,
  );

  const sw = [...document.querySelectorAll(".stat[data-type]")].map((c) => ({
    t: c.getAttribute("data-type"),
    color: (c.getAttribute("style") || "").match(/--t-[a-z]+/)?.[0],
  }));
  check("★ 正控：真的枚举到了类型卡（0 张会让下面两条恒真）", sw.length > 0, true);
  check("每张类型卡都带了颜色", sw.length > 0 && sw.every((x) => !!x.color), true);
  check("颜色互不重复", new Set(sw.map((x) => x.color)).size, sw.length);
}

function isUncollected(api) {
  return api.notes().some((n) => n.includes("未采集"));
}

function isEmptyFilter(api) {
  return api.viewText().includes("这个筛选下没有工作项");
}

export function verifyFull(api, check) {
  console.log("=== full：多档有数、空档占位、点开对账、色板映射 ===");
  api.show("全部:");
  assertClickMatches(api, check);
  {
    const vars = api.bars().map((b) => b.barStyle.match(/--a\d/)?.[0]);
    check(
      "每根柱子都用严重度色（不是类型色）",
      vars.every((v) => !!v),
      true,
    );
    check(
      "严重度沿档位单调不降",
      vars.every((v, i) => i === 0 || v >= vars[i - 1]),
      true,
    );
    // 测的是这份 fixture 的色板映射，不是「库存必须有老档」。
    const old = api.at(">90d");
    check("★ 正控：full 有 >90d 非空档（否则热色臂是空的）", !!old?.clickable, true);
    check(">90d 用热色 --a6", old?.barStyle.match(/--a\d/)?.[0], "--a6");
    check("<1d 用冷色 --a0", api.at("<1d")?.barStyle.match(/--a\d/)?.[0], "--a0");
    console.log(
      `  ${api
        .bars()
        .map((b, i) => `${b.key}=${vars[i]}`)
        .join("  ")}`,
    );
  }
  assertEmptyBins(api, check);

  console.log("=== 类型 × 年龄 ===");
  api.click(api.tab("global"));
  api.click(api.chip("bug"));
  api.show("bug:");
  for (const key of api.bars().map((b) => b.key)) {
    const declared = api.at(key).n;
    api.click(api.at(key).el);
    check(`bug × ${key}`, api.cards(), declared);
    api.click(api.at(key).el);
  }
  api.click(api.chip(""));

  console.log("=== 年龄筛 + 搜索框叠加 ===");
  assertSearchOverlay(api, check);

  console.log("=== legend / X 尺度 / 类型色 ===");
  assertLegendAndCharts(api, check);
}

export function verifyEmpty(api, check) {
  console.log("=== empty：一条都没有 → 空筛选，不是未采集 ===");
  api.show("全部:");
  check("空筛选文案", isEmptyFilter(api), true);
  check("不是未采集", isUncollected(api), false);
  check("每个档都在（数出来是 0，不是藏起来）", api.cols().length, AGE_BUCKETS.length);
  check("无一可点", api.bars().length, 0);
  check("bars()[0] 为空而不是崩", api.bars()[0] == null, true);
  assertEmptyBins(api, check);
  api.click(api.tab("global"));
  check("切到全局不崩", !!api.document.getElementById("view"), true);
  check("全局仍是空筛选", isEmptyFilter(api), true);
  check("全局仍不是未采集", isUncollected(api), false);
}

export function verifySingleBin(api, check) {
  console.log("=== single-bin：全是新 issue，最老非空用冷色合法 ===");
  api.show("全部:");
  check("只有一档可点", api.bars().length, 1);
  check("那一档是 <1d", api.bars()[0]?.key, "<1d");
  const color = api.bars()[0]?.barStyle.match(/--a\d/)?.[0];
  check("<1d 用冷色 --a0", color, "--a0");
  check("冷色不在热色组（全是新 issue 合法）", HOT.includes(color), false);
  assertClickMatches(api, check);
  assertEmptyBins(api, check);
  api.click(api.tab("global"));
  api.click(api.chip(""));
  assertSearchOverlay(api, check);
}

export function verifyAllZero(api, check) {
  console.log("=== all-zero：有工作项，选零存量类型后全零，不崩、不是未采集 ===");
  api.show("筛选前:");
  check("★ 正控：筛选前有可点档（否则没碰到 all-zero 的入口）", api.bars().length > 0, true);
  const symptom = api.document.querySelector('.stat[data-type="symptom"]');
  check("★ 正控：概览有 symptom 类型卡", !!symptom, true);
  api.click(symptom);
  api.show("symptom:");
  check("空筛选文案", isEmptyFilter(api), true);
  check("不是未采集", isUncollected(api), false);
  check("每个档都在", api.cols().length, AGE_BUCKETS.length);
  check("无一可点", api.bars().length, 0);
  check("bars()[0] 为空而不是崩", api.bars()[0] == null, true);
  check(
    "空档一律不可点",
    api.cols().every((c) => !c.clickable),
    true,
  );
}

export function verifyUncollected(api, check) {
  console.log("=== uncollected：有工作项但没 timeline → 未采集，不画零柱 ===");
  check("未采集 note", isUncollected(api), true);
  check("不是空筛选文案", isEmptyFilter(api), false);
  check("不画年龄柱", api.cols().length, 0);
  check("bars() 为空", api.bars().length, 0);
  api.click(api.tab("global"));
  check(
    "条目还在（仪器没数据 ≠ 没有工作项）",
    api.document.querySelectorAll("#view .card").length > 0,
    true,
  );
  check("全局仍是未采集", isUncollected(api), true);
  check("全局仍不画年龄柱", api.cols().length, 0);
  check("全局仍不是空筛选", isEmptyFilter(api), false);
}

/**
 * 活数据一轮：能渲染、能点开、不崩。零数字、零库存、零档名、零颜色断言。
 * 五种 fixture 都得能过 —— 否则它还在编码「这一轮长什么样」。
 */
const LIVE_TABS = ["overview", "global", "epics", "trace"];

export function verifyLive(api, check) {
  console.log("=== live structural：能渲染、能点开、不崩（无数字/库存断言） ===");
  const { document, click, tab, bars, chip } = api;
  const view = document.getElementById("view");
  check("能渲染：#view 存在", !!view, true);
  check("能渲染：#view 非空", (view?.innerHTML?.length ?? 0) > 0, true);

  // 缺一个具名标签 = 失败，不是 continue。`.tab` 还在但 data-v 改名时，
  // 「有标签页」仍绿，所以必须按名字点名。
  check("有标签页", document.querySelectorAll(".tab").length > 0, true);
  for (const v of LIVE_TABS) {
    const t = tab(v);
    check(`有「${v}」标签（缺了不是 skip）`, !!t, true);
    if (!t) continue;
    click(t);
    check(`点「${v}」后 #view 仍在`, !!document.getElementById("view"), true);
  }

  const overview = tab("overview");
  if (overview) click(overview);
  // 可点年龄柱随库存变：empty / uncollected 合法地一根都没有。这不是必做探针。
  const first = bars()[0];
  if (first) {
    click(first.el);
    check("点得开一根柱子（不崩）", !!document.getElementById("view"), true);
    click(first.el);
  }

  const global = tab("global");
  if (global) click(global);
  const allChip = chip("");
  check("全局页有「全部」类型 chip（缺了不是 skip）", !!allChip, true);
  if (allChip) {
    click(allChip);
    check("点类型 chip 不崩", !!document.getElementById("view"), true);
  }

  const inp = document.getElementById("q");
  check("有搜索框", !!inp, true);
  if (inp) {
    inp.value = "x";
    inp.dispatchEvent(new api.window.Event("input", { bubbles: true }));
    check("搜索框可输入（不崩）", !!document.getElementById("view"), true);
    inp.value = "";
    inp.dispatchEvent(new api.window.Event("input", { bubbles: true }));
  }
}

export const VERIFIERS = {
  full: verifyFull,
  empty: verifyEmpty,
  "single-bin": verifySingleBin,
  "all-zero": verifyAllZero,
  uncollected: verifyUncollected,
};

export function runShape(name, html, parseHTML) {
  const checker = makeChecker();
  try {
    const api = mount(html, parseHTML);
    const fn = VERIFIERS[name];
    if (!fn) throw new Error(`unknown shape: ${name}`);
    fn(api, checker.check);
  } catch (e) {
    checker.check(`未捕获异常: ${e instanceof Error ? e.message : e}`, false, true);
  }
  return { fails: checker.fails() };
}

export function runLive(html, parseHTML) {
  const checker = makeChecker();
  try {
    verifyLive(mount(html, parseHTML), checker.check);
  } catch (e) {
    checker.check(`未捕获异常: ${e instanceof Error ? e.message : e}`, false, true);
  }
  return { fails: checker.fails() };
}

/** @returns {{ shape: string | null, htmlFile: string | null, error: string | null }} */
export function parseArgv(args) {
  let shape = null;
  let htmlFile = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--shape" || a.startsWith("--shape=")) {
      const v = a === "--shape" ? args[++i] : a.slice("--shape=".length);
      if (!v || v.startsWith("-")) {
        return {
          shape: null,
          htmlFile: null,
          error: "--shape 需要一个形态名（full|empty|single-bin|all-zero|uncollected）",
        };
      }
      shape = v;
      continue;
    }
    if (a.startsWith("-")) {
      return { shape: null, htmlFile: null, error: `unknown flag: ${a}` };
    }
    htmlFile = a;
  }
  return { shape, htmlFile, error: null };
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (parsed.error) {
    console.error(`✗ ${parsed.error}`);
    process.exit(2);
  }
  const shapeArg = parsed.shape;
  const htmlFile = parsed.htmlFile;

  let parseHTML;
  try {
    parseHTML = await loadParseHTML();
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }

  const names = shapeArg ? [shapeArg] : Object.keys(MODELS);
  if (shapeArg && !MODELS[shapeArg]) {
    console.error(`✗ unknown shape: ${shapeArg}（${Object.keys(MODELS).join(", ")}）`);
    process.exit(2);
  }

  let total = 0;
  for (const name of names) {
    console.log(`\n######## fixture: ${name} ########`);
    total += runShape(name, renderHtml(MODELS[name]), parseHTML).fails;
  }
  if (htmlFile) {
    if (!existsSync(htmlFile)) {
      console.error(`✗ 找不到活数据 HTML: ${htmlFile}`);
      process.exit(2);
    }
    console.log(`\n######## live (structural): ${htmlFile} ########`);
    total += runLive(readFileSync(htmlFile, "utf8"), parseHTML).fails;
  }

  console.log(total === 0 ? "\n✅ 全部通过" : `\n❌ ${total} 项失败`);
  process.exit(total === 0 ? 0 : 1);
}

if (import.meta.main) await main();
