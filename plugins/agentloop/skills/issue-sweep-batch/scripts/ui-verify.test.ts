import { describe, expect, test } from "bun:test";
import { allZero } from "./fixtures/all-zero";
import { empty } from "./fixtures/empty";
import { full } from "./fixtures/full";
import { singleBin } from "./fixtures/single-bin";
import { uncollected } from "./fixtures/uncollected";
import { renderHtml } from "./html";
import { loadParseHTML, MODELS, parseArgv, runLive, runShape } from "./ui-verify.mjs";

const parseHTML = await loadParseHTML();

const byName = {
  full,
  empty,
  "single-bin": singleBin,
  "all-zero": allZero,
  uncollected,
} as const;

describe("ui-verify 五种手写 Model", () => {
  test("registry 正好是五份，不是一份大 fixture", () => {
    expect(Object.keys(MODELS).sort()).toEqual(
      ["all-zero", "empty", "full", "single-bin", "uncollected"].sort(),
    );
  });

  for (const name of Object.keys(byName) as (keyof typeof byName)[]) {
    test(`fixture ${name}`, () => {
      const r = runShape(name, renderHtml(byName[name]), parseHTML);
      expect(r.fails).toBe(0);
    });
  }
});

describe("活数据一轮降级为结构性检查", () => {
  test("五种形态都过 —— 否则它还在编码库存", () => {
    for (const model of Object.values(byName)) {
      const r = runLive(renderHtml(model), parseHTML);
      expect(r.fails).toBe(0);
    }
  });

  test("剥掉标签页 → live 必须红（探针零命中不是 skip）", () => {
    const html = renderHtml(full).replace(/<div class="tab\b[^>]*>[\s\S]*?<\/div>/g, "");
    const r = runLive(html, parseHTML);
    expect(r.fails).toBeGreaterThan(0);
  });

  test("data-v 改名只留 overview+global → 缺的标签必须红，不是 continue 变绿", () => {
    const html = renderHtml(full)
      .replace('data-v="epics"', 'data-v="gone-epics"')
      .replace('data-v="trace"', 'data-v="gone-trace"');
    const r = runLive(html, parseHTML);
    expect(r.fails).toBeGreaterThan(0);
  });

  test("剥掉搜索框 → live 必须红", () => {
    const html = renderHtml(full).replace(/<input id="q"[^>]*>/, "");
    const r = runLive(html, parseHTML);
    expect(r.fails).toBeGreaterThan(0);
  });
});

describe("parseArgv fail-closed", () => {
  test("--shape 少给值", () => {
    expect(parseArgv(["--shape"]).error).toContain("--shape");
  });
  test("--shape=empty 认成 empty，不是静默全跑", () => {
    expect(parseArgv(["--shape=empty"])).toEqual({ shape: "empty", htmlFile: null, error: null });
  });
  test("--shape empty 认成 empty", () => {
    expect(parseArgv(["--shape", "empty"])).toEqual({
      shape: "empty",
      htmlFile: null,
      error: null,
    });
  });
});
