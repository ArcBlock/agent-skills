/**
 * WorkItemSource —— 工作项从哪来的抽象。
 *
 * 本 skill 的判定核心（layer / 路径面 / 三态不相交 / ledger 增量）与来源无关。
 * 今天来自 GitHub issue；将来来自我们自己的 work object（arc #5540）。
 * 两个适配器过同一套 `source.conformance.test.ts`，与本仓 provider conformance 同构：
 * **换源不得静默改变行为。**
 *
 * ## 为什么这个抽象值得现在就做（效率，不只是整洁）
 *
 * GitHub 适配器**必须**把全部 open issue 拉下来再在本地过滤——`gh issue list` 的
 * label 过滤能收窄，但 epic 成员关系、认领状态、以及「上次 sweep 之后变了什么」
 * 都拿不到，只能全量 + client 过滤。这正是本仓 CLAUDE.md 点名的反模式
 * （「大集合列表自己做 client 过滤/翻页扫全量 → 用 collection query 下推」）。
 *
 * work object 落地后三件事同时变便宜：
 *
 * 1. **查询下推** —— `/.actions/query` 按 label / layer / 分类时间过滤，
 *    不再每轮拉 300+ 条正文。正文是本 skill 最大的读取成本（路径面要扫全文）。
 * 2. **分类是对象上的字段，不是旁路 ledger** —— `layer` / `pathSurface` /
 *    `surfaceState` 直接住在 work object 上。ledger 文件消失，
 *    「上次分类到哪」不再是本地状态，多机之间天然一致。
 * 3. **关系是边，不是 label** —— epic → 成员是真实关系，
 *    不用靠 `epic:<n>` 这种把编号编进字符串的约定去解析。
 *
 * 三条合起来把每轮 sweep 从「全量重扫」变成「只读变化的那几条」。
 *
 * ## 纪律：声明即配套
 *
 * `capabilities.pushdown` 声明了就必须真的在源侧过滤。用「取全量再本地 filter」
 * 的实现声明它，就是本仓反复踩的同色问题——conformance 里有一条断言专门测这个。
 * 做不到就**不要声明**，fail-closed，别退化成「假装下推」。
 */

export interface WorkItem {
  /** 稳定标识。GitHub 下是 issue 号；work object 下是其数值 id。 */
  id: number;
  title: string;
  body: string | null;
  labels: string[];
}

export interface ListQuery {
  state: "open" | "closed" | "all";
  withLabels?: string[];
  withoutLabels?: string[];
  /** 只要这个时刻之后有变化的（work object 下可下推；GitHub 下只能近似）。 */
  changedSince?: Date;
  limit?: number;
}

export interface TimedRow {
  id: number;
  labels: string[];
  createdAt: string;
  closedAt: string | null;
}

export interface NeighborSignal {
  closedNeighbors: number[];
  unblockedBy: number[];
}

export interface SourceCapabilities {
  /** 过滤是否在源侧完成（而不是取全量再本地 filter）。 */
  pushdown: boolean;
  /** 能否按「上次之后变了什么」增量拉取。 */
  incremental: boolean;
  /** 分类结果能否写回工作项本身（而不是旁路 ledger 文件）。 */
  writableClassification: boolean;
  /** 能否给出邻域变化信号（邻居关闭 / 被解锁）。false = 只能看见自身变化。 */
  neighborhood: boolean;
}

export interface WorkItemSource {
  list(q: ListQuery): Promise<WorkItem[]>;
  /** 被在飞工作（PR / change set）认领的 id —— G5 用。 */
  claimedIds(): Promise<Set<number>>;
  /** epic id -> 成员 id[]。 */
  epicMembers(): Promise<Map<number, number[]>>;
  /**
   * 概览页要的带时间戳的项（含**已关闭**的）。
   * 画流量/存量图必须有 `closedAt`，而 `list({state:"open"})` 拿不到。
   * GitHub 下这是额外一次昂贵拉取（closed 项很多，要限量）；
   * work object 下是一次带时间范围的查询——这也是它的具体优势之一。
   */
  timeline?(sinceDays: number): Promise<TimedRow[]>;
  /**
   * 邻域变化：近窗口内关闭的邻居、被解锁的项。
   * GitHub 下由 issue-graph 的 `graph-scan.ts` 供给（kicks / blocked 计算）；
   * work object 下直接读关系边，且可按 `changedSince` 下推。
   * 不支持就返回空 Map —— 但那意味着**只能看见自身变化**，
   * 「邻居合了导致旧分类不成立」这一类会整类漏掉。
   */
  neighborhood?(sinceHours: number): Promise<Map<number, NeighborSignal>>;
  capabilities?: SourceCapabilities;
  /** 上一次 list 实际从后端读了多少条（conformance 用它验证下推声明是否诚实）。 */
  lastReadCount?: number;
}

