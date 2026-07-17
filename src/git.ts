import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { WorkTarget } from "./config";
import { log } from "./logger";

const execFileAsync = promisify(execFile);

/**
 * Fetches each of the target's repos' remotes before a task so Claude branches from and PRs
 * against up-to-date refs. Deliberately non-destructive: no reset/checkout/clean, because messages
 * are follow-ups in an ongoing conversation - wiping the working tree between messages would throw
 * away in-progress work the next message is meant to build on. Failures are logged, not fatal.
 */
export async function fetchTargetRepos(target: WorkTarget): Promise<void> {
  for (const repo of target.repos) {
    const cwd = repo.subdir === "." ? target.cwd : path.join(target.cwd, repo.subdir);
    try {
      await execFileAsync("git", ["-C", cwd, "fetch", "--all", "--prune"], { timeout: 120000 });
      log("git_fetch_ok", { target: target.label, repo: repo.name });
    } catch (err) {
      log("git_fetch_failed", { target: target.label, repo: repo.name, error: String(err) });
    }
  }
}
