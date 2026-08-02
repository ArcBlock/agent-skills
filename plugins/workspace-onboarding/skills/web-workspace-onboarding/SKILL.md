---
name: web-workspace-onboarding
description: Discover and safely route work inside a compatible web or content workspace. Use when an agent enters through a voice session, local directory, MCP resource, AFS mount, or fresh checkout and must identify project instructions, authoritative facts, local skills, content storage, locale rules, and validation gates before drafting, editing, or handing off work.
---

# Web Workspace Onboarding

This is an entry and routing skill. Let the target workspace own its product facts, writing
standards, storage layout, review process, and validation commands. Do not duplicate or override
those project-native rules here.

Read [the workspace contract](references/workspace-contract.md) before creating a durable project
profile or preparing a handoff. Use the bundled profile template only after the user authorizes a
project-local profile.

## 1. Establish the workspace boundary

1. Identify the access source: local checkout, supplied directory, MCP resource, AFS mount, or a
   repository that must first be checked out. Verify the source instead of assuming that a visible
   directory is the project root.
2. Locate the narrowest owning workspace and inspect its top-level instructions before reading
   unrelated files. Look for `AGENTS.md`, `CLAUDE.md`, repository profiles, and scoped instruction
   files in the affected subtree.
3. Record existing working-tree changes before writing. Preserve them unless the user explicitly
   asks to change or discard them.
4. Use the project-provided access method. Do not require a clone when a readable MCP or AFS source
   already exposes the authoritative files.

Classify the result:

- **Declared**: a project profile or explicit instructions identify the content/workflow contract.
- **Discoverable**: instructions and project layout reveal enough contract to route the current
  task safely.
- **Partial**: the workspace can be read but lacks enough authority, storage, or validation detail.
- **Unavailable**: the source cannot be read or its boundary is ambiguous.

For Partial or Unavailable workspaces, explain the missing contract and ask the smallest necessary
question before making a project change. Do not guess a publishing path or a canonical fact source.

## 2. Build a workspace map

Read only the files needed to build this compact map:

| Map field | Establish from evidence |
| --- | --- |
| Workspace and scope | Project root, task subtree, access source, dirty-state boundary |
| Instruction hierarchy | Root and scoped instructions, including which rule wins on conflict |
| Fact authority | Current author statements, canonical product/profile sources, implementation, historical references |
| Task routes | Local skills for writing, translation, review, code, media, and release work |
| Delivery contract | Content roots, schema/frontmatter, tags, locales, output paths, validation commands |
| Approval boundary | What may be drafted, written, committed, or externally published |

Present the map in concise prose or a small table before work crosses from discovery into writing or
editing. State the classification and anything still unknown.

## 3. Maintain a fact ledger during a voice conversation

Treat live, author-confirmed statements as the most current source for the task. Keep four distinct
lists; never silently merge them:

1. **Confirmed facts** — with their source or confirmation context.
2. **Working interpretations** — useful but not yet confirmed.
3. **Open questions** — factual, editorial, or approval decisions still needed.
4. **Rejected or superseded statements** — retain enough provenance to avoid reviving them.

During voice work, surface questions as compact text that the user can answer later. Do not turn an
unanswered question into a spoken interruption unless continuing would create an unsafe, destructive,
or materially misleading result. Label a source as current, draft, or historical before relying on
it. Do not convert a strategy note, archived material, or old documentation into a current product
commitment.

## 4. Prepare a complete handoff packet

Before invoking a project-native production skill, prepare the handoff fields in the workspace
contract:

- task type and intended audience;
- content identity and approval mode: a signed author piece, institutional news/release,
  documentation, or another declared format;
- owner/author and who can approve factual or editorial judgments;
- thesis, desired outcome, and prohibited claims;
- source material and fact-precedence rule;
- target deliverable, locales, and content or code destination;
- local skills to invoke and their required inputs;
- validation steps and publication/commit authority;
- open questions that must remain visible to the next agent.

Give the native skill this packet rather than a vague request such as “write an article.” Preserve the
user's language, corrections, and unresolved decisions in the packet without presenting them as
settled facts.

## 5. Route instead of replacing local skills

1. Search the workspace for relevant local skills only after reading the governing instructions.
2. Read the selected skill completely and follow it. Prefer a project-native article, translation,
   review, release, or code skill over a generic substitute.
3. Use a context/profile skill to load factual background, not to overwrite newer author guidance.
4. If a native skill does not exist, produce an approved brief or draft in the project's declared
   scratch location. Do not invent a schema, taxonomy, or deployment procedure.
5. Keep the route explicit: discovery -> fact ledger -> approved brief -> native production skill ->
   review/validation -> authorized delivery.

## 6. Handle content work safely

When the routed task creates or updates an article, page, or localized content:

1. Confirm the content identity before selecting a production skill. A signed article and an
   institutional release may have different owners, evidence standards, review gates, and routes.
2. Derive the destination from the workspace's content contract; do not assume a framework or file
   naming convention.
3. Check for duplicate slugs, routes, or existing localized siblings before creating files.
4. Follow the declared frontmatter, tag registry, source-language, quotation, and translation rules.
5. Keep drafts and canonical project content distinct until the user authorizes storage.
6. Run only the validation gates identified by the workspace contract and report what they establish.

Writing files into a repository is not authorization to commit, push, create a pull request, or
publish externally. Obtain separate, explicit authorization for those state changes.

## 7. Close the loop

Report the useful outcome in human terms:

- the workspace contract and selected route;
- files or resources actually changed;
- validation performed and any remaining uncertainty;
- the next author decision, if one is needed.

When the project repeatedly needs the same discovery information, offer to create a project-local
profile from `assets/workspace-profile.template.md`. Create it only with authorization, then treat it
as a project-native source that may be superseded by the user's current instruction.
