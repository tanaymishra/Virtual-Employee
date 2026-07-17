import { config, ProjectConfig, findProjectByAlias } from "./config";

export type ProjectResolution =
  | { kind: "resolved"; project: ProjectConfig }
  | { kind: "ambiguous"; aliases: string[] }
  | { kind: "unknown" };

/**
 * Picks the project a message is about.
 * 1. An explicitly-mentioned alias (whole word, case-insensitive) wins.
 * 2. If none is mentioned and only one project exists, use it.
 * 3. If none is mentioned but there IS a "current" project (the last one worked on), keep
 *    talking to it - this is what makes plain follow-ups ("also fix the header") work like a
 *    normal continuing Claude Code conversation instead of asking "which project?" every time.
 * 4. Otherwise, ambiguous/unknown.
 */
export function resolveProject(text: string, lastProjectAlias: string | null): ProjectResolution {
  const lower = text.toLowerCase();
  const matches = config.projects.filter((p) => {
    const re = new RegExp(`\\b${escapeRegExp(p.alias.toLowerCase())}\\b`);
    return re.test(lower);
  });

  if (matches.length === 1) {
    return { kind: "resolved", project: matches[0] };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", aliases: matches.map((p) => p.alias) };
  }
  if (config.projects.length === 1) {
    return { kind: "resolved", project: config.projects[0] };
  }
  if (lastProjectAlias) {
    const project = findProjectByAlias(lastProjectAlias);
    if (project) {
      return { kind: "resolved", project };
    }
  }
  return { kind: "unknown" };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
