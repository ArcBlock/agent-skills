#!/usr/bin/env bun
/**
 * bot-clean — decide, mechanically, whether a review bot finished a PR with NO
 * findings, ON THE COMMIT THAT IS HEAD (ArcBlock/arc#6013).
 *
 *   bun bot-clean.ts --pr <n> [--repo owner/name] [--vendor 'login[bot]']
 *
 * With no `--vendor`, every vendor in `RECOGNISED_REVIEW_VENDORS` is judged —
 * including those that left no trace (`absent` is a real per-vendor verdict),
 * not only the ones that happened to appear — one line each, plus a
 * `vendorsSeen=` summary line.
 *
 * Exit 0 = every vendor clean · 1 = some vendor not clean · 2 = usage, or a
 * face could not be fetched (fail-closed).
 *
 * ## The defect this exists to end
 *
 * Codex publishes a summary comment whose only status cell reads
 * `✅ **Completed**`. That means **this review run finished**. It does NOT mean
 * it found nothing — Codex says so itself, in the collapsed note inside the very
 * same comment:
 *
 *   > Codex reacts with 👀 while any review is running, comments if it has
 *   > suggestions, and **reacts with 👍 once all reviews finish with no
 *   > findings**.
 *
 * Two independent pr-review runs read `Completed` as "bot clean" and shipped
 * past **9 findings, 4 of them P1**:
 *
 *   | PR    | codex inline findings | verdict written | lag    |
 *   |-------|-----------------------|-----------------|--------|
 *   | #6009 | 6 (2×P1) at 08:43:57Z | 08:54:21Z       | 10.4 m |
 *   | #6011 | 3 (2×P1) at 09:09:37Z | 09:23:12Z       | 13.6 m |
 *
 * Neither was a race: the findings had existed for ten-plus minutes. The
 * genuinely clean #6097 and the 3-finding #6011 publish summary comments that
 * are identical but for a timestamp and a sha. That byte-identity between
 * "finished, 0 findings" and "finished, 3 findings" is the whole bug — the
 * repo's own 度量正控 shape (#5637 / #5638 / #5639), landed on the INPUT of a
 * merge decision.
 *
 * ## Two more faces of the same bug, found by this PR's adversarial review
 *
 * **The findings are not all on one face.** When Codex cannot attach to diff
 * lines it posts the ENTIRE review as a top-level issue comment
 * (`### 💡 Codex Review`, P-badges and all), which lands in
 * `issues/<n>/comments` — not `pulls/<n>/comments`. Measured live: #5978
 * (a P1 + a P2) and #6015 (a P2) both have an EMPTY inline face. A judge that
 * counts only the inline face prints `botFindings=0` beside a live P1. Both
 * faces are counted here.
 *
 * **The 👍 is per-PR and is never cleared.** It carries no commit of its own.
 * Measured across the 100 most recent PRs: 13 carried a codex 👍 and **5 of
 * them named a commit that had been rebased away** — #6070's 👍 was for
 * `44b4546` while head had moved to `041fce5` eight minutes later. So the
 * reviewed sha is read out of the summary's Commit cell and compared with
 * head; a 👍 that does not name head is `stale`, never `clean`.
 *
 * ## The criterion, stated once
 *
 *   clean  ⟺  every face was actually FETCHED (all five, including
 *               `pulls/<n>/reviews`)
 *             ∧ zero *live* findings from this vendor on either comment face
 *               (a COMPLETED head-bound 👍 supersedes earlier findings the
 *               same way it supersedes an earlier quota notice; comments are
 *               never deleted, so a raw `total > 0` is absorbing)
 *             ∧ the vendor published its affirmative no-findings signal (👍)
 *             ∧ that signal names the commit that is HEAD
 *             ∧ no review is in flight (no 👀, and the status cell says
 *               `Completed`) — `Completed` is still not EVIDENCE of clean;
 *               this is only its contrapositive, NOT-Completed ⇒ NOT-clean
 *
 * Everything else is a distinct, nameable state — never folded into clean:
 *
 *   findings     ≥1 *live* finding from this vendor, on the inline or the
 *                conversation face. Historical findings that a later
 *                COMPLETED head-bound 👍 outranks are not this state.
 *   blocked      the vendor said it CANNOT run (usage limit). Waiting is
 *                futile; this must not wear the colour of "still running".
 *   running      👍 exists, but a review is in flight (👀, or the status cell
 *                is not yet `Completed`). The 👍 is from an earlier round and
 *                is about to be superseded.
 *   stale        👍 exists, but names a commit that is not head — the bot
 *                approved something else
 *   unbound      👍 exists and no reviewed sha could be read at all, so the
 *                approval cannot be tied to any commit
 *   incomplete   present (summary and/or 👀) but has not said 👍; the truth
 *                is UNKNOWN, which is not the same as fine
 *   absent       never spoke at all — it may not run on this repo. Not clean
 *                either. Whether to WAIT is a policy question that lives in
 *                epic-conductor §6, not in this judge.
 *   unavailable  a face could not be read. 取失败 ≠ 没有 finding.
 *
 * `botFindings` is always printed, including `0` and including the literal
 * `UNAVAILABLE`, so 「数出来是 0」 and 「根本没数」 cannot share a colour. So are
 * the signals: one derived from a face that was never read prints `UNKNOWN`,
 * not `false` — an absent byte must not render as a negative one.
 *
 * ## Self-reference: why classification here is STRUCTURAL, not substring
 *
 * This judge decides what a comment IS by looking at its body — and the thing
 * it judges is the review system itself. So a genuine finding written ABOUT
 * this script naturally quotes the very markers and phrases the classifier
 * keys on, and thereby removes itself from the count. **The more precisely a
 * finding discusses this judge, the more likely the judge is to conclude that
 * the finding does not exist.**
 *
 * That is not a hypothetical. Three separate rounds of this PR's own
 * cross-engine review produced the same defect at three sites, and every one
 * of them failed toward false `clean` — #6013's own direction:
 *
 *   | site                        | mechanism                                |
 *   |-----------------------------|------------------------------------------|
 *   | `QUOTA_NOTICE_RE`           | substring match on the quota phrase       |
 *   | `isSummaryComment`          | `includes` on the summary marker          |
 *   | quota supersession          | compared the sha, never the time          |
 *
 * The rule this leaves behind: **do not add a fourth substring rule.** A
 * comment's class is decided by where the token sits (a marker at the body's
 * start, a notice opening the body) and by ordering facts (timestamps), and
 * the SAME predicate is used everywhere a class is tested — two notions of
 * "is the summary" is how a comment ends up neither counted nor read.
 *
 * ## No bypass
 *
 * There is deliberately no flag that turns a not-clean verdict into clean. The
 * escape from `findings` is to answer the findings and get a fresh head-bound
 * 👍 (comments are never deleted, so that later completion must supersede
 * them); from `stale`, to re-trigger the review on head; from `running`, to
 * wait for the run in flight; from `blocked`, to restore the vendor's quota;
 * from `incomplete`, to wait; from `unavailable`, to fetch again; from
 * `absent`, to wait or record why the PR proceeds without that vendor.
 *
 * `treatCompletedSummaryAsClean` is NOT a bypass — it is the mutation knob that
 * re-creates the defect, unreachable from argv, and it exists solely so
 * `bot-clean.test.ts` §4 can prove the reject arms actually detect the revert.
 */
