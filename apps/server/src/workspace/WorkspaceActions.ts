import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  ThreadId,
  WorkspaceOperationError,
  type WorkspaceActionRun,
  type WorkspaceActionsSnapshot,
  type WorkspaceTask,
} from "@t3tools/contracts";
import { resolveWorkspaceVariables, workspaceTaskGraph } from "@t3tools/shared/workspaceTasks";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as MultiRepoWorkspace from "./MultiRepoWorkspace.ts";

export class WorkspaceActions extends Context.Service<
  WorkspaceActions,
  {
    readonly snapshot: (
      threadId: ThreadId,
    ) => Effect.Effect<typeof WorkspaceActionsSnapshot.Type, WorkspaceOperationError>;
    readonly start: (input: {
      threadId: ThreadId;
      taskId: string;
    }) => Effect.Effect<void, WorkspaceOperationError>;
    readonly cancel: (threadId: ThreadId) => Effect.Effect<void, WorkspaceOperationError>;
  }
>()("t3/workspace/WorkspaceActions") {}

const make = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const platform = yield* HostProcess.Platform;
  const locks = yield* KeyedLock.make<ThreadId>();
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const workspaces = yield* MultiRepoWorkspace.MultiRepoWorkspace;
  const scripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const terminals = yield* TerminalManager.TerminalManager;
  const path = yield* Path.Path;
  const runs = new Map<ThreadId, WorkspaceActionRun[]>();
  const fibers = new Map<ThreadId, Fiber.Fiber<void, never>>();
  const crypto = yield* Crypto.Crypto;
  const sessionId = (yield* crypto.randomUUIDv4().pipe(Effect.orDie)).slice(0, 8);
  const dedicated = new Map<string, string>();
  const shared = new Map<string, string[]>();
  let sequence = 0;
  const failure = (threadId: string, cause: unknown) =>
    Schema.is(WorkspaceOperationError)(cause)
      ? cause
      : new WorkspaceOperationError({
          operation: "actions",
          path: threadId,
          message: cause instanceof Error ? cause.message : "Workspace action failed",
          cause,
        });
  const resolve = Effect.fn(function* (threadId: ThreadId) {
    const thread = yield* projections.getThread(threadId);
    const project = Option.getOrUndefined(yield* projects.getById(thread.projectId));
    if (!project) return yield* failure(threadId, "Project not found");
    const root = thread.worktreePath ?? project.workspaceRoot;
    const original =
      thread.workspace ??
      project.workspace ??
      (yield* workspaces.discover({ path: project.workspaceRoot }));
    const remap = (source: string) => {
      const checkout = [...(thread.workspaceCheckouts ?? [])]
        .sort((a, b) => b.sourcePath.length - a.sourcePath.length)
        .find(
          (entry) =>
            source === entry.sourcePath || source.startsWith(`${entry.sourcePath}${path.sep}`),
        );
      if (checkout) return path.join(checkout.path, path.relative(checkout.sourcePath, source));
      if (
        thread.worktreePath &&
        (source === project.workspaceRoot ||
          source.startsWith(`${project.workspaceRoot}${path.sep}`))
      )
        return path.join(root, path.relative(project.workspaceRoot, source));
      return source;
    };
    const workspace = {
      ...original,
      filePath: original.filePath ? remap(original.filePath) : null,
      folders: original.folders.map((folder) => ({ ...folder, path: remap(folder.path) })),
    };
    const parsed = yield* workspaces.tasks({ path: root, workspace });
    return { ...parsed, workspace, project, root };
  });
  const snapshot: WorkspaceActions["Service"]["snapshot"] = (threadId) =>
    resolve(threadId).pipe(
      Effect.map(({ tasks, errors }) => ({ tasks, errors, runs: runs.get(threadId) ?? [] })),
      Effect.mapError((cause) => failure(threadId, cause)),
    );
  const cancel: WorkspaceActions["Service"]["cancel"] = (threadId) =>
    locks.withLock(
      threadId,
      Effect.gen(function* () {
        const fiber = fibers.get(threadId);
        if (fiber) yield* Fiber.interrupt(fiber);
        for (const run of runs.get(threadId) ?? []) {
          if (run.status !== "running" && run.status !== "waiting") continue;
          if (run.terminalId) yield* terminals.close({ threadId, terminalId: run.terminalId });
        }
        runs.set(
          threadId,
          (runs.get(threadId) ?? []).map((run) =>
            run.status === "waiting" || run.status === "running"
              ? { ...run, status: "cancelled" }
              : run,
          ),
        );
        fibers.delete(threadId);
      }).pipe(Effect.mapError((cause) => failure(threadId, cause))),
    );
  const start: WorkspaceActions["Service"]["start"] = (input) =>
    locks.withLock(
      input.threadId,
      Effect.gen(function* () {
        if (
          (runs.get(input.threadId) ?? []).some(
            (run) => run.status === "running" || run.status === "waiting",
          )
        )
          return yield* failure(
            input.threadId,
            new Error("Stop the running workspace actions before starting another group."),
          );
        const context = yield* resolve(input.threadId);
        const tasks = yield* Effect.try(() => workspaceTaskGraph(context.tasks, input.taskId));
        const folders = new Map(
          context.workspace.folders.map((folder) => [folder.name, folder.path]),
        );
        const commands = yield* Effect.try(
          () =>
            new Map(
              tasks.map((task) => {
                const folder = context.workspace.folders.find(
                  (entry) => entry.id === task.folderId,
                )!;
                const quote = (value: string) =>
                  platform === "win32"
                    ? `'${value.replaceAll("'", "''")}'`
                    : `'${value.replaceAll("'", "'\\''")}'`;
                const args = (task.args ?? []).map((arg) =>
                  quote(resolveWorkspaceVariables(arg, folder.path, folders)),
                );
                return [
                  task.id,
                  {
                    command: task.command
                      ? [
                          resolveWorkspaceVariables(task.command, folder.path, folders),
                          ...args,
                        ].join(" ")
                      : null,
                    cwd: path.resolve(
                      folder.path,
                      resolveWorkspaceVariables(task.cwd, folder.path, folders),
                    ),
                  },
                ];
              }),
            ),
        );
        const group = ++sequence;
        runs.set(
          input.threadId,
          tasks.map((task, index) => ({
            id: `${sessionId}-${group}-${index}`,
            threadId: input.threadId,
            taskId: task.id,
            label: task.label,
            terminalId: null,
            status: "waiting",
            exitCode: null,
            error: null,
          })),
        );
        const update = (id: string, change: Partial<WorkspaceActionRun>) =>
          Effect.sync(() => {
            runs.set(
              input.threadId,
              (runs.get(input.threadId) ?? []).map((run) =>
                run.taskId === id && run.status !== "cancelled" ? { ...run, ...change } : run,
              ),
            );
          });
        const cached = new Map<string, Effect.Effect<void, WorkspaceOperationError>>();
        const execute = (task: WorkspaceTask): Effect.Effect<void, WorkspaceOperationError> =>
          Effect.gen(function* () {
            yield* Effect.forEach(task.dependencies, (id) => cached.get(id)!, {
              concurrency: task.order === "parallel" ? "unbounded" : 1,
            });
            const command = commands.get(task.id)!;
            if (!command.command) {
              yield* update(task.id, { status: "succeeded", exitCode: 0 });
              return;
            }
            const dedicatedKey = `${input.threadId}:${task.id}`;
            const sharedKey = `${input.threadId}:${command.cwd}`;
            const panel = task.presentation?.panel ?? "shared";
            const available = shared
              .get(sharedKey)
              ?.find(
                (id) =>
                  !(runs.get(input.threadId) ?? []).some(
                    (run) => run.terminalId === id && run.status === "running",
                  ),
              );
            const terminalId =
              panel === "dedicated" && dedicated.has(dedicatedKey)
                ? dedicated.get(dedicatedKey)!
                : panel === "shared" && available
                  ? available
                  : `workspace-action-${sessionId}-${group}-${tasks.indexOf(task)}`;
            if (panel === "dedicated") dedicated.set(dedicatedKey, terminalId);
            if (panel === "shared" && !shared.get(sharedKey)?.includes(terminalId))
              shared.set(sharedKey, [...(shared.get(sharedKey) ?? []), terminalId]);
            yield* update(task.id, { status: "running", terminalId });
            const launched = yield* scripts.runForThread({
              threadId: input.threadId,
              project: context.project,
              worktreePath: command.cwd,
              preferredTerminalId: terminalId,
              closeOnSuccess: task.presentation?.close ?? false,
              scriptOverride: {
                id: task.id,
                name: task.label,
                command: command.command,
                icon: "play",
                runOnWorktreeCreate: false,
                async: task.background,
              },
              observeCompletion: {},
            });
            if (launched.status !== "started" || !launched.completion)
              return yield* failure(input.threadId, new Error(`Could not launch ${task.label}`));
            const complete = launched.completion.pipe(
              Effect.flatMap((result) =>
                update(task.id, {
                  status: result.exitCode === 0 ? "succeeded" : "failed",
                  exitCode: result.exitCode,
                }).pipe(
                  Effect.andThen(
                    result.exitCode === 0
                      ? Effect.void
                      : Effect.fail(
                          failure(
                            input.threadId,
                            new Error(
                              `${task.label} exited with ${result.exitCode ?? "no exit status"}`,
                            ),
                          ),
                        ),
                  ),
                ),
              ),
            );
            if (task.background) yield* complete.pipe(Effect.ignore, Effect.forkIn(scope));
            else yield* complete;
          }).pipe(
            Effect.mapError((cause) => failure(input.threadId, cause)),
            Effect.tapError((error) => update(task.id, { status: "failed", error: error.message })),
          );
        for (const task of tasks) cached.set(task.id, yield* Effect.cached(execute(task)));
        const fiber = yield* cached.get(input.taskId)!.pipe(
          Effect.catch((error) =>
            Effect.forEach(
              tasks,
              (task) => {
                const run = runs.get(input.threadId)?.find((entry) => entry.taskId === task.id);
                return run?.status === "waiting"
                  ? update(task.id, { status: "failed", error: error.message })
                  : Effect.void;
              },
              { discard: true },
            ),
          ),
          Effect.forkIn(scope),
        );
        fibers.set(input.threadId, fiber);
      }).pipe(Effect.mapError((cause) => failure(input.threadId, cause))),
    );
  return WorkspaceActions.of({ snapshot, start, cancel });
});
export const layer = Layer.effect(WorkspaceActions, make);
