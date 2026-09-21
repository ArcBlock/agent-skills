/**
 * WorkItemSource —— 工作项从哪来的抽象。
 *
 * 本 skill 的判定核心（layer / 路径面 / 三态不相交 / ledger 增量）与来源无关。
 * 默认是 `WorkObjectSource`（arc #6000 / #5540）；`--source github` 是 opt-in 投影 alias。
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

/** Same codes as `@aigne/afs` — local copies so the plugin does not import that package. */
export class AFSNotFoundError extends Error {
  readonly code = "AFS_NOT_FOUND";
  readonly path: string;
  constructor(path: string, message?: string) {
    super(message || `Path not found: ${path}`);
    this.name = "AFSNotFoundError";
    this.path = path;
  }
}

export class AFSValidationError extends Error {
  readonly code = "AFS_VALIDATION_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "AFSValidationError";
  }
}

export class AFSUnsupportedError extends Error {
  readonly code = "AFS_UNSUPPORTED";
  readonly operation: string;
  constructor(operation: string, message?: string) {
    super(message || `Operation not supported: ${operation}`);
    this.name = "AFSUnsupportedError";
    this.operation = operation;
  }
}

function joinURL(base: string, segment: string): string {
  return `${base.replace(/\/+$/, "")}/${segment.replace(/^\/+/, "")}`;
}

/** Injected AFS-shaped surface. Same contract as `@aigne/aos` WorkLedgerOps. */
export interface WorkLedgerOps {
  read(path: string): Promise<{ data?: { content?: unknown; meta?: unknown } | null }>;
  readMany(paths: string[]): Promise<Map<string, { content?: unknown } | null>>;
  write(
    path: string,
    payload: { content?: unknown; meta?: Record<string, unknown> },
    options?: { ifMatch?: string },
  ): Promise<{ data?: { path?: string; meta?: unknown } }>;
  exec(path: string, args: Record<string, unknown>): Promise<{ success?: boolean; data?: unknown }>;
}

export const WORK_OBJECT_ROOT = "/work";

