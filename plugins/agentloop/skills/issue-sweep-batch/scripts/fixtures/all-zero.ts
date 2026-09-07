/**
 * all-zero —— 模型里有工作项，但选一个零存量类型（symptom）之后所有档都是 0。
 * 入口与 empty 不同：筛选前有可点柱；筛选后走空筛选分支，bars()[0] 必须是空而不是崩。
 * 不得走进「未采集」。
 */
import { allGranularity, baseModel, emptyByType, flowDay, item } from "./lib";

const items = [
  item({ id: "301", title: "only-bug-one", type: "bug", ageBucket: "3-7d" }),
  item({ id: "302", title: "only-bug-two", type: "bug", ageBucket: "7-14d" }),
];

const day = flowDay({
  opened: [1, 1, 0],
  closed: [0, 0, 1],
  stock: [2, 3, 2],
  byType: {
    bug: { opened: [1, 1, 0], closed: [0, 0, 1], stock: [2, 3, 2] },
  },
});

export const allZero = baseModel({
  totals: { all: 2, candidates: 2, selected: 2, skipped: 0 },
  items,
  overview: {
    total: 2,
    byType: {
      ...emptyByType(),
      bug: { open: 2, closed: 1 },
    },
    unknownTypes: [],
    series: allGranularity(day),
    windowNote: "fixture window",
  },
});
