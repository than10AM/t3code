import * as MultiRepoWorkspace from "./MultiRepoWorkspace.ts";
import { WorkspaceCheckout } from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";

import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectEntry,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

export class WorkspaceEntriesWindowsPathUnsupportedError extends Schema.TaggedError<WorkspaceEntriesWindowsPathUnsupportedError>()(
  "WorkspaceEntriesWindowsPathUnsupportedError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    platform: Schema.String,
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Windows-style workspace path '${this.partialPath}' is not supported on '${this.platform}'${cwd}.`;
  }
}

export class WorkspaceEntriesCurrentProjectRequiredError extends Schema.TaggedError<WorkspaceEntriesCurrentProjectRequiredError>()(
  "WorkspaceEntriesCurrentProjectRequiredError",
  {
    partialPath: Schema.String,
  },
) {
  override get message(): string {
    return `A current project is required to browse relative workspace path '${this.partialPath}'.`;
  }
}

export class WorkspaceEntriesReadDirectoryError extends Schema.TaggedError<WorkspaceEntriesReadDirectoryError>()(
  "WorkspaceEntriesReadDirectoryError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    parentPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Failed to read workspace directory '${this.parentPath}' while browsing '${this.partialPath}'${cwd}.`;
  }
}

export const WorkspaceEntriesBrowseError = Schema.Union([
  WorkspaceEntriesWindowsPathUnsupportedError,
  WorkspaceEntriesCurrentProjectRequiredError,
  WorkspaceEntriesReadDirectoryError,
]);
export type WorkspaceEntriesBrowseError = typeof WorkspaceEntriesBrowseError.Type;

export const WorkspaceEntriesError = Schema.Union([
  WorkspaceEntriesReadDirectoryError,
  WorkspacePaths.WorkspaceRootNotExistsError,
  WorkspacePaths.WorkspaceRootCreateFailedError,
  WorkspacePaths.WorkspaceRootStatFailedError,
  WorkspacePaths.WorkspaceRootNotDirectoryError,
  WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed,
  WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut,
  WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed,
]);
export type WorkspaceEntriesError = typeof WorkspaceEntriesError.Type;

