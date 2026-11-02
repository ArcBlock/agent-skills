/**
 * needs-human-confirm admission (nhc audit R-5 amplifier + R-11, 2026-10-25).
 *
 * The label is valid only for an R2 decision: the comment posted with it
 * names the R2 category on its first line after the agent identity line
 * (`> 🤖 AI Agent …`), or on its first non-empty line when a person wrote it:
 *
 *     R2: <category>[ — free text]
 *
 * A label whose comment has no such line, or one older than
 * {@link NHC_MAX_AGE_DAYS} days, no longer keeps an issue out of a
 * dispatchable epic: it goes back to the jury / portfolio to be re-judged.
 * A wrong label must never exclude forever.
 *
 * Reusable: other tools import the parser from here.
 */

export const NHC_LABEL = "needs-human-confirm";

/** Days after which a needs-human-confirm label is re-judged instead of honoured. */
export const NHC_MAX_AGE_DAYS = 7;

// The closed R2 list: one source, pinned to reference/r2-admission.md's table.
import { R2_CATEGORIES, type R2Category } from "../../../lib/r2-categories";

export { R2_CATEGORIES, type R2Category };

/** How far (either side) a comment may be from the label event and still be its comment. */
const LABEL_COMMENT_WINDOW_MS = 60 * 60 * 1000;

const IDENTITY_LINE = /^>\s*🤖\s*AI Agent\b/;
const R2_LINE = /^R2:\s*([a-z0-9-]+)\s*(?:[—–:-]+\s*(.*))?$/i;

/** The R2 category a comment declares, or undefined. */
export function parseR2Line(body: string): { category: R2Category; text: string } | undefined {
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const first = lines[0] !== undefined && IDENTITY_LINE.test(lines[0]) ? lines[1] : lines[0];
  if (first === undefined) return undefined;
  const m = first.match(R2_LINE);
  if (!m) return undefined;
  const category = (m[1] ?? "").toLowerCase();
  if (!(R2_CATEGORIES as readonly string[]).includes(category)) return undefined;
  return { category: category as R2Category, text: (m[2] ?? "").trim() };
}

export interface LabelEvidence {
  /** When the label was (last) added; absent = unknown. */
  labeledAt?: string;
  comments: Array<{ body: string; createdAt: string }>;
}

export type NhcJudgement =
  | { valid: true; category: R2Category }
  | { valid: false; why: "stale" | "no-r2-category" | "unverified" };

/** Is this needs-human-confirm label a valid R2 exclusion right now? */
export function judgeNhcLabel(ev: LabelEvidence, now: Date): NhcJudgement {
  const at = ev.labeledAt ? Date.parse(ev.labeledAt) : Number.NaN;
  if (!Number.isFinite(at)) return { valid: false, why: "unverified" };
  if (now.getTime() - at > NHC_MAX_AGE_DAYS * 24 * 3600_000) return { valid: false, why: "stale" };
  // The label's comment: any comment within the window that names an R2
  // category, preferring one at/after the label (the explanation usually
  // follows it), then the nearest before it.
  let best: { category: R2Category; after: boolean; d: number } | undefined;
  for (const c of ev.comments) {
    const t = Date.parse(c.createdAt);
    if (!Number.isFinite(t)) continue;
    const d = Math.abs(t - at);
    if (d > LABEL_COMMENT_WINDOW_MS) continue;
    const r2 = parseR2Line(c.body);
    if (!r2) continue;
    const after = t >= at;
    if (!best || (after && !best.after) || (after === best.after && d < best.d)) {
      best = { category: r2.category, after, d };
    }
  }
  return best ? { valid: true, category: best.category } : { valid: false, why: "no-r2-category" };
}

/** GitHub issue timeline (`gh api repos/{o}/{r}/issues/{n}/timeline`) → evidence for `label`. */
export function labelEvidenceFromTimeline(
  events: readonly unknown[],
  label: string,
): LabelEvidence {
  const out: LabelEvidence = { comments: [] };
  for (const raw of events) {
    const e = raw as {
      event?: unknown;
      label?: { name?: unknown };
      created_at?: unknown;
      body?: unknown;
    };
    if (typeof e.created_at !== "string") continue;
    if (e.event === "labeled" && e.label?.name === label) out.labeledAt = e.created_at;
    if (e.event === "commented" && typeof e.body === "string") {
      out.comments.push({ body: e.body, createdAt: e.created_at });
    }
  }
  return out;
}

/** Labels that keep an issue out without further evidence (a person's hold, an attention flag). */
const ALWAYS_BLOCKING = ["agent:hold", "needs-decision"];

export type HumanBlock = { blocked: true; reason: string } | { blocked: false; note?: string };

/**
 * sweep-batch's candidate gate. `evidence` is read only for a
 * needs-human-confirm label; when it cannot be read the issue stays out, in
 * its own bucket (visible, never silently admitted).
 */
export async function humanBlockOf(
  labels: readonly string[],
  evidence: () => Promise<LabelEvidence>,
  now: Date,
): Promise<HumanBlock> {
  const hold = ALWAYS_BLOCKING.find((l) => labels.includes(l));
  if (hold) return { blocked: true, reason: hold };
  if (!labels.includes(NHC_LABEL)) return { blocked: false };
  let ev: LabelEvidence;
  try {
    ev = await evidence();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { blocked: true, reason: `${NHC_LABEL} 未能核验（${why}）` };
  }
  const j = judgeNhcLabel(ev, now);
  if (j.valid) return { blocked: true, reason: `${NHC_LABEL}（R2: ${j.category}）` };
  if (j.why === "unverified")
    return { blocked: true, reason: `${NHC_LABEL} 未能核验（无贴标时间）` };
  return { blocked: false, note: `${NHC_LABEL} 失效（${j.why}）：交评判团 / portfolio 复判` };
}
