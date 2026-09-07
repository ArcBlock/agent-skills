/**
 * WorkObjectSource contract tests that do not need DIDSpaceProvider
 * (issue #5943). The query harness lives in packages/aos/test/work-object-source.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultTypesFor, parseTypes, typeOf } from "./classify";
import {
  AFSNotFoundError,
  AFSValidationError,
  CHANGE_SET_WORK_TYPE,
  capabilitiesOf,
  createArcAfsWorkLedgerOps,
  createSweepSource,
  DEFAULT_SWEEP_SOURCE,
  epicIdOf,
  GitHubIssueSource,
  isArcAfsNotFound,
  isInEpic,
  isProjectedPullUrl,
  membershipMode,
  WORK_ID_RE,
  WORK_QUERY_PAGE,
  type WorkItemSource,
  type WorkLedgerOps,
  WorkObjectSource,
} from "./source";

const SRC = readFileSync(join(import.meta.dir, "source.ts"), "utf8");
const SWEEP = readFileSync(join(import.meta.dir, "sweep-batch.ts"), "utf8");
const SKILL = readFileSync(join(import.meta.dir, "../SKILL.md"), "utf8");

function failingOps(): WorkLedgerOps {
  const boom = () => {
    throw new AFSNotFoundError("/work", "Path not found: /work");
  };
  return {
    read: async () => boom(),
    readMany: async () => boom(),
    write: async () => boom(),
    exec: async () => boom(),
  };
}

describe("WorkObjectSource — fail-closed vs successful 0", () => {
  test("AFS 不可用 → throw，不得返回 []", async () => {
    const src = new WorkObjectSource(failingOps());
    let thrown: unknown;
    try {
      await src.list({ state: "open" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown).toBeInstanceOf(AFSNotFoundError);
    await expect(src.list({ state: "open" })).rejects.toThrow();
    await expect(src.claimedIds()).rejects.toThrow();
    await expect(src.epicMembers()).rejects.toThrow();
  });

  test("query success:false 也 throw，不退化成 []", async () => {
    const src = new WorkObjectSource({
      read: async () => ({ data: null }),
      readMany: async () => new Map(),
      write: async () => ({}),
      exec: async () => ({ success: false, data: { entries: [] } }),
    });
    await expect(src.list({ state: "open" })).rejects.toThrow();
  });

  test("成功的空集合返回 []，与 throw 分色", async () => {
    const src = new WorkObjectSource({
      read: async () => ({ data: null }),
      readMany: async () => new Map(),
      write: async () => ({}),
      exec: async () => ({ success: true, data: { entries: [] } }),
    });
    const empty = await src.list({ state: "open" });
    expect(empty).toEqual([]);
    expect(src.lastReadCount).toBe(0);
  });

  test("constructor 注入 WorkLedgerOps；缺 ops 不得默默 fail-open", () => {
    expect(() => new WorkObjectSource(undefined as unknown as WorkLedgerOps)).toThrow(
      AFSValidationError,
    );
    expect(typeof createArcAfsWorkLedgerOps).toBe("function");
  });

  test("throw 与成功的 0 在输出上不同色：失败不得写出『存量 0』", async () => {
    const src = new WorkObjectSource(failingOps());
    const result = await src
      .list({ state: "open" })
      .then((items) => ({ ok: true as const, items }))
      .catch((err) => ({ ok: false as const, err }));
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error(`存量 ${result.items.length}`);
    }
  });
});

describe("membershipMode — --source work-object 不得把 epic:<n> 当成员资格", () => {
  test("edges 模式忽略 epic:<n> label", () => {
    const labels = ["bug", "epic:5540"];
    const edges = new Map<string, string[]>([["w_epic", ["w_member"]]]);
    expect(isInEpic("w_other", labels, edges, "edges")).toBe(false);
    expect(isInEpic("w_member", labels, edges, "edges")).toBe(true);
    expect(epicIdOf("w_member", labels, edges, "edges")).toBe("w_epic");
    expect(epicIdOf("w_other", labels, edges, "edges")).toBeNull();
  });

  test("labels 模式仍解析 epic:<n>（GitHub 源）", () => {
    expect(isInEpic("1", ["epic:5540"], new Map(), "labels")).toBe(true);
    expect(epicIdOf("1", ["epic:5540"], new Map(), "labels")).toBe("5540");
    expect(isInEpic("1", ["bug"], new Map(), "labels")).toBe(false);
  });

  test("work-object → edges，github → labels", () => {
    expect(membershipMode("work-object")).toBe("edges");
    expect(membershipMode("github")).toBe("labels");
    expect(membershipMode("github:ArcBlock/arc")).toBe("labels");
  });

  test("sweep-batch 在 work-object 下用 membershipMode，不把 /^epic:\\d+$/ 当唯一成员资格", () => {
    expect(SWEEP).toMatch(/membershipMode/);
    expect(SWEEP).toMatch(/isInEpic/);
    expect(SWEEP).toMatch(/writeClassification/);
    expect(SWEEP).toMatch(/createSweepSource/);
    expect(SRC).toMatch(/createArcAfsWorkLedgerOps/);
    expect(SWEEP).toMatch(/classificationFromWork/);
    expect(SWEEP).not.toMatch(/fetch\(/);
  });

  test("production write uses classificationWriteback — never hardcodes layer: null", () => {
    expect(SWEEP).toMatch(/classificationWriteback/);
    expect(SWEEP).not.toMatch(/layer:\s*null/);
  });
});

describe("isArcAfsNotFound — CLI not-found sniff", () => {
  test("ACCEPT: matches the CLI's No data found for path:", () => {
    expect(isArcAfsNotFound("No data found for path: /work/x.json")).toBe(true);
    expect(isArcAfsNotFound("Error: No data found for path: /work")).toBe(true);
  });

  test("ACCEPT: still matches the older Path not found / AFS_NOT_FOUND shapes", () => {
    expect(isArcAfsNotFound("Path not found: /work")).toBe(true);
    expect(isArcAfsNotFound("AFS_NOT_FOUND")).toBe(true);
  });

  test("REJECT: generic failures stay generic", () => {
    expect(isArcAfsNotFound("permission denied")).toBe(false);
    expect(isArcAfsNotFound("exit 1")).toBe(false);
  });
});

function lookupContent(
  entries: Array<{ path: string; content?: unknown }>,
  path: string,
): { content?: unknown } | null {
  const hit = entries.find((e) => e.path === path);
  return hit ? { content: hit.content } : null;
}

function mockOps(entries: Array<{ path: string; content: unknown }>): WorkLedgerOps {
  return {
    read: async (path) => {
      const hit = lookupContent(entries, path);
      if (!hit) throw new AFSNotFoundError(path);
      return { data: { content: hit.content, meta: { version: "v1" } } };
    },
    readMany: async (paths) => {
      const map = new Map<string, { content?: unknown } | null>();
      for (const path of paths) map.set(path, lookupContent(entries, path));
      return map;
    },
    write: async () => ({}),
    exec: async (_path, args) => {
      let rows = entries.map((e) => ({ path: e.path, content: e.content }));
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      if (limit != null) rows = rows.slice(0, limit);
      return { success: true, data: { entries: rows } };
    },
  };
}

/** Query returns path+meta only; bodies live behind read/readMany. */
function countingOps(
  entries: FixtureEntry[],
  opts?: { queryIncludesContent?: boolean; readManyNull?: Iterable<string> },
): { ops: WorkLedgerOps; reads: string[]; readManyCalls: string[][] } {
  const reads: string[] = [];
  const readManyCalls: string[][] = [];
  const includeContent = opts?.queryIncludesContent === true;
  const nullPaths = new Set(opts?.readManyNull ?? []);
  return {
    reads,
    readManyCalls,
    ops: {
      read: async (path) => {
        reads.push(path);
        if (nullPaths.has(path)) throw new AFSNotFoundError(path);
        const hit = lookupContent(entries, path);
        if (!hit) throw new AFSNotFoundError(path);
        return { data: { content: hit.content, meta: { version: "v1" } } };
      },
      readMany: async (paths) => {
        readManyCalls.push([...paths]);
        const map = new Map<string, { content?: unknown } | null>();
        for (const path of paths) {
          map.set(path, nullPaths.has(path) ? null : lookupContent(entries, path));
        }
        return map;
      },
      write: async () => ({}),
      exec: async (_path, args) => {
        const w = whereField(args.where);
        let rows = entries;
        if (w.field === "meta.predicate" && w.eq === "member-of") {
          rows = entries.filter((e) => e.meta?.predicate === "member-of");
        } else if (w.field === "meta.objectId" && typeof w.eq === "string") {
          rows = entries.filter((e) => e.meta?.objectId === w.eq);
        } else {
          rows = entries.filter((e) => e.meta?.predicate !== "member-of");
        }
        const mapped = rows.map((e) => ({
          path: e.path,
          meta: e.meta,
          ...(includeContent ? { content: e.content } : {}),
        }));
        const offset =
          typeof args.cursor === "string" && /^\d+$/.test(args.cursor) ? Number(args.cursor) : 0;
        const limit = typeof args.limit === "number" ? args.limit : mapped.length;
        const page = mapped.slice(offset, offset + limit);
        const next = offset + page.length;
        const cursor = next < mapped.length ? String(next) : undefined;
        return {
          success: true,
          data: { entries: page, ...(cursor ? { cursor } : {}) },
        };
      },
    },
  };
}