/** Same pattern as `@aigne/aos` WORK_ID_RE — local copy so the plugin does not import that package. */
export const WORK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Sweep-batch `--source` default after factory cutover (#6000). GitHub is opt-in. */
export const DEFAULT_SWEEP_SOURCE = "work-object";

function workRecordPath(root: string, id: string): string {
  if (!WORK_ID_RE.test(id)) {
    throw new AFSValidationError(`work id must be a single safe path segment, got "${id}"`);
  }
  return joinURL(root, `${id}.json`);
}

export interface WorkItem {
  /** 稳定标识。GitHub 下是 issue 号的十进制字符串；work object 下是 `w_<32hex>` path stem。禁止把 DID 哈希成 number。 */
  id: string;
  title: string;
  body: string | null;
  labels: string[];
  /** Present when the source stores classification on the work record itself. */
  layer?: string | null;
  fingerprint?: string;
  classifiedAt?: string;
  /** Canonical work DID when present. Roundtrips through list(); never hashed to number. */
  objectId?: string;
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
  id: string;
  labels: string[];
  createdAt: string;
  closedAt: string | null;
}

export interface NeighborSignal {
  closedNeighbors: string[];
  unblockedBy: string[];
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

export interface WorkClassification {
  layer: string | null;
  pathSurface: string[];
  surfaceState: string;
  fingerprint?: string;
  classifiedAt?: string;
  epic?: string | null;
}

export interface WorkItemSource {
  list(q: ListQuery): Promise<WorkItem[]>;
  /** 被在飞工作（PR / change set）认领的 id —— G5 用。 */
  claimedIds(): Promise<Set<string>>;
  /** epic id -> 成员 id[]。 */
  epicMembers(): Promise<Map<string, string[]>>;
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
  neighborhood?(sinceHours: number): Promise<Map<string, NeighborSignal>>;
  capabilities?: SourceCapabilities;
  /** 上一次 list 实际从后端读了多少条（conformance 用它验证下推声明是否诚实）。 */
  lastReadCount?: number;
  /**
   * 把分类写回工作项本身（ifMatch）。只有 `writableClassification` 源实现。
   * 写路径的调用点在 sweep-batch.ts。
   */
  writeClassification?(id: string, patch: WorkClassification): Promise<void>;
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

  async claimedIds(): Promise<Set<string>> {
    return new Set();
  }

  async epicMembers(): Promise<Map<string, string[]>> {
    const m = new Map<string, string[]>();
    for (const i of this.items) {
      for (const l of i.labels) {
        const g = l.match(/^epic:(\d+)$/);
        if (g?.[1]) m.set(g[1], [...(m.get(g[1]) ?? []), i.id]);
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
  closing?: Array<number | string>;
}): string[] {
  const cmp = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
  if (pr.closing?.length) return [...new Set(pr.closing.map(String))].sort(cmp);
  const out = new Set<string>();
  const br = /(?:^|[-/])issue-(\d{3,6})(?:[-/]|$)/.exec(pr.headRefName);
  if (br?.[1]) out.add(br[1]);
  for (const m of (pr.body ?? "").matchAll(
    /\b(?:Fixes|Closes|Resolves|Part of)\s+#(\d{3,6})\b/gi,
  )) {
    if (m[1]) out.add(m[1]);
  }
  return [...out].sort(cmp);
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
      id: String(i.number),
      title: i.title,
      body: i.body,
      labels: i.labels.map((l) => l.name),
    }));
    if (q.withLabels?.length) r = r.filter((i) => q.withLabels!.every((l) => i.labels.includes(l)));
    if (q.withoutLabels?.length)
      r = r.filter((i) => !q.withoutLabels!.some((l) => i.labels.includes(l)));
    return q.limit ? r.slice(0, q.limit) : r;
  }

  async claimedIds(): Promise<Set<string>> {
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
    const s = new Set<string>();
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
          id: String(i.number),
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

  async epicMembers(): Promise<Map<string, string[]>> {
    const m = new Map<string, string[]>();
    for (const i of this.all("open")) {
      for (const l of i.labels) {
        const g = l.name.match(/^epic:(\d+)$/);
        if (g?.[1]) m.set(g[1], [...(m.get(g[1]) ?? []), String(i.number)]);
      }
    }
    return m;
  }
}

/* ===== 成员资格：label 约定 vs 真实边 ===== */

export type MembershipMode = "labels" | "edges";

export function membershipMode(source: string): MembershipMode {
  return source === "work-object" || source.startsWith("work-object:") ? "edges" : "labels";
}

export function isInEpic(
  id: string,
  labels: string[],
  epicMembers: Map<string, string[]>,
  mode: MembershipMode,
): boolean {
  if (mode === "edges") {
    for (const members of epicMembers.values()) {
      if (members.includes(id)) return true;
    }
    return false;
  }
  return labels.some((x) => /^epic:\d+$/.test(x));
}

export function epicIdOf(
  id: string,
  labels: string[],
  epicMembers: Map<string, string[]>,
  mode: MembershipMode,
): string | null {
  if (mode === "edges") {
    for (const [epic, members] of epicMembers) {
      if (members.includes(id)) return epic;
    }
    return null;
  }
  const hit = labels.find((l) => /^epic:\d+$/.test(l));
  return hit ? hit.slice("epic:".length) : null;
}

/* ===== work object 适配器（arc #5540 / #5943）===== */

const OPEN_STATUSES = ["idea", "planned", "active", "blocked"];
const CLOSED_STATUSES = ["done", "dropped"];
/** Query page and `readMany` chunk size. Same 200 as aos work-ledger paging. */
export const WORK_QUERY_PAGE = 200;
const QUERY_PAGE = WORK_QUERY_PAGE;

type QueryEntry = {
  path?: string;
  content?: unknown;
  meta?: Record<string, unknown>;
};

function parseRecord(content: unknown): Record<string, unknown> | undefined {
  let value = content;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function versionOf(meta: unknown): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const m = meta as { version?: unknown; cid?: unknown };
  if (typeof m.version === "string" && m.version) return m.version;
  if (typeof m.cid === "string" && m.cid) return m.cid;
  return undefined;
}

function idOfPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.endsWith(".json") ? base.slice(0, -".json".length) : base;
}

function labelsOf(record: Record<string, unknown>): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string" || !value || seen.has(value)) return;
    seen.add(value);
    labels.push(value);
  };
  if (Array.isArray(record.keywords)) {
    for (const k of record.keywords) add(k);
  }
  add(record.kind);
  add(record.workType);
  return labels;
}