import { run } from "../../../lib/report.ts";

/* ===== inputs: the GitHub faces, verbatim ===== */

export interface Reaction {
  content: string;
  user: { login: string };
  created_at?: string;
}

export interface CommentLike {
  id?: number;
  user: { login: string };
  created_at?: string;
  path?: string;
  body: string;
}

/**
 * One element of `gh api repos/{o}/{r}/pulls/<n>/reviews`.
 *
 * Codex posts a `COMMENTED` review whose body is a pointer
 * (`**Reviewed commit:** \`abc1234\``); the findings themselves land on the
 * two comment faces. This face is still fetched: an unread face must not
 * share a colour with an empty one (#6164 F4), and the Reviewed-commit
 * marker is a second source for `reviewedSha` — the summary's Commit cell
 * names head 4.5 minutes before the run concludes (#6119).
 */
export interface ReviewLike {
  id?: number;
  user: { login: string };
  submitted_at?: string;
  commit_id?: string;
  state?: string;
  body: string;
}

export interface BotFaces {
  /**
   * `gh api repos/{o}/{r}/pulls/<n>` → `.head.sha`. Required: without it the
   * 👍 cannot be bound to a commit and `stale` cannot be told from `clean`.
   * `null` = the fetch failed.
   */
  headSha: string | null;
  /**
   * `gh api repos/{o}/{r}/issues/<n>/reactions` — where the 👍 lands. Measured:
   * the connector reacts on the PR ITSELF, not on its own summary comment
   * (#6097 → one `+1` on `issues/6097/reactions`, none on the comment).
   */
  issueReactions: Reaction[] | null;
  /**
   * `gh api repos/{o}/{r}/pulls/<n>/comments` — inline findings.
   * **`null` means the fetch FAILED.** An empty array means it succeeded and
   * there is nothing there. Collapsing the two is the defect one layer down.
   */
  inlineComments: CommentLike[] | null;
  /**
   * `gh api repos/{o}/{r}/issues/<n>/comments` — carries BOTH the summary and,
   * when Codex could not attach to diff lines, the whole review body.
   */
  issueComments: CommentLike[] | null;
  /**
   * `gh api repos/{o}/{r}/pulls/<n>/reviews` — Codex `COMMENTED` review
   * objects. **`null` means the fetch FAILED.** An empty array means it
   * succeeded and there is nothing there. This face is not optional: omitting
   * it is the same 同色 hole as never fetching it (#6164 F4).
   */
  reviews: ReviewLike[] | null;
}

/**
 * Which faces could not be read. ALL FIVE are nullable on purpose: an
 * unreadable reactions face must not read as "no 👍", an unreadable
 * conversation face must not read as "the bot never spoke", an unreadable
 * head sha must not read as "the review was for head", and an unreadable
 * reviews face must not read as "the vendor posted no review object".
 */
