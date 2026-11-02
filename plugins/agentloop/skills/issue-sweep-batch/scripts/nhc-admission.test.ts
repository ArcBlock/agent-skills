import { describe, expect, test } from "bun:test";
import {
  humanBlockOf,
  judgeNhcLabel,
  labelEvidenceFromTimeline,
  NHC_LABEL,
  NHC_MAX_AGE_DAYS,
  parseR2Line,
  R2_CATEGORIES,
} from "./nhc-admission";

// R-5 放大器 / R-11（nhc 审计）：needs-human-confirm 只有在贴标评论首行写明 R2 类别、
// 且贴标不超过 7 天时，才把 issue 挡在可派 epic 之外。其余（没写类别、过期）交评判团 / portfolio 复判。

const ID =
  "> 🤖 AI Agent nhc 根因修复 @ host · runner:x · agentloop@0.46.3 · skill:land · engine:claude";
const NOW = new Date("2026-10-25T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

describe("parseR2Line", () => {
  test("ACCEPT: the first line after the identity line names an R2 category; the rest is free text", () => {
    expect(parseR2Line(`${ID}\n\nR2: permission — 给工厂建独立 PAT\n\n正文`)).toEqual({
      category: "permission",
      text: "给工厂建独立 PAT",
    });
  });

  test("ACCEPT: a person's comment (no identity line): the first non-empty line", () => {
    expect(parseR2Line("\n  R2: spend\nwe pay for it")).toEqual({ category: "spend", text: "" });
  });

  test("ACCEPT: every category of the closed list parses", () => {
    expect(R2_CATEGORIES).toEqual([
      "breaking",
      "release",
      "external-commitment",
      "market",
      "permission",
      "spend",
      "deploy-prod",
      "data-delete",
      "r2-list",
      "merge-criteria",
    ]);
    for (const c of R2_CATEGORIES) expect(parseR2Line(`${ID}\nR2: ${c}`)?.category).toBe(c);
  });

  test("REJECT: an unknown category → none (unsure is not R2)", () => {
    expect(parseR2Line(`${ID}\nR2: direction — A or B`)).toBeUndefined();
  });

  test("REJECT: the R2 line is not the first line after the identity line → none", () => {
    expect(parseR2Line(`${ID}\n需要人拍板\nR2: permission`)).toBeUndefined();
  });

  test("REJECT: no R2 line at all (the old template) → none", () => {
    expect(parseR2Line(`${ID}\n\n流程立法：合并前要人点头`)).toBeUndefined();
    expect(parseR2Line("")).toBeUndefined();
  });
});

describe("judgeNhcLabel", () => {
  test("ACCEPT: labelled 2h ago with an R2 comment next to it → valid, with its category", () => {
    const j = judgeNhcLabel(
      {
        labeledAt: hoursAgo(2),
        comments: [{ body: `${ID}\nR2: release — 发布节奏`, createdAt: hoursAgo(2.01) }],
      },
      NOW,
    );
    expect(j).toEqual({ valid: true, category: "release" });
  });

  test("REJECT: older than 7 days, even with the R2 line → stale (re-judged, never excluded forever)", () => {
    expect(NHC_MAX_AGE_DAYS).toBe(7);
    const j = judgeNhcLabel(
      {
        labeledAt: hoursAgo(7 * 24 + 1),
        comments: [{ body: `${ID}\nR2: permission`, createdAt: hoursAgo(7 * 24 + 1) }],
      },
      NOW,
    );
    expect(j).toEqual({ valid: false, why: "stale" });
  });

  test("ACCEPT TWIN: exactly 7 days is not yet older than 7 days", () => {
    const j = judgeNhcLabel(
      {
        labeledAt: hoursAgo(7 * 24),
        comments: [{ body: `${ID}\nR2: permission`, createdAt: hoursAgo(7 * 24) }],
      },
      NOW,
    );
    expect(j).toEqual({ valid: true, category: "permission" });
  });

  test("REJECT: the comment by the label has no R2 line → no-r2-category", () => {
    const j = judgeNhcLabel(
      {
        labeledAt: hoursAgo(1),
        comments: [{ body: `${ID}\n有推荐但不代为拍板`, createdAt: hoursAgo(1) }],
      },
      NOW,
    );
    expect(j).toEqual({ valid: false, why: "no-r2-category" });
  });

  test("REJECT: an R2 comment far from the label (another day) is not the label's comment", () => {
    const j = judgeNhcLabel(
      {
        labeledAt: hoursAgo(1),
        comments: [{ body: `${ID}\nR2: spend`, createdAt: hoursAgo(30) }],
      },
      NOW,
    );
    expect(j).toEqual({ valid: false, why: "no-r2-category" });
  });

  test("the nearest comment to the label decides: a later plain comment does not undo the R2 one", () => {
    const j = judgeNhcLabel(
      {
        labeledAt: hoursAgo(3),
        comments: [
          { body: `${ID}\nR2: breaking — 删 v1 API`, createdAt: hoursAgo(3) },
          { body: "ping", createdAt: hoursAgo(1) },
        ],
      },
      NOW,
    );
    expect(j).toEqual({ valid: true, category: "breaking" });
  });

  test("REJECT: no label time known → unverified", () => {
    expect(judgeNhcLabel({ comments: [] }, NOW)).toEqual({ valid: false, why: "unverified" });
  });
});

describe("labelEvidenceFromTimeline (GitHub issue timeline)", () => {
  test("the LAST labeled event of the label, and every comment", () => {
    const ev = labelEvidenceFromTimeline(
      [
        { event: "labeled", label: { name: NHC_LABEL }, created_at: "2026-08-01T00:00:00Z" },
        { event: "unlabeled", label: { name: NHC_LABEL }, created_at: "2026-08-02T00:00:00Z" },
        { event: "commented", body: "R2: spend", created_at: "2026-10-20T00:00:00Z" },
        { event: "labeled", label: { name: NHC_LABEL }, created_at: "2026-10-20T00:01:00Z" },
        { event: "labeled", label: { name: "bug" }, created_at: "2026-10-21T00:00:00Z" },
      ],
      NHC_LABEL,
    );
    expect(ev).toEqual({
      labeledAt: "2026-10-20T00:01:00Z",
      comments: [{ body: "R2: spend", createdAt: "2026-10-20T00:00:00Z" }],
    });
  });

  test("no labeled event for the label → no labeledAt", () => {
    expect(labelEvidenceFromTimeline([], NHC_LABEL)).toEqual({ comments: [] });
  });
});

describe("humanBlockOf — the candidate gate of sweep-batch", () => {
  const valid = async () => ({
    labeledAt: hoursAgo(1),
    comments: [{ body: `${ID}\nR2: permission`, createdAt: hoursAgo(1) }],
  });
  const stale = async () => ({
    labeledAt: hoursAgo(24 * 30),
    comments: [{ body: `${ID}\n流程立法：合并前要人点头`, createdAt: hoursAgo(24 * 30) }],
  });

  test("ACCEPT (excluded): a valid R2 label keeps the issue out, naming the category", async () => {
    expect(await humanBlockOf(["bug", NHC_LABEL], valid, NOW)).toEqual({
      blocked: true,
      reason: "needs-human-confirm（R2: permission）",
    });
  });

  test("REJECT (not excluded): a stale, category-less label no longer excludes; the note says why", async () => {
    expect(await humanBlockOf([NHC_LABEL], stale, NOW)).toEqual({
      blocked: false,
      note: "needs-human-confirm 失效（stale）：交评判团 / portfolio 复判",
    });
  });

  test("evidence unreadable → still excluded, in its own visible bucket (never silently admitted)", async () => {
    const r = await humanBlockOf(
      [NHC_LABEL],
      async () => {
        throw new Error("gh: 502");
      },
      NOW,
    );
    expect(r).toEqual({ blocked: true, reason: "needs-human-confirm 未能核验（gh: 502）" });
  });

  test("needs-decision and agent:hold are unchanged: excluded without reading evidence", async () => {
    let read = 0;
    const counting = async () => {
      read++;
      return { comments: [] };
    };
    expect(await humanBlockOf(["needs-decision"], counting, NOW)).toEqual({
      blocked: true,
      reason: "needs-decision",
    });
    expect(await humanBlockOf(["agent:hold", NHC_LABEL], counting, NOW)).toEqual({
      blocked: true,
      reason: "agent:hold",
    });
    expect(read).toBe(0);
  });

  test("no human label → not blocked, no note", async () => {
    expect(await humanBlockOf(["bug"], valid, NOW)).toEqual({ blocked: false });
  });
});

describe("R2 categories added by PR-L review", () => {
  test("ACCEPT: deploy-prod and data-delete parse; REJECT TWIN: deploy (not prod) does not", () => {
    expect(parseR2Line(`${ID}\nR2: deploy-prod — 上生产`)?.category).toBe("deploy-prod");
    expect(parseR2Line("R2: data-delete")?.category).toBe("data-delete");
    expect(parseR2Line("R2: deploy")).toBeUndefined();
  });
});

describe("panel P3 — any R2 comment in the window counts, preferring one at/after the label", () => {
  test("ACCEPT: a plain comment nearest the label does not hide an R2 comment 30 min later", () => {
    const j = judgeNhcLabel(
      {
        labeledAt: hoursAgo(2),
        comments: [
          { body: "ping", createdAt: hoursAgo(2.001) },
          { body: `${ID}\nR2: spend — 买 GPU`, createdAt: hoursAgo(1.5) },
        ],
      },
      NOW,
    );
    expect(j).toEqual({ valid: true, category: "spend" });
  });

  test("prefers the R2 comment at/after the label over one just before it", () => {
    const j = judgeNhcLabel(
      {
        labeledAt: hoursAgo(2),
        comments: [
          { body: "R2: market", createdAt: hoursAgo(2.01) },
          { body: "R2: release", createdAt: hoursAgo(1.9) },
        ],
      },
      NOW,
    );
    expect(j).toEqual({ valid: true, category: "release" });
  });

  test("REJECT TWIN: an R2 comment outside the window still does not count", () => {
    const j = judgeNhcLabel(
      {
        labeledAt: hoursAgo(2),
        comments: [
          { body: "ping", createdAt: hoursAgo(2) },
          { body: "R2: spend", createdAt: hoursAgo(0.5) },
        ],
      },
      NOW,
    );
    expect(j).toEqual({ valid: false, why: "no-r2-category" });
  });
});
