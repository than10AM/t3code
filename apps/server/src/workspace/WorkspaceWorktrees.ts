import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import {
  WorkspaceCheckout,
  WorkspaceConfiguration,
  WorkspaceOperationError,
} from "@t3tools/contracts/multiRepoWorkspace";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const Manifest = Schema.Struct({
  workspace: WorkspaceConfiguration,
  destination: Schema.String,
  branch: Schema.String,
  checkouts: Schema.Array(WorkspaceCheckout),
});
export type WorkspaceWorktreeManifest = typeof Manifest.Type;

export class WorkspaceWorktrees extends Context.Service<
  WorkspaceWorktrees,
  {
    readonly create: (input: {
      readonly workspace: WorkspaceConfiguration;
      readonly destination: string;
      readonly branch: string;
      readonly baseRefs?: Readonly<Record<string, string>>;
    }) => Effect.Effect<WorkspaceWorktreeManifest, WorkspaceOperationError>;
    readonly read: (
      destination: string,
    ) => Effect.Effect<WorkspaceWorktreeManifest | null, WorkspaceOperationError>;
    readonly remove: (destination: string) => Effect.Effect<void, WorkspaceOperationError>;
    readonly markSetup: (
      destination: string,
      repositoryId: string,
      state: "setup" | "ready" | "failed",
      completedPhase?: "cursor" | "t3",
    ) => Effect.Effect<void, WorkspaceOperationError>;
  }
