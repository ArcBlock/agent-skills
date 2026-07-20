#!/usr/bin/env bun
/**
 * fleet-report — turn `fleet.jsonl` into numbers a human can act on.
 *
 * UNIVERSAL: every deployment writes the same record shape, so this ships with the plugin
 * rather than being re-written per machine (the hand-rolled `monitor.sh` in one deployment's
 * config dir was the thing this replaces).
 *
 * DETERMINISTIC BY CONSTRUCTION. Every number here is computed from the file. Nothing in this
 * pipeline asks a model to count, because the failure it would introduce is silent: a plausible
 * wrong number reads exactly like a right one. A skill may INTERPRET this output; it must never
 * produce it.
 *
 *   bun scripts/fleet-report.ts [--file <fleet.jsonl>] [--days N] [--html <out.html>] [--json]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

// ── record shape (mirrors driver.ts RunRecord; extra keys tolerated) ─────────
interface Rec {
  ts: string;
  runner: string;
  slug: string;
  skill: string;
  outcome: string;
  exitCode: number | null;
  ms: number;
  detail: string;
  runId?: string;
  residualProcs?: number;
  produced?: {
    prsOpened?: number[];
    prsMerged?: number[];
    issuesClosed?: number[];
    issuesOpened?: number[];
    commentsPosted?: number;
    noop?: boolean;
    summary?: string;
  };
}

const EXECUTED = new Set(["ok", "failed", "checkout-failed", "setup-failed"]);
const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const has = (n: string) => process.argv.includes(n);

export function parse(text: string): Rec[] {
  const out: Rec[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === "object" && r.ts && r.slug) out.push(r as Rec);
    } catch {
      /* a torn last line during a concurrent append is expected, not an error */
    }
  }
  return out;
}