function unreadableFaces(faces: BotFaces): string[] {
  return (
    [
      ["pulls/<n> (head.sha)", faces.headSha],
      ["issues/<n>/reactions", faces.issueReactions],
      ["pulls/<n>/comments", faces.inlineComments],
      ["issues/<n>/comments", faces.issueComments],
      ["pulls/<n>/reviews", faces.reviews],
    ] as const
  )
    .filter(([, v]) => v == null)
    .map(([name]) => name);
}

/* ===== outputs ===== */

export type BotState =
  | "clean"
  | "findings"
  | "blocked"
  | "stale"
  | "unbound"
  | "running"
  | "incomplete"
  | "absent"
  | "unavailable";

export interface BotSignals {
  /** the vendor left a `+1` reaction — its affirmative "no findings" signal */
  thumbsUp: boolean;
  /** the vendor left an `eyes` reaction — a review is still running */
  eyes: boolean;
  /** the vendor published a conversation comment at all */
  summaryPresent: boolean;
  /**
   * that comment's status cell says `✅ Completed`. NECESSARY but NOT
   * SUFFICIENT for clean (#6119 `3948679018`) — see judgeBotReview.
   */
  summaryCompleted: boolean;
  /**
   * the sha named in the summary's Commit cell, or — if that cell is missing —
   * the newest `**Reviewed commit:**` on the reviews face (#6164 F4).
   */
  reviewedSha: string | null;
  /** the vendor said it has hit its usage limit and will not run */
  quotaBlocked: boolean;
  /** epoch ms of the status comment, or `null` if absent/unparsable */
  summaryAt: number | null;
  /** epoch ms of the NEWEST usage-limit notice, or `null` if none/unparsable */
  latestQuotaAt: number | null;
  /** epoch ms of the NEWEST finding (inline or conversation), or `null` */
  latestFindingAt: number | null;
  /** findings on `pulls/<n>/comments` (raw; may include superseded history) */
  inlineFindings: number;
  /** findings posted as top-level `issues/<n>/comments` review bodies */
  conversationFindings: number;
  /** the vendor posted a non-empty review object on `pulls/<n>/reviews` */
  reviewPresent: boolean;
  /** how many review objects this vendor posted (0 is a read, not a miss) */
  reviewsPosted: number;
}

/** Which faces the signals were actually derived from (#6013, P3b). */
export interface FaceRead {
  head: boolean;
  reactions: boolean;
  inline: boolean;
  conversation: boolean;
  reviews: boolean;
}

export interface BotVerdict {
  vendor: string;
  state: BotState;
  /** never omitted; `"UNAVAILABLE"` when a face could not be read */
  botFindings: number | "UNAVAILABLE";
  signals: BotSignals;
  faceRead: FaceRead;
  reason: string;
}

export const CODEX_VENDOR = "chatgpt-codex-connector[bot]";
export const THUMBS_UP = "+1";
export const EYES = "eyes";

/** The hidden marker Codex puts on its status comment, and nothing else. */
export const SUMMARY_MARKER = "<!-- codex-pull-request-review-summary -->";

/**
 * The summary status cell. Anchored on the ✅ + the word, tolerating the bold
 * markers Codex wraps it in (`✅ **Completed**`). Matching this is never a
 * reason to conclude clean — it is parsed only so the verdict can SAY that the
 * misleading cell was present.
 */
export const SUMMARY_COMPLETED_RE = /✅\s*\*{0,2}\s*Completed/;

/** The Commit cell of that same table row: `| \`44b4546\` |`. */
export const SUMMARY_COMMIT_RE = /\|\s*`([0-9a-f]{7,40})`\s*\|/;

/**
 * Codex review-object body: `**Reviewed commit:** \`2de275e8b1\``. Independent
 * of the summary's Commit cell, and posted when the run concludes rather than
 * when it starts (#6164 F4 / #6119's 4.5-minute window).
 */
