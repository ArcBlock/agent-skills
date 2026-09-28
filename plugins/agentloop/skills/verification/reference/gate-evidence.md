# verification — evidence identity, carry-forward, capabilities

> On-demand reference for [`verification`](../SKILL.md).
> The hot path (when to run, when to reuse, who runs the merge gate) stays in SKILL.md.
> This file is the mechanism: equivalent evidence, carry-forward, and host capabilities.

- **A scenario may inherit another scenario's PASS when it is the same question**
  (engine feature; **arc no longer declares it** — see the end of this bullet).
  `ScenarioConfig.equivalentEvidenceFrom: ["pre-pr"]` on pre-merge lets it reuse
  pre-pr's record at the **same sha, same resolved base, same capabilities** — which
  is exactly the merge-base == default-branch-tip case, where the two doors run the
  same checks over the same diff on the same tree (measured: 33 of 88 pre-merge runs
  on one machine, all re-PASS, ≈81 min). The engine still requires the donor to be a
  full PASS whose executed checks **cover every check this scenario would select**
  at that base; a FAIL never crosses scenarios (and an `--na` exemption is local-only,
  never in the shared store, so it cannot donate); a check the donor lacks turns it
  off and is named on stderr (`does not cover: <id>`). One-way: pre-pr never inherits
  from pre-merge (#6239). The report header says `♻️ Equivalent evidence` and names
  the donor; the local `.verify/<sha>.metadata.json` carries `equivalentFrom`. The
  lane peek honours it too, so an equivalent run never queues behind another gate.
  To reuse evidence, **invoke the entrypoint** (`--deliver-cached` for a read that
  never re-runs) — the sticky marker carries neither base nor scenario. The merge gate
  is the one reader that does read the sticky directly, and it asks only for
  `sha == head` and `result=PASS|NA`.
  A repo may stop naming a donor when the two scenarios stop asking the same question
  even though their check IDS still match — the engine compares ids, not work. **arc
  stopped in #7024** (`.claude/verify/config.ts`, the pre-merge scenario): once pre-pr
  became L0, its ids still "covered" pre-merge while the work did not. That does not
  put pre-merge back in the PR loop — the merge gate accepts the same-SHA pre-pr PASS
  and never spawns pre-merge.
- **Named checks may carry a PASS across a delta they cannot observe.**
  `ScenarioConfig.carryForward: (delta) => string | undefined` is the repo's judge and
  `carryForwardChecks` names the ONLY checks that may carry (no list means no carry). On a
  full, clean, unscoped, non-retry run, the engine finds the nearest ancestor of HEAD
  (past the resolved base) with ANY record for this scenario at the same base — local
  cache or ANY shared location slot, ANY result. The nearest record decides: a red
  anywhere refuses (an older PASS never launders a newer FAIL from another worktree);
  PARTIAL / NA / env-gap / capability-mismatched donors are refused. If the donor is a
  full PASS that executed every carried check and the judge accepts every file in the
  `--no-renames` diff from donor to HEAD, each carried check renders a
  `carried from <sha>` PASS row instead of running — and **every other check still
  runs on HEAD** (a cheap whole-corpus lint that reads the changed doc judges it for
  real). The report gets a `Carried-forward evidence` notice naming donor + delta; the
  record carries `carriedFrom`. A donor that exists only in the local cache marks its
  carried rows `reusable: false`, so the run never reaches the shared store.
  `--no-carry-forward` forces every check to run.
- **…and by WHAT THE HOST COULD DO while it was produced** (#5386). `location`
  answers *where*, not *with what*. Some checks' answers depend on an
  environment fact — can this host reach the upstream it mirrors, does
  `*.localhost` resolve — and an input outside the identity gives one identity
  two correct answers. A repo declares those facts as `capabilities` next to
  its check list (`{ id, probe }`); the vector is probed once per run, recorded
  on every artifact, and forms the record's slot. A verdict produced **without**
  a capability is never served to a host that has it, and — the direction that
  actually launders failures — a green produced **because a check could not
  run** is never served to a host that would really have run it. Refusals name
  the capability and both its states.
  - **Only a fact that can be PROBED ahead of the run is eligible to be keyed.**
    A gap a check *reports* (`stats.envGap` / `failure.class = "ENV_GAP"`) is
    knowable only afterwards, so it never enters the key: the slot a reader
    computes could never be the slot such a run publishes into, and that host
    would be unable to read back its own artifact, which livelocks `pre-push`.
  - **A run an env gap decided publishes no reusable evidence at all.** It still
    writes its LOCAL artifact — that is this host's own answer for its own push
    gate — but nothing is banked for anyone to inherit, and the run says so.
    Disclosure alone was not enough: the notice is prose while the gate parses
    `result=`, so a host that HAS the capability would inherit a green this gate
    never measured there. This is a publish-time decision, not an identity input,
    and it is the same shape as the dirty-tree rule beside it. The price is that
    a gapped host re-runs every time; declare the capability to get reuse back.
  - **A check can also opt out of reuse without claiming an env gap (#6420).**
    `CheckResult.reusable: false` is the other publish-time withhold. Use it when
    this round's answer is host-local (a true timeout, a machine-bound
    measurement) but the host is not missing a capability — lying `ENV_GAP` to
    get the withhold was the hole this field closes. Colours, `passed()`, and
    the sticky-gate accept set do not move (taxonomy R2); only publish-or-not.
  - **`unknown` is an equality class.** A probe that throws records `unknown`,
    and two hosts whose probes threw for *different* reasons will reuse each
    other's evidence. That is a named residual, accepted deliberately: the
    alternative — `unknown` matching nothing — lets one broken probe silently
    switch the broker off, which looks identical to a working broker. A repo
    that wants a hard answer should return `false`, which is its own class.
  - **Bumping `EVIDENCE_SCHEMA_VERSION` costs one full gate per runner.** Every
    banked record is invalidated, so on the release that carries a bump each
    fleet runner re-runs its whole gate once, per in-flight (sha, scenario,
    base, location). Real, one-time, and worth stating before you bump.
