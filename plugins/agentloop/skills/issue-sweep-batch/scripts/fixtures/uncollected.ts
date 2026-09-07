/**
 * uncollected —— 有工作项，但 ageBucket 是 null（源不提供 timeline）。
 * 走 agingRow 的 `!counted.length`：「未采集」note，不画七根零柱。
 * 与 empty / all-zero 的空筛选分支必须不同色。
 */
import { allGranularity, baseModel, emptyByType, flowDay, item } from "./lib";

const items = [
  item({ id: "401", title: "no-timeline-one", type: "bug", ageBucket: null }),
  item({ id: "402", title: "no-timeline-two", type: "feature", ageBucket: null }),
];

const day = flowDay({
  opened: [1, 0, 1],
  closed: [0, 1, 0],
  stock: [1, 1, 2],
  byType: {
    bug: { opened: [1, 0, 0], closed: [0, 1, 0], stock: [1, 0, 1] },
    feature: { opened: [0, 0, 1], closed: [0, 0, 0], stock: [0, 1, 1] },
  },
});

export const uncollected = baseModel({
  totals: { all: 2, candidates: 2, selected: 2, skipped: 0 },
  items,
  overview: {
    total: 2,
    byType: {
      ...emptyByType(),
      bug: { open: 1, closed: 0 },
      feature: { open: 1, closed: 0 },
    },
    unknownTypes: [],
    series: allGranularity(day),
    windowNote: "fixture window",
  },
});
