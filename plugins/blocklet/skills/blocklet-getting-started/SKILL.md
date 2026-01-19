---
name: blocklet-getting-started
description: Guide users to choose between blocklet-dev-setup and blocklet-server-dev-setup. Ask what to develop (blocklet or server), handle migration from existing environments, explain convention directories, and showcase advanced usages. Use `/blocklet-getting-started` or say "I want to start blocklet development", "how to setup blocklet dev environment" to trigger.
---

# Blocklet Getting Started

An interactive Q&A guide for developers who are new to ArcBlock's Blocklet ecosystem and don't know what questions to ask.

## Core Philosophy

**"Guide through questions, answer from skills."**

This skill maintains a curated list of questions. When user selects a question, AI reads the relevant skill files in `plugins/blocklet/skills/` to understand the context and provide accurate answers.

**"If users knew what to ask, they wouldn't need this skill."**

Users who know their questions can ask AI directly. This skill is for those who need guided discovery.

---

## Workflow

### Phase 0: Language Selection

**First, use AskUserQuestion to determine the user's preferred language**:

```
Which language do you prefer? / 请选择您的语言 / 言語を選択してください

Options:
A. English
B. 中文 (Chinese)
C. 日本語 (Japanese)
```

**After user selects a language, ALL subsequent communication must be in that language.**

---

### Phase 1: Present Questions (Loop)

**Use AskUserQuestion to present questions.**

Due to UI constraints (max 4 options), present 3 questions + 1 special option:
- 3 questions from different categories (maximize user choice)
- "Start my first environment setup" - Redirect to `/blocklet-dev-setup` or `/blocklet-server-dev-setup`

**After answering each question, return to Phase 1 and present the next set of questions (pick different ones).**

---

## Question Catalog

Questions are organized by category. When presenting questions, pick 3 from different categories to give variety. Track which questions have been asked to avoid repetition.

### Category: Getting Started (GS)

| ID | Question | Answer Source |
|----|----------|---------------|
| GS-1 | What's the difference between developing a Blocklet vs developing Blocklet Server? | Read `blocklet-dev-setup/SKILL.md` and `blocklet-server-dev-setup/SKILL.md`, compare their purposes |
| GS-2 | Which skill should I use to start development? | Analyze user's goal, recommend `blocklet-dev-setup` or `blocklet-server-dev-setup` |
| GS-3 | What is the complete development workflow from setup to PR? | Read `blocklet-dev-setup/SKILL.md` Phase 1-7, `blocklet-pr/SKILL.md` |
| GS-4 | What prerequisites do I need before starting? | Read `blocklet-dev-setup/SKILL.md` Phase 0 and Phase 3 |
| GS-5 | How do I know if my environment is ready? | Read `blocklet-dev-setup/SKILL.md` Phase 3 (Prerequisites Check) |

### Category: Convention Directories (CD)

| ID | Question | Answer Source |
|----|----------|---------------|
| CD-1 | Why do we use convention directories like ~/arcblock-repos/? | Read `blocklet-dev-setup/SKILL.md` Convention Directories section |
| CD-2 | What are all the convention directories and their purposes? | Read `blocklet-dev-setup/SKILL.md` Convention Directories table |
| CD-3 | What happens if I don't follow the convention directories? | Explain: AI cannot auto-discover repos, cross-project analysis fails |
| CD-4 | How do I migrate my existing repos to convention directories? | Provide migration commands (move or symlink) |
| CD-5 | Where should I put my Blocklet Server data? | Explain `~/blocklet-server-data/` vs `~/blocklet-server-dev-data/` |

### Category: Server Modes (SM)

| ID | Question | Answer Source |
|----|----------|---------------|
| SM-1 | What's the difference between `blocklet server`, source development, and `blocklet dev`? | Read `blocklet-dev-setup/SKILL.md` Phase 4, `blocklet-server-dev-setup/SKILL.md` |
| SM-2 | When should I use `blocklet server start` vs source development? | Explain: CLI for blocklet apps, source for Server core changes |
| SM-3 | Can I run CLI Server and Source Server at the same time? | No, they use same ports. Read `blocklet-dev-setup/SKILL.md` Phase 4.0 |
| SM-4 | What is `bn-dev` and when do I use it? | Read `blocklet-dev-setup/SKILL.md` Phase 4.1.1 |
| SM-5 | How do I switch between production and source development mode? | Read `blocklet-dev-setup/SKILL.md` Phase 4.1 |

### Category: tmux Process Management (TM)

| ID | Question | Answer Source |
|----|----------|---------------|
| TM-1 | Why do we use tmux to manage blocklet dev processes? | Explain: AI can read logs via `tmux capture-pane`, monitor without blocking |
| TM-2 | How do I see what tmux sessions are running? | Command: `tmux ls` |
| TM-3 | How do I attach to a tmux session to see output? | Command: `tmux attach -t {session-name}` |
| TM-4 | How do I exit tmux without stopping the process? | Key: `Ctrl+B`, then `D` |
| TM-5 | How do I scroll up to see old output in tmux? | Key: `Ctrl+B`, `[`, then arrow keys, `q` to exit |
| TM-6 | How do I switch between windows in a tmux session? | Key: `Ctrl+B`, `n` (next) / `p` (previous) / `0-9` (specific) |
| TM-7 | How do I stop a blocklet dev process? | Command: `tmux kill-session -t blocklet-dev-{repo}` |
| TM-8 | What's the tmux session naming convention? | `blocklet-dev-{repo}` for apps, `blocklet` for Server source |

