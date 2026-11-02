# epic-conductor — live hired children

Hired factory/worker children still `status=running` (pid alive) make
it **forbidden** to `end_turn` / close the session. Allowed: true closeout after each hire has
GitHub evidence (PR URL or skip-comment) **or** the child was explicitly `stop`ped. Before
treating yourself as done:
```bash
bun "${AGENTLOOP_ROOT:-$HOME/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop}/skills/epic-conductor/scripts/assert-no-live-children.ts" \
  --runs-dir "$(arc service status --print home 2>/dev/null || printf '%s' "$HOME")/.afs/code-agents/runs" \
  --ids <hired-id>,<hired-id>
```
Exit 0 only when none is live. A ghost (`running`, dead pid) does not block; factory cockpit rows
are `pid=-1` and the watchdog must fail-closed on them (live, not ghost).