export function capabilitiesOf(s: WorkItemSource): SourceCapabilities {
  return (
    s.capabilities ?? {
      pushdown: false,
      incremental: false,
      writableClassification: false,
      neighborhood: false,
    }
  );
}

/* ===== 内存源：conformance 的参照实现，也用于测试 ===== */

export class MemoryWorkItemSource implements WorkItemSource {
  lastReadCount = 0;
  readonly capabilities: SourceCapabilities = {
    pushdown: false,
    incremental: false,
    writableClassification: false,
    neighborhood: false,
  };
  constructor(private items: WorkItem[]) {}

  async list(q: ListQuery): Promise<WorkItem[]> {
    this.lastReadCount = this.items.length; // 诚实：全量读
    let r = this.items;
    if (q.withLabels?.length) r = r.filter((i) => q.withLabels!.every((l) => i.labels.includes(l)));
    if (q.withoutLabels?.length)
      r = r.filter((i) => !q.withoutLabels!.some((l) => i.labels.includes(l)));
    return q.limit ? r.slice(0, q.limit) : r;
  }

  async claimedIds(): Promise<Set<number>> {
    return new Set();
  }

  async epicMembers(): Promise<Map<number, number[]>> {
    const m = new Map<number, number[]>();
    for (const i of this.items) {
      for (const l of i.labels) {
        const g = l.match(/^epic:(\d+)$/);
        if (g) m.set(Number(g[1]), [...(m.get(Number(g[1])) ?? []), i.id]);
      }
    }
    return m;
  }
}

/**
 * 从一个 PR 推出它**认领**了哪些工作项。
 *
 * 判据按权威性排序，不是「正文里出现过 #N」——
 * 一个「参考 #1234 的做法」的 PR 会把 #1234 从批量里压掉，那不是认领。
 * （Codex 在 #5628 的评审里指出，成立。）
 *
 * 1. `closingIssuesReferences` —— GitHub 自己解析的闭合引用，最权威
 * 2. 确定性分支名 `claude/issue-<N>`（+ `-p<phase>`）—— 本仓的认领约定
 * 3. 正文里的 `Fixes #N` / `Part of #N` —— 显式声明
 */