>()("t3/workspace/WorkspaceWorktrees") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const process = yield* VcsProcess.VcsProcess;
  const locks = yield* KeyedLock.make<string>();
  const git = (cwd: string, args: readonly string[]) =>
    process.run({
      operation: "workspace.worktrees",
      command: "git",
      args,
      cwd,
      timeoutMs: 300_000,
    });
  const failure = (operation: string, destination: string, cause: unknown) =>
    Schema.is(WorkspaceOperationError)(cause)
      ? cause
      : new WorkspaceOperationError({
          operation,
          path: destination,
          message: `Workspace ${operation} failed. Existing checkouts have been retained for recovery.`,
          cause,
        });
  const manifestPath = (destination: string) => `${destination}.t3-workspace.json`;
  const save = Effect.fn("WorkspaceWorktrees.save")(function* (
    manifest: WorkspaceWorktreeManifest,
  ) {
    const target = manifestPath(manifest.destination);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(
      `${target}.tmp`,
      yield* Schema.encodeEffect(Schema.fromJsonString(Manifest))(manifest),
    );
    yield* fs.rename(`${target}.tmp`, target);
  });
  const read = (destination: string) =>
    Effect.gen(function* () {
      const target = manifestPath(destination);
      if (!(yield* fs.exists(target))) return null;
      return yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(
        yield* fs.readFileString(target),
      );
    }).pipe(Effect.mapError((cause) => failure("read", destination, cause)));

  const create: WorkspaceWorktrees["Service"]["create"] = (input) =>
    locks.withLock(
      input.destination,
      Effect.gen(function* () {
        const destination = path.resolve(input.destination);
        let manifest = yield* read(destination);
        if (
          manifest !== null &&
          (manifest.branch !== input.branch ||
            manifest.workspace.filePath !== input.workspace.filePath ||
            manifest.workspace.folders[0]?.path !== input.workspace.folders[0]?.path)
        ) {
          return yield* new WorkspaceOperationError({
            operation: "create",
            path: destination,
            message: "This destination belongs to another workspace operation.",
          });
        }
        if (manifest?.checkouts.some((checkout) => checkout.state === "removed"))
          return yield* new WorkspaceOperationError({
            operation: "create",
            path: destination,
            message: "This workspace was removed. Choose a new destination and branch.",
          });
        if (manifest === null) {
          if (yield* fs.exists(destination))
            return yield* new WorkspaceOperationError({
              operation: "create",
              path: destination,
              message: "Worktree destination already exists.",
            });
          const selected = input.workspace.repositories.filter((repo) => repo.selected);
          if (selected.length === 0)
            return yield* new WorkspaceOperationError({
              operation: "create",
              path: destination,
              message: "Select at least one repository.",
            });
          if (new Set(selected.map((repo) => repo.commonDirectory)).size !== selected.length)
            return yield* new WorkspaceOperationError({
              operation: "create",
              path: destination,
              message:
                "Select one checkout per repository. Deselect the main checkout when choosing an alternate.",
            });
          const root = input.workspace.folders[0]!.path;
          const checkouts: WorkspaceCheckout[] = [];
          for (const repo of selected) {
            if (!repo.head)
              return yield* new WorkspaceOperationError({
                operation: "create",
                path: repo.path,
                message: "Commit this repository before creating a worktree.",
              });
            const main = input.workspace.repositories.find(
              (candidate) =>
                candidate.commonDirectory === repo.commonDirectory && !candidate.isWorktree,
            );
            const layoutPath = main?.path ?? repo.path;
            const relative = path.relative(root, layoutPath);
            const target =
              relative === ""
                ? destination
                : relative.startsWith(`..${path.sep}`) ||
                    relative === ".." ||
                    path.isAbsolute(relative)
                  ? path.join(
                      destination,
                      ".workspace-folders",
                      String(checkouts.length),
                      repo.name,
                    )
                  : path.join(destination, relative);
            yield* git(repo.path, ["check-ref-format", "--branch", input.branch]);
            const branches = yield* git(repo.path, [
              "for-each-ref",
              "--format=%(refname)",
              `refs/heads/${input.branch}`,
            ]);
            if (branches.stdout.trim())
              return yield* new WorkspaceOperationError({
                operation: "create",
                path: repo.path,
                message: `Branch ${input.branch} already exists. Choose a new branch name.`,
              });
            const base = yield* git(repo.path, [
              "rev-parse",
              "--verify",
              `${input.baseRefs?.[repo.id] ?? repo.baseRef ?? "HEAD"}^{commit}`,
            ]);
            checkouts.push({
              repositoryId: repo.id,
              sourcePath: repo.path,
              path: target,
              baseCommit: base.stdout.trim(),
              branch: input.branch,
              state: "pending",
            });
          }
          // A folder outside every selected repository cannot be isolated by Git.
          for (const folder of input.workspace.folders) {
            if (
              !selected.some((repo) =>
                input.workspace.repositories.some(
                  (candidate) =>
                    candidate.commonDirectory === repo.commonDirectory &&
                    (folder.path === candidate.path ||
                      folder.path.startsWith(`${candidate.path}${path.sep}`)),
                ),
              )
            ) {
              return yield* new WorkspaceOperationError({
                operation: "create",
                path: folder.path,
                message:
                  "Every workspace folder must belong to a selected repository for isolated mode.",
              });
            }
          }
          checkouts.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
          manifest = { workspace: input.workspace, destination, branch: input.branch, checkouts };
          yield* save(manifest);
        }
        const checkouts = [...manifest.checkouts];
        for (let index = 0; index < checkouts.length; index++) {
          const checkout = checkouts[index]!;
          if (checkout.state !== "pending") continue;
          if (yield* fs.exists(path.join(checkout.path, ".git"))) {
            // Recover the crash window between git worktree add and manifest persistence.
            const common = yield* git(checkout.path, [
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ]);
            const branch = yield* git(checkout.path, ["symbolic-ref", "--short", "HEAD"]);
            const repo = manifest.workspace.repositories.find(
              (candidate) => candidate.id === checkout.repositoryId,
            )!;
            if (
              (yield* fs.realPath(common.stdout.trim())) !== repo.commonDirectory ||
              branch.stdout.trim() !== checkout.branch
            ) {
              return yield* new WorkspaceOperationError({
                operation: "recover",
                path: checkout.path,
                message: "Destination does not match this workspace operation.",
              });
            }
          } else {
            if (yield* fs.exists(checkout.path))
              return yield* new WorkspaceOperationError({
                operation: "create",
                path: checkout.path,
                message: "A worktree destination is occupied.",
              });
            yield* fs.makeDirectory(path.dirname(checkout.path), { recursive: true });
            yield* git(checkout.sourcePath, [
              "worktree",
              "add",
              "-b",
              checkout.branch,
              checkout.path,
              checkout.baseCommit,
            ]);
          }
          checkouts[index] = { ...checkout, state: "created" };
          manifest = { ...manifest, checkouts: [...checkouts] };
          yield* save(manifest);
        }
        return manifest;
      }).pipe(Effect.mapError((cause) => failure("create", input.destination, cause))),
    );

  const remove = (destination: string) =>
    locks.withLock(
      destination,
      Effect.gen(function* () {
        const manifest = yield* read(destination);
        if (manifest === null)
          return yield* new WorkspaceOperationError({
            operation: "remove",
            path: destination,
            message: "No owned workspace manifest was found.",
          });
        // Check every checkout before removing any. Nested repositories are separate owners.
        for (const checkout of manifest.checkouts) {
          if (checkout.state === "removed" || !(yield* fs.exists(checkout.path))) continue;
          const children = manifest.checkouts.filter((child) =>
            child.path.startsWith(`${checkout.path}${path.sep}`),
          );
          const status = yield* git(checkout.path, [
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--",
            ".",
            ...children.map((child) => `:(exclude)${path.relative(checkout.path, child.path)}`),
          ]);
          if (status.stdout.length)
            return yield* new WorkspaceOperationError({
              operation: "remove",
              path: checkout.path,
              message:
                "Worktree has changes. Commit or discard them before removing the workspace.",
            });
        }
        const checkouts = [...manifest.checkouts];
        for (let index = checkouts.length - 1; index >= 0; index--) {
          const checkout = checkouts[index]!;
          if (checkout.state === "removed") continue;
          if (yield* fs.exists(checkout.path))
            yield* git(checkout.sourcePath, ["worktree", "remove", checkout.path]);
          checkouts[index] = { ...checkout, state: "removed" };
          yield* save({ ...manifest, checkouts: [...checkouts] });
        }
      }).pipe(Effect.mapError((cause) => failure("remove", destination, cause))),
    );

  const markSetup: WorkspaceWorktrees["Service"]["markSetup"] = (
    destination,
    repositoryId,
    state,
    completedPhase,
  ) =>
    locks.withLock(
      destination,
      Effect.gen(function* () {
        const manifest = yield* read(destination);
        if (!manifest)
          return yield* new WorkspaceOperationError({
            operation: "setup",
            path: destination,
            message: "Workspace creation manifest is missing.",
          });
        yield* save({
          ...manifest,
          checkouts: manifest.checkouts.map((entry) =>
            entry.repositoryId === repositoryId
              ? {
                  ...entry,
                  state,
                  ...(completedPhase
                    ? {
                        completedSetupPhases: [
                          ...new Set([...(entry.completedSetupPhases ?? []), completedPhase]),
                        ],
                      }
                    : {}),
                }
              : entry,
          ),
        });
      }).pipe(Effect.mapError((cause) => failure("setup", destination, cause))),
    );
  return WorkspaceWorktrees.of({ create, read, remove, markSetup });
});

export const layer = Layer.effect(WorkspaceWorktrees, make);