export class WorkspaceEntries extends Context.Service<
  WorkspaceEntries,
  {
    readonly browse: (
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesBrowseError>;
    readonly list: (
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
    readonly searchContents: (
      input: ProjectSearchContentsInput,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceEntriesError>;
    readonly refresh: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/workspace/WorkspaceEntries") {}

const resolveBrowseTarget = Effect.fn("WorkspaceEntries.resolveBrowseTarget")(function* (
  input: FilesystemBrowseInput,
  path: Path.Path,
): Effect.fn.Return<string, WorkspaceEntriesBrowseError> {
  const platform = yield* HostProcess.Platform;
  if (platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
    return yield* new WorkspaceEntriesWindowsPathUnsupportedError({
      cwd: input.cwd,
      partialPath: input.partialPath,
      platform,
    });
  }

  if (!isExplicitRelativePath(input.partialPath)) {
    return path.resolve(expandHomePath(input.partialPath, yield* HostProcess.HomeDirectory));
  }

  if (!input.cwd) {
    return yield* new WorkspaceEntriesCurrentProjectRequiredError({
      partialPath: input.partialPath,
    });
  }
  return path.resolve(
    expandHomePath(input.cwd, yield* HostProcess.HomeDirectory),
    input.partialPath,
  );
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceSearchIndexes = yield* WorkspaceSearchIndex.WorkspaceSearchIndexMap;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const workspaces = yield* MultiRepoWorkspace.MultiRepoWorkspace;

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd);
  });

  const refresh: WorkspaceEntries["Service"]["refresh"] = Effect.fn("WorkspaceEntries.refresh")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.orElseSucceed(() => cwd),
      );
      for (const variant of WorkspaceSearchIndex.WORKSPACE_SEARCH_INDEX_VARIANTS) {
        const indexKey = WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, variant);
        if (!(yield* RcMap.has(workspaceSearchIndexes.rcMap, indexKey))) {
          continue;
        }
        const recoverRefreshFailure = (
          cause:
            | WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed
            | WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut
            | WorkspaceSearchIndex.WorkspaceSearchIndexRefreshFailed,
        ) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Failed to refresh workspace search index", {
              cwd,
              variant,
              cause,
            });
            yield* workspaceSearchIndexes.invalidate(indexKey);
          });
        yield* Effect.gen(function* () {
          const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
          yield* searchIndex.refresh();
        }).pipe(
          Effect.provide(workspaceSearchIndexes.get(indexKey)),
          Effect.catchTags({
            WorkspaceSearchIndexCreateFailed: recoverRefreshFailure,
            WorkspaceSearchIndexScanTimedOut: recoverRefreshFailure,
            WorkspaceSearchIndexRefreshFailed: recoverRefreshFailure,
          }),
        );
      }
    },
  );

  const browse: WorkspaceEntries["Service"]["browse"] = Effect.fn("WorkspaceEntries.browse")(
    function* (input) {
      const resolvedInputPath = yield* resolveBrowseTarget(input, path);
      const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
      const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
      const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);

      const dirents = yield* Effect.tryPromise({
        try: () => NodeFSP.readdir(parentPath, { withFileTypes: true }),
        catch: (cause) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: input.cwd,
            partialPath: input.partialPath,
            parentPath,
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) => {
            const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
            return code === "EACCES" || code === "EPERM";
          },
          () => Effect.succeed([]),
        ),
      );

      const showHidden = endsWithSeparator || prefix.startsWith(".");
      const lowerPrefix = prefix.toLowerCase();
      const entries: Array<{ readonly name: string; readonly fullPath: string }> = [];
      for (const dirent of dirents) {
        if (
          dirent.isDirectory() &&
          dirent.name.toLowerCase().startsWith(lowerPrefix) &&
          (showHidden || !dirent.name.startsWith("."))
        ) {
          entries.push({
            name: dirent.name,
            fullPath: path.join(parentPath, dirent.name),
          });
        }
      }

      return {
        parentPath,
        entries: entries.toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    },
  );

  const searchSingle: WorkspaceEntries["Service"]["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      const normalizedQuery = normalizeSearchQuery(input.query, {
        trimLeadingPattern: /^[@./]+/,
      });
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.search(normalizedQuery, input.limit, input.kind, input.imageOnly);
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
      );
    },
  );

  const searchContentsSingle: WorkspaceEntries["Service"]["searchContents"] = Effect.fn(
    "WorkspaceEntries.searchContents",
  )(function* (input) {
    const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
    return yield* Effect.gen(function* () {
      const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
      return yield* searchIndex.searchContents(input);
    }).pipe(
      Effect.provide(
        workspaceSearchIndexes.get(
          WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "content"),
        ),
      ),
    );
  });

  const listSingle: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      if (input.directoryPath !== undefined) {
        const directoryPath = input.directoryPath;
        const toError = (cause: unknown) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: normalizedCwd,
            partialPath: directoryPath,
            parentPath: path.resolve(normalizedCwd, directoryPath),
            cause,
          });
        const target =
          directoryPath === ""
            ? { absolutePath: normalizedCwd, relativePath: "" }
            : yield* workspacePaths
                .resolveRelativePathWithinRoot({
                  workspaceRoot: normalizedCwd,
                  relativePath: directoryPath,
                })
                .pipe(Effect.mapError(toError));
        const entries = yield* Effect.tryPromise({
          try: async () => {
            const root = await NodeFSP.realpath(normalizedCwd);
            const directory = await NodeFSP.realpath(target.absolutePath);
            const relative = path.relative(root, directory);
            if (
              relative === ".." ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative) ||
              relative.split(path.sep).includes(".git") ||
              target.relativePath.split("/").includes(".git")
            ) {
              throw new Error("Directory must be inside the workspace and outside .git.");
            }
            const children = await NodeFSP.readdir(directory, { withFileTypes: true });
            return children.flatMap((child): ProjectEntry[] => {
              if (child.name === ".git" || (!child.isDirectory() && !child.isFile())) return [];
              return [
                {
                  path: target.relativePath ? `${target.relativePath}/${child.name}` : child.name,
                  kind: child.isDirectory() ? "directory" : "file",
                },
              ];
            });
          },
          catch: toError,
        });
        // Use stdin so large directories cannot exceed the command-line argument limit.
        // Ignore classification is optional in non-git workspaces or when git is unavailable.
        const ignored = new Set<string>();
        for (let offset = 0; offset < entries.length; offset += 1000) {
          const chunk = entries.slice(offset, offset + 1000);
          const result = yield* vcsProcess
            .run({
              operation: "WorkspaceEntries.list",
              command: "git",
              args: ["-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"],
              cwd: target.absolutePath,
              stdin: `${chunk.map((entry) => path.join(normalizedCwd, entry.path)).join("\0")}\0`,
              allowNonZeroExit: true,
              timeoutMs: 10_000,
              maxOutputBytes: 16 * 1024 * 1024,
            })
            .pipe(Effect.orElseSucceed(() => undefined));
          if (!result || (result.exitCode !== 0 && result.exitCode !== 1)) break;
          for (const ignoredPath of result.stdout.split("\0"))
            ignored.add(path.relative(normalizedCwd, ignoredPath).split(path.sep).join("/"));
        }
        // A nested repository owns its ignore rules even when the parent ignores its root.
        for (const entry of entries) {
          if (entry.kind !== "directory" || !ignored.has(entry.path)) continue;
          const marker = path.join(normalizedCwd, entry.path, ".git");
          if (
            yield* Effect.tryPromise(() => NodeFSP.stat(marker)).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            )
          )
            ignored.delete(entry.path);
        }
        return {
          entries: entries.map((entry) =>
            ignored.has(entry.path) ? { ...entry, ignored: true } : entry,
          ),
          truncated: false,
        };
      }
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.list();
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
      );
    },
  );

  const rootCache = new Map<
    string,
    { expires: number; roots: readonly { id: string; path: string }[] }
  >();
  const rootsFor = Effect.fn(
    function* (input: {
      cwd: string;
      workspaceCheckouts?: readonly WorkspaceCheckout[] | undefined;
    }) {
      if (input.workspaceCheckouts?.length)
        return input.workspaceCheckouts.map((entry) => ({
          id: entry.repositoryId,
          path: entry.path,
        }));
      const cached = rootCache.get(input.cwd);
      if (cached && cached.expires > (yield* Clock.currentTimeMillis)) return cached.roots;
      const manifest = yield* Effect.tryPromise(() =>
        NodeFSP.readFile(`${input.cwd}.t3-workspace.json`, "utf8"),
      ).pipe(Effect.orElseSucceed(() => null));
      let roots: readonly { id: string; path: string }[] = [];
      if (manifest !== null) {
        const parsed = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ checkouts: Schema.Array(WorkspaceCheckout) })),
        )(manifest);
        roots = parsed.checkouts
          .filter((entry) => entry.state !== "removed")
          .map((entry) => ({ id: entry.repositoryId, path: entry.path }));
      } else {
        const files = yield* Effect.tryPromise(() => NodeFSP.readdir(input.cwd));
        if (files.some((file) => file.endsWith(".code-workspace"))) {
          const workspace = yield* workspaces.discover({ path: input.cwd });
          roots = workspace.repositories
            .filter((repo) => repo.selected)
            .map((repo) => ({ id: repo.id, path: repo.path }));
        }
      }
      rootCache.set(input.cwd, { expires: (yield* Clock.currentTimeMillis) + 10_000, roots });
      return roots;
    },
    Effect.mapError(
      (cause) => new WorkspaceEntriesReadDirectoryError({ partialPath: "", parentPath: "", cause }),
    ),
  );
  const prefixFor = (cwd: string, repository: string) => {
    const relative = path.relative(cwd, repository).split(path.sep).join("/");
    return relative === "" ? "" : relative + "/";
  };
  const owned = (file: string, root: string, roots: readonly { path: string }[]) =>
    !roots.some(
      (other) =>
        other.path.startsWith(root + path.sep) && file.startsWith(prefixFor(root, other.path)),
    );
  const search: WorkspaceEntries["Service"]["search"] = (input) =>
    Effect.gen(function* () {
      const roots = yield* rootsFor(input);
      if (roots.length < 2) return yield* searchSingle(input);
      const groups = yield* Effect.forEach(
        roots,
        (root) =>
          searchSingle({ ...input, cwd: root.path }).pipe(
            Effect.map((result) => ({
              ...result,
              entries: result.entries
                .filter((entry) => owned(entry.path, root.path, roots))
                .map((entry) => ({
                  ...entry,
                  path: prefixFor(input.cwd, root.path) + entry.path,
                  repositoryId: root.id,
                })),
            })),
          ),
        { concurrency: 4 },
      );
      const entries = groups.flatMap((group) => group.entries);
      return {
        entries: entries.slice(0, input.limit),
        truncated: entries.length > input.limit || groups.some((group) => group.truncated),
      };
    });
  const searchContents: WorkspaceEntries["Service"]["searchContents"] = (input) =>
    Effect.gen(function* () {
      const roots = yield* rootsFor(input);
      if (roots.length < 2) return yield* searchContentsSingle(input);
      const groups = yield* Effect.forEach(
        roots,
        (root) =>
          searchContentsSingle({ ...input, cwd: root.path }).pipe(
            Effect.map((result) => ({
              ...result,
              matches: result.matches
                .filter((entry) => owned(entry.path, root.path, roots))
                .map((entry) => ({
                  ...entry,
                  path: prefixFor(input.cwd, root.path) + entry.path,
                  repositoryId: root.id,
                })),
            })),
          ),
        { concurrency: 4 },
      );
      const matches = groups.flatMap((group) => group.matches);
      return {
        matches: matches.slice(0, input.limit),
        truncated: matches.length > input.limit || groups.some((group) => group.truncated),
        ...(groups.find((group) => group.regexFallbackError)?.regexFallbackError
          ? {
              regexFallbackError: groups.find((group) => group.regexFallbackError)!
                .regexFallbackError,
            }
          : {}),
      };
    });
  const list: WorkspaceEntries["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      if (input.directoryPath !== undefined) return yield* listSingle(input);
      const roots = yield* rootsFor(input);
      if (roots.length < 2) return yield* listSingle(input);
      const groups = yield* Effect.forEach(
        roots,
        (root) =>
          listSingle({ ...input, cwd: root.path }).pipe(
            Effect.map((result) => ({
              ...result,
              entries: result.entries
                .filter((entry) => owned(entry.path, root.path, roots))
                .map((entry) => ({
                  ...entry,
                  path: prefixFor(input.cwd, root.path) + entry.path,
                  repositoryId: root.id,
                })),
            })),
          ),
        { concurrency: 4 },
      );
      return {
        entries: groups.flatMap((group) => group.entries),
        truncated: groups.some((group) => group.truncated),
      };
    });
  return WorkspaceEntries.of({
    browse,
    list,
    refresh: (cwd) => {
      rootCache.delete(cwd);
      return refresh(cwd);
    },
    search,
    searchContents,
  });
});

export const layer = Layer.effect(WorkspaceEntries, make).pipe(
  Layer.provide(MultiRepoWorkspace.layer),
  Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
  Layer.provide(VcsProcess.layer),
);
