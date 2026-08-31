/**
 * issue-sweep-batch 的可判定核心。
 *
 * 这里只放**纯函数**：路径面抽取、三态不相交判定、指纹、ledger 增量。
 * 与 GitHub 通信的部分住在 sweep-batch.ts，好让本文件可以被完整测试。
 *
 * 设计要点（每条都来自 2026-08-29/30 那轮手工 batch sweep 的实测）：
 *
 * 1. **不相交是三态，不是布尔。** issue 正文里没有路径 != 它与别人不相交。
 *    「没测到冲突」与「测过了没冲突」完全同色——这是 accept-path 铁律作用在测量本身上。
 * 2. **交集算文件级。** 目录级会把 `.claude/verify/checks/check-tests.ts` 与
 *    `check-metadata.ts` 判成相交，产生假冲突。
 * 3. **pre-pr.ts / pre-merge.ts 是命令引用，不是编辑目标。** 几乎每条 issue 的复现
 *    步骤里都会出现它们；当成落点会让所有 issue 互相「相交」。
 */

import { createHash } from "node:crypto";

/* ===== 路径面 ===== */

/**
 * `partial` = 抽到了一些落点，但正文里还有**未识别**的路径样 token。
 *
 * 抽取器只认固定的根目录 + 扩展名白名单。一条同时提到 `.github/workflows/verify.yml`
 * 和 `scripts/a.ts` 的 issue，如果标成 `measured`，那么「完整测量」与
 * 「测量了我认识的那部分」就完全同色——三态纪律必须同样作用在抽取器自己身上。
 * （Codex 在 #5628 的评审里指出，成立。）
 */
export type SurfaceState = "measured" | "partial" | "unproven" | "code-located";

export interface PathSurface {
  /** 全路径的具体文件（带扩展名）。交集只看这个。 */
  files: string[];
  /** 看起来像路径但不在识别范围内的 token —— 它们的存在使 surface 不完整。 */
  unrecognized: string[];
  /** 归一到目录的车道，仅用于人读的分组展示，不参与判定。 */
  lanes: string[];
  state: SurfaceState;
}

/** 命令引用，不是编辑目标。 */
const COMMAND_QUOTE = /(^|\/)(pre-pr|pre-merge)\.ts$/;

const FILE_RE =
  /((?:scripts|\.claude|providers|runtimes|packages|tools|blocklets)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|cjs|js|jsx|sh|json|jsonc|py|md|ya?ml|toml))/g;

/**
 * 宽口径的「像路径」：任意 `<段>/<段>...<扩展名>`。用来发现 FILE_RE 漏掉的东西，
 * **不**用于判定落点——只用于把 surface 标成 partial。
 */
