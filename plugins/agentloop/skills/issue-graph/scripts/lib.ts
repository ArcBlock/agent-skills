/**
 * issue-graph 共享工具：REST-only 的 gh 封装。
 *
 * 为什么不用 GraphQL / --paginate：cloud routine 环境的出站代理只放行 gh 的
 * REST 调用（GraphQL 报 403 "not enabled for this session"），且 --paginate
 * 对 issues 端点会被代理改写 Link header 触发 numeric-ID 错误（见根
 * CLAUDE.md「按需安装 CLI 依赖」节）。所以：全 REST + 手动 page=N 循环。
 */

export interface GhResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export function gh(args: string[]): GhResult {
  const p = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    ok: p.exitCode === 0,
    code: p.exitCode ?? -1,
    stdout: p.stdout.toString(),
    stderr: p.stderr.toString(),
  };
}

/** GET/POST 等 REST 调用；非 2xx 抛错（带 stderr 摘要）。 */
export function api(path: string, extra: string[] = []): any {
  const r = gh(["api", path, ...extra]);
  if (!r.ok) throw new Error(`gh api ${path} failed (${r.code}): ${r.stderr.slice(0, 400)}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

/** 同 api()，但把 HTTP 错误作为值返回而不是抛出（幂等写入要辨认 422 等）。 */
export function apiRaw(path: string, extra: string[] = []): GhResult {
  return gh(["api", path, ...extra]);
}

/** 手动分页 GET：循环 page=1,2,3… 直到返回空页。 */
export function apiPaged(pathWithQuery: string, maxPages = 20): any[] {
  const sep = pathWithQuery.includes("?") ? "&" : "?";
  const out: any[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = api(`${pathWithQuery}${sep}per_page=100&page=${page}`);
    const items = Array.isArray(batch) ? batch : (batch?.items ?? []);
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

/**
 * 从 git remote URL 提取 owner/repo；非 github.com 或解析不出返回 null。
 *
 * 兜底识别 `.../git/<owner>/<repo>` 路径形态——某些 Claude Code 云端会话的出站
 * git 代理（本地 git-proxy daemon，如 `http://local_proxy@127.0.0.1:<port>/git/<owner>/<repo>`）
 * 把 origin 重写成这个形态而非真实 github.com host，`gh` 的 `{owner}/{repo}`
 * 占位符解析因此认不出「known GitHub host」而失败（issue #745 verification
 * comment.ts 的 --comment 全部失败即因于此）。只匹配字面 `/git/` 路径段，
 * 不放宽成任意 host 的「最后两段」——否则会让 gitlab.com 等非 github 远程
 * 误判为可用（见 lib.test.ts "non-github remote returns null"）。
 */
export function parseOwnerRepoFromGitUrl(url: string): string | null {
  const trimmed = url.trim();
  const github = trimmed.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (github) return `${github[1]}/${github[2]}`;
  const proxy = trimmed.match(/\/git\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return proxy ? `${proxy[1]}/${proxy[2]}` : null;
}

export function resolveRepo(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.ISSUE_GRAPH_REPO) return process.env.ISSUE_GRAPH_REPO;
  // 先走纯本地的 git remote（零网络）——`gh repo view` 是 GraphQL，
  // cloud-routine 代理必拒（见文件头注释），只留作最后的兜底。
  const remote = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (remote.exitCode === 0) {
    const parsed = parseOwnerRepoFromGitUrl(remote.stdout.toString());
    if (parsed) return parsed;
  }
  const r = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  if (!r.ok) throw new Error("无法确定 repo：不在 git repo 内且未传 --repo / ISSUE_GRAPH_REPO");
  return r.stdout.trim();
}

/** 简单字符串 hash（顺序随机化用，不求密码学强度）。 */
export function strHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * 按 hostname 旋转数组起点：成员资格确定性、处理顺序机器间错峰，
 * 让多机同分钟起跑时锁竞争从"必然"变"罕见"（#1308 并发设计第 2 条）。
 */
export function hostRotate<T>(arr: T[]): T[] {
  if (arr.length <= 1) return arr;
  const host = process.env.HOSTNAME ?? Bun.spawnSync(["hostname"]).stdout.toString().trim();
  const k = strHash(host) % arr.length;
  return [...arr.slice(k), ...arr.slice(0, k)];
}

export function parseArgs(argv: string[]): Map<string, string | boolean> {
  const m = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      m.set(key, next);
      i++;
    } else {
      m.set(key, true);
    }
  }
  return m;
}
