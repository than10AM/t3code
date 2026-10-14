/**
 * CheckpointStore - Repository interface for filesystem-backed workspace checkpoints.
 *
 * Owns hidden Git-ref checkpoint capture/restore and diff computation for a
 * workspace thread timeline. It does not store user-facing checkpoint metadata
 * and does not coordinate provider conversation rollback.
 *
 * The live adapter resolves the active VCS driver once per checkpoint operation
 * and delegates to the driver's optional checkpoint capability.
 *
 * Uses Effect `Context.Service` for dependency injection and exposes typed
 * domain errors for checkpoint storage operations.
 *
 * @module CheckpointStore
 */
import { VcsUnsupportedOperationError, type CheckpointRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { CheckpointStoreError } from "./Errors.ts";
import type { VcsCheckpointOps } from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly workspaceCheckouts?: readonly import("@t3tools/contracts").WorkspaceCheckout[];
  readonly checkpointRef: CheckpointRef;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly workspaceCheckouts?: readonly import("@t3tools/contracts").WorkspaceCheckout[];
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly workspaceCheckouts?: readonly import("@t3tools/contracts").WorkspaceCheckout[];
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly format?: "patch" | "numstat";
  /** Limits the diff to these exact paths. An empty list yields an empty diff. */
  readonly filePaths?: ReadonlyArray<string>;
}

export interface ListAuthoredPathsInput {
  readonly cwd: string;
  readonly workspaceCheckouts?: readonly import("@t3tools/contracts").WorkspaceCheckout[];
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly workspaceCheckouts?: readonly import("@t3tools/contracts").WorkspaceCheckout[];
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

/** Service tag for checkpoint persistence and restore operations. */
export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    /** Check whether cwd is inside a Git worktree. */
    readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Capture a checkpoint commit and store it at the provided checkpoint ref.
     *
     * Uses an isolated temporary Git index and writes a hidden ref.
     */
    readonly captureCheckpoint: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<void, CheckpointStoreError>;