export function claimsFromPr(pr: {
  headRefName: string;
  body: string | null;
  closing?: number[];
}): number[] {
  if (pr.closing?.length) return [...new Set(pr.closing)].sort((a, b) => a - b);
  const out = new Set<number>();
  const br = /(?:^|[-/])issue-(\d{3,6})(?:[-/]|$)/.exec(pr.headRefName);
  if (br) out.add(Number(br[1]));
  for (const m of (pr.body ?? "").matchAll(
    /\b(?:Fixes|Closes|Resolves|Part of)\s+#(\d{3,6})\b/gi,
  )) {
    out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

/* ===== GitHub 适配器 ===== */

function gh(a: string[]): string {
  const p = Bun.spawnSync(["gh", ...a], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`gh ${a.slice(0, 3).join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
}

export class GitHubIssueSource implements WorkItemSource {
  lastReadCount = 0;
  /**
   * pushdown=false 是**诚实的自述**，不是待办。
   * `gh issue list --label` 能收窄一部分，但本 skill 需要的是
   * 「label + 认领状态 + epic 关系 + 变更时间」的联合过滤，GitHub 侧给不出，
   * 所以实现取全量再本地过滤。声明 true 会让 conformance 的诚实臂变红。
   */
  readonly capabilities: SourceCapabilities = {
    pushdown: false,
    incremental: false,
    writableClassification: false,
    // issue-graph 的 graph-scan.ts 能算 kicks/blocked，但那是**另一个 skill 的脚本**，
    // 本源不自带；接线是 SKILL.md Step 1.5 的事。声明 false 是诚实的。
    neighborhood: false,
  };
  private cache: GhIssue[] | null = null;

  constructor(private repo: string) {}

  private all(state: string): GhIssue[] {
    if (this.cache) return this.cache;
    this.cache = JSON.parse(
      gh([
        "issue",
        "list",
        "-R",
        this.repo,
        "--state",
        state,
        "--limit",
        "500",
        "--json",
        "number,title,body,labels",
      ]),
    ) as GhIssue[];
    this.lastReadCount = this.cache.length;
    return this.cache;
  }

  async list(q: ListQuery): Promise<WorkItem[]> {
    let r = this.all(q.state).map((i) => ({
      id: i.number,
      title: i.title,
      body: i.body,
      labels: i.labels.map((l) => l.name),
    }));
    if (q.withLabels?.length) r = r.filter((i) => q.withLabels!.every((l) => i.labels.includes(l)));
    if (q.withoutLabels?.length)
      r = r.filter((i) => !q.withoutLabels!.some((l) => i.labels.includes(l)));
    return q.limit ? r.slice(0, q.limit) : r;
  }

  async claimedIds(): Promise<Set<number>> {
    const prs: {
      headRefName: string;
      body: string | null;
      closingIssuesReferences?: { nodes?: { number: number }[] };
    }[] = JSON.parse(
      gh([
        "pr",
        "list",
        "-R",
        this.repo,
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "number,headRefName,body,closingIssuesReferences",
      ]),
    );
    const s = new Set<number>();
    for (const p of prs) {
      const closing = p.closingIssuesReferences?.nodes?.map((n) => n.number);
      for (const id of claimsFromPr({ headRefName: p.headRefName, body: p.body, closing })) {
        s.add(id);
      }
    }
    return s;
  }

  async timeline(sinceDays: number): Promise<TimedRow[]> {
    // open 全量 + closed 限量。closed 用 --search 按更新时间收窄，
    // 这是 GitHub 侧能做到的最好收窄；仍然比 work object 的时间范围查询贵得多。
    const rows: TimedRow[] = [];
    const grab = (state: string, extra: string[]) => {
      const raw = gh([
        "issue",
        "list",
        "-R",
        this.repo,
        "--state",
        state,
        "--limit",
        "800",
        "--json",
        "number,labels,createdAt,closedAt",
        ...extra,
      ]);
      for (const i of JSON.parse(raw) as {
        number: number;
        labels: { name: string }[];
        createdAt: string;
        closedAt: string | null;
      }[]) {
        rows.push({
          id: i.number,
          labels: i.labels.map((l) => l.name),
          createdAt: i.createdAt,
          closedAt: i.closedAt,
        });
      }
    };
    grab("open", []);
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
    grab("closed", ["--search", `closed:>=${since}`]);
    return rows;
  }

  async epicMembers(): Promise<Map<number, number[]>> {
    const m = new Map<number, number[]>();
    for (const i of this.all("open")) {
      for (const l of i.labels) {
        const g = l.name.match(/^epic:(\d+)$/);
        if (g) m.set(Number(g[1]), [...(m.get(Number(g[1])) ?? []), i.number]);
      }
    }
    return m;
  }
}

/* ===== work object 适配器（arc #5540）===== */

/**
 * 契约已写死，实现等 work object 落地。
 *
 * **刻意 fail-closed，不给可运行的假实现。** 本仓纪律：「声明某能力却无法在任何地方
 * 跑通它的 accept path，就不要声明」。一个返回空数组的桩会让 conformance 的
 * ACCEPT 臂无法区分「源是空的」和「源坏了」——正是本 skill 要防的同色问题。
 *
 * 落地时要兑现的三条（对应上面注释里的效率论证）：
 *
 * 1. `list()` 走 `/.actions/query` 下推 label / layer / changedSince，
 *    **并把 `capabilities.pushdown` 翻成 true** —— conformance 的诚实臂会验它。
 * 2. `classify()` 把 `layer` / `pathSurface` / `surfaceState` 写回 work object 本身，
 *    `writableClassification: true`，ledger 文件随之退役。
 * 3. `epicMembers()` 读真实关系边，不再解析 `epic:<n>` 字符串。
 *
 * 所有 I/O 必须走 AFS API（`afs.read` / `afs.list` / `afs.exec`），不得直连后端——
 * 见仓库根 CLAUDE.md「AFS-Only I/O」第一原则。
 */
export class WorkObjectSource implements WorkItemSource {
  readonly capabilities: SourceCapabilities = {
    pushdown: true,
    incremental: true,
    writableClassification: true,
    // 关系是边，邻域变化是一次图查询 —— 不用像 GitHub 那样靠另一个 skill 补算。
    neighborhood: true,
  };
  private fail(): never {
    throw new Error(
      "WorkObjectSource 尚未实现：work object（arc #5540）落地前不可用。" +
        "契约见本文件注释；不要用返回空集的桩代替——那会让 conformance 的 ACCEPT 臂失效。",
    );
  }
  async list(): Promise<WorkItem[]> {
    this.fail();
  }
  async claimedIds(): Promise<Set<number>> {
    this.fail();
  }
  async epicMembers(): Promise<Map<number, number[]>> {
    this.fail();
  }
}