### Category: Repository & Branch (RB)

| ID | Question | Answer Source |
|----|----------|---------------|
| RB-1 | How does AI find and clone repositories automatically? | Read `blocklet-dev-setup/SKILL.md` Phase 1 and Repository Search section |
| RB-2 | What inputs can I provide to start development? | GitHub Issue URL, Blocklet URL, repo name, problem description |
| RB-3 | How does AI determine which branch to use? | Read `blocklet-branch/SKILL.md` |
| RB-4 | How does AI create feature branches? | Read `blocklet-branch/SKILL.md` branch naming conventions |
| RB-5 | What are the GitHub organizations for ArcBlock projects? | ArcBlock (core), blocklet (apps), AIGNE-io (AI framework) |

### Category: Development Workflow (DW)

| ID | Question | Answer Source |
|----|----------|---------------|
| DW-1 | How do I start developing a specific blocklet? | Read `blocklet-dev-setup/SKILL.md` Phase 1-6 |
| DW-2 | How do I access my blocklet after starting dev server? | Read `blocklet-dev-setup/SKILL.md` Phase 6.1.2 (parse URLs from output) |
| DW-3 | What's the difference between Server Admin and Service Admin URLs? | `/.well-known/server/admin` vs `/.well-known/service/admin` |
| DW-4 | How do I create commits following conventions? | Use `/commit` skill |
| DW-5 | How do I create a PR after development? | Use `/blocklet-pr` skill, requires `gh` CLI |
| DW-6 | What checks run before PR creation? | Read `blocklet-pr/SKILL.md` (lint, tests, version bump) |

### Category: Troubleshooting (TS)

| ID | Question | Answer Source |
|----|----------|---------------|
| TS-1 | Why can't I access *.did.abtnet.io or *.ip.abtnet.io domains? | DNS issue, set DNS to 8.8.8.8. Read `blocklet-dev-setup/SKILL.md` Error Handling |
| TS-2 | Why does Blocklet Server fail to start with "worker_connections NaN"? | Set `ulimit -n 65536`. Read `blocklet-dev-setup/SKILL.md` Phase 3.6 |
| TS-3 | Why do I get EACCES error on port 80/443? | No permission for privileged ports, use 8080/8443. Read Phase 3.7 |
| TS-4 | Why does blocklet dev fail with "Blocklet Server is not running"? | Start Server first. Read `blocklet-dev-setup/SKILL.md` Phase 4 |
| TS-5 | How do I check Blocklet Server logs? | `PM2_HOME=~/.arcblock/abtnode pm2 logs abt-node-daemon --lines 100` |
| TS-6 | How do I completely stop all blocklet development processes? | Read `blocklet-dev-setup/SKILL.md` "Stop Blocklet Dev Process" section |

### Category: Advanced Topics (AT)

| ID | Question | Answer Source |
|----|----------|---------------|
| AT-1 | How do I analyze a Blocklet URL to find its source repository? | Use `/blocklet-url-analyzer` skill |
| AT-2 | How do I handle multi-repository issues? | Read `blocklet-dev-setup/SKILL.md` Phase 1.3 |
| AT-3 | How do I create a new release/version of my blocklet? | Use `/blocklet-updater` skill |
| AT-4 | What is first-time wallet binding and why is it required? | Read `blocklet-dev-setup/SKILL.md` Phase 4.5 |
| AT-5 | How do I convert an existing project to a blocklet? | Use `/blocklet-converter` skill |

---

## How to Answer Questions

When user selects a question:

1. **Read the Answer Source** - Load the referenced skill file(s) from `plugins/blocklet/skills/`
2. **Extract relevant information** - Find the specific section mentioned
3. **Provide a clear, concise answer** - Explain in user's selected language
4. **Include practical examples** - Commands, code snippets when relevant
5. **Return to Phase 1** - Present next set of questions

---

## Presenting Questions

### Default: Show 3 Questions + 1 Special Option

Pick 3 questions from different categories, plus 1 special option (max 4 total):

```
What would you like to know?

A. What's the difference between developing a Blocklet vs developing Blocklet Server?
B. Why do we use convention directories like ~/arcblock-repos/?
C. Why can't I access *.did.abtnet.io domains?
D. Start my first environment setup (ready to begin development)
```

**After answering a question, pick 3 different questions for the next round.**

### When User Selects "Start My First Environment Setup"

**Use AskUserQuestion to determine development target**:

```
What do you want to develop?

A. Blocklet Application (Recommended)
   - Examples: payment-kit, media-kit, discuss-kit, your own blocklet
   - Applications that run ON Blocklet Server

B. Blocklet Server Core
   - The Server runtime itself
   - Contributing to Blocklet Server core functionality
```

| User Choice | Action |
|-------------|--------|
| Blocklet Application | Redirect to `/blocklet-dev-setup` skill |
| Blocklet Server Core | Redirect to `/blocklet-server-dev-setup` skill |

---

## Error Handling

| Situation | Handling |
|-----------|----------|
| User asks question not in catalog | Try to answer from skill files, or add to catalog for future |
| Referenced skill file not found | Inform user, provide general guidance |
| User wants to start developing | Redirect to `/blocklet-dev-setup` or `/blocklet-server-dev-setup` |
| User provides Issue URL or Blocklet URL | Redirect to `/blocklet-dev-setup` directly |
