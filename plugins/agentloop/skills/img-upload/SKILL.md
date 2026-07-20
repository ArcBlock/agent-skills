---
name: img-upload
description: >
  Upload a screenshot — or a whole directory of them — to the shared public asset repo and get back
  raw.githubusercontent.com/main URLs, the only host+ref the GitHub MCP comment-writer keeps as an
  inline image (#1334). Binary-safe: never MCP file-write for images (#1079). The mechanism is two
  universal plugin scripts (gh-upload-image.sh single, gh-upload-dir.sh dir); this skill is the
  discoverable entry + the doctrine. Used by test-sweep, ui-verify, and any repo's screenshot flow.
---

# img-upload — 截图上传，输出 raw.githubusercontent.com URL

把截图（单张或整目录）上传到公共图床仓（默认 `ArcBlock/loop-agent-assets`），返回**可匿名访问**的
`raw.githubusercontent.com/.../main/...` URL，供内嵌进 issue / comment 的 markdown。

> **Output language: 中文**；代码 / 路径 / 命令保持原文。

## 机制 = 插件里两个通用脚本（任何仓库同样跑，自动从 `git remote` 探 source repo，落在 `<slug>/<ctx>/`）

先解析插件根，脚本都在其 `scripts/` 下：

```bash
PLUGIN="${AGENTLOOP_ROOT:-$HOME/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop}"
```

- **单张图**：`bash "$PLUGIN/scripts/gh-upload-image.sh" <image> [name]`
  → 自动选写通道（gh contents API / git push）→ content-type=`image/*` 闸 → stdout 打印 raw.githubusercontent/main URL。
- **整目录**：`SCREENSHOT_DIR=<dir> CONTEXT=<ctx> bash "$PLUGIN/scripts/gh-upload-dir.sh"`
  → 遍历目录逐张调上面那个 → stdout 每行 `filename\turl`；任一张失败追加一行 `UPLOAD_FAILED\t<原因>`
  （**始终 exit 0**，失败看这行不看退出码）。

## Usage

```
/agentloop:img-upload <dir>          # 上传目录下所有 .png/.jpg/.jpeg → filename\turl map
/agentloop:img-upload <image.png>    # 单张

# 消费方 skill 的 bash 里直接调脚本（自动化调机制、不调 slash 命令）：
SCREENSHOT_DIR="$SHOT_DIR" CONTEXT="pr${PR}" bash "$PLUGIN/scripts/gh-upload-dir.sh" > url-map.tsv
```

内嵌 markdown 用 `![截图](<raw-url>)`。收到 `UPLOAD_FAILED` 行时在报告顶部显示 `> ⚠️ 截图上传失败 — <原因>`
并降级 `SendUserFile` 直投（不能内嵌，但不产出损坏文件）。

## 为什么必须是 raw.githubusercontent.com/main（脚本已强制，别自己换）

- **#1334**：GitHub MCP 写侧（`add_issue_comment` / `issue_write`）的 sanitizer 把 `![](url)` **剥成纯链接**——
  唯一例外是 host=`raw.githubusercontent.com` **且** ref=`main`。绝不用 `cdn.jsdelivr.net`、绝不用 session 分支 ref。
  （`gh pr comment` / `gh issue comment` 发的评论不受此限，但统一走 raw.githubusercontent/main 对两条发帖通道都安全。）
- **#1079**：MCP 文件写工具（`create_or_update_file` / `push_files`）对二进制**二次 base64 编码** → 存成
  ASCII 字符串不是图片。**图片二进制永远不走任何 MCP 写工具**——脚本走 gh contents API 或 git push，
  并对返回 URL 做 content-type=`image/*` 抽查（非 image/* = 双编码，判失败）。

## 双通道（脚本自动选，调用方无需关心）

- **通道 A — `gh` contents API**：`gh` 存在且对图床仓有写权限时用（本地 PAT / 有写权限的 token）；带瞬时 5xx 重试。
- **通道 B — git push**：无 `gh`（或无写权限）时，`cp` 进已 clone 的图床仓工作区（`$ASSETS_REPO_DIR` 或探测
  `~/loop-agent-assets` 等）→ `commit` + `push origin main`（带 fetch+rebase 重试）。cloud routine 里
  gh token 是 placeholder（对本 org 写接口 403，#1334），走的就是这条——前提是图床仓配为第二个 git source。

两通道都不可用 → 脚本 exit 2 → 消费方降级 `SendUserFile`。

## 消费方

- `test-sweep`（arc）、`ui-verify`（arcblock-site，及将来 did）等在自己的 bash 里调 `gh-upload-dir.sh`。
- **机制永远是那两个脚本，别再各仓手撸 `for f in *.png` 循环**（arc 与 arcblock-site 曾各写一份、已漂移——#1037）。
  需要人读的 doctrine + 可发现入口就是本 skill。
