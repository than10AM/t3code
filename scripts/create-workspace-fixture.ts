import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

// Deliberately standalone: the acceptance fixture needs only Node and Git.
const root = NodePath.resolve(process.argv[2] ?? ".t3/fixtures/kasqade");
if (NodeFS.existsSync(root)) throw new Error(`Destination already exists: ${root}`);
function write(path: string, text: string) {
  NodeFS.writeFileSync(NodePath.join(root, path), text);
}
function git(cwd: string, ...args: string[]) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function init(cwd: string) {
  NodeFS.mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Workspace Fixture");
  git(cwd, "config", "user.email", "workspace@example.invalid");
  NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "Initial fixture content.\n");
}
init(root);
for (const dir of [".vscode", ".cursor/skills", ".claude"])
  NodeFS.mkdirSync(NodePath.join(root, dir), { recursive: true });
write(
  ".gitignore",
  "kasqade-fs/\nkasqade-ml/\nkasqade-infra/\nkasqade-gitops/\n.fixture-setup.log\n",
);
write(
  "AGENTS.md",
  "This is a harmless workspace acceptance fixture. Keep each repository independent.\n",
);
write(".cursor/skills/README.md", "Shared fixture instructions.\n");
NodeFS.symlinkSync("../.cursor/skills", NodePath.join(root, ".claude/skills"));
write(
  "kasqade.code-workspace",
  `{
  // Matches Kasqade's single-folder repository discovery.
  "folders": [{"name":"kasqade", "path":"."}],
  "settings": {"git.autoRepositoryDetection":"subFolders", "git.repositoryScanMaxDepth":1},
}`,
);
write(
  ".vscode/tasks.json",
  `{
  "version":"2.0.0", "tasks":[
    {"label":"API", "type":"shell", "command":"node -e 'console.log(process.cwd());setInterval(()=>console.log(\\"api tick\\"),1000)'", "options":{"cwd":"\u0024{workspaceFolder}/kasqade-fs"}, "isBackground":true, "problemMatcher":[], "presentation":{"panel":"dedicated","reveal":"always"}},
    {"label":"ML", "type":"shell", "command":"node -e 'console.log(process.cwd())'", "options":{"cwd":"\u0024{workspaceFolder}/kasqade-ml"}},
    {"label":"Start App", "dependsOn":["API","ML"], "dependsOrder":"parallel"},
    {"label":"Sequential", "dependsOn":["ML","ML"], "dependsOrder":"sequence"},
    {"label":"Fails", "type":"shell", "command":"node -e 'process.exit(7)'"},
  ]
}`,
);
write(
  ".cursor/worktrees.json",
  '{"setup-worktree":["echo cursor-parent >> .fixture-setup.log"]}\n',
);
write(
  "t3.json",
  '{"scripts":[{"name":"Fixture setup","command":"echo t3-parent >> .fixture-setup.log","runOnWorktreeCreate":true,"async":false}]}\n',
);
git(root, "add", ".");
git(root, "commit", "-m", "Shared workspace configuration");
for (const name of ["fs", "ml", "infra", "gitops", "slint-demo"]) {
  const child = NodePath.join(root, `kasqade-${name}`);
  init(child);
  NodeFS.writeFileSync(
    NodePath.join(child, "AGENTS.md"),
    `Instructions for the ${name} fixture repository.\n`,
  );
  git(child, "add", ".");
  git(child, "commit", "-m", "Initial child");
}
git(
  NodePath.join(root, "kasqade-fs"),
  "worktree",
  "add",
  "-b",
  "alternate",
  NodePath.join(root, "kasqade-fs-alternate"),
);
NodeFS.mkdirSync(NodePath.join(root, ".worktrees"));
git(
  NodePath.join(root, "kasqade-ml"),
  "worktree",
  "add",
  "-b",
  "hidden-alternate",
  NodePath.join(root, ".worktrees/ml"),
);
console.log(NodePath.join(root, "kasqade.code-workspace"));