    /** Check whether a checkpoint ref exists. */
    readonly hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Restore workspace and staging state to a checkpoint.
     *
     * Optionally falls back to current `HEAD` when the checkpoint ref is missing.
     */
    readonly restoreCheckpoint: (
      input: RestoreCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Compute a diff between two checkpoint refs. Defaults to a full patch.
     *
     * Numstat output has NUL-delimited paths for file summaries.
     * Can optionally treat a missing "from" ref as `HEAD`.
     */
    readonly diffCheckpoints: (
      input: DiffCheckpointsInput,
    ) => Effect.Effect<string, CheckpointStoreError>;

    /**
     * List paths changed by work done after the "from" checkpoint: uncommitted
     * edits at either checkpoint, commits made after "from", and commits that
     * left HEAD. Commits a pull, merge, or rebase brought in are older than
     * "from", so their paths are not listed.
     *
     * Returns null when HEAD did not move or a checkpoint does not record HEAD.
     * Then every changed path belongs to the turn.
     */
    readonly listAuthoredPaths: (
      input: ListAuthoredPathsInput,
    ) => Effect.Effect<ReadonlySet<string> | null, CheckpointStoreError>;

    /**
     * Delete the provided checkpoint refs.
     *
     * Best-effort delete: missing refs are tolerated.
     */
    readonly deleteCheckpointRefs: (
      input: DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, CheckpointStoreError>;
  }
>()("t3/checkpointing/CheckpointStore") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const resolveCheckpoints = Effect.fn("CheckpointStore.resolveCheckpoints")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* vcsRegistry.resolve({ cwd });
    if (!handle.driver.checkpoints) {
      return yield* new VcsUnsupportedOperationError({
        operation,
        kind: handle.kind,
        detail: `${handle.kind} driver does not implement checkpoint operations.`,
      });
    }
    return handle.driver.checkpoints satisfies VcsCheckpointOps;
  });

  const isGitRepository: CheckpointStore["Service"]["isGitRepository"] = (cwd) =>
    vcsRegistry
      .detect({ cwd, requestedKind: "git" })
      .pipe(Effect.map((repository) => repository !== null));

  const targets = (input: {
    cwd: string;
    workspaceCheckouts?: readonly import("@t3tools/contracts").WorkspaceCheckout[];
  }) => {
    const root = input.cwd.replaceAll("\\", "/").replace(/\/$/, "");
    return (
      input.workspaceCheckouts?.length
        ? input.workspaceCheckouts
        : [{ path: input.cwd, repositoryId: input.cwd }]
    ).map((checkout, index) => {
      const cwd = checkout.path;
      const normalized = cwd.replaceAll("\\", "/");
      const prefix =
        normalized === root
          ? ""
          : normalized.startsWith(root + "/")
            ? normalized.slice(root.length + 1) + "/"
            : `workspace-${index}/`;
      const excludePaths = (input.workspaceCheckouts ?? [])
        .filter(
          (child) =>
            child.path !== cwd && child.path.replaceAll("\\", "/").startsWith(normalized + "/"),
        )
        .map((child) => child.path.slice(cwd.length + 1));
      return { cwd, prefix, excludePaths };
    });
  };

  const captureCheckpoint: CheckpointStore["Service"]["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    for (const target of targets(input)) {
      const checkpoints = yield* resolveCheckpoints(
        "CheckpointStore.captureCheckpoint",
        target.cwd,
      );
      yield* checkpoints.captureCheckpoint({
        ...input,
        cwd: target.cwd,
        ...(input.workspaceCheckouts ? { excludePaths: target.excludePaths } : {}),
      });
    }
  });

  const hasCheckpointRef: CheckpointStore["Service"]["hasCheckpointRef"] = Effect.fn(
    "hasCheckpointRef",
  )(function* (input) {
    for (const target of targets(input)) {
      const checkpoints = yield* resolveCheckpoints("CheckpointStore.hasCheckpointRef", target.cwd);
      if (!(yield* checkpoints.hasCheckpointRef({ ...input, cwd: target.cwd }))) return false;
    }
    return true;
  });

  const restoreCheckpoint: CheckpointStore["Service"]["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    // Preflight every ref before the first repository is changed.
    if (!input.fallbackToHead && !(yield* hasCheckpointRef(input))) return false;
    for (const target of targets(input).reverse()) {
      const checkpoints = yield* resolveCheckpoints(
        "CheckpointStore.restoreCheckpoint",
        target.cwd,
      );
      if (
        !(yield* checkpoints.restoreCheckpoint({
          ...input,
          cwd: target.cwd,
          excludePaths: target.excludePaths,
        }))
      )
        return false;
    }
    return true;
  });

  const diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"] = Effect.fn(
    "diffCheckpoints",
  )(function* (input) {
    const diffs: string[] = [];
    for (const target of targets(input)) {
      const checkpoints = yield* resolveCheckpoints("CheckpointStore.diffCheckpoints", target.cwd);
      const filePaths = input.filePaths
        ?.filter(
          (file) =>
            file.startsWith(target.prefix) &&
            !target.excludePaths.some((excluded) =>
              file.startsWith(target.prefix + excluded + "/"),
            ),
        )
        .map((file) => file.slice(target.prefix.length));
      diffs.push(
        yield* checkpoints.diffCheckpoints({
          ...input,
          cwd: target.cwd,
          pathPrefix: target.prefix,
          ...(filePaths ? { filePaths } : {}),
        }),
      );
    }
    return diffs.join("");
  });

  const listAuthoredPaths: CheckpointStore["Service"]["listAuthoredPaths"] = Effect.fn(
    "listAuthoredPaths",
  )(function* (input) {
    // A null filter preserves every repository's edits when any HEAD is unchanged.
    const paths = new Set<string>();
    for (const target of targets(input)) {
      const checkpoints = yield* resolveCheckpoints(
        "CheckpointStore.listAuthoredPaths",
        target.cwd,
      );
      const authored = yield* checkpoints.listAuthoredPaths({ ...input, cwd: target.cwd });
      if (authored === null) return null;
      for (const file of authored) paths.add(target.prefix + file);
    }
    return paths;
  });

  const deleteCheckpointRefs: CheckpointStore["Service"]["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    for (const target of targets(input)) {
      const checkpoints = yield* resolveCheckpoints(
        "CheckpointStore.deleteCheckpointRefs",
        target.cwd,
      );
      yield* checkpoints.deleteCheckpointRefs({ ...input, cwd: target.cwd });
    }
  });

  return CheckpointStore.of({
    isGitRepository,
    captureCheckpoint,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    listAuthoredPaths,
    deleteCheckpointRefs,
  });
});

export const layer = Layer.effect(CheckpointStore, make);