export const REVIEWED_COMMIT_RE = /\*\*Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`/;

/**
 * "You have reached your Codex usage limits for code reviews." (#5982)
 *
 * **Anchored to the OPENING of the comment**, which is where the real notice
 * lives (measured on #5982: the body's first bytes are `You have reached your
 * Codex usage limits…`). A bare substring match was a false-`clean` path
 * INSIDE the judge whose only job is to eliminate false-`clean` (#6119 review
 * F1): a genuine top-level finding that merely QUOTES the phrase — a review
 * about this very file would — was simultaneously excluded from
 * `conversationFindings` by `isReviewBody()` and made `quotaBlocked` true, and
 * a head-bound 👍 then superseded the block. Constructed and run: `state=clean
 * botFindings=0` beside a live P1.
 *
 * Every other misclassification in this judge makes it over-refuse, which is
 * safe. This one made it UNDER-refuse — the exact direction that produced
 * #6013 — so it is anchored rather than merely narrowed. The `{0,20}` prefix
 * still admits the vendor rewording its opener ("You have ", "⚠️ You have ");
 * it does not admit a review body, which carries hundreds of characters of
 * P-badge markup before any quotation.
 */
export const QUOTA_NOTICE_RE = /^\s*[^\n]{0,20}reached your [^\n]{0,40}usage limits/i;

/** GitHub marks app accounts with this suffix; it is the only non-human tell. */
const BOT_LOGIN_RE = /\[bot\]$/;

export interface JudgeOptions {
  /** which bot to judge; one call per vendor */
  vendor?: string;
  /**
   * ⚠️ MUTATION KNOB — the #6013 defect, reproduced exactly: a `✅ Completed`
   * summary is taken as sufficient proof the bot found nothing, short-circuiting
   * both finding counts and the staleness check the way the two bad reviews did.
   * Not reachable from argv. Its only caller is the suite's mutation pair.
   */
  treatCompletedSummaryAsClean?: boolean;
}

/**
 * Review connectors this judge knows how to read.
 *
 * `[bot]` is NOT the same predicate as "review connector" (#6119 Codex
 * `3948679028`). Everything below — the summary marker, the Commit cell, the
 * 👍/👀 vocabulary, and `isReviewBody()`'s fail-closed default — is
 * Codex-shaped. Applied to `github-actions[bot]`, a "Deploy preview ready"
 * status comment is counted as a finding and the whole command goes red.
 * Not reachable in arc today (0 of the last 60 PRs carry a third bot), but this
 * skill is declared repo-agnostic, and a consuming repo with a CI / coverage /
 * preview bot would be permanently red on day one — which is a synonym for
 * ignored, the failure mode CLAUDE.md names by name.
 *
 * Adding a connector here is the whole cost of supporting it.
 */
export const RECOGNISED_REVIEW_VENDORS: readonly string[] = [CODEX_VENDOR, "cursor[bot]"] as const;

/** Every bot login appearing anywhere on this PR, recognised or not. */
function allBotLogins(faces: BotFaces): string[] {
  const seen = new Set<string>();
  for (const r of faces.issueReactions ?? [])
    if (BOT_LOGIN_RE.test(r.user.login)) seen.add(r.user.login);
  for (const c of faces.inlineComments ?? [])
    if (BOT_LOGIN_RE.test(c.user.login)) seen.add(c.user.login);
  for (const c of faces.issueComments ?? [])
    if (BOT_LOGIN_RE.test(c.user.login)) seen.add(c.user.login);
  for (const c of faces.reviews ?? []) if (BOT_LOGIN_RE.test(c.user.login)) seen.add(c.user.login);
  return [...seen].sort();
}

/**
 * The RECOGNISED review connectors this judge will score.
 *
 * Presence on the PR is NOT the accept-set (#6164 F2). A vendor in the roster
 * that left no trace is `absent` — which is explicitly not clean — and must
 * be computed, printed, and folded into the exit. Enumerating only who
 * appeared made "Codex was judged and was fine" share a colour with "Codex
 * was never judged", as long as some *other* recognised vendor showed up.
 *
 * The `faces` argument is the other half of the host-gate pair (unknown bots
 * still come from the PR); the judged set itself is the roster.
 */
export function enumerateVendors(_faces: BotFaces): string[] {
  return [...RECOGNISED_REVIEW_VENDORS].sort();
}

/**
 * Bots present that this judge does NOT know how to read.
 *
 * Narrowing the judged set creates a new way to be silent: a genuinely new
 * review connector would simply not be judged, and "we looked and it was fine"
 * would again share a colour with "we never looked". So they are REPORTED —
 * one `unknownBot=` line each — without being counted or blocking.
 */
export function enumerateUnknownBots(faces: BotFaces): string[] {
  return allBotLogins(faces).filter((l) => !RECOGNISED_REVIEW_VENDORS.includes(l));
}

/**
 * A vendor conversation comment that is a REVIEW, not bookkeeping.
 *
 * Fail-closed on purpose: anything that is neither the status comment nor a
 * quota notice counts. Over-counting produces `findings` (someone reads it);
 * under-counting produces `clean` (nobody does). The suite pins both ends —
 * the summary and the quota notice must NOT count, #5978's review body must.
 */
function isReviewBody(body: string): boolean {
  return !isSummaryComment(body) && !QUOTA_NOTICE_RE.test(body);
}

/**
 * Is this comment THE status comment — not a comment that quotes its marker?
 *
 * Codex emits the marker as the comment's first bytes (measured on #6097:
 * the body opens `<!-- codex-pull-request-review-summary -->\n\n## Codex
 * Review Summary`). A bare `includes` therefore had the same shape as the
 * un-anchored quota notice (#6119 codex `fzrmpv0`): a top-level finding that
 * QUOTES the marker — a review of this very file does, which is how it was
 * found — was classified as the summary, dropped from `conversationFindings`,
 * and the verdict came back `state=clean botFindings=0` beside a live P1.
 *
 * The same predicate is used for BOTH the summary lookup and the review-body
 * filter on purpose: two different notions of "is the summary" is how a
 * comment ends up being neither counted nor read.
 */
export function isSummaryComment(body: string): boolean {
  return body.trimStart().startsWith(SUMMARY_MARKER);
}

/** Epoch ms, or `null` when absent/unparsable — never a silent `0`. */
function at(value: string | undefined): number | null {
  if (value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function newest(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? null : Math.max(...known);
}

function reviewedShaFromReviews(reviews: ReviewLike[] | null, vendor: string): string | null {
  const mine = (reviews ?? [])
    .filter((r) => r.user.login === vendor)
    .map((r) => ({
      sha: REVIEWED_COMMIT_RE.exec(r.body ?? "")?.[1] ?? null,
      at: at(r.submitted_at),
    }))
    .filter((x): x is { sha: string; at: number | null } => x.sha !== null);
  if (mine.length === 0) return null;
  const [first, ...rest] = mine;
  if (first === undefined) return null;
  let best = first;
  for (const row of rest) {
    if (row.at !== null && (best.at === null || row.at > best.at)) best = row;
  }
  return best.sha;
}

function collectSignals(faces: BotFaces, vendor: string): BotSignals {
  const mine = (faces.issueComments ?? []).filter((c) => c.user.login === vendor);
  const reactions = faces.issueReactions ?? [];
  const summary = mine.find((c) => isSummaryComment(c.body));
  const vendorReviews = (faces.reviews ?? []).filter((r) => r.user.login === vendor);
  const inlineMine = (faces.inlineComments ?? []).filter((c) => c.user.login === vendor);
  const conversationMine = mine.filter((c) => isReviewBody(c.body));
  return {
    thumbsUp: reactions.some((r) => r.content === THUMBS_UP && r.user.login === vendor),
    eyes: reactions.some((r) => r.content === EYES && r.user.login === vendor),
    summaryPresent: mine.length > 0,
    summaryCompleted: summary !== undefined && SUMMARY_COMPLETED_RE.test(summary.body),
    reviewedSha:
      SUMMARY_COMMIT_RE.exec(summary?.body ?? "")?.[1] ??
      reviewedShaFromReviews(faces.reviews, vendor),
    quotaBlocked: mine.some((c) => QUOTA_NOTICE_RE.test(c.body)),
    summaryAt: at(summary?.created_at),
    latestQuotaAt: newest(
      mine.filter((c) => QUOTA_NOTICE_RE.test(c.body)).map((c) => at(c.created_at)),
    ),
    latestFindingAt: newest([...inlineMine, ...conversationMine].map((c) => at(c.created_at))),
    inlineFindings: inlineMine.length,
    conversationFindings: conversationMine.length,
    reviewPresent: vendorReviews.some((r) => (r.body ?? "").trim() !== ""),
    reviewsPosted: vendorReviews.length,
  };
}

/**
 * A finding whose timestamp is strictly earlier than a COMPLETED head-bound
 * 👍 is historical: comments are never deleted, so counting it forever made
 * `findings` absorbing — the same shape as the `blocked` bug #6119 fixed
 * (#6164 F3). Unorderable timestamps fail-closed (the finding stands).
 */
function findingIsLive(
  createdAt: string | undefined,
  headBoundClean: boolean,
  completionAt: number | null,
): boolean {
  if (!headBoundClean) return true;
  const t = at(createdAt);
  if (t === null || completionAt === null) return true;
  return t >= completionAt;
}

function liveFindingCounts(
  faces: BotFaces,
  vendor: string,
  headBoundClean: boolean,
  completionAt: number | null,
): { inline: number; conversation: number } {
  const live = (createdAt: string | undefined) =>
    findingIsLive(createdAt, headBoundClean, completionAt);
  return {
    inline: (faces.inlineComments ?? []).filter(
      (c) => c.user.login === vendor && live(c.created_at),
    ).length,
    conversation: (faces.issueComments ?? []).filter(
      (c) => c.user.login === vendor && isReviewBody(c.body) && live(c.created_at),
    ).length,
  };
}

export function judgeBotReview(faces: BotFaces, opts: JudgeOptions = {}): BotVerdict {
  const vendor = opts.vendor ?? CODEX_VENDOR;
  const signals = collectSignals(faces, vendor);
  const faceRead: FaceRead = {
    head: faces.headSha !== null,
    reactions: faces.issueReactions !== null,
    inline: faces.inlineComments !== null,
    conversation: faces.issueComments !== null,
    reviews: faces.reviews != null,
  };
  const verdict = (state: BotState, botFindings: number | "UNAVAILABLE", reason: string) => ({
    vendor,
    state,
    botFindings,
    signals,
    faceRead,
    reason,
  });

  // ⚠️ MUTANT PATH ONLY. This is what the two bad reviews did: read the status
  // cell, conclude clean, never count and never check which commit it was for.
  if (opts.treatCompletedSummaryAsClean && signals.summaryCompleted) {
    return verdict("clean", 0, "MUTANT: summary says ✅ Completed — treated as proof of clean");
  }

  const unreadable = unreadableFaces(faces);
  const head = faces.headSha;
  // `head === null` is already covered by `unreadable`; it is repeated so the
  // compiler narrows `head` below, not because the first test is incomplete.
  if (unreadable.length > 0 || head === null) {
    return verdict(
      "unavailable",
      "UNAVAILABLE",
      `could not fetch ${unreadable.join(", ")} — 取失败 ≠ 没有 finding, so this is not clean`,
    );
  }

  /**
   * The vendor's own proof that a review RAN TO COMPLETION on this commit.
   *
   * Spelled once here because three rules need it: live-finding supersession
   * (#6164 F3), the quota supersession just below, and the 👍 ladder further
   * down (which reaches the same conclusion by elimination and owns the
   * wording).
   */
  const headBoundClean =
    signals.thumbsUp &&
    signals.reviewedSha !== null &&
    !signals.eyes &&
    signals.summaryCompleted &&
    head.startsWith(signals.reviewedSha);

  const live = liveFindingCounts(faces, vendor, headBoundClean, signals.summaryAt);
  const total = live.inline + live.conversation;
  if (total > 0) {
    const where = [
      live.inline > 0 ? `${live.inline} inline` : "",
      live.conversation > 0 ? `${live.conversation} as top-level comment(s)` : "",
    ]
      .filter(Boolean)
      .join(" + ");
    return verdict(
      "findings",
      total,
      `${total} finding(s) from ${vendor} (${where})` +
        (signals.summaryCompleted ? " — a ✅ Completed summary does not cancel them" : ""),
    );
  }

  /**
   * A quota notice is a COMMENT, and comments are never deleted. Scanning the
   * whole history for one unconditionally made `blocked` ABSORBING: a PR that
   * once hit the limit could never read `clean` again — not even after the
   * quota was restored and the vendor completed a fresh run on head, which is
   * precisely what the `blocked` reason tells you to go and do (#6119 codex
   * `f1n2ryut`). The bug is quiet because `blocked` is the not-clean
   * direction: it wears the colour of caution while being a judge that can
   * only say no — the shape this whole PR exists to kill, one state in.
   *
   * A COMPLETED, head-bound 👍 supersedes an EARLIER notice. Anything short of
   * that — a stale 👍, a run in flight, no 👍 at all — leaves the notice
   * standing, so this is a supersession rule and NOT a bypass.
   *
   * **The ordering is checked, not assumed** (#6119 codex `fidsouz`). The
   * first cut of this rule compared only the sha, so a notice posted AFTER a
   * completed run on the same head was cancelled by that older completion:
   * `quotaBlocked=true` and still `clean`, i.e. "the newest round could not
   * run" reported as "finished with nothing to say". That is the same
   * false-`clean` direction as F1, introduced by the fix for the opposite bug
   * — over-refusal and under-refusal are one edit apart here, which is why
   * both ends are pinned by arms.
   *
   * Missing or unparsable timestamps are fail-closed: unproven order leaves
   * the notice standing, because `blocked` is the not-clean direction.
   */
  const completionOutranksNotice =
    signals.summaryAt !== null &&
    signals.latestQuotaAt !== null &&
    signals.summaryAt > signals.latestQuotaAt;

  if (signals.quotaBlocked && !(headBoundClean && completionOutranksNotice)) {
    return verdict(
      "blocked",
      0,
      `${vendor} reported a usage limit — this review will never run, so waiting for it is futile. ` +
        `Restore the vendor's quota and re-trigger, or record why the PR proceeds without it.`,
    );
  }

  if (signals.thumbsUp) {
    if (signals.reviewedSha === null) {
      return verdict(
        "unbound",
        0,
        `${vendor} reacted 👍 but no reviewed commit could be read from its summary, so the ` +
          `approval cannot be tied to any commit. Reactions are per-PR and are never cleared.`,
      );
    }
    // A RETAINED 👍 must not survive an active review (#6119 Codex `3948679018`).
    // Measured on that PR: summary CREATED 10:05:50Z already naming head
    // `2de275e`; findings published 10:10:18Z; Status cell became `Completed`
    // only at 10:10:21Z. So `reviewedSha == head` holds 4.5 minutes before the
    // conclusion exists, and reactions are never cleared — the exact window in
    // which epic-conductor §6 asks "is it clean?".
    //
    // This does not make `Completed` EVIDENCE of clean. It is only the
    // contrapositive: while a review is in flight the cell is precisely NOT
    // `Completed`, so NOT-Completed guarantees NOT-clean.
    if (signals.eyes || !signals.summaryCompleted) {
      return verdict(
        "running",
        0,
        `${vendor} has a 👍, but a review is in flight ` +
          `(${signals.eyes ? "👀 reaction present" : 'status cell is not "✅ Completed"'}). ` +
          `Reactions are per-PR and are never cleared, so that 👍 belongs to an earlier round ` +
          `and is about to be superseded. Wait for this run to finish.`,
      );
    }
    if (!head.startsWith(signals.reviewedSha)) {
      return verdict(
        "stale",
        0,
        `${vendor} reacted 👍 for commit ${signals.reviewedSha}, but head is ${head.slice(0, 7)}. ` +
          `The reaction is per-PR and is never cleared, so it outlived the commit it was about ` +
          `(measured on #6070, and on 5 of the 13 👍 in the last 100 PRs). Re-trigger the review on head.`,
      );
    }
    const rawTotal = signals.inlineFindings + signals.conversationFindings;
    return verdict(
      "clean",
      0,
      `${vendor} reacted 👍 for ${signals.reviewedSha}, which is head` +
        (rawTotal > 0
          ? `, and ${rawTotal} earlier finding(s) are superseded by that completion`
          : ", and both faces are empty"),
    );
  }

  if (signals.summaryPresent || signals.eyes || signals.reviewPresent) {
    return verdict(
      "incomplete",
      0,
      `${vendor} has not reacted 👍${
        signals.summaryCompleted ? ' — a "✅ Completed" summary is not that signal' : ""
      }; Completed means the run finished, not that it found nothing, and it is published ` +
        `alongside findings (measured on #6009 and #6011). Empty faces here mean UNKNOWN, not clean.`,
    );
  }

  return verdict("absent", 0, `${vendor} has left no comment and no reaction on this PR`);
}

