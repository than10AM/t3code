import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  WorkspaceConfiguration,
  WorkspaceFile,
  WorkspaceOperationError,
  type WorkspaceRepository,
  type WorkspaceTasksResult,
} from "@t3tools/contracts/multiRepoWorkspace";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { parseWorkspaceTasks } from "@t3tools/shared/workspaceTasks";
import * as VcsProcess from "../vcs/VcsProcess.ts";

export class MultiRepoWorkspace extends Context.Service<
  MultiRepoWorkspace,
  {
    readonly discover: (input: {
      readonly path: string;
    }) => Effect.Effect<WorkspaceConfiguration, WorkspaceOperationError>;
    readonly tasks: (input: {
      readonly path: string;
      readonly workspace?: WorkspaceConfiguration;
    }) => Effect.Effect<typeof WorkspaceTasksResult.Type, WorkspaceOperationError>;
  }
>()("t3/workspace/MultiRepoWorkspace") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const process = yield* VcsProcess.VcsProcess;
  const git = (cwd: string, args: readonly string[]) =>
    process.run({
      operation: "workspace.discover",
      command: "git",
      args,
      cwd,
      allowNonZeroExit: true,
    });
  const readFile = (filePath: string) =>
    fs.readFileString(filePath).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
      }),
    );

  const discover = Effect.fn("MultiRepoWorkspace.discover")(
    function* (input: { readonly path: string }) {
      const location = path.resolve(input.path);
      const stat = yield* fs.stat(location);
      let filePath: string | null = stat.type === "File" ? location : null;
      if (stat.type !== "File" && stat.type !== "Directory") {
        return yield* new WorkspaceOperationError({
          operation: "discover",
          path: location,
          message: "Choose a workspace file or directory.",
        });
      }
      if (filePath !== null && !filePath.endsWith(".code-workspace")) {
        return yield* new WorkspaceOperationError({
          operation: "discover",
          path: location,
          message: "Expected a .code-workspace file.",
        });
      }
      if (filePath === null) {
        const candidates = (yield* fs.readDirectory(location))
          .filter((name) => name.endsWith(".code-workspace"))
          .sort();
        if (candidates.length === 1) filePath = path.join(location, candidates[0]!);
        if (candidates.length > 1)
          return yield* new WorkspaceOperationError({
            operation: "discover",
            path: location,
            message: "Multiple workspace files found. Choose a .code-workspace file explicitly.",
          });
      }
      const file =
        filePath === null
          ? null
          : yield* Schema.decodeEffect(fromLenientJson(WorkspaceFile))(
              yield* fs.readFileString(filePath),
            );
      const settings = file?.settings ?? {};
      const detection = settings["git.autoRepositoryDetection"] ?? true;
      const detectSubfolders = file !== null && (detection === true || detection === "subFolders");
      const depth = settings["git.repositoryScanMaxDepth"] ?? 1;
      if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0 || depth > 20) {
        return yield* new WorkspaceOperationError({
          operation: "discover",
          path: location,
          message: "Repository scan depth must be an integer between 0 and 20.",
        });
      }
      const base = filePath === null ? location : path.dirname(filePath);
      const folders: Array<(typeof WorkspaceConfiguration.Type.folders)[number]> = [];
      for (const folder of file?.folders ?? [{ path: location }]) {
        if (/^[a-z][a-z\d+.-]*:\/\//i.test(folder.path))
          return yield* new WorkspaceOperationError({
            operation: "discover",
            path: folder.path,
            message: "Workspace URI folders are not supported; use server filesystem paths.",
          });
        const folderPath = yield* fs.realPath(path.resolve(base, folder.path));
        if ((yield* fs.stat(folderPath)).type !== "Directory")
          return yield* new WorkspaceOperationError({
            operation: "discover",
            path: folderPath,
            message: "Workspace folder is not a directory.",
          });
        if (!folders.some((item) => item.path === folderPath))
          folders.push({
            id: folderPath,
            name: folder.name ?? path.basename(folderPath),
            path: folderPath,
          });
      }
      if (folders.length === 0)
        return yield* new WorkspaceOperationError({
          operation: "discover",
          path: location,
          message: "Workspace contains no folders.",
        });
      const repositories: WorkspaceRepository[] = [];
      const seen = new Set<string>();
      const scan = Effect.fn("MultiRepoWorkspace.scan")(function* (
        cwd: string,
        folderId: string,
        remaining: number,
      ): Effect.fn.Return<
        void,
        | WorkspaceOperationError
        | import("effect/PlatformError").PlatformError
        | import("@t3tools/contracts").VcsError
      > {
        if (seen.has(cwd)) return;
        seen.add(cwd);
        if (seen.size > 2000)
          return yield* new WorkspaceOperationError({
            operation: "discover",
            path: location,
            message: "Repository discovery exceeded 2000 directories. Reduce the scan depth.",
          });
        const marker = path.join(cwd, ".git");
        if (yield* fs.exists(marker)) {
          const root = yield* git(cwd, ["rev-parse", "--show-toplevel"]);
          if (root.exitCode === 0 && path.resolve(root.stdout.trim()) === cwd) {
            const common = yield* git(cwd, [
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ]);
            const head = yield* git(cwd, ["rev-parse", "--verify", "HEAD"]);
            const branch = yield* git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
            const commonDirectory = yield* fs.realPath(common.stdout.trim());
            const gitDirectory = yield* git(cwd, ["rev-parse", "--absolute-git-dir"]);
            const isWorktree = (yield* fs.realPath(gitDirectory.stdout.trim())) !== commonDirectory;
            repositories.push({
              id: cwd,
              folderId,
              name: path.basename(cwd),
              path: cwd,
              commonDirectory,
              head: head.exitCode === 0 ? head.stdout.trim() : "",
              branch: branch.exitCode === 0 ? branch.stdout.trim() : null,
              isWorktree,
              selected: !isWorktree,
            });
            if (isWorktree && cwd !== folderId) return;
          }
        }
        if (remaining === 0) return;
        for (const name of (yield* fs.readDirectory(cwd)).sort()) {
          // Generated worktree collections and dependencies are never discovery roots.
          if (
            name.startsWith(".") ||
            ["node_modules", "vendor", "dist", "build", "target"].includes(name)
          )
            continue;
          const child = path.join(cwd, name);
          const childStat = yield* fs.stat(child).pipe(
            Effect.catchTags({
              PlatformError: (error) =>
                error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
            }),
          );
          if (childStat?.type !== "Directory") continue;
          if ((yield* fs.realPath(child)) !== child) continue;
          yield* scan(child, folderId, remaining - 1);
        }
      });
      for (const folder of folders)
        yield* scan(folder.path, folder.id, detectSubfolders ? depth : 0);
      // An explicitly opened linked worktree is intentional, unlike incidental siblings.
      for (const folder of folders) {
        const index = repositories.findIndex((repo) => repo.path === folder.path);
        if (index !== -1) repositories[index] = { ...repositories[index]!, selected: true };
      }
      return {
        filePath,
        folders,
        repositories,
        scanDepth: depth,
        detectSubfolders,
      } satisfies WorkspaceConfiguration;
    },
    Effect.mapError((cause) =>
      Schema.is(WorkspaceOperationError)(cause)
        ? cause
        : new WorkspaceOperationError({
            operation: "discover",
            path: inputPath(cause),
            message: "Could not read workspace configuration or repositories.",
            cause,
          }),
    ),
  );

  const tasks = Effect.fn("MultiRepoWorkspace.tasks")(
    function* (input: { readonly path: string; readonly workspace?: WorkspaceConfiguration }) {
      const workspace = input.workspace ?? (yield* discover(input));
      const result: {
        tasks: Array<(typeof WorkspaceTasksResult.Type.tasks)[number]>;
        errors: string[];
      } = { tasks: [], errors: [] };
      const append = (contents: string, folderId: string, source: string) => {
        const parsed = parseWorkspaceTasks(contents, folderId, source);
        result.tasks.push(...parsed.tasks);
        result.errors.push(...parsed.errors);
      };
      for (const folder of workspace.folders) {
        const source = path.join(folder.path, ".vscode", "tasks.json");
        const contents = yield* readFile(source);
        if (contents !== null) yield* Effect.try(() => append(contents, folder.id, source));
      }
      if (workspace.filePath !== null) {
        const file = yield* Schema.decodeEffect(fromLenientJson(WorkspaceFile))(
          yield* fs.readFileString(workspace.filePath),
        );
        if (file.tasks !== undefined) {
          const contents = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            file.tasks,
          );
          yield* Effect.try(() => append(contents, workspace.folders[0]!.id, workspace.filePath!));
        }
      }
      return result;
    },
    Effect.mapError((cause) =>
      Schema.is(WorkspaceOperationError)(cause)
        ? cause
        : new WorkspaceOperationError({
            operation: "tasks",
            path: "",
            message: "Could not read workspace tasks.",
            cause,
          }),
    ),
  );

  return MultiRepoWorkspace.of({ discover, tasks });
});

function inputPath(cause: unknown): string {
  return Schema.is(WorkspaceOperationError)(cause) ? cause.path : "";
}

export const layer = Layer.effect(MultiRepoWorkspace, make);
