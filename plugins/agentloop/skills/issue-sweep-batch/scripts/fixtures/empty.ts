/**
 * empty —— 模型里一条工作项都没有。
 * 走 agingRow 的 `!items.length`：七根零高柱 + 「这个筛选下没有工作项」，不是「未采集」。
 */
import { baseModel } from "./lib";

export const empty = baseModel();