type FixtureEntry = {
  path: string;
  content?: unknown;
  meta?: Record<string, unknown>;
};

function whereField(where: unknown): { field?: unknown; eq?: unknown } {
  if (typeof where !== "object" || where === null) return {};
  return where as { field?: unknown; eq?: unknown };
}

function whereClauses(where: unknown): Array<{ field?: unknown; eq?: unknown; in?: unknown }> {
  if (typeof where !== "object" || where === null) return [];
  const w = where as { all?: unknown; field?: unknown; eq?: unknown; in?: unknown };
  if (Array.isArray(w.all)) return w.all.flatMap((c) => whereClauses(c));
  return [w];
}

/** Filter `/work` rows by query `where` so claimedIds' three queries stay distinct. */
function claimedFixtureOps(rows: FixtureEntry[]): WorkLedgerOps {
  return {
    read: async (path) => {
      const hit = lookupContent(rows, path);
      if (!hit) throw new AFSNotFoundError(path);
      return { data: { content: hit.content, meta: { version: "v1" } } };
    },
    readMany: async (paths) => {
      const map = new Map<string, { content?: unknown } | null>();
      for (const path of paths) map.set(path, lookupContent(rows, path));
      return map;
    },
    write: async () => ({}),
    exec: async (_path, args) => {
      const clauses = whereClauses(args.where);
      const matched = rows.filter((row) => {
        for (const c of clauses) {
          if (typeof c.field !== "string") continue;
          const key = c.field.replace(/^meta\./, "");
          const value = row.meta?.[key];
          if (c.eq !== undefined && value !== c.eq) return false;
          if (Array.isArray(c.in) && !c.in.includes(value)) return false;
        }
        return true;
      });
      return { success: true, data: { entries: matched } };
    },
  };
}

function memberEdge(subjectDid: string, objectDid: string, id: string): FixtureEntry {
  return {
    path: `/work/${id}.json`,
    meta: { predicate: "member-of", subjectDid, objectDid },
  };
}

function relationOps(works: FixtureEntry[], edges: FixtureEntry[]): WorkLedgerOps {
  return {
    read: async (path) => {
      const hit = works.find((e) => e.path === path);
      if (!hit) throw new AFSNotFoundError(path);
      return { data: { content: hit.content, meta: { version: "v1", ...hit.meta } } };
    },
    readMany: async (paths) => {
      const map = new Map<string, { content?: unknown } | null>();
      for (const path of paths) map.set(path, lookupContent(works, path));
      return map;
    },
    write: async () => ({}),
    exec: async (_path, args) => {
      const w = whereField(args.where);
      let rows: FixtureEntry[] = [];
      if (w.field === "meta.predicate" && w.eq === "member-of") rows = edges;
      else if (w.field === "meta.objectId" && typeof w.eq === "string") {
        rows = works.filter((e) => e.meta?.objectId === w.eq);
      } else {
        rows = works;
      }
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      if (limit != null) rows = rows.slice(0, limit);
      return { success: true, data: { entries: rows } };
    },
  };
}

function countingRelationOps(): { ops: WorkLedgerOps; objectIdQueries: string[] } {
  const works: FixtureEntry[] = [
    {
      path: "/work/w_epic.json",
      content: { ...PLANNED, name: "epic", objectId: "did:example:epic", workType: "epic" },
      meta: { contentType: "work", objectId: "did:example:epic", creativeWorkStatus: "planned" },
    },
    {
      path: "/work/w_a.json",
      content: { ...PLANNED, name: "a", objectId: "did:example:a" },
      meta: { contentType: "work", objectId: "did:example:a", creativeWorkStatus: "planned" },
    },
    {
      path: "/work/w_b.json",
      content: { ...PLANNED, name: "b", objectId: "did:example:b" },
      meta: { contentType: "work", objectId: "did:example:b", creativeWorkStatus: "planned" },
    },
  ];
  const edges = [
    memberEdge("did:example:a", "did:example:epic", "r1"),
    memberEdge("did:example:b", "did:example:epic", "r2"),
  ];
  const objectIdQueries: string[] = [];
  const inner = relationOps(works, edges);
  const ops: WorkLedgerOps = {
    ...inner,
    exec: async (path, args) => {
      const w = whereField(args.where);
      if (w.field === "meta.objectId" && typeof w.eq === "string") objectIdQueries.push(w.eq);
      return inner.exec(path, args);
    },
  };
  return { ops, objectIdQueries };
}

