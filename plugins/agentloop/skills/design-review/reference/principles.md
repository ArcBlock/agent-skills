# Key principles

> Principle essay. The short list stays in `SKILL.md`.

## Key Principles

1. **Each subagent is completely fresh** — it does not inherit any context from previous rounds or the parent conversation. This ensures unbiased review.

2. **The reviewer never modifies files** — separation of concerns. The reviewer finds problems, you (the main agent) fix them.

3. **Score is based on implementability** — "Could a developer with no project background complete the implementation using only these documents?"

4. **Document type determines review strategy** — don't apply implementation plan criteria to a post-mortem, and don't skip test coverage checks on a real implementation plan.

5. **Tasks.md generation is opt-in** — if a design should have tasks but doesn't, ask the user. Never auto-generate without confirmation.

6. **Security and data integrity are non-negotiable** — for implementation plans, every phase involving I/O must have tests for path traversal, prototype pollution, injection, resource exhaustion, namespace isolation, data roundtrip, binary safety, unicode safety, concurrency, and failure atomicity.

7. **Zero regression is enforced** — the review checks that each phase maintains backward compatibility with existing tests and functionality.

8. **方案设计必须 grounded：客观、精确、实事求是。** 任何关于*现状*的断言（架构、存储后端、API、文件布局、现有行为）都要 `path:line` 坐实——**代码是唯一权威**，与引用的 planning/docs 冲突时以代码为准并指出文档过时（典型幻觉：把存储后端说成 "KV" 而代码其实是 R2+D1，整套后续 phase 就建在错地基上）。任何数字（延迟/吞吐/大小/数量/上限）要么**实测**（附命令+输出）、要么**显式标注为未验证估计**、否则删掉——**凭空数字当事实是最高发的幻觉**（如随手写 "0ms/1-2ms"，实测却是 200ms+）。事实 grounding + 数字纪律对设计文档是 **HARD GATE**，不是软维度——一份地基错的设计不该拿到 APPROVED。
