/**
 * single-bin —— 全部工作项落在最年轻的一档。
 * 最老的非空档是 <1d，用冷色 --a0：这在一个全是新 issue 的仓库里是合法的。
 * 「最老非空必须热色」这条库存假设在这里必须红。
 */
import { allGranularity, baseModel, emptyByType, flowDay, item } from "./lib";

const items = [
  item({ id: "201", title: "fresh-alpha", type: "bug", ageBucket: "<1d" }),
  item({ id: "202", title: "fresh-beta", type: "feature", ageBucket: "<1d" }),
  item({ id: "203", title: "fresh-gamma", type: "bug", ageBucket: "<1d" }),
];

const day = flowDay({
  opened: [2, 1, 0],
  closed: [0, 1, 0],
  stock: [2, 2, 3],
  byType: {
    bug: { opened: [1, 1, 0], closed: [0, 1, 0], stock: [1, 1, 2] },
    feature: { opened: [1, 0, 0], closed: [0, 0, 0], stock: [1, 1, 1] },
  },
});

export const singleBin = baseModel({
  totals: { all: 3, candidates: 3, selected: 3, skipped: 0 },
  items,
  overview: {
    total: 3,
    byType: {
      ...emptyByType(),
      bug: { open: 2, closed: 0 },
      feature: { open: 1, closed: 0 },
    },
    unknownTypes: [],
    series: allGranularity(day),
    windowNote: "fixture window",
  },
});