function workIsClosed(record?: Record<string, unknown>, meta?: Record<string, unknown>): boolean {
  const status =
    (typeof meta?.creativeWorkStatus === "string" && meta.creativeWorkStatus) ||
    (typeof record?.creativeWorkStatus === "string" && record.creativeWorkStatus) ||
    "";
  if ((CLOSED_STATUSES as readonly string[]).includes(status)) return true;
  const closedAt =
    (typeof record?.closedAt === "string" && record.closedAt) ||
    (typeof meta?.closedAt === "string" && meta.closedAt) ||
    "";
  return closedAt.length > 0;
}

/** True when meta alone proves the row cannot fall inside a timeline `since` window. */
function timelineMetaOutsideWindow(
  meta: Record<string, unknown> | undefined,
  since: number,
): boolean {
  if (!meta) return false;
  const closedAt = typeof meta.closedAt === "string" ? meta.closedAt : null;
  if (!closedAt) return false;
  const closedMs = Date.parse(closedAt);
  if (!Number.isFinite(closedMs) || closedMs >= since) return false;
  const createdAt =
    typeof meta.dateCreated === "string" ? meta.dateCreated : new Date(0).toISOString();
  const createdMs = Date.parse(createdAt);
  return Number.isFinite(createdMs) && createdMs < since;
}

type HydratedSlot = {
  entry: QueryEntry;
  record?: Record<string, unknown>;
  missing: boolean;
};

export const CHANGE_SET_WORK_TYPE = "change-set";

function isChangeSet(record?: Record<string, unknown>, meta?: Record<string, unknown>): boolean {
  return record?.workType === CHANGE_SET_WORK_TYPE || meta?.workType === CHANGE_SET_WORK_TYPE;
}

function objectIdOf(
  record?: Record<string, unknown>,
  meta?: Record<string, unknown>,
): string | undefined {
  if (typeof record?.objectId === "string" && record.objectId) return record.objectId;
  if (typeof meta?.objectId === "string" && meta.objectId) return meta.objectId;
  return undefined;
}

