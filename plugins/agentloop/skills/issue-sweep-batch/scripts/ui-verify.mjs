/**
 * 年龄柱可点的 accept-path 检查 —— **柱子上写的数，必须等于点开后得到的那批**。
 *
 * 单测看不出这条：桶的归属、柱子的计数、过滤器三处任何一处漂移，页面照样渲染得
 * 好好的，只是数对不上，而没有人会去数。所以这里跑的是 renderHtml() **真正产出的
 * 那段脚本**（从 HTML 里抠出来直接执行），不是照着它重写一份逻辑——重写一份只能
 * 证明重写品是对的。
 *
 * 它抓到过一个真的：全局页是车道图，一条 issue 碰几个路径面就画几张卡，于是
 * 「柱子说 101」而下面铺了 172 张卡。修法不是改筛选器（筛选器是对的），
 * 是让页面把两个数都说出来。
 *
 * 用法（改动 html.ts 的筛选 / 年龄柱后必跑）：
 *   bun scripts/sweep-batch.ts --dry-run --types bug --html /tmp/s.html
 *   node scripts/ui-verify.mjs /tmp/s.html
 *
 * ⚠ 依赖 linkedom（仓库 node_modules 里的传递依赖，**不是**本 skill 声明的依赖），
 *   所以它没有挂进 bun test。解析不到时**直接失败**并说清原因——不静默跳过：
 *   一个悄悄跳过的检查与一个通过的检查同色。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** linkedom 在 pnpm 下只作为传递依赖存在，仓库根没有顶层软链，所以要扫 .pnpm。 */
function findLinkedom(start) {
  for (let d = start; d !== "/"; d = join(d, "..")) {
    const direct = join(d, "node_modules", "linkedom", "esm", "index.js");
    if (existsSync(direct)) return direct;
    const pnpm = join(d, "node_modules", ".pnpm");
    if (!existsSync(pnpm)) continue;
    const hit = readdirSync(pnpm).find((x) => x.startsWith("linkedom@"));
    if (hit) return join(pnpm, hit, "node_modules", "linkedom", "esm", "index.js");
  }
  return null;
}

let parseHTML;
const lk = findLinkedom(process.cwd());
if (lk) {
  ({ parseHTML } = await import(lk));
} else {
  console.error(
    "✗ 解析不到 linkedom（仓库 node_modules 的传递依赖）。请在 arc 仓库根下跑，或 pnpm add -D linkedom。没有跑成 ≠ 通过。",
  );
  process.exit(2);
}

const html = readFileSync(process.argv[2], "utf8");
const { window, document } = parseHTML(html);
const srcs = [...document.querySelectorAll("script")].map((s) => s.textContent);
// 两段脚本在浏览器里共享全局作用域（M 在第一段，逻辑在第二段），所以合成一个作用域跑。
new Function("window", "document", srcs.join("\n;\n"))(window, document);

const click = (el) =>
  el.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
// 全部档位（含空档）。空档没有 data-age —— 那正是要断言的。
const cols = () =>
  [...document.querySelectorAll(".agecol")].map((c) => ({
    key: c.getAttribute("data-age") ?? c.querySelector(".agek").textContent,
    n: Number(c.querySelector(".agev").textContent),
    on: c.classList.contains("on"),
    zero: c.classList.contains("zero"),
    clickable: c.hasAttribute("data-age"),
    barStyle: c.querySelector(".agebar").getAttribute("style") || "",
    el: c,
  }));
const bars = () => cols().filter((c) => c.clickable);
const at = (key) => cols().find((c) => c.key === key);
// 数**去重后的条数**：全局页是车道图，一条碰几个路径面就画几张卡。
const cards = () =>
  new Set([...document.querySelectorAll("#view .card")].map((c) => c.getAttribute("data-id"))).size;
// 页面必须把「条数」和「卡片数」都说出来 —— 只给一个的话「筛错了」和「一条铺多张卡」同色。
const recon = () =>
  document.querySelector("#view .recon")?.textContent.replace(/\s+/g, " ").trim() ?? "";
const chip = (t) =>
  [...document.querySelectorAll(".tchip")].find((c) => c.getAttribute("data-ftype") === t);

let fails = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗"} ${name}: got=${got} want=${want}`);
};
const show = (label) =>
  console.log(
    " ",
    label,
    cols()
      .map((b) => `${b.key}:${b.n}${b.zero ? "(空)" : ""}`)
      .join("  "),
  );

console.log("=== 概览页的年龄档 ===");
show("全部:");

