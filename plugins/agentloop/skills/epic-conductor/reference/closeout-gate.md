# epic-conductor — closeout gate limits

> On-demand reference for [`epic-conductor`](../SKILL.md) (moved out of SKILL.md in #7105).

> ⚠️ **Read the refusal, don't just obey it.** The witness issue in the attribution evidence is a **human-supplied** input: the attribution gate machine-checks only that it EXISTS and is OPEN, never that it has any causal relation to the reds — any open issue passes. So this gate's precision is capped by the witness's. Every refusal prints the witness number and the state it read for exactly that reason: if the cited issue has nothing to do with that PR's red, the evidence is wrong and the fix is to correct the attribution, not to route around the gate. The converse also holds — a closed witness releases the gate without proving the red is gone.
>
> Two more limits, stated so they are not mistaken for coverage: **(1)** the gate's scope is the `epic:<n>` label, which you apply yourself — a blocked PR that never got labelled is invisible to it; **(2)** only the gate's own verification comments count as evidence (marker-checked), so a PR whose report was never posted reads as "no claim". Neither is detectable from inside the gate.


  Why a count and not judgement: a complex enough diff can always yield one more finding, so
  "one more round and it's clean" reads true at every round. The cap is what separates "this
  PR is not good enough" from "we are polishing forever" — they look identical per round.