/** GitHub PR projection URL — the WorkObject analog of `gh pr list --state open`. */
export function isProjectedPullUrl(url: string): boolean {
  return /\/pull\/\d+(?:$|[/?#])/i.test(url.trim());
}

function toWorkItem(
  path: string,
  record: Record<string, unknown>,
  meta?: Record<string, unknown>,
): WorkItem {
  const objectId = objectIdOf(record, meta);
  return {
    id: idOfPath(path),
    title: typeof record.name === "string" ? record.name : "",
    body: typeof record.description === "string" ? record.description : null,
    labels: labelsOf(record),
    layer: record.layer === null || typeof record.layer === "string" ? record.layer : undefined,
    fingerprint: typeof record.fingerprint === "string" ? record.fingerprint : undefined,
    classifiedAt: typeof record.classifiedAt === "string" ? record.classifiedAt : undefined,
    ...(objectId ? { objectId } : {}),
  };
}

function whereAll(clauses: Array<Record<string, unknown>>): Record<string, unknown> {
  if (clauses.length === 1) return clauses[0]!;
  return { all: clauses };
}

/**
 * `list()` 走 `/.actions/query` 下推；`epicMembers()` 读 `r_*` `member-of` 边；
 * 分类写回走 ifMatch。AFS 不可用必须 throw，不得返回 `[]`。
 *
 * 所有 I/O 走注入的 {@link WorkLedgerOps}（AFS-shaped）。sweep-batch 默认用
 * {@link createArcAfsWorkLedgerOps}（`arc afs`），禁止裸 fetch。
 */
export class WorkObjectSource implements WorkItemSource {
  lastReadCount = 0;
  readonly capabilities: SourceCapabilities = {
    pushdown: true,
    incremental: true,
    writableClassification: true,
    neighborhood: true,
  };
  /** DID → path-stem, filled during `list()` and reused by `idForDid`. */
  private readonly idByDid = new Map<string, { id: string; closed: boolean } | undefined>();

  constructor(
    private readonly ops: WorkLedgerOps,
    private readonly root: string = WORK_OBJECT_ROOT,
  ) {
    if (
      !ops ||
      typeof ops.exec !== "function" ||
      typeof ops.read !== "function" ||
      typeof ops.readMany !== "function"
    ) {
      throw new AFSValidationError(
        "WorkObjectSource requires an injected WorkLedgerOps (AFS read/readMany/write/exec); do not construct without a backend",
      );
    }
  }

  async list(q: ListQuery): Promise<WorkItem[]> {
    const clauses: Array<Record<string, unknown>> = [{ field: "meta.contentType", eq: "work" }];
    if (q.state === "open") {
      clauses.push({ field: "meta.creativeWorkStatus", in: OPEN_STATUSES });
    } else if (q.state === "closed") {
      clauses.push({ field: "meta.creativeWorkStatus", in: CLOSED_STATUSES });
    }
    if (q.withLabels?.length) {
      for (const label of q.withLabels) {
        clauses.push({ field: "meta.keywords", contains: label });
      }
    }
    if (q.changedSince) {
      // WHERE `mtime` compiles to content-JSON `$.mtime`, which work records
      // do not have. Query the stamped metadata field (ISO 8601; lex-ordered).
      clauses.push({ field: "meta.dateModified", gte: q.changedSince.toISOString() });
    }
    // `withoutLabels` is client-side (no NOT-contains in the dialect), so a
    // server-side `limit` would slice the pre-filter set and under-fill.
    const queryLimit = q.withoutLabels?.length ? undefined : q.limit;
    const entries = await this.queryEntries(whereAll(clauses), queryLimit);
    const items: WorkItem[] = [];
    let missingCount = 0;
    for (const slot of await this.hydrateEntries(entries)) {
      if (typeof slot.entry.path !== "string") continue;
      if (slot.missing) {
        missingCount += 1;
        continue;
      }
      const parsed = this.requireWorkRecord(slot.entry.path, slot.record);
      // Change Sets are products of in-flight work, not dispatch candidates.
      // claimedIds still queries them to mark the parent claimed.
      if (isChangeSet(parsed, slot.entry.meta)) continue;
      items.push(toWorkItem(slot.entry.path, parsed, slot.entry.meta));
      const objectId = objectIdOf(parsed, slot.entry.meta);
      if (objectId) {
        this.idByDid.set(objectId, {
          id: idOfPath(slot.entry.path),
          closed: workIsClosed(parsed, slot.entry.meta),
        });
      }
    }
    if (items.length === 0 && missingCount > 0) {
      throw new AFSValidationError(
        `work-object query on ${this.root} returned ${missingCount} row(s) whose bodies are missing; refusing to treat this as 0 items`,
      );
    }
    this.lastReadCount = items.length;
    let r = items;
    if (q.withoutLabels?.length) {
      r = r.filter((i) => !q.withoutLabels!.some((l) => i.labels.includes(l)));
    }
    return q.limit ? r.slice(0, q.limit) : r;
  }

  async claimedIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    const active = await this.queryEntries(
      whereAll([
        { field: "meta.contentType", eq: "work" },
        { field: "meta.creativeWorkStatus", eq: "active" },
      ]),
    );
    for (const entry of active) {
      if (typeof entry.path === "string") ids.add(idOfPath(entry.path));
    }
    // Claimed-via-PR: GitHubIssueSource treated an open pull as a claim
    // (claimsFromPr). A Change Set with a pull sourceUrl is that projection;
    // its parent work is claimed. No silent color change vs the GitHub source.
    const changeSets = await this.queryEntries(
      whereAll([
        { field: "meta.contentType", eq: "work" },
        { field: "meta.workType", eq: "change-set" },
      ]),
    );
    const csDids = new Set<string>();
    for (const slot of await this.hydrateEntries(changeSets)) {
      if (slot.missing || typeof slot.entry.path !== "string") continue;
      const parsed = slot.record;
      if (workIsClosed(parsed, slot.entry.meta)) continue;
      const url =
        (typeof parsed?.sourceUrl === "string" && parsed.sourceUrl) ||
        (typeof slot.entry.meta?.sourceUrl === "string" && slot.entry.meta.sourceUrl) ||
        "";
      if (!isProjectedPullUrl(url)) continue;
      const did = objectIdOf(parsed, slot.entry.meta);
      if (did) csDids.add(did);
    }
    if (csDids.size === 0) return ids;
    const edges = await this.queryEntries({
      field: "meta.predicate",
      in: ["spun-off-from", "member-of"],
    });
    const parentDids: string[] = [];
    for (const entry of edges) {
      const meta = entry.meta ?? {};
      const subjectDid = typeof meta.subjectDid === "string" ? meta.subjectDid : undefined;
      const objectDid = typeof meta.objectDid === "string" ? meta.objectDid : undefined;
      if (!subjectDid || !objectDid || !csDids.has(subjectDid)) continue;
      parentDids.push(objectDid);
    }
    await this.ensureRefs(parentDids);
    for (const did of parentDids) {
      const ref = this.idByDid.get(did);
      if (ref && !ref.closed) ids.add(ref.id);
    }
    return ids;
  }

  async epicMembers(): Promise<Map<string, string[]>> {
    const entries = await this.queryEntries({
      field: "meta.predicate",
      eq: "member-of",
    });
    const pairs: Array<{ subjectDid: string; objectDid: string }> = [];
    const dids: string[] = [];
    for (const entry of entries) {
      const meta = entry.meta ?? {};
      const subjectDid = typeof meta.subjectDid === "string" ? meta.subjectDid : undefined;
      const objectDid = typeof meta.objectDid === "string" ? meta.objectDid : undefined;
      if (!subjectDid || !objectDid) continue;
      pairs.push({ subjectDid, objectDid });
      dids.push(subjectDid, objectDid);
    }
    await this.ensureRefs(dids);
    const m = new Map<string, string[]>();
    for (const { subjectDid, objectDid } of pairs) {
      const member = this.idByDid.get(subjectDid);
      const epic = this.idByDid.get(objectDid);
      if (!member || !epic || member.closed || epic.closed) continue;
      m.set(epic.id, [...(m.get(epic.id) ?? []), member.id]);
    }
    return m;
  }

  /**
   * Windowed open+closed rows for the overview charts.
   *
   * Collection-query is AND-only (no OR), so the window is a **union of AND
   * queries**, not one `{ contentType=work }` plus a client filter.
   *
   * DID Space file-form evaluates **content** fields only from the ≤2KiB inline
   * cache. `workStatusMeta` / `completeWork` stamp `creativeWorkStatus` and
   * `dateModified` on meta, not `closedAt` / `dateCreated`. Fat closed GitHub
   * imports therefore miss every content-`closedAt` arm — that looks collected
   * with false zero-closes, the same color as 未采集. Window predicates here
   * are **meta-only**; hydrate then client-filters `closedAt`.
   *
   * `sinceDays=0` is an empty window (collected `[]`, no I/O) — not 未采集
   * (method absent) and not “all currently open”.
   */
  async timeline(sinceDays: number): Promise<TimedRow[]> {
    if (!Number.isFinite(sinceDays) || sinceDays < 0) {
      throw new AFSValidationError(
        `timeline sinceDays must be a non-negative finite number, got ${String(sinceDays)}`,
      );
    }
    if (sinceDays === 0) {
      this.lastReadCount = 0;
      return [];
    }
    const since = Date.now() - sinceDays * 86_400_000;
    const sinceIso = new Date(since).toISOString();
    const work = { field: "meta.contentType", eq: "work" };
    const pages = await Promise.all([
      this.queryEntries(whereAll([work, { field: "meta.creativeWorkStatus", in: OPEN_STATUSES }])),
      // Fat-safe closed window: status + dateModified live on meta (workStatusMeta).
      this.queryEntries(
        whereAll([
          work,
          { field: "meta.creativeWorkStatus", in: CLOSED_STATUSES },
          { field: "meta.dateModified", gte: sinceIso },
        ]),
      ),
      // When writers stamp meta.closedAt / meta.dateCreated (#6329).
      this.queryEntries(whereAll([work, { field: "meta.closedAt", gte: sinceIso }])),
      this.queryEntries(whereAll([work, { field: "meta.dateCreated", gte: sinceIso }])),
    ]);
    const seen = new Set<string>();
    const entries: QueryEntry[] = [];
    for (const page of pages) {
      for (const entry of page) {
        if (typeof entry.path !== "string" || seen.has(entry.path)) continue;
        seen.add(entry.path);
        entries.push(entry);
      }
    }
    this.lastReadCount = entries.length;
    const candidates = entries.filter((entry) => !timelineMetaOutsideWindow(entry.meta, since));
    const rows: TimedRow[] = [];
    for (const slot of await this.hydrateEntries(candidates)) {
      if (typeof slot.entry.path !== "string") continue;
      if (slot.missing) continue;
      const parsed = this.requireWorkRecord(slot.entry.path, slot.record);
      const createdAt =
        typeof parsed.dateCreated === "string"
          ? parsed.dateCreated
          : typeof slot.entry.meta?.dateCreated === "string"
            ? slot.entry.meta.dateCreated
            : new Date(0).toISOString();
      const closedAt =
        typeof parsed.closedAt === "string"
          ? parsed.closedAt
          : typeof slot.entry.meta?.closedAt === "string"
            ? slot.entry.meta.closedAt
            : null;
      const createdMs = Date.parse(createdAt);
      const closedMs = closedAt ? Date.parse(closedAt) : null;
      if (closedMs != null && closedMs < since && createdMs < since) continue;
      rows.push({
        id: idOfPath(slot.entry.path),
        labels: labelsOf(parsed),
        createdAt,
        closedAt,
      });
    }
    return rows;
  }

  async neighborhood(sinceHours: number): Promise<Map<string, NeighborSignal>> {
    const since = Date.now() - sinceHours * 3_600_000;
    const entries = await this.queryEntries({
      field: "meta.predicate",
      in: ["blocks", "blocked-by"],
    });
    const out = new Map<string, NeighborSignal>();
    const signal = (id: string): NeighborSignal => {
      const existing = out.get(id);
      if (existing) return existing;
      const created = { closedNeighbors: [] as string[], unblockedBy: [] as string[] };
      out.set(id, created);
      return created;
    };
    for (const entry of entries) {
      const meta = entry.meta ?? {};
      const predicate = meta.predicate;
      const subjectDid = typeof meta.subjectDid === "string" ? meta.subjectDid : undefined;
      const objectDid = typeof meta.objectDid === "string" ? meta.objectDid : undefined;
      if (!subjectDid || !objectDid) continue;
      const subjectId = await this.idForDid(subjectDid);
      const objectId = await this.idForDid(objectDid);
      if (!subjectId || !objectId) continue;
      const objectRecord = await this.readWork(objectId);
      const closedAt =
        objectRecord && typeof objectRecord.closedAt === "string"
          ? Date.parse(objectRecord.closedAt)
          : Number.NaN;
      if (!Number.isFinite(closedAt) || closedAt < since) continue;
      signal(subjectId).closedNeighbors.push(objectId);
      if (predicate === "blocked-by") signal(subjectId).unblockedBy.push(objectId);
    }
    return out;
  }

  async writeClassification(id: string, patch: WorkClassification): Promise<void> {
    const path = workRecordPath(this.root, id);
    const read = await this.ops.read(path);
    const record = parseRecord(read.data?.content);
    if (!record) throw new AFSNotFoundError(path, `no work record at ${path}`);
    const token = versionOf(read.data?.meta);
    if (!token) {
      throw new AFSUnsupportedError(
        "work-object.classify",
        `work object backend exposes no meta.version/meta.cid for ${path}; cannot write classification without ifMatch`,
      );
    }
    const updated: Record<string, unknown> = {
      ...record,
      layer: patch.layer,
      pathSurface: patch.pathSurface,
      surfaceState: patch.surfaceState,
    };
    if (patch.fingerprint !== undefined) updated.fingerprint = patch.fingerprint;
    if (patch.classifiedAt !== undefined) {
      updated.classifiedAt = patch.classifiedAt;
      updated.dateModified = patch.classifiedAt;
    }
    if (patch.epic !== undefined) updated.epic = patch.epic;
    const meta: Record<string, unknown> = {
      contentType: "work",
      creativeWorkStatus: String(updated.creativeWorkStatus ?? ""),
      keywords: labelsOf(updated),
      layer: patch.layer,
      surfaceState: patch.surfaceState,
    };
    if (typeof updated.dateModified === "string") meta.dateModified = updated.dateModified;
    else if (typeof updated.dateCreated === "string") meta.dateModified = updated.dateCreated;
    if (typeof updated.objectId === "string") meta.objectId = updated.objectId;
    if (typeof updated.workType === "string") meta.workType = updated.workType;
    await this.ops.write(path, { content: updated, meta }, { ifMatch: token });
    const reloaded = parseRecord((await this.ops.read(path)).data?.content);
    if (!reloaded) {
      throw new AFSValidationError(`classification write at ${path} did not persist a work record`);
    }
    if (reloaded.layer !== patch.layer) {
      throw new AFSValidationError(
        `classification write at ${path} did not persist layer (wrote ${JSON.stringify(patch.layer)}, read ${JSON.stringify(reloaded.layer)})`,
      );
    }
    if (patch.fingerprint !== undefined && reloaded.fingerprint !== patch.fingerprint) {
      throw new AFSValidationError(`classification write at ${path} did not persist fingerprint`);
    }
  }

  private async queryEntries(
    where: Record<string, unknown>,
    limit?: number,
  ): Promise<QueryEntry[]> {
    const out: QueryEntry[] = [];
    let cursor: string | undefined;
    const pageLimit = Math.min(limit ?? QUERY_PAGE, QUERY_PAGE);
    for (;;) {
      const args: Record<string, unknown> = {
        path: this.root,
        where,
        orderBy: [["ctime", "asc"]],
        limit: pageLimit,
      };
      if (cursor) args.cursor = cursor;
      const page = await this.execQuery(args);
      out.push(...page.entries);
      if (limit != null && out.length >= limit) return out.slice(0, limit);
      if (!page.cursor || page.cursor === cursor || page.entries.length === 0) return out;
      cursor = page.cursor;
    }
  }

  private async execQuery(
    args: Record<string, unknown>,
  ): Promise<{ entries: QueryEntry[]; cursor?: string }> {
    const res = await this.ops.exec("/.actions/query", args);
    const data = res.data as { entries?: unknown; cursor?: unknown } | undefined;
    if (res.success !== true || !Array.isArray(data?.entries)) {
      throw new AFSValidationError(
        `work-object query on ${this.root} failed (AFS unavailable or unexpected shape); refusing to treat this as 0 items`,
      );
    }
    const entries: QueryEntry[] = [];
    for (const raw of data.entries) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as QueryEntry;
      if (typeof entry.path === "string") entries.push(entry);
    }
    const cursor = typeof data.cursor === "string" && data.cursor ? data.cursor : undefined;
    return { entries, ...(cursor ? { cursor } : {}) };
  }

  /**
   * Inline parseable bodies stay local. Absent bodies are `readMany` in
   * `WORK_QUERY_PAGE` chunks — never N singleton `read`s.
   * `readMany` `null` (blob gone) is `missing`; a present unparseable body is corrupt.
   */
  private async hydrateEntries(entries: QueryEntry[]): Promise<HydratedSlot[]> {
    const slots: HydratedSlot[] = [];
    const missing: string[] = [];
    for (const entry of entries) {
      if (entry.content !== undefined && entry.content !== null) {
        const parsed = parseRecord(entry.content);
        slots.push({ entry, record: parsed, missing: false });
        continue;
      }
      slots.push({ entry, missing: false });
      if (typeof entry.path === "string") missing.push(entry.path);
    }
    if (missing.length === 0) return slots;
    const fetched = new Map<string, { content?: unknown } | null>();
    for (let i = 0; i < missing.length; i += QUERY_PAGE) {
      const chunk = missing.slice(i, i + QUERY_PAGE);
      const part = await this.ops.readMany(chunk);
      for (const [path, value] of part) fetched.set(path, value);
    }
    for (const slot of slots) {
      if (slot.record || typeof slot.entry.path !== "string") continue;
      if (slot.entry.content !== undefined && slot.entry.content !== null) continue;
      const hit = fetched.get(slot.entry.path);
      if (hit == null) {
        slot.missing = true;
        continue;
      }
      slot.record = parseRecord(hit.content);
    }
    return slots;
  }

  private requireWorkRecord(
    path: string,
    record: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    if (!record) {
      throw new AFSValidationError(
        `work-object query row at ${path} is not a parseable work record; refusing to drop it`,
      );
    }
    return record;
  }

  private async ensureRefs(dids: string[]): Promise<void> {
    const unique = [...new Set(dids)].filter((did) => !this.idByDid.has(did));
    if (unique.length === 0) return;
    const workEntries: QueryEntry[] = [];
    const didByPath = new Map<string, string>();
    for (const did of unique) {
      const entries = await this.queryEntries({ field: "meta.objectId", eq: did }, 8);
      let found = false;
      for (const entry of entries) {
        if (typeof entry.path !== "string") continue;
        if (entry.meta?.contentType != null && entry.meta.contentType !== "work") continue;
        workEntries.push(entry);
        didByPath.set(entry.path, did);
        found = true;
        break;
      }
      if (!found) this.idByDid.set(did, undefined);
    }
    if (workEntries.length === 0) return;
    for (const slot of await this.hydrateEntries(workEntries)) {
      const path = slot.entry.path;
      if (typeof path !== "string") continue;
      const did = didByPath.get(path);
      if (!did) continue;
      if (slot.missing) {
        this.idByDid.set(did, {
          id: idOfPath(path),
          closed: workIsClosed(undefined, slot.entry.meta),
        });
        continue;
      }
      const parsed = this.requireWorkRecord(path, slot.record);
      this.idByDid.set(did, {
        id: idOfPath(path),
        closed: workIsClosed(parsed, slot.entry.meta),
      });
    }
  }

  private async refForDid(did: string): Promise<{ id: string; closed: boolean } | undefined> {
    if (!this.idByDid.has(did)) await this.ensureRefs([did]);
    return this.idByDid.get(did);
  }

  private async idForDid(did: string): Promise<string | undefined> {
    return (await this.refForDid(did))?.id;
  }

  private async readWork(id: string): Promise<Record<string, unknown> | undefined> {
    try {
      const read = await this.ops.read(workRecordPath(this.root, id));
      return parseRecord(read.data?.content);
    } catch (err) {
      if (err instanceof AFSNotFoundError) return undefined;
      throw err;
    }
  }
}

