/**
 * #5697 review P2 —— **skill 引用的 profile 键集 ≡ scaffold 生成的键集**。
 *
 * 插件的 CLAUDE.md 把这条写成了规矩（「新引用一个 `<profile_key>` 要同步三处」），
 * 但曾经没有任何测试守它：一个键只落了两处（skill 读它、arc 自己的 profile 有它），
 * `init-profile.sh` 的 scaffold **没有** —— 新采用者 `repo-setup` 出来的 profile
 * 缺这个键，读它的脚本一跑就失败。
 *
 * **「这个键不需要」与「忘了加进 scaffold」在 scaffold 的输出上同色。**
 * 这条测试让它们分开。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = import.meta.dir;
const SCRIPT = join(HERE, "init-profile.sh");
const scaffold = readFileSync(SCRIPT, "utf8");

/**
 * **真跑一次 scaffold，读它产出的文件** —— #5697 第 2 轮 review 的 P2。
 *
 * 这个文件原来只 `grep` 脚本文本。于是加一个键那行时写成了**裸反引号**
 * （邻行全是 `\``），而 `cat > "$OUT" <<EOF` 的定界符**没加引号** —— shell 把
 * `` `<FILL>` `` 当成命令替换：
 *
 *     bash: command substitution: syntax error near unexpected token `newline'
 *     | `some_key` |  — …      ← <FILL> 被吞掉，值是空的
 *
 * **而脚本退出码仍是 0。** 「scaffold 生成了占位符」与「scaffold 生成了空值」在只读
 * 脚本文本的检查上完全同色 —— 我写的那条正控自己犯了它要防的病。
 */
function runScaffold(): string {
  const dir = mkdtempSync(join(tmpdir(), "init-profile-"));
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const res = Bun.spawnSync(["bash", SCRIPT], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = res.stderr.toString();
    // 退出码是 0 也不够：命令替换失败只写 stderr。两者都要干净。
    if (err.includes("command substitution") || err.includes("syntax error")) {
      throw new Error(`scaffold 的 heredoc 有未转义的元字符：${err.trim().split("\n")[0]}`);
    }
    return readFileSync(join(dir, ".claude/repo-profile.md"), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * skill / 脚本真正从 profile 里读的键。**新增一个就加在这里** —— 这份清单是
 * 「谁读了什么」的唯一声明，下面那条断言拿它去比 scaffold。
 */
const KEYS_READ_BY_SKILLS = [
  "package_manager",
  "test_runner",
  "change_set_record_entry",
  "pr_sweep_freeze_ttl_days",
  "pr_sweep_stale_escalation_days",
] as const;

describe("profile scaffold 的键集（#5697 review P2）", () => {
  test("★ 正控：scaffold 真的被读到了，不是在对一个空串做断言", () => {
    // 空枚举必须先被拒绝：一个读不到文件的实现会让下面每一条 includes 恒假，
    // 而那种失败长得像「键都缺」，与真的缺键同色。
    expect(scaffold.length).toBeGreaterThan(500);
    expect(scaffold).toContain("change_set_record_entry");
  });

  test("★ skill 读的每个键，scaffold 都要生成", () => {
    const missing = KEYS_READ_BY_SKILLS.filter((k) => !scaffold.includes(k));
    expect(missing).toEqual([]);
  });

  test("★ REJECT：一个不存在的键必须被认出来 —— 否则上面那条恒真", () => {
    // 缺这一臂，一个「scaffold 里什么都算有」的检查满足上面的断言。
    expect(scaffold.includes("a_key_that_does_not_exist_5697")).toBe(false);
  });

  test("★★ 真跑 scaffold：每个键都在产出里，`<FILL>` 没有被 shell 吞掉", () => {
    // 只 grep 脚本文本会漏掉 heredoc 的转义问题（本 describe 顶部的注释是实盘）。
    const out = runScaffold();
    expect(out.length).toBeGreaterThan(500); // ★ 正控：真的读到了产出
    const missing = KEYS_READ_BY_SKILLS.filter((k) => !out.includes(k));
    expect(missing).toEqual([]);
    const line = out.split("\n").find((l) => l.includes("change_set_record_entry")) ?? "";
    expect(line).toContain("<FILL:");
  });

  test("test_runner 带 <FILL> 占位 —— scaffold 出来的是待填，不是一个错的默认值", () => {
    const line = scaffold.split("\n").find((l) => l.includes("test_runner")) ?? "";
    expect(line).toContain("<FILL:");
  });
});