const PATHISH_RE =
  /(?:^|[\s`([<"'])((?:\.?[A-Za-z0-9_.@-]+\/){1,8}[A-Za-z0-9_.@-]+\.[A-Za-z0-9]{1,6})/g;

function laneOf(file: string): string {
  const s = file.split("/").filter(Boolean);
  s.pop(); // 去掉文件名，留目录
  if (s[0] === ".claude") return s.slice(0, Math.min(3, s.length)).join("/");
  if (s[0] === "tools") return "tools";
  if (s[0] === "scripts") return s.slice(0, Math.min(2, s.length)).join("/");
  return s.slice(0, Math.min(3, s.length)).join("/");
}

export function pathSurface(body: string | null | undefined): PathSurface {
  const text = typeof body === "string" ? body : "";
  const seen = new Set<string>();
  for (const m of text.matchAll(FILE_RE)) {
    const f = m[1].replace(/[.,:;)`]+$/, "");
    if (COMMAND_QUOTE.test(f)) continue;
    seen.add(f);
  }
  const files = [...seen].sort();

  // 宽口径再扫一遍：任何像路径却没被 FILE_RE 收下的 token，都让 surface 变成不完整。
  const unknown = new Set<string>();
  for (const m of text.matchAll(PATHISH_RE)) {
    const f = m[1].replace(/[.,:;)`]+$/, "");
    if (COMMAND_QUOTE.test(f)) continue;
    if (seen.has(f)) continue;
    unknown.add(f);
  }
  const unrecognized = [...unknown].sort();

  return {
    files,
    unrecognized,
    lanes: [...new Set(files.map(laneOf))].sort(),
    // 抽不到落点 = unproven（不得默认成「与谁都不冲突」）；
    // 抽到了但还有未识别的 = partial（不足以证明不相交）。
    state: files.length === 0 ? "unproven" : unrecognized.length > 0 ? "partial" : "measured",
  };
}

/** Step 3 读代码补出的落点：与 measured 同等参与判定。 */
export function codeLocated(files: string[]): PathSurface {
  const f = [...new Set(files)].sort();
  return {
    files: f,
    unrecognized: [],
    lanes: [...new Set(f.map(laneOf))].sort(),
    state: "code-located",
  };
}

/* ===== 三态不相交 ===== */

export type DisjointState = "disjoint" | "overlap" | "unproven";

export interface DisjointResult {
  state: DisjointState;
  /** overlap 时点名共同文件，好让人直接看到撞哪。 */
  shared: string[];
  reason: string;
}

function proven(s: PathSurface): boolean {
  return s.state !== "unproven" && s.files.length > 0;
}

/** partial 的一边不足以证明不相交，但**已识别的**冲突仍然作数。 */
function complete(s: PathSurface): boolean {
  return proven(s) && s.state !== "partial";
}

export function disjointness(a: PathSurface, b: PathSurface): DisjointResult {
  // 已识别的文件先比：partial 也可能藏着一个**已知**的冲突，
  // 那个冲突不该被「不完整」吞掉。
  const known = new Set(b.files);
  const sharedKnown = a.files.filter((x) => known.has(x));
  if (sharedKnown.length > 0) {
    return { state: "overlap", shared: sharedKnown, reason: `共享 ${sharedKnown.length} 个文件` };
  }

  // 没有已知冲突时，才轮到「能不能证明不相交」。
  if (!complete(a) || !complete(b)) {
    const pa = a.state === "partial";
    const pb = b.state === "partial";
    if (pa || pb) {
      const which = pa && pb ? "两边" : pa ? "左边" : "右边";
      const rest = [...a.unrecognized, ...b.unrecognized].slice(0, 3).join(", ");
      return {
        state: "unproven",
        shared: [],
        reason: `${which}的落点**不完整**：还有未识别的路径（${rest}）。partial 不足以证明不相交。`,
      };
    }
  }

  if (!proven(a) || !proven(b)) {
    const which = !proven(a) && !proven(b) ? "两边" : !proven(a) ? "左边" : "右边";
    return {
      state: "unproven",
      shared: [],
      reason: `${which}的落点未知（正文无路径）。派前必须读代码定位，unproven 不等于 disjoint。`,
    };
  }
  return { state: "disjoint", shared: [], reason: "两边落点均已知且无共同文件" };
}

/**
 * 候选是不是这个 epic 自己的成员。
 *
 * `--mode all` 下已归 epic 的项也是候选，于是一个成员会与它**自己所属的** epic
 * 报出 overlap——那是同一份工作，不是两个 agent 会撞车。实测报告里
 * #5627/#5634/#5635 都是 #5560 的成员却被列成「撞 #5560」，让整份冲突清单不可用。
 */
export function isSelfMember(id: number, epicMembers: number[]): boolean {
  return epicMembers.includes(id);
}

/* ===== 缺陷层 ===== */

/**
 * 同层判据一句话：**两条能不能被同一个修复方向覆盖？**
 * 症状相同不足以同层——#5487「共享 worker 槽位」与 #4749「独占 heavy lease」
 * 症状同为并发争用，方向相反，捆一起会产出「既共享又独占」。
 * 所以 layer 是显式赋予的标签，本函数只做归一比较，绝不从症状词推断。
 */
export function sameLayer(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/* ===== 指纹与 ledger 增量 ===== */

export function fingerprint(body: string | null | undefined, labels: string[]): string {
  const h = createHash("sha256");
  h.update(typeof body === "string" ? body : "");
  h.update(" ");
  h.update([...labels].sort().join(","));
  return h.digest("hex").slice(0, 16);
}

export interface LedgerRecord {
  issue: number;
  fingerprint: string;
  classifiedAt: string;
  layer?: string | null;
  pathSurface?: string[];
  surfaceState?: SurfaceState;
  epic?: number | null;
  outcome?: string;
  exclusionReason?: string | null;
}

/** 与来源无关的最小工作项（见 source.ts 的 WorkItemSource）。 */
export interface WorkItemLite {
  number: number;
  body: string | null | undefined;
  labels: string[];
}

export interface Delta {
  /** 需要（重新）分类的 */
  toClassify: number[];
  /** ledger 里没有的全新条目 */
  fresh: number[];
  /** 指纹未变且未过 TTL，本轮跳过 —— 效率的全部来源 */
  skipped: number[];
}

export function ledgerDelta(
  issues: WorkItemLite[],
  ledger: LedgerRecord[],
  ttlDays: number,
  now: Date,
): Delta {
  const byIssue = new Map(ledger.map((r) => [r.issue, r]));
  const d: Delta = { toClassify: [], fresh: [], skipped: [] };
  for (const i of issues) {
    const rec = byIssue.get(i.number);
    if (!rec) {
      d.toClassify.push(i.number);
      d.fresh.push(i.number);
      continue;
    }
    const fpChanged = rec.fingerprint !== fingerprint(i.body, i.labels);
    const ageDays = (now.getTime() - new Date(rec.classifiedAt).getTime()) / 86_400_000;
    if (fpChanged || ageDays > ttlDays) d.toClassify.push(i.number);
    else d.skipped.push(i.number);
  }
  return d;
}

/** @deprecated 旧名，保留以免外部引用断裂。 */
export type IssueLite = WorkItemLite;
