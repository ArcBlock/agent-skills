# Workspace Contract

Use this reference to turn a one-time discovery pass into a durable, project-local contract. The
contract should describe how an agent works in a particular workspace; it must not duplicate product
facts, brand voice, or domain rules that already have canonical homes.

## Compatibility

A workspace is compatible when an agent can determine all of the following from instructions,
profiles, configuration, or an explicit user answer:

1. Where the workspace begins and which source is authoritative.
2. Which instructions and local skills govern the requested task.
3. Which sources can establish current facts and which are historical reference only.
4. Where approved outputs belong and how they are verified.
5. What requires user approval, including commits and external publication.

Treat an incomplete workspace as **Partial**, not as an invitation to make up a convention.

## Authority precedence

Use this order unless the target workspace declares a stricter one:

1. The user's current, explicit corrections and approvals.
2. Task-specific canonical source material named by the user or workspace.
3. Current project implementation and configuration.
4. Maintained project profiles and documentation.
5. Dated strategy notes, previous drafts, external commentary, and search results.

Record a conflict rather than silently reconciling it. Ask the author to decide when a conflict
would change the deliverable or its public claims.

## Project-local profile fields

Use the template in `assets/workspace-profile.template.md` only after approval. Keep it short and
evidence-based.

| Section | What it must identify |
| --- | --- |
| Workspace | Root, scope, and supported access sources |
| Instructions | Root/scoped instruction locations and precedence |
| Facts | Canonical profiles, live-author precedence, and historical-only sources |
| Skill routes | Which local skill owns each task class |
| Content | Roots, schema, tags/taxonomy, locales, and source-language policy |
| Delivery | Draft versus canonical destinations, validation gates, and publication boundary |
| Ownership | Who can resolve factual, editorial, and release decisions |

Avoid listing every possible file. Link to stable entry points and name the conditions under which an
agent should read deeper material.

## Workspace map template

Use this in conversation or a task handoff. Omit fields that do not apply, but never hide a missing
field that blocks safe work.

```markdown
## Workspace Map

- **Mode:** Declared | Discoverable | Partial | Unavailable
- **Scope:** <project root and task subtree>
- **Access:** <local directory | MCP resource | AFS mount | checkout>
- **Instructions:** <ordered files and precedence>
- **Fact authority:** <current author > canonical source > implementation > history>
- **Task route:** <selected project-native skills>
- **Delivery:** <draft/canonical root, locales, validation>
- **Approval boundary:** <what is authorized now>
- **Open questions:** <only unresolved blockers or author judgments>
```

## Handoff packet template

Use the following packet to enter a project-native production skill or transfer a task to another
agent.

```markdown
## Task Handoff

- **Task:** <requested outcome>
- **Content identity:** <signed article | institutional release | documentation | other>
- **Audience:** <reader/user/operator>
- **Authoritative facts:** <sources and precedence>
- **Confirmed decisions:** <approved thesis, scope, claims, terminology>
- **Constraints:** <claims to avoid, style, privacy, localization, safety>
- **Deliverable:** <type, destination, target locales>
- **Route:** <native skills in order>
- **Validation:** <commands or review gates>
- **Authority now:** <draft/write/commit/publish permissions>
- **Open questions:** <not-yet-resolved author judgments>
```

## Reuse across access mechanisms

The same contract applies whether the workspace reaches the agent through a direct path, MCP, AFS,
or a checked-out repository. Only the access field changes. Do not mirror or clone information merely
to make it fit the skill; use the accessible authoritative source unless the task requires a local
write target.