console.log("\n=== 每个非空档：柱子上写的数 vs 点开后列表里的条数 ===");
for (const key of bars().map((b) => b.key)) {
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

console.log("\n=== 年龄严重度：越老越热，且不与类型色互冒充 ===");
{
  const hot = ["--a4", "--a5", "--a6"];
  const nz = bars();
  check("★ 正控：真的枚举到了非空档", nz.length > 0, true);
  const vars = nz.map((b) => b.barStyle.match(/--a\d/)?.[0]);
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
  check(
    `最老的非空档「${nz[nz.length - 1].key}」用的是热色`,
    hot.includes(vars[vars.length - 1]),
    true,
  );
  console.log("  " + nz.map((b, i) => `${b.key}=${vars[i]}`).join("  "));
}

console.log("\n=== 空档：不给柱子、不可点 —— 不制造「这里还有东西」的错觉 ===");
{
  const zs = cols().filter((c) => c.zero);
  // 这一臂必须非空，否则它在断言一个不存在的东西 —— 与「测过了」同色。
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

console.log("\n=== 类型 × 年龄：选 bug 后柱子跟着变，点开仍要对得上 ===");
click(chip("bug"));
show("bug:");
for (const key of bars().map((b) => b.key)) {
  const declared = at(key).n;
  click(at(key).el);
  check(`bug × ${key}`, cards(), declared);
  click(at(key).el);
}

console.log("\n=== 对抗 1：全空的档位组不能白屏，也不能装作有东西 ===");
click(chip("symptom"));
show("symptom:");
{
  const z = cols().filter((c) => c.zero);
  check("symptom 下确实有空档", z.length > 0, true);
  check(
    "空档一律不可点",
    z.every((c) => !c.clickable),
    true,
  );
  // 全零分布是**合法产出**（这个仓库这一轮可能一条 symptom 都没有）。
  // 直接取 bars()[0] 会在那种情况下崩掉——把「没东西可点」变成假红。
  const nz = bars()[0];
  if (!nz) {
    console.log("  ⊘ 这一轮 symptom 全零：没有可点的档，跳过这一臂（不是失败）");
  } else {
    click(nz.el);
    check(`symptom × ${nz.key}`, cards(), nz.n);
    click(at(nz.key).el);
  }
}

console.log("\n=== 对抗 2：年龄筛 + 搜索框叠加，两个条件必须同时生效 ===");
click(chip(""));
const oldest = bars()[bars().length - 1];
if (!oldest) {
  console.log("\n⊘ 没有任何非空年龄档，叠加搜索这一臂无从跑起（不是失败）");
  console.log(fails === 0 ? "\n✅ 全部通过" : `\n❌ ${fails} 项失败`);
  process.exit(fails === 0 ? 0 : 1);
}
click(oldest.el);
const before = cards();
// 搜索词从**当前结果里真实存在的一条**上取（它的 id），不写死 arc 特有内容——
// 写死 `did-space` 会让「这个仓库这一轮恰好没有那条」变成假红（本地 codex 报的 P2）。
const seed = document.querySelector("#view .card")?.getAttribute("data-id") ?? "";
const inp = document.getElementById("q");
inp.value = seed;
inp.dispatchEvent(new window.Event("input", { bubbles: true }));
const after = cards();
check(`★ 正控：拿到了一个真实存在的搜索种子`, seed.length > 0, true);
check(`${oldest.key} 叠 #${seed} 后条数变少但非空`, after < before && after > 0, true);
check(
  "结果仍是合法卡片（每张都挂着 data-id）",
  [...document.querySelectorAll("#view .card")].every((c) =>
    Number.isFinite(Number(c.getAttribute("data-id"))),
  ),
  true,
);
console.log(`  ${oldest.key} 全部 ${before} 条 → 叠 "${seed}" 后 ${after} 条`);

console.log("\n=== 类型色：每个类型一个色，且互不重复 ===");
{
  // 回到概览页 —— 类型卡只在那里。不切回去的话这一臂会数到 0 个卡片而
  // 「0 个都合格」满足每一条断言：**空枚举必须先被拒绝**，再谈内容对不对。
  click(
    [...document.querySelectorAll(".tab")].find((t) => t.getAttribute("data-v") === "overview"),
  );
  const sw = [...document.querySelectorAll(".stat[data-type]")].map((c) => ({
    t: c.getAttribute("data-type"),
    color: (c.getAttribute("style") || "").match(/--t-[a-z]+/)?.[0],
  }));
  check("★ 正控：真的枚举到了类型卡（0 张会让下面两条恒真）", sw.length > 0, true);
  check("每张类型卡都带了颜色", sw.length > 0 && sw.every((x) => !!x.color), true);
  check("颜色互不重复", new Set(sw.map((x) => x.color)).size, sw.length);
  console.log("  " + sw.map((x) => `${x.t}=${x.color}`).join("  "));
}

console.log(fails === 0 ? "\n✅ 全部通过" : `\n❌ ${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
