import { describe, expect, it } from "bun:test";
import { prReviewRound, roundsFromComments } from "./pr-review-round.ts";

const trace = (o: Record<string, unknown>) => `<!-- sweep-trace: ${JSON.stringify(o)} -->`;
const verdict = (round: number, val = "COMMENT") =>
  `<!-- pr-review-verdict -->\n结论…\n${trace({ ver: 1, pr: 1, gate: "verdict", val, sha: "a".repeat(40), round })}`;

describe("roundsFromComments", () => {
  it("★ ACCEPT：读出 round —— 没有这一臂，一个恒返回 0 的实现满足全部 REJECT 断言", () => {
    expect(roundsFromComments([verdict(3)])).toEqual({ round: 3, traces: 1, malformed: 0 });
  });

  it("★ 没有 trace ⇒ 0（真的还没审过）", () => {
    expect(roundsFromComments(["普通评论", "> 🤖 AI Agent …"])).toEqual({
      round: 0,
      traces: 0,
      malformed: 0,
    });
  });

  it("★★ 取 MAX 不取最后一条 —— 否则再发一条低轮次的 trace 就能把上限绕过去", () => {
    expect(roundsFromComments([verdict(3), verdict(1)]).round).toBe(3);
  });

  it("★★ 坏掉的 trace 单独计数，不冒充「第 0 轮」", () => {
    const broken = "<!-- sweep-trace: {不是json} -->";
    const r = roundsFromComments([broken]);
    expect(r.round).toBe(0);
    expect(r.malformed).toBe(1); // ← 这个字段就是「0 是数出来的还是坏出来的」的分色器
    expect(r.traces).toBe(1);
  });

  it("★ round 类型不对（字符串 / 负数 / 小数）算 malformed，不被当数值采信", () => {
    for (const bad of ['"3"', "-1", "1.5", "null"]) {
      const r = roundsFromComments([`<!-- sweep-trace: {"gate":"verdict","round":${bad}} -->`]);
      expect(r.round).toBe(0);
      expect(r.malformed).toBe(1);
    }
  });

  it("★ 没有 round 字段的旧 trace 不算 malformed —— 它只是旧格式", () => {
    const old = trace({ ver: 1, pr: 1, gate: "verdict", val: "MERGE" });
    expect(roundsFromComments([old])).toEqual({ round: 0, traces: 1, malformed: 0 });
  });

  it("★ 跨多条评论取全局最大", () => {
    expect(roundsFromComments([verdict(1), "噪音", verdict(2)]).round).toBe(2);
  });
});

describe("prReviewRound —— 「读不到」必须与「第 0 轮」分色", () => {
  // 契约是「每行一个 JSON 字符串」（--paginate 下 --jq 逐页输出、直接拼接，
  // 数组过滤器会产生多个 JSON 文档，parse 不了）。fixture 必须照这个形状喂。
  const ok = (out: string) => () => ({ code: 0, out });
  const lines = (...bodies: string[]) => ok(bodies.map((b) => JSON.stringify(b)).join("\n"));

  it("★ ACCEPT：正常读出", () => {
    const r = prReviewRound("6255", lines(verdict(2)));
    expect(r).toMatchObject({ ok: true, round: 2 });
  });

  it("★★ REJECT：gh 失败 ⇒ ok:false，绝不是 round 0", () => {
    const r = prReviewRound("6255", () => ({ code: 1, out: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cannot read/);
  });

  it("★ REJECT：gh 返回的不是 JSON ⇒ ok:false", () => {
    expect(prReviewRound("6255", ok("<html>502</html>")).ok).toBe(false);
  });

  it("★★ 多页拼接（每行一个 body）能读全 —— 高轮次往往在最后一页", () => {
    // 不分页时 gh 只给第一页，而 round 只增不减：被丢掉的恰好是轮次最高的那些，
    // 计数偏低，而偏低正是「你还可以再审一轮」的那个答案。
    const r = prReviewRound("6255", lines(verdict(1), "噪音评论", verdict(4)));
    expect(r).toMatchObject({ ok: true, round: 4 });
  });

  it("★ REJECT：某一行不是 JSON 字符串 ⇒ fail-closed，不是少数几条丢掉", () => {
    const bad = () => ({ code: 0, out: `${JSON.stringify(verdict(3))}\n{"not":"a string"}` });
    expect(prReviewRound("6255", bad).ok).toBe(false);
  });

  it("★ REJECT：PR 号不是数字 ⇒ 不去执行任何命令", () => {
    let called = false;
    const r = prReviewRound("../etc", () => {
      called = true;
      return { code: 0, out: "[]" };
    });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("★ 空评论列表 ⇒ ok:true round=0（这是真的第一轮）", () => {
    expect(prReviewRound("1", ok(""))).toMatchObject({ ok: true, round: 0, traces: 0 });
  });
});
