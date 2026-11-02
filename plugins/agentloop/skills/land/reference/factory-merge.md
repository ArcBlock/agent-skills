# land — merging a factory-delivered PR

A PR a factory run delivered (its ready-to-merge checklist, a Change Set produced by a run) is
merged by the factory's host merger (#8182, `packages/aos-factory/src/work-factory-merge.ts`) after the
approval drain's cross-engine review: an executor other than the coder, not a person. land does
not merge it. The host merger is the default merger; a person who merges one by hand goes
through `merge-verified-pr.sh`, which runs the same check.

`merge-verified-pr.sh` then runs the repo's factory merge check (profile
`factory_merge_check_entry`; arc: `arc -i factory work merge-check`, whose bare `arc` the script runs as
`$ARC_CLI` or the factory shim `~/.arc-factory/bin/arc`, never PATH's `arc` — agent-factory#20): independent approve on the
latest Change Set round AND the producer run path-compliant at the PR head. A refusal is final;
`arc work` state `ready-to-merge` alone does not check allowed paths.

A person's fix-up push to a factory PR moves its head past the reviewed round: hand it back to the
factory (a new round), do not merge around the check.
