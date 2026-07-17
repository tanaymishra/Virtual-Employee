import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { ProjectConfig } from "./config";
import { log } from "./logger";

const execFileAsync = promisify(execFile);

function repoPath(project: ProjectConfig, subdir: string): string {
  return subdir === "." ? project.path : path.join(project.path, subdir);
}

/**
 * Fetches each member repo's remotes before a task so Claude branches from and PRs against
 * up-to-date refs. Deliberately non-destructive: no reset/checkout/clean, because messages are
 * follow-ups in an ongoing conversation - wiping the working tree between messages would throw
 * away in-progress work the next message is meant to build on. Failures are logged, not fatal.
 */
export async function fetchProjectRepos(project: ProjectConfig): Promise<void> {
  for (const repo of project.repos) {
    const cwd = repoPath(project, repo.subdir);
    try {
      await execFileAsync("git", ["-C", cwd, "fetch", "--all", "--prune"], { timeout: 120000 });
      log("git_fetch_ok", { project: project.alias, repo: repo.name });
    } catch (err) {
      log("git_fetch_failed", { project: project.alias, repo: repo.name, error: String(err) });
    }
  }
}
