/**
 * 手写 Model 的共用零件。五种形态各自一份文件，这里只放构造，不放「满仓」数据。
 */
import { AGE_BUCKETS } from "../health";
import type { HtmlItem, Model, Overview, OverviewSeries } from "../html";

export { AGE_BUCKETS };

const TYPES = ["bug", "feature", "idea", "research", "symptom", "report", "untyped"] as const;

const ZERO3 = { opened: [0, 0, 0], closed: [0, 0, 0], stock: [0, 0, 0] };

export function item(over: Partial<HtmlItem> & Pick<HtmlItem, "id">): HtmlItem {
  const id = String(over.id);
  return {
    title: `item-${id}`,
    type: "bug",
    selected: true,
    lanes: ["scripts"],
    files: [`scripts/item-${id}.ts`],
    surfaceState: "measured",
    reasons: [],
    epic: null,
    url: `https://example.test/issues/${id}`,
    ageBucket: "<1d",
    ...over,
    id,
  };
}

export function emptyByType(): Overview["byType"] {
  return Object.fromEntries(TYPES.map((t) => [t, { open: 0, closed: 0 }]));
}

export function zeroSeries(): OverviewSeries {
  return {
    labels: ["d1", "d2", "d3"],
    opened: [0, 0, 0],
    closed: [0, 0, 0],
    stock: [0, 0, 0],
    byType: Object.fromEntries(TYPES.map((t) => [t, { ...ZERO3 }])),
  };
}

/** 四种粒度共用同一份 day 序列 —— fixture 不测切粒度，只避免点 gtab 时 series[gran] 是 undefined。 */
export function allGranularity(day: OverviewSeries): Overview["series"] {
  return { hour: day, day, week: day, month: day };
}

export function flowDay(partial: {
  opened: number[];
  closed: number[];
  stock: number[];
  byType: Record<string, { opened: number[]; closed: number[]; stock: number[] }>;
}): OverviewSeries {
  const z = { opened: [0, 0, 0], closed: [0, 0, 0], stock: [0, 0, 0] };
  return {
    labels: ["d1", "d2", "d3"],
    opened: partial.opened,
    closed: partial.closed,
    stock: partial.stock,
    byType: {
      ...Object.fromEntries(TYPES.map((t) => [t, z])),
      ...partial.byType,
    },
  };
}

export function baseModel(over: Partial<Model> = {}): Model {
  const day = zeroSeries();
  return {
    generatedAt: "2026-09-01 00:00",
    repo: "example/fixture-repo",
    source: "github:example/fixture-repo",
    types: ["bug"],
    mode: "all",
    capabilities: {
      pushdown: false,
      incremental: false,
      writableClassification: false,
      neighborhood: false,
    },
    totals: { all: 0, candidates: 0, selected: 0, skipped: 0 },
    items: [],
    epics: [],
    overlaps: [],
    ageScale: [...AGE_BUCKETS],
    overview: {
      total: 0,
      byType: emptyByType(),
      unknownTypes: [],
      series: allGranularity(day),
      windowNote: "fixture window",
    },
    ...over,
  };
}
