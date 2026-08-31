/**
 * 全局分类 —— 本 skill 的实质。
 *
 * 「epic 构建器」是它的一个输出形态，不是它本身。真正在做的事是：
 * **给存量里的每一条工作项确定它属于哪一类、在那类的哪一簇，并知道这个结论什么时候失效。**
 * epic 只是「一簇 bug 且路径面不相交」时的产物。
 *
 * ## 两个泛化
 *
 * **一、分类轴按类型不同。** bug 按「缺陷层」聚——判据是能否被同一个修复方向覆盖。
 * 这条判据对 feature / idea **不成立**（它们没有缺陷），硬套上去会把「同一个产品面的
 * 两个不同主张」当成一簇。所以每种类型有自己的轴和自己的聚簇判据。
 *
 * **二、失效有三个来源，不只是「自己变了」。**
 *
 * | 来源 | 信号 |
 * |---|---|
 * | 自身变了 | fingerprint（正文 + label） |
 * | **邻域变了** | issue-graph 的 `kicks`：邻居关闭 / 被解锁 |
 * | 从未分类 | 记录里没有 layer |
 *
 * 第二条是 GitHub label **给不出**的：一条 issue 可以一个字没改，而它依赖的那条已经
 * 合了——过去的分类可能已经不成立。这正是 graph（将来是 work object 的关系边）
 * 相对 label 的不可比优势。
 */

export type WorkType = "bug" | "feature" | "idea" | "research" | "report" | "untyped";

/** 每种类型的分类轴。untyped 没有轴——必须先定类型。 */
export type Axis = "defectLayer" | "capabilityArea" | "openQuestion";

const TYPE_LABELS: [WorkType, string[]][] = [
  // report 最优先：自动生成的 QA 报告不是「有人开的工作项」，有自己的处理通道。
  // 实测回归——#5625 同时挂 bug + nightly-test-report，若让 bug 赢就会混进分类。
  ["report", ["nightly-test-report", "test-sweep-report"]],
  // 其次 bug：一条同时挂 bug 和 idea 时按 bug 处理（缺陷的判据更硬）
  ["bug", ["bug"]],
  ["research", ["research"]],
  ["feature", ["feature", "enhancement"]],
  ["idea", ["idea"]],
];

export function typeOf(labels: string[]): WorkType {
  const L = new Set(labels);
  for (const [t, keys] of TYPE_LABELS) if (keys.some((k) => L.has(k))) return t;
  // 无类型标签不得默默当成 bug——arc 实测近 14 天新建的 34% 属于这一类，
  // 把它们塞进 bug 的轴会污染缺陷层的聚簇。
  return "untyped";
}

export function axisFor(t: WorkType): Axis | null {
  switch (t) {
    case "bug":
      return "defectLayer";
    case "feature":
    case "idea":
      return "capabilityArea";
    case "research":
      return "openQuestion";
    // report 与 untyped 都没有轴：前者不是工作项，后者必须先定类型。
    default:
      return null;
  }
}

/**
 * 聚簇判据 —— 一句可回答的问题，不是一个形容词。
 * 每种类型必须给出**不同**的问题；用同一句话套所有类型就等于没有分轴。
 */
export function groupingQuestion(t: WorkType): string {
  switch (t) {
    case "bug":
      return "这几条能不能被同一个修复方向覆盖？不能就不是同一层。";
    case "feature":
    case "idea":
      return "这几条会不会被同一次设计决定一起决定掉？不会就不是同一个能力面。";
    case "research":
      return "这几条会不会被同一次调查一起回答？不会就不是同一个待答问题。";
    default:
      return "";
  }
}

/* ===== 失效判定 ===== */

export interface ClassificationRecord {
  issue: number;
  fingerprint: string;
  classifiedAt: string;
  /** null = 从未分类过 */
  layer: string | null;
  type?: WorkType;
  epic?: number | null;
}

/** 来自 issue-graph 的邻域信号（graph-scan 的 kicks / blocked 计算）。 */
export interface Neighborhood {
  /** 近窗口内关闭的邻居（父 / 子 / blocker） */
  closedNeighbors: number[];
  /** 因某条关闭而被解锁 */
  unblockedBy: number[];
  /** 分类之后出现过新的人类输入 */
  newHumanInput: boolean;
}

/**
 * 返回**所有**需要重新分类的理由（不短路——多个理由要同时看得见，
 * 否则重验完一条又被另一条重新触发，会来回跑）。
 * 空数组 = 可以跳过。**跳过是效率的全部来源，所以这个函数必须真的能返回空。**
 */
export function revalidationReasons(
  rec: ClassificationRecord,
  currentFingerprint: string,
  nb: Neighborhood,
  ttlDays: number,
  now: Date,
): string[] {
  const out: string[] = [];
  const neverClassified = !rec.layer;
  if (neverClassified) out.push("从未分类过（记录里没有 layer）");
  if (rec.fingerprint !== currentFingerprint) out.push("正文或 label 变了（指纹不符）");
  if (nb.closedNeighbors.length > 0)
    out.push(`邻域变了：邻居 ${nb.closedNeighbors.join(", ")} 已关闭`);
  if (nb.unblockedBy.length > 0) out.push(`被解锁：${nb.unblockedBy.join(", ")} 关闭后本条可动`);
  if (nb.newHumanInput) out.push("分类之后有新的人类输入");
  // 从未分类过就没有「旧」这回事——同时报 TTL 会把「没有分类」说成「分类旧了」，
  // 并且从 epoch 算出的天数（20696 天）看起来像 bug。
  if (!neverClassified) {
    const ageDays = (now.getTime() - new Date(rec.classifiedAt).getTime()) / 86_400_000;
    if (ageDays > ttlDays) out.push(`分类已过 TTL（${Math.round(ageDays)} 天 > ${ttlDays} 天）`);
  }
  return out;
}

/** 三种运行模式。 */
export type Mode =
  /** 只处理从未分类的 —— 反复归类没动的东西是纯浪费 */
  | "new"
  /** 只重验已分类的 —— 世界变了之后看旧结论还成不成立 */
  | "revalidate"
  /** 两者都做 */
  | "all";

export function shouldProcess(mode: Mode, everClassified: boolean, reasons: string[]): boolean {
  if (mode === "new") return !everClassified;
  if (mode === "revalidate") return everClassified && reasons.length > 0;
  return reasons.length > 0;
}
