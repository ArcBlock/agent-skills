# Headless Factory run — no next turn (arc#7617)

> Shared reference for [`land`](../skills/land/SKILL.md), [`epic-conductor`](../skills/epic-conductor/SKILL.md)
> and [`verification`](../skills/verification/SKILL.md). Each SKILL.md carries the one-line rule; this file
> holds the why and the commands.

## When it applies

`ARC_CODE_AGENT_RUN_ID` is set in the environment. The run was started by the code-agents host
(Factory dispatch, `/dev/code-agents/.actions/run` / `dispatch-work`) as a headless engine
(`claude -p`, `codex exec`, …). Check it once at the start:

```bash
[ -n "${ARC_CODE_AGENT_RUN_ID:-}" ] && echo "headless Factory run $ARC_CODE_AGENT_RUN_ID"
```

## Why

A headless run has exactly one turn. When the model ends its turn, the engine process exits, and
its background shells are reaped with it. Nothing wakes it up again: not the gate finishing, not a
child run settling. "I'll pick up when it finishes" is abandoning the work.

Seen twice on epic #7614: a land run put `pre-pr` in the background and ended its turn (the gate was
reaped, nothing reached GitHub); another spawned a reviewer child run and ended its turn to wait for
it (the child settled and nothing resumed the parent).

The host now records an exit that still owns a live child run as **not delivered**, with the ids in
`exitOutcome.awaiting` (reason "… still live: the turn ended waiting on them (needs resume)"). The
approval drain holds the work while they run (at most 2 h), then resumes the run with a follow-up
once they settle, so nothing is parked or re-dispatched blind. A backgrounded shell is invisible to
the host. Either way the turn was wasted.

## The rule

1. **Never end the turn while something whose result the flow still needs is pending.** A
   background shell, a background subagent, a child run: all of them.
2. **Run the gate in the foreground**, to its result, in this turn. Do not use
   `run_in_background` (or `&`, `nohup`, `setsid`) for `<verification_entry>`, a build, or a test
   you will read.
3. **A command that may outlive one tool call's timeout** may be started in the background, but then
   wait for it **in the same turn**: repeat a blocking wait (the engine's "wait for background task
   output" call, or a poll loop that stays under the tool timeout) until it has exited and you hold
   its output. Only then continue.
4. **A child run** (`/dev/code-agents/<child>`, e.g. a cross-engine reviewer): wait with a blocking
   poll until it settles, then read its result. `paused` counts as live, like `running`. Each call
   below takes at most ~100 s (5 × 20 s), under the engine's default 120 s Bash tool timeout; a
   total deadline (2 h, the same bound the host's approval drain holds the work for) spans calls.
   `arc --json afs read` prints the AFS read result, so the run record is `.data.content`.

   ```bash
   (
     CHILD=agent-xxxxxxxx   # the id the run action returned
     MARK="${TMPDIR:-/tmp}/await-$CHILD.start"; [ -f "$MARK" ] || date +%s >"$MARK"
     for _ in 1 2 3 4 5; do
       if ! s=$(arc --json afs read "/dev/code-agents/$CHILD" | jq -er '.data.content.status'); then
         echo "ERROR: cannot read the status of $CHILD"; exit 2
       fi
       case "$s" in
         exited | failed | stopped | safety-invalidated) echo "SETTLED $CHILD status=$s"; exit 0 ;;
         running | paused) ;; # paused counts as live
         *) echo "ERROR: $CHILD has unknown status '$s'"; exit 2 ;;
       esac
       if [ $(( $(date +%s) - $(cat "$MARK") )) -gt 7200 ]; then
         echo "DEADLINE: $CHILD still $s after 2h"; exit 3
       fi
       sleep 20
     done
     echo "STILL-LIVE $CHILD"; exit 1
   )
   ```

   | exit | meaning | next |
   |---|---|---|
   | 0 `SETTLED` | terminal status (whitelisted) | read the child's result, continue the flow |
   | 1 `STILL-LIVE` | `running` / `paused` | run the same call again, in this turn |
   | 2 `ERROR` | the read failed, or a status outside the list | stop waiting; report the run BLOCKED with that line as the reason. Never read it as settled |
   | 3 `DEADLINE` | still live after 2 h | stop waiting; report BLOCKED: "awaited run `<child>` still live after 2 h". If it is still live when you exit, the host records the exit as not delivered (`exitOutcome.awaiting`) and resumes or retries the work |

   `arc work review` already blocks until its reviewer settles; run it in the foreground the same
   way. An epic conductor's hired workers are the same case: `assert-no-live-children.ts` must exit 0
   before the turn ends.
5. Waiting is work. A slow gate that fills the whole run is correct; fire-and-forget followed by
   ending the turn is the defect.

Outside a Factory run (an attended session with a person who will send the next turn), backgrounding
is a scheduling choice, not this defect, and this file does not apply.
