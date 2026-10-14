import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as VcsProcess from "../vcs/VcsProcess.ts";

/** A parent with ignored independent repositories, like the Kasqade checkout. */
export const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const process = yield* VcsProcess.VcsProcess;
  const temp = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-" }));
  const root = path.join(temp, "kasqade");
  const git = (cwd: string, args: string[]) =>
    process.run({ operation: "test.workspace", command: "git", args, cwd });
  const init = Effect.fn(function* (cwd: string) {
    yield* fs.makeDirectory(cwd, { recursive: true });
    yield* git(cwd, ["init", "-b", "main"]);
    yield* git(cwd, ["config", "user.name", "Workspace Test"]);
    yield* git(cwd, ["config", "user.email", "workspace@example.invalid"]);
    yield* fs.writeFileString(path.join(cwd, "README.md"), "initial\n");
  });
  yield* init(root);
  yield* fs.writeFileString(
    path.join(root, ".gitignore"),
    "kasqade-fs/\nkasqade-ml/\nkasqade-infra/\nkasqade-gitops/\n",
  );
  yield* fs.writeFileString(
    path.join(root, "kasqade.code-workspace"),
    `{
    "folders": [{"name":"kasqade", "path":"."}],
    "settings": {"git.autoRepositoryDetection":"subFolders", "git.repositoryScanMaxDepth":1},
  }`,
  );
  yield* fs.makeDirectory(path.join(root, ".cursor", "skills"), { recursive: true });
  yield* fs.writeFileString(path.join(root, ".cursor", "skills", "README.md"), "shared skills\n");
  yield* fs.makeDirectory(path.join(root, ".claude"));
  yield* fs.symlink("../.cursor/skills", path.join(root, ".claude", "skills"));
  yield* fs.makeDirectory(path.join(root, ".vscode"));
  yield* fs.writeFileString(
    path.join(root, ".vscode", "tasks.json"),
    `{
    "version":"2.0.0", "tasks":[
      {"label":"Backend", "type":"shell", "command":"node --version", "options":{"cwd":"\u0024{workspaceFolder}/kasqade-fs"}, "isBackground":true},
      {"label":"ML", "type":"shell", "command":"node --version", "options":{"cwd":"\u0024{workspaceFolder}/kasqade-ml"}},
      {"label":"Start App", "dependsOn":["Backend","ML"], "dependsOrder":"parallel"},
    ]
  }`,
  );
  yield* git(root, ["add", "."]);
  yield* git(root, ["commit", "-m", "workspace"]);
  for (const name of ["fs", "ml", "infra", "gitops", "slint-demo"]) {
    const cwd = path.join(root, `kasqade-${name}`);
    yield* init(cwd);
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial"]);
  }
  yield* git(path.join(root, "kasqade-fs"), [
    "worktree",
    "add",
    "-b",
    "alternate",
    path.join(root, "kasqade-fs-alternate"),
  ]);
  return { root, temp, git };
});
