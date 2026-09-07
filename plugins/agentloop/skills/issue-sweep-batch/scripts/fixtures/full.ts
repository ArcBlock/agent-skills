/**
 * full —— 多档有数、多档为空、多种类型、最老档是 >90d。
 * 走「正常画柱 + 空档占位 + 点开对账 + 类型色/热度色」那一支。
 */
import { allGranularity, baseModel, emptyByType, flowDay, item } from "./lib";

const items = [
  item({
    id: "101",
    title: "alpha-widget",
    type: "bug",
    ageBucket: "<1d",
    lanes: ["scripts", "providers"],
    files: ["scripts/a.ts", "providers/b.ts"],
  }),
  item({ id: "102", title: "beta-router", type: "bug", ageBucket: "3-7d" }),
  item({
    id: "103",
    title: "gamma-store",
    type: "feature",
    ageBucket: "7-14d",
    lanes: ["blocklets"],
    files: ["blocklets/x/index.ts"],
  }),
  item({ id: "104", title: "delta-cache", type: "bug", ageBucket: "14-30d" }),
  item({ id: "105", title: "omega-kernel", type: "feature", ageBucket: ">90d" }),
  item({ id: "106", title: "omega-runtime", type: "bug", ageBucket: ">90d" }),
];
// 空档：1-3d、30-90d。非空：<1d、3-7d、7-14d、14-30d、>90d。

const day = flowDay({
  opened: [3, 1, 2],
  closed: [1, 2, 2],
  stock: [10, 9, 9],
  byType: {
    bug: { opened: [2, 0, 1], closed: [1, 1, 1], stock: [6, 5, 5] },
    feature: { opened: [1, 1, 1], closed: [0, 1, 1], stock: [4, 4, 4] },
  },
});

export const full = baseModel({
  totals: { all: 6, candidates: 6, selected: 6, skipped: 0 },
  items,
  overview: {
    total: 6,
    byType: {
      ...emptyByType(),
      bug: { open: 4, closed: 1 },
      feature: { open: 2, closed: 1 },
    },
    unknownTypes: [],
    series: allGranularity(day),
    windowNote: "fixture window",
  },
});