const median = (a: number[]): number => {
  if (!a.length) return Number.NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const pct = (a: number[], p: number): number => {
  if (!a.length) return Number.NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const repo = (slug: string) => slug.split("/").pop() ?? slug;

/** A round can report a product yet open nothing — `noop:false` with an empty `prsOpened`.
 *  Rendering that as a bare "PR " reads as a missing value; it is a real, different state. */
const prodTag = (p: NonNullable<Rec["produced"]>): string => {
  if (p.noop) return "noop";
  const prs = p.prsOpened ?? [];
  return prs.length ? `PR ${prs.join(",")}` : "无 PR";
};

export interface Stats {
  windowDays: number | null;
  from: string;
  to: string;
  total: number;
  executed: number;
  ok: number;
  failed: number;
  skippedCadence: number;
  skippedLocked: number;
  /** How much of the window can even answer a question — old records lack the newer fields. */
  coverage: { produced: number; residual: number; runId: number };
  noop: number;
  withProduct: number;
  prsOpened: number;
  issuesClosed: number;
  commentsPosted: number;
  residualRounds: number;
  residualMax: number;
  byTarget: {
    key: string;
    repo: string;
    skill: string;
    runs: number;
    ok: number;
    medianMin: number;
    p90Min: number;
    maxMin: number;
    prs: number;
    noop: number;
    skipped: number;
  }[];
  byHour: { hour: string; executed: number; skipped: number; prs: number }[];
  recent: Rec[];
}

export function analyze(rows: Rec[], days: number | null): Stats {
  const cutoff = days ? Date.now() - days * 86400_000 : 0;
  const win = rows
    .filter((r) => Date.parse(r.ts) >= cutoff)
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const ex = win.filter((r) => EXECUTED.has(r.outcome));
  const prod = ex.filter((r) => r.produced);

  const targets = new Map<string, Rec[]>();
  for (const r of win) {
    const k = `${repo(r.slug)}|${r.skill}`;
    (targets.get(k) ?? targets.set(k, []).get(k)!).push(r);
  }

  const hours = new Map<string, { executed: number; skipped: number; prs: number }>();
  for (const r of win) {
    const h = r.ts.slice(0, 13);
    const cur = hours.get(h) ?? { executed: 0, skipped: 0, prs: 0 };
    if (EXECUTED.has(r.outcome)) cur.executed++;
    else cur.skipped++;
    cur.prs += r.produced?.prsOpened?.length ?? 0;
    hours.set(h, cur);
  }

  const sum = (f: (r: Rec) => number) => ex.reduce((n, r) => n + f(r), 0);

  return {
    windowDays: days,
    from: win[0]?.ts ?? "",
    to: win.at(-1)?.ts ?? "",
    total: win.length,
    executed: ex.length,
    ok: ex.filter((r) => r.outcome === "ok").length,
    failed: ex.filter((r) => r.outcome !== "ok").length,
    skippedCadence: win.filter((r) => r.outcome === "skipped-cadence").length,
    skippedLocked: win.filter((r) => r.outcome === "skipped-locked").length,
    coverage: {
      produced: prod.length,
      residual: ex.filter((r) => r.residualProcs !== undefined).length,
      runId: ex.filter((r) => r.runId).length,
    },
    noop: prod.filter((r) => r.produced?.noop).length,
    withProduct: prod.length,
    prsOpened: sum((r) => r.produced?.prsOpened?.length ?? 0),
    issuesClosed: sum((r) => r.produced?.issuesClosed?.length ?? 0),
    commentsPosted: sum((r) => r.produced?.commentsPosted ?? 0),
    residualRounds: ex.filter((r) => (r.residualProcs ?? 0) > 0).length,
    residualMax: ex.reduce((n, r) => Math.max(n, r.residualProcs ?? 0), 0),
    byTarget: [...targets.entries()]
      .map(([k, rs]) => {
        const e = rs.filter((r) => EXECUTED.has(r.outcome));
        const mins = e.map((r) => r.ms / 60000);
        const [rp, sk] = k.split("|");
        return {
          key: k,
          repo: rp,
          skill: sk,
          runs: e.length,
          ok: e.filter((r) => r.outcome === "ok").length,
          medianMin: median(mins),
          p90Min: pct(mins, 90),
          maxMin: mins.length ? Math.max(...mins) : Number.NaN,
          prs: e.reduce((n, r) => n + (r.produced?.prsOpened?.length ?? 0), 0),
          noop: e.filter((r) => r.produced?.noop).length,
          skipped: rs.length - e.length,
        };
      })
      .sort((a, b) => b.runs - a.runs || a.key.localeCompare(b.key)),
    byHour: [...hours.entries()]
      .map(([hour, v]) => ({ hour, ...v }))
      .sort((a, b) => a.hour.localeCompare(b.hour)),
    recent: win
      .filter((r) => EXECUTED.has(r.outcome))
      .slice(-15)
      .reverse(),
  };
}

// ── terminal ────────────────────────────────────────────────────────────────
const n1 = (x: number) => (Number.isNaN(x) ? "—" : x.toFixed(1));
const local = (iso: string) =>
  iso
    ? new Date(iso).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

function terminal(s: Stats): string {
  const L: string[] = [];
  const rate = s.executed ? ((s.ok / s.executed) * 100).toFixed(0) : "—";
  L.push(
    `fleet report  ${local(s.from)} → ${local(s.to)}${s.windowDays ? `  (最近 ${s.windowDays} 天)` : "  (全部)"}`,
  );
  L.push("");
  L.push(`  执行 ${s.executed} 轮   成功 ${s.ok} (${rate}%)   失败 ${s.failed}`);
  L.push(
    `  跳过 ${s.skippedCadence + s.skippedLocked} 次   cadence ${s.skippedCadence} · 锁冲突 ${s.skippedLocked}`,
  );
  L.push(`  产出 PR ${s.prsOpened} · 关闭 issue ${s.issuesClosed} · 评论 ${s.commentsPosted}`);
  if (s.withProduct)
    L.push(
      `  上报产出的轮次 ${s.withProduct}/${s.executed}   其中 noop ${s.noop} (${((s.noop / s.withProduct) * 100).toFixed(0)}%)`,
    );
  L.push(
    `  残留进程:${s.residualRounds ? `⚠ ${s.residualRounds} 轮有残留,最多 ${s.residualMax} 个` : "0 轮 ✓"}`,
  );

  // Coverage is stated, never assumed: an old record simply cannot answer the newer questions,
  // and a rate computed over a partial window silently understates everything.
  if (s.coverage.produced < s.executed || s.coverage.residual < s.executed) {
    L.push("");
    L.push(`  ⓘ 字段覆盖率(旧记录没有新字段,占比不足时上面的比例只代表已覆盖部分):`);
    L.push(
      `     produced ${s.coverage.produced}/${s.executed} · residualProcs ${s.coverage.residual}/${s.executed} · runId ${s.coverage.runId}/${s.executed}`,
    );
  }

  // Width from the data, not a guess: `arcblock-site · issue-sweep` overflows any fixed pad
  // and silently shears the columns to the right of it.
  const w = Math.max(12, ...s.byTarget.map((t) => `${t.repo} · ${t.skill}`.length));
  L.push("");
  L.push(`  ${"repo × skill".padEnd(w)}  轮次  成功   中位    P90   最长    PR  noop  跳过`);
  L.push(`  ${"─".repeat(w + 46)}`);
  for (const t of s.byTarget) {
    L.push(
      `  ${`${t.repo} · ${t.skill}`.padEnd(w)}${String(t.runs).padStart(6)}${String(t.ok).padStart(6)}` +
        `${n1(t.medianMin).padStart(7)}${n1(t.p90Min).padStart(7)}${n1(t.maxMin).padStart(7)}` +
        `${String(t.prs).padStart(6)}${String(t.noop).padStart(6)}${String(t.skipped).padStart(6)}`,
    );
  }
  L.push(`  ${" ".repeat(w)}${" ".repeat(12)}${"←— 分钟 —→".padStart(9)}`);

  const withSummary = s.recent.filter((r) => r.produced?.summary);
  if (withSummary.length) {
    L.push("");
    L.push("  最近的产出:");
    for (const r of withSummary.slice(0, 6)) {
      const p = r.produced!;
      const tag = prodTag(p);
      L.push(
        `   ${local(r.ts)} ${repo(r.slug)}·${r.skill} [${tag}] ${(p.summary ?? "").slice(0, 88)}`,
      );
    }
  }
  return L.join("\n");
}

// ── html ────────────────────────────────────────────────────────────────────
// Palette: validated categorical slots + the fixed status palette (dataviz skill reference).
// Status colors carry outcome state and always ship with a text label, never color alone.
function html(s: Stats): string {
  const rate = s.executed ? (s.ok / s.executed) * 100 : 0;
  const maxDur = Math.max(1, ...s.byTarget.map((t) => (Number.isNaN(t.p90Min) ? 0 : t.p90Min)));
  const maxHour = Math.max(1, ...s.byHour.map((h) => h.executed + h.skipped));
  const esc = (x: unknown) =>
    String(x ?? "").replace(
      /[<>&"]/g,
      (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!,
    );

  const tile = (label: string, value: string, sub = "") =>
    `<div class="tile"><div class="tl">${esc(label)}</div><div class="tv">${esc(value)}</div><div class="ts">${esc(sub)}</div></div>`;

  // Outcome mix — one stacked bar, part-to-whole, status palette + labels.
  // good↔critical measure ΔE 4.1 under deuteranopia — the two states a reader most needs to
  // tell apart are the two a red-green viewer cannot. Colour alone is therefore not allowed to
  // carry it: the failure segment gets a diagonal texture, and every segment is labelled.
  const mix = [
    { k: "成功", v: s.ok, c: "var(--good)", tex: false },
    { k: "失败", v: s.failed, c: "var(--critical)", tex: true },
    { k: "cadence 跳过", v: s.skippedCadence, c: "var(--muted-fill)", tex: false },
    { k: "锁冲突跳过", v: s.skippedLocked, c: "var(--warning)", tex: true },
  ].filter((x) => x.v > 0);
  const mixTotal = mix.reduce((n, x) => n + x.v, 0) || 1;

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>fleet report</title><style>
:root,.viz{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f4f3f0;--line:#e2e1dc;
 --text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#83817b;
 --s1:#2a78d6;--seq:#2a78d6;--muted-fill:#c8c6c0;
 --good:#0ca30c;--warning:#fab219;--serious:#ec835a;--critical:#d03b3b}
@media(prefers-color-scheme:dark){:root:where(:not([data-theme=light])),:root:where(:not([data-theme=light])) .viz{color-scheme:dark;
 --surface-1:#1a1a19;--surface-2:#232322;--line:#383835;
 --text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#8f8e86;
 --s1:#3987e5;--seq:#3987e5;--muted-fill:#4a4a46}}
:root[data-theme=dark],:root[data-theme=dark] .viz{color-scheme:dark;--surface-1:#1a1a19;--surface-2:#232322;--line:#383835;
 --text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#8f8e86;--s1:#3987e5;--seq:#3987e5;--muted-fill:#4a4a46}
*{box-sizing:border-box}
body{margin:0;background:var(--surface-1);color:var(--text-primary);
 font:14px/1.55 ui-sans-serif,-apple-system,"PingFang SC",system-ui,sans-serif}
.viz{max-width:1080px;margin:0 auto;padding:32px 24px 64px}
h1{font-size:20px;margin:0 0 2px;font-weight:600}
.sub{color:var(--text-secondary);font-size:13px;margin-bottom:24px}
h2{font-size:13px;font-weight:600;color:var(--text-secondary);margin:32px 0 12px;
 text-transform:uppercase;letter-spacing:.06em}
.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.tile{background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.tl{font-size:12px;color:var(--text-secondary)}
.tv{font-size:26px;font-weight:600;margin:4px 0 0;font-variant-numeric:tabular-nums}
.ts{font-size:12px;color:var(--text-muted)}
.stack{display:flex;height:26px;border-radius:5px;overflow:hidden;gap:2px;background:var(--surface-2)}
.stack>div{min-width:3px}
.tex{background-image:repeating-linear-gradient(45deg,transparent 0 3px,rgba(255,255,255,.55) 3px 6px)}
.legend{display:flex;flex-wrap:wrap;gap:16px;margin-top:10px;font-size:12px;color:var(--text-secondary)}
.legend i{width:10px;height:10px;border-radius:3px;display:inline-block;margin-right:6px;vertical-align:-1px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:500;color:var(--text-secondary);font-size:12px;
 padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:7px 8px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
td.n{text-align:right}
.bar{height:9px;border-radius:4px;background:var(--seq);min-width:3px}
.track{background:var(--surface-2);border-radius:4px;height:9px;width:120px}
.spark{display:flex;align-items:flex-end;gap:2px;height:54px}
.spark>div{flex:1;min-width:2px;border-radius:3px 3px 0 0;background:var(--seq)}
.spark>div.sk{background:var(--muted-fill)}
.note{color:var(--text-muted);font-size:12px;margin-top:8px}
.sum{color:var(--text-secondary);font-size:12.5px}
.pill{display:inline-block;padding:1px 7px;border-radius:20px;font-size:11px;border:1px solid var(--line)}
</style></head><body><div class="viz">

<h1>fleet report</h1>
<div class="sub">${esc(local(s.from))} → ${esc(local(s.to))}${s.windowDays ? `　最近 ${s.windowDays} 天` : "　全部记录"}　·　runner 本地采集</div>

<div class="kpi">
${tile("执行轮次", String(s.executed), `${s.total} 条记录`)}
${tile("成功率", `${rate.toFixed(0)}%`, `失败 ${s.failed}`)}
${tile("开出 PR", String(s.prsOpened), `关闭 issue ${s.issuesClosed}`)}
${tile("noop 轮次", s.withProduct ? `${s.noop}/${s.withProduct}` : "—", s.withProduct ? "已上报产出的轮次中" : "尚无产出上报")}
${tile("残留进程", s.residualRounds ? `⚠ ${s.residualRounds}` : "0", s.residualRounds ? `最多 ${s.residualMax} 个/轮` : "全部干净")}
</div>

<h2>轮次构成</h2>
<div class="stack">${mix.map((m) => `<div class="${m.tex ? "tex" : ""}" style="width:${(m.v / mixTotal) * 100}%;background:${m.c}" title="${esc(m.k)} ${m.v}"></div>`).join("")}</div>
<div class="legend">${mix.map((m) => `<span><i class="${m.tex ? "tex" : ""}" style="background:${m.c}"></i>${esc(m.k)} ${m.v}</span>`).join("")}</div>

<h2>各 repo × skill</h2>
<table><thead><tr>
<th>目标</th><th class="n">轮次</th><th class="n">成功</th><th class="n">中位(分)</th>
<th class="n">P90</th><th class="n">最长</th><th>P90 分布</th><th class="n">PR</th><th class="n">noop</th><th class="n">跳过</th>
</tr></thead><tbody>
${s.byTarget
  .map(
    (t) => `<tr><td>${esc(t.repo)} · ${esc(t.skill)}</td>
<td class="n">${t.runs}</td><td class="n">${t.ok}</td>
<td class="n">${esc(n1(t.medianMin))}</td><td class="n">${esc(n1(t.p90Min))}</td><td class="n">${esc(n1(t.maxMin))}</td>
<td><div class="track"><div class="bar" style="width:${Number.isNaN(t.p90Min) ? 0 : (t.p90Min / maxDur) * 100}%"></div></div></td>
<td class="n">${t.prs}</td><td class="n">${t.noop}</td><td class="n">${t.skipped}</td></tr>`,
  )
  .join("")}
</tbody></table>
<div class="note">时长单位分钟。P90 条形按本表最大 P90 归一,仅用于横向比较。</div>

<h2>按小时(执行 vs 跳过)</h2>
<div class="spark">${s.byHour
    .slice(-48)
    .map(
      (h) =>
        `<div style="height:${((h.executed + h.skipped) / maxHour) * 100}%" class="${h.executed ? "" : "sk"}" title="${esc(h.hour)} 执行${h.executed} 跳过${h.skipped}"></div>`,
    )
    .join("")}</div>
<div class="legend"><span><i style="background:var(--seq)"></i>含执行</span><span><i style="background:var(--muted-fill)"></i>全部跳过</span></div>

<h2>最近产出</h2>
<table><thead><tr><th>时间</th><th>目标</th><th>结果</th><th>用时</th><th>产出</th></tr></thead><tbody>
${s.recent
  .map((r) => {
    const p = r.produced;
    const tag = !p ? "—" : prodTag(p);
    return `<tr><td>${esc(local(r.ts))}</td><td>${esc(repo(r.slug))} · ${esc(r.skill)}</td>
<td><span class="pill" style="border-color:${r.outcome === "ok" ? "var(--good)" : "var(--critical)"}">${esc(r.outcome)}</span></td>
<td class="n">${Math.round(r.ms / 60000)}分</td>
<td><span class="pill">${esc(tag)}</span> <span class="sum">${esc((p?.summary ?? r.detail).slice(0, 150))}</span></td></tr>`;
  })
  .join("")}
</tbody></table>

${
  s.coverage.produced < s.executed
    ? `<div class="note">ⓘ 字段覆盖:produced ${s.coverage.produced}/${s.executed} · residualProcs ${s.coverage.residual}/${s.executed} · runId ${s.coverage.runId}/${s.executed}。旧记录没有这些字段,上面按覆盖到的部分统计 — 不是"这些轮次没产出"。</div>`
    : ""
}
</div></body></html>`;
}

// ── main ────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const file =
    arg("--file") ??
    (existsSync(`${homedir()}/.agentloop-fleet/logs/fleet.jsonl`)
      ? `${homedir()}/.agentloop-fleet/logs/fleet.jsonl`
      : "");
  if (!file || !existsSync(file)) {
    console.error(`✗ fleet.jsonl not found${file ? `: ${file}` : ""} — pass --file <path>`);
    process.exit(1);
  }
  const days = arg("--days") ? Number(arg("--days")) : null;
  const stats = analyze(parse(readFileSync(file, "utf8")), days);
  if (!stats.total) {
    console.error(`✗ no records${days ? ` in the last ${days} day(s)` : ""} in ${file}`);
    process.exit(1);
  }
  if (has("--json")) console.log(JSON.stringify(stats, null, 2));
  else console.log(terminal(stats));

  const out = arg("--html");
  if (out) {
    writeFileSync(out, html(stats));
    console.log(`\n  → ${out}`);
  }
}