const PLANNED = {
  name: "x",
  creativeWorkStatus: "planned",
  dateCreated: "2026-09-05T00:00:00.000Z",
};

describe("WorkObjectSource list — lastReadCount / limit / changedSince", () => {
  test("ACCEPT: well-formed rows populate lastReadCount", async () => {
    const src = new WorkObjectSource(
      mockOps([
        { path: "/work/a.json", content: { ...PLANNED, name: "ok", keywords: ["bug"] } },
        { path: "/work/b.json", content: { ...PLANNED, name: "also", keywords: ["feature"] } },
      ]),
    );
    const items = await src.list({ state: "open" });
    expect(items).toHaveLength(2);
    expect(src.lastReadCount).toBe(2);
  });

  test("limit applies after withoutLabels, not before", async () => {
    const src = new WorkObjectSource(
      mockOps([
        { path: "/work/bug.json", content: { ...PLANNED, name: "bug", keywords: ["bug"] } },
        { path: "/work/feat.json", content: { ...PLANNED, name: "feat", keywords: ["feature"] } },
      ]),
    );
    const rows = await src.list({ state: "open", withoutLabels: ["bug"], limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.labels.includes("bug")).toBe(false);
    expect(rows[0]?.id).toBe("feat");
  });

  test("epicMembers excludes work with closedAt or creativeWorkStatus===done", async () => {
    const ops = relationOps(
      [
        {
          path: "/work/w_epic.json",
          content: { ...PLANNED, name: "epic", objectId: "did:example:epic", workType: "epic" },
          meta: {
            contentType: "work",
            objectId: "did:example:epic",
            creativeWorkStatus: "planned",
          },
        },
        {
          path: "/work/w_live.json",
          content: { ...PLANNED, name: "live", objectId: "did:example:live" },
          meta: {
            contentType: "work",
            objectId: "did:example:live",
            creativeWorkStatus: "planned",
          },
        },
        {
          path: "/work/w_done.json",
          content: {
            ...PLANNED,
            name: "done",
            objectId: "did:example:done",
            creativeWorkStatus: "done",
          },
          meta: {
            contentType: "work",
            objectId: "did:example:done",
            creativeWorkStatus: "done",
          },
        },
        {
          path: "/work/w_closed.json",
          content: {
            ...PLANNED,
            name: "closed",
            objectId: "did:example:closed",
            closedAt: "2026-09-05T00:00:00.000Z",
          },
          meta: {
            contentType: "work",
            objectId: "did:example:closed",
            creativeWorkStatus: "planned",
          },
        },
      ],
      [
        memberEdge("did:example:live", "did:example:epic", "r1"),
        memberEdge("did:example:done", "did:example:epic", "r2"),
        memberEdge("did:example:closed", "did:example:epic", "r3"),
      ],
    );
    const src = new WorkObjectSource(ops);
    const members = await src.epicMembers();
    expect(members.get("w_epic")).toEqual(["w_live"]);
  });

  test("idForDid is memoized: list() pass fills the Map, same DID is not re-queried", async () => {
    const { ops, objectIdQueries } = countingRelationOps();
    const src = new WorkObjectSource(ops);
    await src.list({ state: "open" });
    const afterList = objectIdQueries.length;
    const members = await src.epicMembers();
    expect(members.get("w_epic")?.slice().sort()).toEqual(["w_a", "w_b"]);
    expect(objectIdQueries.length).toBe(afterList);
  });

  test("idForDid is memoized within epicMembers when list() did not run", async () => {
    const { ops, objectIdQueries } = countingRelationOps();
    const src = new WorkObjectSource(ops);
    const members = await src.epicMembers();
    expect(members.get("w_epic")?.slice().sort()).toEqual(["w_a", "w_b"]);
    const unique = [...new Set(objectIdQueries)].sort();
    expect(unique).toEqual(["did:example:a", "did:example:b", "did:example:epic"]);
    expect(objectIdQueries).toHaveLength(unique.length);
  });

  test("changedSince queries meta.dateModified, not content JSON mtime", async () => {
    const ops = mockOps([
      { path: "/work/a.json", content: { ...PLANNED, name: "a", keywords: ["bug"] } },
    ]);
    const execArgs: Array<Record<string, unknown>> = [];
    const spied: WorkLedgerOps = {
      ...ops,
      exec: async (path, args) => {
        execArgs.push(args);
        return ops.exec(path, args);
      },
    };
    const src = new WorkObjectSource(spied);
    await src.list({ state: "open", changedSince: new Date("2026-09-05T00:00:00.000Z") });
    expect(execArgs.length).toBeGreaterThan(0);
    const where = JSON.stringify(execArgs[0]?.where ?? {});
    expect(where).toContain("meta.dateModified");
    expect(where).not.toMatch(/"mtime"/);
  });
});

describe("mutation: 谎称下推的源过不了诚实臂", () => {
  test("全量 list 再 filter 仍声明 pushdown → after 不少读", async () => {
    const items = [
      { id: "1", title: "a", body: null, labels: ["bug"] },
      { id: "2", title: "b", body: null, labels: ["feature"] },
      { id: "3", title: "c", body: null, labels: ["bug"] },
    ];
    const dishonest: WorkItemSource = {
      lastReadCount: 0,
      capabilities: {
        pushdown: true,
        incremental: true,
        writableClassification: true,
        neighborhood: true,
      },
      async list(q) {
        this.lastReadCount = items.length;
        let r = items;
        if (q.withLabels?.length)
          r = r.filter((i) => q.withLabels!.every((l) => i.labels.includes(l)));
        return r;
      },
      async claimedIds() {
        return new Set();
      },
      async epicMembers() {
        return new Map();
      },
    };
    await dishonest.list({ state: "open" });
    const before = dishonest.lastReadCount as number;
    await dishonest.list({ state: "open", withLabels: ["bug"] });
    const after = dishonest.lastReadCount as number;
    expect(after).not.toBeLessThan(before);
    expect(capabilitiesOf(dishonest).pushdown).toBe(true);
  });

  test("WorkObjectSource 源码不把 DID 哈希成 number，也不解析 epic:<n>", () => {
    const classBody = SRC.slice(SRC.indexOf("export class WorkObjectSource"));
    expect(classBody).not.toMatch(/epic:\\d/);
    expect(classBody).not.toMatch(/\^epic:/);
    expect(SRC).not.toMatch(/Number\(.*workPathId/);
    expect(SRC).not.toMatch(/hash.*DID.*number/i);
  });
});

const FALLBACK_WORKS: FixtureEntry[] = [
  {
    path: "/work/w_a.json",
    content: { ...PLANNED, name: "a", keywords: ["bug"] },
    meta: { contentType: "work", creativeWorkStatus: "planned" },
  },
  {
    path: "/work/w_b.json",
    content: { ...PLANNED, name: "b", keywords: ["feature"] },
    meta: { contentType: "work", creativeWorkStatus: "planned" },
  },
  {
    path: "/work/w_c.json",
    content: { ...PLANNED, name: "c", keywords: ["bug"] },
    meta: { contentType: "work", creativeWorkStatus: "planned" },
  },
];

describe("WorkObjectSource — readMany fallback (f1nxbhh2)", () => {
  test("honesty: N>1 missing content → one readMany, zero singleton reads", async () => {
    const { ops, reads, readManyCalls } = countingOps(FALLBACK_WORKS);
    const src = new WorkObjectSource(ops);
    const items = await src.list({ state: "open" });
    expect(items.map((i) => i.id).sort()).toEqual(["w_a", "w_b", "w_c"]);
    expect(reads).toEqual([]);
    expect(readManyCalls).toHaveLength(1);
    expect(readManyCalls[0]?.slice().sort()).toEqual([
      "/work/w_a.json",
      "/work/w_b.json",
      "/work/w_c.json",
    ]);
  });

  test("ACCEPT: well-formed entry.content needs zero extra reads", async () => {
    const { ops, reads, readManyCalls } = countingOps(FALLBACK_WORKS, {
      queryIncludesContent: true,
    });
    const src = new WorkObjectSource(ops);
    const items = await src.list({ state: "open" });
    expect(items).toHaveLength(3);
    expect(reads).toEqual([]);
    expect(readManyCalls).toEqual([]);
  });

  test("timeline fallback of size N>1 is one readMany, not N singleton reads", async () => {
    const { ops, reads, readManyCalls } = countingOps(FALLBACK_WORKS);
    const src = new WorkObjectSource(ops);
    const rows = await src.timeline!(30);
    expect(rows).toHaveLength(3);
    expect(reads).toEqual([]);
    expect(readManyCalls).toHaveLength(1);
    expect(readManyCalls[0]?.length).toBe(3);
  });

  test("epicMembers hydrates missing work bodies in one readMany, zero singleton reads", async () => {
    const { ops, reads, readManyCalls } = countingOps([
      {
        path: "/work/w_epic.json",
        content: { ...PLANNED, name: "epic", objectId: "did:example:epic", workType: "epic" },
        meta: {
          contentType: "work",
          objectId: "did:example:epic",
          creativeWorkStatus: "planned",
        },
      },
      {
        path: "/work/w_a.json",
        content: { ...PLANNED, name: "a", objectId: "did:example:a" },
        meta: { contentType: "work", objectId: "did:example:a", creativeWorkStatus: "planned" },
      },
      {
        path: "/work/w_b.json",
        content: { ...PLANNED, name: "b", objectId: "did:example:b" },
        meta: { contentType: "work", objectId: "did:example:b", creativeWorkStatus: "planned" },
      },
      memberEdge("did:example:a", "did:example:epic", "r1"),
      memberEdge("did:example:b", "did:example:epic", "r2"),
    ]);
    const src = new WorkObjectSource(ops);
    const members = await src.epicMembers();
    expect(members.get("w_epic")?.slice().sort()).toEqual(["w_a", "w_b"]);
    expect(reads).toEqual([]);
    expect(readManyCalls).toHaveLength(1);
    expect(readManyCalls[0]?.slice().sort()).toEqual([
      "/work/w_a.json",
      "/work/w_b.json",
      "/work/w_epic.json",
    ]);
  });

  test("epicMembers: missing blob still resolves id from index path+meta", async () => {
    const { ops } = countingOps(
      [
        {
          path: "/work/w_epic.json",
          content: { ...PLANNED, name: "epic", objectId: "did:example:epic", workType: "epic" },
          meta: {
            contentType: "work",
            objectId: "did:example:epic",
            creativeWorkStatus: "planned",
          },
        },
        {
          path: "/work/w_a.json",
          content: { ...PLANNED, name: "a", objectId: "did:example:a" },
          meta: { contentType: "work", objectId: "did:example:a", creativeWorkStatus: "planned" },
        },
        {
          path: "/work/w_b.json",
          content: { ...PLANNED, name: "b", objectId: "did:example:b" },
          meta: { contentType: "work", objectId: "did:example:b", creativeWorkStatus: "planned" },
        },
        memberEdge("did:example:a", "did:example:epic", "r1"),
        memberEdge("did:example:b", "did:example:epic", "r2"),
      ],
      { readManyNull: ["/work/w_epic.json", "/work/w_a.json", "/work/w_b.json"] },
    );
    const members = await new WorkObjectSource(ops).epicMembers();
    expect(members.get("w_epic")?.slice().sort()).toEqual(["w_a", "w_b"]);
  });

  test("epicMembers: present unparseable work body still fail-closes", async () => {
    const { ops } = countingOps(
      [
        {
          path: "/work/w_epic.json",
          content: "<<<not-a-record>>>",
          meta: {
            contentType: "work",
            objectId: "did:example:epic",
            creativeWorkStatus: "planned",
          },
        },
        {
          path: "/work/w_a.json",
          content: { ...PLANNED, name: "a", objectId: "did:example:a" },
          meta: { contentType: "work", objectId: "did:example:a", creativeWorkStatus: "planned" },
        },
        memberEdge("did:example:a", "did:example:epic", "r1"),
      ],
      { queryIncludesContent: true },
    );
    await expect(new WorkObjectSource(ops).epicMembers()).rejects.toThrow(AFSValidationError);
  });

  test("readMany of size > WORK_QUERY_PAGE is chunked, never one unbounded call", async () => {
    const n = WORK_QUERY_PAGE + 1;
    const entries: FixtureEntry[] = Array.from({ length: n }, (_, i) => ({
      path: `/work/w_${i}.json`,
      content: { ...PLANNED, name: `n${i}` },
      meta: { contentType: "work", creativeWorkStatus: "planned" },
    }));
    const { ops, reads, readManyCalls } = countingOps(entries);
    const src = new WorkObjectSource(ops);
    const items = await src.list({ state: "open" });
    expect(items).toHaveLength(n);
    expect(reads).toEqual([]);
    expect(readManyCalls.length).toBeGreaterThan(1);
    expect(Math.max(...readManyCalls.map((c) => c.length))).toBeLessThanOrEqual(WORK_QUERY_PAGE);
    expect(readManyCalls.flat()).toHaveLength(n);
  });
});

describe("WorkObjectSource — fail-closed list parse (f1penig9)", () => {
  test("unparseable work row throws AFSValidationError, does not silently drop", async () => {
    const src = new WorkObjectSource(
      mockOps([
        { path: "/work/a.json", content: { ...PLANNED, name: "ok", keywords: ["bug"] } },
        { path: "/work/b.json", content: "<<<not-a-record>>>" },
      ]),
    );
    let thrown: unknown;
    try {
      await src.list({ state: "open" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AFSValidationError);
    expect(String(thrown)).toMatch(/b\.json/);
    expect(String(thrown)).not.toMatch(/invalid requirement/);
  });

  test("ACCEPT: well-formed rows still return", async () => {
    const src = new WorkObjectSource(
      mockOps([
        { path: "/work/a.json", content: { ...PLANNED, name: "ok", keywords: ["bug"] } },
        { path: "/work/b.json", content: { ...PLANNED, name: "also", keywords: ["feature"] } },
      ]),
    );
    const items = await src.list({ state: "open" });
    expect(items.map((i) => i.id).sort()).toEqual(["a", "b"]);
    expect(items[0]?.title || items[1]?.title).toBeTruthy();
  });

  test("timeline throws on unparseable work row, does not continue", async () => {
    const src = new WorkObjectSource(
      mockOps([
        { path: "/work/a.json", content: { ...PLANNED, name: "ok" } },
        { path: "/work/b.json", content: "<<<not-a-record>>>" },
      ]),
    );
    await expect(src.timeline!(30)).rejects.toThrow(AFSValidationError);
    await expect(src.timeline!(30)).rejects.toThrow(/b\.json/);
  });

  test("all missing blobs with N>0 query rows throw; not successful 0", async () => {
    const { ops } = countingOps(
      [
        {
          path: "/work/a.json",
          content: { ...PLANNED, name: "a" },
          meta: { contentType: "work", creativeWorkStatus: "planned" },
        },
        {
          path: "/work/b.json",
          content: { ...PLANNED, name: "b" },
          meta: { contentType: "work", creativeWorkStatus: "planned" },
        },
      ],
      { readManyNull: ["/work/a.json", "/work/b.json"] },
    );
    const src = new WorkObjectSource(ops);
    let thrown: unknown;
    try {
      await src.list({ state: "open" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AFSValidationError);
    expect(String(thrown)).toMatch(/missing/);
    expect(String(thrown)).not.toMatch(/invalid requirement/);
    const result = await src
      .list({ state: "open" })
      .then((items) => ({ ok: true as const, items }))
      .catch((err) => ({ ok: false as const, err }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error(`存量 ${result.items.length}`);
  });

  test("ACCEPT: readMany null / missing blob skips that row; siblings still return", async () => {
    const { ops } = countingOps(
      [
        {
          path: "/work/a.json",
          content: { ...PLANNED, name: "ok", keywords: ["bug"] },
          meta: { contentType: "work", creativeWorkStatus: "planned" },
        },
        {
          path: "/work/gone.json",
          content: { ...PLANNED, name: "gone" },
          meta: { contentType: "work", creativeWorkStatus: "planned" },
        },
      ],
      { readManyNull: ["/work/gone.json"] },
    );
    const src = new WorkObjectSource(ops);
    const items = await src.list({ state: "open" });
    expect(items.map((i) => i.id)).toEqual(["a"]);
    expect(src.lastReadCount).toBe(1);
  });

  test("missing blob and corrupt body are different colors: null skips, garbage throws", async () => {
    const missing = new WorkObjectSource(
      countingOps(
        [
          {
            path: "/work/ok.json",
            content: { ...PLANNED, name: "ok" },
            meta: { contentType: "work", creativeWorkStatus: "planned" },
          },
          {
            path: "/work/gone.json",
            content: { ...PLANNED, name: "gone" },
            meta: { contentType: "work", creativeWorkStatus: "planned" },
          },
        ],
        { readManyNull: ["/work/gone.json"] },
      ).ops,
    );
    await expect(missing.list({ state: "open" })).resolves.toHaveLength(1);

    const corrupt = new WorkObjectSource(
      mockOps([
        { path: "/work/ok.json", content: { ...PLANNED, name: "ok" } },
        { path: "/work/bad.json", content: "<<<not-a-record>>>" },
      ]),
    );
    await expect(corrupt.list({ state: "open" })).rejects.toThrow(AFSValidationError);
  });

  test("mutation: list/timeline must not continue on !record for a work row", () => {
    const classBody = SRC.slice(SRC.indexOf("export class WorkObjectSource"));
    expect(classBody).not.toMatch(/if \(!record \|\| typeof entry\.path !== "string"\) continue/);
    expect(classBody).not.toMatch(/if \(!record\) continue/);
  });
});

describe("WorkObjectSource — timeline meta prefilter (f1scpt1q)", () => {
  test("rows meta-provably older than since are not hydrated", async () => {
    const old = "2020-01-01T00:00:00.000Z";
    const recent = new Date().toISOString();
    const { ops, reads, readManyCalls } = countingOps([
      {
        path: "/work/old.json",
        content: {
          ...PLANNED,
          name: "old",
          dateCreated: old,
          closedAt: old,
          creativeWorkStatus: "done",
        },
        meta: {
          contentType: "work",
          creativeWorkStatus: "done",
          dateCreated: old,
          closedAt: old,
        },
      },
      {
        path: "/work/live.json",
        content: { ...PLANNED, name: "live", dateCreated: recent },
        meta: { contentType: "work", creativeWorkStatus: "planned", dateCreated: recent },
      },
    ]);
    const src = new WorkObjectSource(ops);
    const rows = await src.timeline!(30);
    expect(rows.map((r) => r.id)).toEqual(["live"]);
    expect(reads).toEqual([]);
    expect(readManyCalls).toHaveLength(1);
    expect(readManyCalls[0]).toEqual(["/work/live.json"]);
  });

  test("ancient corrupt rows dropped by meta do not fail-closed the window", async () => {
    const old = "2020-01-01T00:00:00.000Z";
    const src = new WorkObjectSource(
      countingOps([
        {
          path: "/work/old-bad.json",
          content: "<<<not-a-record>>>",
          meta: {
            contentType: "work",
            creativeWorkStatus: "done",
            dateCreated: old,
            closedAt: old,
          },
        },
        {
          path: "/work/live.json",
          content: { ...PLANNED, name: "live" },
          meta: { contentType: "work", creativeWorkStatus: "planned" },
        },
      ]).ops,
    );
    const rows = await src.timeline!(30);
    expect(rows.map((r) => r.id)).toEqual(["live"]);
  });
});

describe("WorkObjectSource — dropped is closed (f159uyyo)", () => {
  test("ACCEPT: done is still closed", async () => {
    const ops = relationOps(
      [
        {
          path: "/work/w_epic.json",
          content: { ...PLANNED, name: "epic", objectId: "did:example:epic", workType: "epic" },
          meta: {
            contentType: "work",
            objectId: "did:example:epic",
            creativeWorkStatus: "planned",
          },
        },
        {
          path: "/work/w_done.json",
          content: {
            ...PLANNED,
            name: "done",
            objectId: "did:example:done",
            creativeWorkStatus: "done",
          },
          meta: {
            contentType: "work",
            objectId: "did:example:done",
            creativeWorkStatus: "done",
          },
        },
      ],
      [memberEdge("did:example:done", "did:example:epic", "r1")],
    );
    const members = await new WorkObjectSource(ops).epicMembers();
    expect(members.get("w_epic") ?? []).toEqual([]);
  });

  test("dropped members are excluded from epicMembers like done", async () => {
    const ops = relationOps(
      [
        {
          path: "/work/w_epic.json",
          content: { ...PLANNED, name: "epic", objectId: "did:example:epic", workType: "epic" },
          meta: {
            contentType: "work",
            objectId: "did:example:epic",
            creativeWorkStatus: "planned",
          },
        },
        {
          path: "/work/w_live.json",
          content: { ...PLANNED, name: "live", objectId: "did:example:live" },
          meta: {
            contentType: "work",
            objectId: "did:example:live",
            creativeWorkStatus: "planned",
          },
        },
        {
          path: "/work/w_dropped.json",
          content: {
            ...PLANNED,
            name: "dropped",
            objectId: "did:example:dropped",
            creativeWorkStatus: "dropped",
          },
          meta: {
            contentType: "work",
            objectId: "did:example:dropped",
            creativeWorkStatus: "dropped",
          },
        },
      ],
      [
        memberEdge("did:example:live", "did:example:epic", "r1"),
        memberEdge("did:example:dropped", "did:example:epic", "r2"),
      ],
    );
    const members = await new WorkObjectSource(ops).epicMembers();
    expect(members.get("w_epic")).toEqual(["w_live"]);
  });
});

describe("Phase 4 — default source WorkObjectSource (#6000)", () => {
  const READY_DID = "did:example:ready-no-gh";
  const READY_ID = "w_ready";
  const readyOps = () =>
    mockOps([
      {
        path: `/work/${READY_ID}.json`,
        content: {
          ...PLANNED,
          name: "ready work",
          objectId: READY_DID,
          keywords: ["bug"],
        },
      },
    ]);

  test("Happy: planted planned work with no sourceUrl is listed by the default source", async () => {
    expect(DEFAULT_SWEEP_SOURCE).toBe("work-object");
    const { src, label } = createSweepSource(DEFAULT_SWEEP_SOURCE, { ops: readyOps() });
    expect(label).toBe("work-object");
    expect(src).toBeInstanceOf(WorkObjectSource);
    expect(src).not.toBeInstanceOf(GitHubIssueSource);
    const items = await src.list({ state: "open" });
    expect(items.some((i) => i.id === READY_ID)).toBe(true);
    const hit = items.find((i) => i.id === READY_ID);
    expect(hit?.title).toBe("ready work");
    expect(JSON.stringify(hit)).not.toMatch(/sourceUrl/);
    expect(hit?.objectId).toBe(READY_DID);
  });

  test("Honesty: restoring github as the flag() default reddens this", () => {
    expect(SWEEP).toMatch(/flag\("--source", DEFAULT_SWEEP_SOURCE\)/);
    expect(SWEEP).not.toMatch(/flag\("--source", "github"\)/);
    expect(DEFAULT_SWEEP_SOURCE).toBe("work-object");
    expect(membershipMode(DEFAULT_SWEEP_SOURCE)).toBe("edges");
  });

  test("Happy: planted idea work with no keywords is in the default candidate types", async () => {
    const did = "did:example:imported-idea";
    const id = "w_imported";
    const { src } = createSweepSource(DEFAULT_SWEEP_SOURCE, {
      ops: mockOps([
        {
          path: `/work/${id}.json`,
          content: {
            name: "imported idea",
            creativeWorkStatus: "idea",
            dateCreated: "2026-09-05T00:00:00.000Z",
            objectId: did,
          },
        },
      ]),
    });
    const items = await src.list({ state: "open" });
    const hit = items.find((i) => i.id === id);
    expect(hit).toBeDefined();
    expect(typeOf(hit?.labels ?? ["bug"])).toBe("untyped");
    const types = parseTypes(defaultTypesFor(DEFAULT_SWEEP_SOURCE));
    expect(types).toContain("untyped");
    expect(types.includes(typeOf(hit?.labels ?? []))).toBe(true);
  });

  test("REJECT: --types bug still drops untyped imported work", () => {
    expect(parseTypes("bug").includes(typeOf([]))).toBe(false);
    expect(parseTypes("bug").includes(typeOf(["bug"]))).toBe(true);
  });

  test('Honesty: restoring types default "bug" for work-object reddens', () => {
    expect(SWEEP).toMatch(/flag\("--types", defaultTypesFor\(SOURCE\)\)/);
    expect(SWEEP).not.toMatch(/flag\("--types", "bug"\)/);
    expect(defaultTypesFor(DEFAULT_SWEEP_SOURCE)).toMatch(/untyped/);
    expect(SKILL).toMatch(/bug,untyped/);
  });

  test("Honesty: SKILL.md no longer says GitHubIssueSource is the default", () => {
    expect(SKILL).not.toMatch(/GitHubIssueSource（默认）/);
    expect(SKILL).toMatch(/WorkObjectSource（默认）/);
    expect(SKILL).toMatch(/--source github/);
    expect(SKILL).toMatch(/GitHubIssueSource（opt-in）/);
    expect(SRC).not.toMatch(/今天来自 GitHub issue/);
    expect(SRC).toMatch(/默认是 `WorkObjectSource`/);
  });

  test("Honesty: restoring gh issue list as the only list() reddens the default-source test", async () => {
    const { src } = createSweepSource(DEFAULT_SWEEP_SOURCE, { ops: readyOps() });
    const items = await src.list({ state: "open" });
    expect(items.map((i) => i.id)).toContain(READY_ID);
    const classBody = SRC.slice(SRC.indexOf("export class WorkObjectSource"));
    const listFn = classBody.slice(
      classBody.indexOf("async list("),
      classBody.indexOf("async claimedIds"),
    );
    expect(listFn).toMatch(/this\.queryEntries/);
    expect(listFn).not.toMatch(/gh issue list/);
    expect(listFn).not.toMatch(/GitHubIssueSource/);
    expect(listFn).not.toMatch(/\bgh\(/);
  });

  test("Bad input: missing /work / query failure throws, not []", async () => {
    const { src } = createSweepSource(DEFAULT_SWEEP_SOURCE, { ops: failingOps() });
    await expect(src.list({ state: "open" })).rejects.toThrow(AFSNotFoundError);
    const failed = await src
      .list({ state: "open" })
      .then((items) => ({ ok: true as const, items }))
      .catch((err) => ({ ok: false as const, err }));
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error(`GitHub-only success 存量 ${failed.items.length}`);
  });

  test("Security: work-object arm has no silent GitHub fallback; unknown source throws", () => {
    const createFn = SRC.slice(SRC.indexOf("export function createSweepSource"));
    const workArm = createFn.slice(createFn.indexOf("work-object"), createFn.indexOf('"github"'));
    expect(workArm).toMatch(/WorkObjectSource/);
    expect(workArm).not.toMatch(/GitHubIssueSource/);
    expect(workArm).not.toMatch(/catch/);
    const make = SWEEP.slice(
      SWEEP.indexOf("function makeSource"),
      SWEEP.indexOf("const { src, label }"),
    );
    expect(make).not.toMatch(/catch/);
    expect(() => createSweepSource("typo-source")).toThrow(AFSValidationError);
    expect(WORK_ID_RE.test("../etc/passwd")).toBe(false);
    expect(WORK_ID_RE.test("foo/bar")).toBe(false);
    expect(WORK_ID_RE.test(`w_${"a".repeat(32)}`)).toBe(true);
  });

  test("Honesty: plugin WORK_ID_RE source text matches packages/aos work-ledger", () => {
    const aosSrc = readFileSync(
      join(import.meta.dir, "../../../../../../packages/aos/src/work-ledger.ts"),
      "utf8",
    );
    const exported = (src: string): string => {
      const m = src.match(/export const WORK_ID_RE = ([^;]+);/);
      if (!m?.[1]) throw new Error("WORK_ID_RE export not found");
      return m[1].trim();
    };
    expect(exported(SRC)).toBe(exported(aosSrc));
    expect(SRC).toMatch(/local copy so the plugin does not import that package/);
    expect(SRC).not.toMatch(/import\s+[\s\S]*from\s+["']@aigne\/aos/);
  });

  test("Security: path traversal ids rejected by WORK_ID_RE at writeClassification", async () => {
    const src = new WorkObjectSource(readyOps());
    const patch = {
      layer: "gate-credibility",
      pathSurface: [] as string[],
      surfaceState: "measured",
    };
    await expect(src.writeClassification("../etc/passwd", patch)).rejects.toThrow(
      AFSValidationError,
    );
    await expect(src.writeClassification("a/b", patch)).rejects.toThrow(AFSValidationError);
  });

  test("Data loss: writeClassification still ifMatch; cutover does not clobber sibling fields", async () => {
    let stored: Record<string, unknown> = {
      ...PLANNED,
      name: "keep",
      objectId: "did:example:keep",
      extra: "stay",
    };
    let lastIfMatch: string | undefined;
    const ops: WorkLedgerOps = {
      read: async () => ({ data: { content: stored, meta: { version: "tok-1" } } }),
      readMany: async () => new Map(),
      write: async (_path, payload, options) => {
        lastIfMatch = options?.ifMatch;
        stored = payload.content as Record<string, unknown>;
        return {};
      },
      exec: async () => ({ success: true, data: { entries: [] } }),
    };
    const src = new WorkObjectSource(ops);
    await src.writeClassification("keep", {
      layer: "gate-credibility",
      pathSurface: ["scripts/a.ts"],
      surfaceState: "measured",
      fingerprint: "fp-1",
    });
    expect(lastIfMatch).toBe("tok-1");
    expect(stored.extra).toBe("stay");
    expect(stored.objectId).toBe("did:example:keep");
    expect(stored.layer).toBe("gate-credibility");
    expect(stored.fingerprint).toBe("fp-1");
  });

  test("Data damage: WorkItem.id is the w_<32hex> string, never a number; DID roundtrips", async () => {
    const hexId = `w_${"ab".repeat(16)}`;
    const did = "did:example:roundtrip";
    const src = new WorkObjectSource(
      mockOps([
        {
          path: `/work/${hexId}.json`,
          content: { ...PLANNED, name: "rt", objectId: did },
        },
      ]),
    );
    const items = await src.list({ state: "open" });
    expect(items).toHaveLength(1);
    expect(typeof items[0]?.id).toBe("string");
    expect(Number.isFinite(Number(items[0]?.id))).toBe(false);
    expect(items[0]?.id).toBe(hexId);
    expect(items[0]?.objectId).toBe(did);
    const classBody = SRC.slice(SRC.indexOf("export class WorkObjectSource"));
    expect(classBody).not.toMatch(/Number\(.*objectId/);
    expect(SRC).not.toMatch(/hash.*DID.*number/i);
  });

  test("Data leak: WorkObjectSource ops stay on /work; no ~/.git or GitHub API", () => {
    const classBody = SRC.slice(SRC.indexOf("export class WorkObjectSource"));
    expect(classBody).toMatch(/this\.root/);
    expect(classBody).not.toMatch(/~\/\.git/);
    expect(classBody).not.toMatch(/api\.github\.com/);
    expect(classBody).not.toMatch(/gh issue list/);
    expect(classBody).not.toMatch(/spawnSync\(\s*\["gh"/);
    expect(SRC).toMatch(/WORK_OBJECT_ROOT = "\/work"/);
  });

  test("Happy: open PR projection (CS sourceUrl) still claims the parent work", async () => {
    const parentDid = "did:example:claimed-parent";
    const csDid = "did:example:cs-pr";
    const parentId = "w_parent";
    const ops = claimedFixtureOps([
      {
        path: `/work/${parentId}.json`,
        content: { ...PLANNED, name: "parent", objectId: parentDid },
        meta: {
          contentType: "work",
          objectId: parentDid,
          creativeWorkStatus: "planned",
        },
      },
      {
        path: "/work/w_cs.json",
        content: {
          name: "cs",
          objectId: csDid,
          workType: CHANGE_SET_WORK_TYPE,
          sourceUrl: "https://github.com/ArcBlock/arc/pull/6000",
          creativeWorkStatus: "idea",
        },
        meta: {
          contentType: "work",
          objectId: csDid,
          workType: CHANGE_SET_WORK_TYPE,
          creativeWorkStatus: "idea",
          sourceUrl: "https://github.com/ArcBlock/arc/pull/6000",
        },
      },
      {
        path: "/work/r_cs.json",
        meta: {
          predicate: "spun-off-from",
          subjectDid: csDid,
          objectDid: parentDid,
        },
      },
    ]);
    const src = new WorkObjectSource(ops);
    const claimed = await src.claimedIds();
    expect(claimed.has(parentId)).toBe(true);
    expect(isProjectedPullUrl("https://github.com/ArcBlock/arc/pull/6000")).toBe(true);
  });

  test("Happy: default list excludes change-set products; parent stays listed and claimed", async () => {
    const parentDid = "did:example:listed-parent";
    const csDid = "did:example:cs-listed";
    const parentId = "w_parent";
    const csId = "w_cs";
    const ops = claimedFixtureOps([
      {
        path: `/work/${parentId}.json`,
        content: { ...PLANNED, name: "parent", objectId: parentDid },
        meta: {
          contentType: "work",
          objectId: parentDid,
          creativeWorkStatus: "planned",
        },
      },
      {
        path: `/work/${csId}.json`,
        content: {
          name: "cs",
          objectId: csDid,
          workType: CHANGE_SET_WORK_TYPE,
          sourceUrl: "https://github.com/ArcBlock/arc/pull/6000",
          creativeWorkStatus: "idea",
        },
        meta: {
          contentType: "work",
          objectId: csDid,
          workType: CHANGE_SET_WORK_TYPE,
          creativeWorkStatus: "idea",
          sourceUrl: "https://github.com/ArcBlock/arc/pull/6000",
        },
      },
      {
        path: "/work/r_cs.json",
        meta: {
          predicate: "spun-off-from",
          subjectDid: csDid,
          objectDid: parentDid,
        },
      },
    ]);
    const { src } = createSweepSource(DEFAULT_SWEEP_SOURCE, { ops });
    const items = await src.list({ state: "open" });
    expect(items.map((i) => i.id)).not.toContain(csId);
    expect(items.some((i) => i.id === parentId)).toBe(true);
    // Without the exclude, labelsOf(workType) would type the CS as untyped
    // and defaultTypesFor(work-object) would dispatch it as new work.
    expect(typeOf([CHANGE_SET_WORK_TYPE])).toBe("untyped");
    expect(parseTypes(defaultTypesFor(DEFAULT_SWEEP_SOURCE))).toContain("untyped");
    const claimed = await src.claimedIds();
    expect(claimed.has(parentId)).toBe(true);
    expect(claimed.has(csId)).toBe(false);
  });

  test("Honesty: dropping the change-set exclude from list() reddens", () => {
    const classBody = SRC.slice(SRC.indexOf("export class WorkObjectSource"));
    const listFn = classBody.slice(
      classBody.indexOf("async list("),
      classBody.indexOf("async claimedIds()"),
    );
    const claimedFn = classBody.slice(
      classBody.indexOf("async claimedIds()"),
      classBody.indexOf("async epicMembers()"),
    );
    expect(listFn).toMatch(/if \(isChangeSet\(parsed, slot\.entry\.meta\)\) continue;/);
    expect(claimedFn).toMatch(/field: "meta\.workType", eq: "change-set"/);
    expect(claimedFn).not.toMatch(/isChangeSet/);
    expect(SRC).toMatch(/export const CHANGE_SET_WORK_TYPE = "change-set"/);
  });

  test("Honesty: CS without pull sourceUrl does not claim the parent (old GitHub color)", async () => {
    const parentDid = "did:example:unclaimed-parent";
    const csDid = "did:example:cs-nopr";
    const parentId = "w_plain";
    const ops = claimedFixtureOps([
      {
        path: `/work/${parentId}.json`,
        content: { ...PLANNED, name: "plain", objectId: parentDid },
        meta: {
          contentType: "work",
          objectId: parentDid,
          creativeWorkStatus: "planned",
        },
      },
      {
        path: "/work/w_cs_nopr.json",
        content: {
          name: "cs",
          objectId: csDid,
          workType: CHANGE_SET_WORK_TYPE,
          creativeWorkStatus: "idea",
        },
        meta: {
          contentType: "work",
          objectId: csDid,
          workType: CHANGE_SET_WORK_TYPE,
          creativeWorkStatus: "idea",
        },
      },
      {
        path: "/work/r_nopr.json",
        meta: {
          predicate: "spun-off-from",
          subjectDid: csDid,
          objectDid: parentDid,
        },
      },
    ]);
    const src = new WorkObjectSource(ops);
    const claimed = await src.claimedIds();
    expect(claimed.has(parentId)).toBe(false);
    expect(isProjectedPullUrl("https://github.com/ArcBlock/arc/issues/6000")).toBe(false);
    const classBody = SRC.slice(SRC.indexOf("export class WorkObjectSource"));
    const claimedFn = classBody.slice(
      classBody.indexOf("async claimedIds()"),
      classBody.indexOf("async epicMembers()"),
    );
    expect(claimedFn).toMatch(/isProjectedPullUrl/);
    expect(claimedFn).toMatch(/sourceUrl/);
    expect(claimedFn).not.toMatch(/Bun\.spawnSync/);
    expect(claimedFn).not.toMatch(/\bgh\(\[/);
  });

  test("ACCEPT: drain-claimed (active) work is still claimed without a PR", async () => {
    const did = "did:example:active";
    const id = "w_active";
    const src = new WorkObjectSource(
      claimedFixtureOps([
        {
          path: `/work/${id}.json`,
          content: { ...PLANNED, name: "active", objectId: did, creativeWorkStatus: "active" },
          meta: {
            contentType: "work",
            objectId: did,
            creativeWorkStatus: "active",
          },
        },
      ]),
    );
    const claimed = await src.claimedIds();
    expect(claimed.has(id)).toBe(true);
  });
});