/** The one place `clean` is spelled. Anything else is not clean. */
export function isBotClean(v: BotVerdict): boolean {
  return v.state === "clean";
}

export function exitCodeFor(v: BotVerdict): number {
  if (v.state === "clean") return 0;
  if (v.state === "unavailable") return 2; // fail-closed, same rung as usage
  return 1;
}

/** `false` from a face that was read; `UNKNOWN` from one that was not (P3b). */
const tri = (read: boolean, value: boolean): string => (read ? String(value) : "UNKNOWN");

export function buildVerdictLine(v: BotVerdict): string {
  const s = v.signals;
  const r = v.faceRead;
  return (
    `bot-clean: vendor=${v.vendor} state=${v.state} botFindings=${v.botFindings} ` +
    `inline=${r.inline ? s.inlineFindings : "UNKNOWN"} ` +
    `conversation=${r.conversation ? s.conversationFindings : "UNKNOWN"} ` +
    `thumbsUp=${tri(r.reactions, s.thumbsUp)} eyes=${tri(r.reactions, s.eyes)} ` +
    `summaryCompleted=${tri(r.conversation, s.summaryCompleted)} ` +
    `reviewedSha=${r.conversation || r.reviews ? (s.reviewedSha ?? "NONE") : "UNKNOWN"} ` +
    `reviews=${r.reviews ? s.reviewsPosted : "UNKNOWN"}\n` +
    `  ${v.reason}`
  );
}