/**
 * Sweep-batch source factory. Default is {@link WorkObjectSource}.
 * Unknown names throw — never silently fall back to GitHub.
 * Missing `/work` is fail-closed at `list()`, not here.
 */
export function createSweepSource(
  source: string,
  opts?: { ops?: WorkLedgerOps; repo?: string },
): { src: WorkItemSource; label: string } {
  const name = (source || DEFAULT_SWEEP_SOURCE).trim();
  if (name === "work-object" || name.startsWith("work-object:")) {
    return {
      src: new WorkObjectSource(opts?.ops ?? createArcAfsWorkLedgerOps()),
      label: "work-object",
    };
  }
  if (name === "github" || name.startsWith("github:")) {
    const fromFlag = name.startsWith("github:") ? name.slice("github:".length) : "";
    const repo = fromFlag || opts?.repo;
    if (!repo) {
      throw new AFSValidationError("--source github requires a repo slug");
    }
    return { src: new GitHubIssueSource(repo), label: `github:${repo}` };
  }
  throw new AFSValidationError(`unknown --source ${name}; expected work-object or github`);
}

/**
 * Default WorkLedgerOps for sweep-batch: shell out to `arc afs`.
 * Fail closed — a non-zero exit or unparseable result throws, never an empty set.
 */
export function createArcAfsWorkLedgerOps(): WorkLedgerOps {
  return {
    async read(path: string) {
      return JSON.parse(arcAfs(["read", path])) as {
        data?: { content?: unknown; meta?: unknown } | null;
      };
    },
    async readMany(paths: string[]) {
      const map = new Map<string, { content?: unknown } | null>();
      await Promise.all(
        paths.map(async (path) => {
          try {
            const result = JSON.parse(arcAfs(["read", path])) as {
              data?: { content?: unknown } | null;
            };
            map.set(path, result.data ?? null);
          } catch (err) {
            if (err instanceof AFSNotFoundError) {
              map.set(path, null);
              return;
            }
            throw err;
          }
        }),
      );
      return map;
    },
    async write(
      path: string,
      payload: { content?: unknown; meta?: Record<string, unknown> },
      options?: { ifMatch?: string },
    ) {
      const args = ["write", path];
      if (payload.content !== undefined) {
        args.push(
          "--content",
          typeof payload.content === "string" ? payload.content : JSON.stringify(payload.content),
        );
      }
      if (options?.ifMatch) args.push("--if-match", options.ifMatch);
      if (payload.meta) {
        for (const [key, value] of Object.entries(payload.meta)) {
          args.push(
            "--meta",
            `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
          );
        }
      }
      return JSON.parse(arcAfs(args)) as { data?: { path?: string; meta?: unknown } };
    },
    async exec(path: string, args: Record<string, unknown>) {
      return JSON.parse(arcAfs(["exec", path, "--args", JSON.stringify(args)])) as {
        success?: boolean;
        data?: unknown;
      };
    },
  };
}

/** CLI not-found sniff — `arc afs read` says `No data found for path:`, not `Path not found`. */
export function isArcAfsNotFound(msg: string): boolean {
  return /AFS_NOT_FOUND|Path not found|No data found for path:/i.test(msg);
}

function arcAfs(args: string[]): string {
  const p = Bun.spawnSync(["arc", "--json", "afs", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = p.stderr.toString();
  const stdout = p.stdout.toString();
  if (p.exitCode !== 0) {
    const msg = stderr || stdout || `exit ${p.exitCode}`;
    if (isArcAfsNotFound(msg)) {
      throw new AFSNotFoundError(args[1] ?? WORK_OBJECT_ROOT, msg.trim());
    }
    throw new Error(`arc afs ${args[0]}: ${msg.trim()}`);
  }
  return stdout;
}
