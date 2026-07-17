// Ensures every repo referenced by config/projects.json is cloned into its configured path.
// Idempotent: clones what's missing, fetches what's already there. Run by docker-entrypoint.sh
// before the service starts, so the agent always finds its working copies in a container.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const file = process.env.PROJECTS_FILE || "/app/config/projects.json";
if (!fs.existsSync(file)) {
  console.log(`[ensure-repos] no projects file at ${file}; nothing to clone`);
  process.exit(0);
}

const projects = JSON.parse(fs.readFileSync(file, "utf8"));
for (const project of projects) {
  for (const repo of project.repos) {
    const dir = repo.subdir === "." ? project.path : path.join(project.path, repo.subdir);
    const url = `https://github.com/${repo.name}.git`;
    try {
      if (fs.existsSync(path.join(dir, ".git"))) {
        console.log(`[ensure-repos] fetch ${repo.name}`);
        execFileSync("git", ["-C", dir, "fetch", "--all", "--prune"], { stdio: "inherit" });
      } else {
        console.log(`[ensure-repos] clone ${repo.name} -> ${dir}`);
        fs.mkdirSync(dir, { recursive: true });
        execFileSync("git", ["clone", url, dir], { stdio: "inherit" });
      }
    } catch (err) {
      console.error(`[ensure-repos] failed for ${repo.name}: ${err.message}`);
    }
  }
}