/* ===== CLI ===== */

export type ParsedArgs =
  | { ok: true; pr: number; repo?: string; vendor?: string }
  | { ok: false; error: string };

/**
 * `--repo` / `--vendor` end up inside a `bash -c` string. `JSON.stringify`
 * escapes `"` and `\` but NOT `$` or a backtick, so a double-quoted argument
 * still runs command substitution — measured on this script before this guard
 * existed: `--repo 'a/b$(touch /tmp/pwned)'` created the file. Validate
 * fail-closed instead of trusting the quoting.
 */
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const VENDOR_LOGIN_RE = /^[A-Za-z0-9._-]+(?:\[bot\])?$/;
const USAGE = "usage: bun bot-clean.ts --pr <n> [--repo owner/name] [--vendor login]";

export function parseArgs(argv: string[]): ParsedArgs {
  let pr: number | undefined;
  let repo: string | undefined;
  let vendor: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // A flag whose value is missing used to fall through as `undefined`, and
    // `gh` then silently resolved the shell's own repo — a verdict about a
    // DIFFERENT PR, printed as if it were this one (#6013 pre-PR review, P3a).
    const value = (): string | undefined => argv[++i];
    if (a === "--pr" || a === "--repo" || a === "--vendor") {
      const v = value();
      if (v === undefined) return { ok: false, error: `${a} needs a value. ${USAGE}` };
      if (a === "--pr") pr = Number(v);
      else if (a === "--repo") repo = v;
      else vendor = v;
    } else return { ok: false, error: `unknown argument ${JSON.stringify(a)}` };
  }
  if (pr === undefined || !Number.isInteger(pr) || pr <= 0) return { ok: false, error: USAGE };
  if (repo !== undefined && !REPO_SLUG_RE.test(repo)) {
    return { ok: false, error: `--repo must be owner/name, got ${JSON.stringify(repo)}. ${USAGE}` };
  }
  if (vendor !== undefined && !VENDOR_LOGIN_RE.test(vendor)) {
    return {
      ok: false,
      error: `--vendor must be a login, got ${JSON.stringify(vendor)}. ${USAGE}`,
    };
  }
  return {
    ok: true,
    pr,
    ...(repo === undefined ? {} : { repo }),
    ...(vendor === undefined ? {} : { vendor }),
  };
}

export interface MainDeps {
  /** returns the faces; a `null` member means THAT fetch failed */
  fetchFaces: (pr: number, repo: string | undefined) => BotFaces;
  log: (line: string) => void;
}

function gh(path: string, repo: string | undefined): { code: number; out: string } {
  const slug = repo ?? "{owner}/{repo}";
  return run(`gh api ${JSON.stringify(`repos/${slug}/${path}`)} --paginate`, {}, undefined, 60_000);
}

/**
 * Flatten `gh api --paginate` output into one array of elements.
 *
 * MEASURED (gh 2.83.2, `issues/6119/comments?per_page=1 --paginate`): four
 * pages come back as ONE merged array of four and a single `JSON.parse`
 * succeeds — the one-document path is what actually runs today. But `gh`
 * ships `--slurp` precisely because that merge is not universal, and a
 * concatenated `[…][…]` body would parse as nothing, become `null`, and be
 * reported as `unavailable` — a SUCCESSFUL fetch wearing the colour of a
 * failed one (#6119 codex `f1x3l37r`).
 *
 * The seams are found by scanning, with string/escape awareness — never by a
 * `][` regex, which would corrupt any body that contains those two characters
 * (this PR's own review comments do, which is why the naive repair is not an
 * option). Anything that is not a run of complete top-level JSON arrays still
 * yields `null`: this widens what parses, it does not weaken fail-closed.
 */
export function parsePaginatedArray<T>(text: string): T[] | null {
  const s = text.trim();
  if (s === "") return [];
  const out: T[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (start === -1) {
      if (/\s/.test(ch)) continue;
      // A top-level document that is not an array (an error object, a scalar)
      // is not something this caller can use.
      if (ch !== "[") return null;
      start = i;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth < 0) return null;
      if (depth === 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
        if (!Array.isArray(parsed)) return null;
        out.push(...(parsed as T[]));
        start = -1;
      }
    }
  }
  // Unterminated document, unterminated string, or a dangling opener.
  if (depth !== 0 || inString || start !== -1) return null;
  return out;
}

/** A non-zero exit or unparsable body yields `null`, never `[]`. */
function ghJson<T>(path: string, repo?: string): T[] | null {
  const r = gh(path, repo);
  if (r.code !== 0) return null;
  return parsePaginatedArray<T>(r.out);
}

function ghHeadSha(pr: number, repo?: string): string | null {
  const r = gh(`pulls/${pr}`, repo);
  if (r.code !== 0) return null;
  try {
    const sha = (JSON.parse(r.out.trim() || "{}") as { head?: { sha?: string } }).head?.sha;
    return typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * No `?? []` anywhere here — that is precisely how a failed fetch becomes an
 * empty result and an empty result becomes "nothing to see".
 */
export const liveFetchFaces: MainDeps["fetchFaces"] = (pr, repo) => ({
  headSha: ghHeadSha(pr, repo),
  issueReactions: ghJson<Reaction>(`issues/${pr}/reactions`, repo),
  inlineComments: ghJson<CommentLike>(`pulls/${pr}/comments`, repo),
  issueComments: ghJson<CommentLike>(`issues/${pr}/comments`, repo),
  reviews: ghJson<ReviewLike>(`pulls/${pr}/reviews`, repo),
});

export function main(argv: string[], deps: MainDeps): number {
  const args = parseArgs(argv);
  if (!args.ok) {
    deps.log(args.error);
    return 2;
  }
  const faces = deps.fetchFaces(args.pr, args.repo);

  // Bots this judge cannot read are REPORTED, never counted and never blocking.
  // Narrowing the judged set (#6119 `3948679028`) would otherwise create a new
  // silence: a genuinely new review connector simply not judged, with "looked
  // and it was fine" sharing a colour with "never looked".
  if (!args.vendor) {
    for (const bot of enumerateUnknownBots(faces)) {
      deps.log(
        `bot-clean: unknownBot=${bot} — not a recognised review connector, NOT judged and NOT ` +
          `counted. If it posts findings, add it to RECOGNISED_REVIEW_VENDORS.`,
      );
    }
  }

  // One named vendor, or every RECOGNISED vendor — including those that left
  // no trace. Presence is not the accept-set (#6164 F2); `absent` is a real
  // per-vendor verdict and must affect the exit. The roster is never empty
  // (RECOGNISED_REVIEW_VENDORS is a non-empty const), so there is no
  // `vendorsSeen=0` fallback that quietly judged only Codex.
  const vendors = args.vendor ? [args.vendor] : enumerateVendors(faces);

  let worst = 0;
  const states: string[] = [];
  for (const vendor of vendors) {
    const v = judgeBotReview(faces, { vendor });
    deps.log(buildVerdictLine(v));
    states.push(`${vendor}=${v.state}`);
    worst = Math.max(worst, exitCodeFor(v));
  }
  deps.log(
    `bot-clean: vendorsSeen=${vendors.length} vendors=${vendors.join(",")} overall=${states.join(" ")}`,
  );
  return worst;
}

if (import.meta.main) {
  process.exit(
    main(process.argv.slice(2), { fetchFaces: liveFetchFaces, log: (s) => console.log(s) }),
  );
}
