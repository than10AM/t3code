import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import { parseWorkspaceTasks } from "@t3tools/shared/workspaceTasks";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as MultiRepoWorkspace from "./MultiRepoWorkspace.ts";
import * as WorkspaceActions from "./WorkspaceActions.ts";

const threadId = ThreadId.make("tasks");
const projectId = ProjectId.make("tasks");
const workspace = {
  filePath: null,
  folders: [{ id: "root", name: "root", path: "/source" }],
  repositories: [],
  scanDepth: 1,
  detectSubfolders: true,
};
const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
const thread: OrchestrationV2AppThread = {
  id: threadId,
  projectId,
  createdBy: "user",
  creationSource: "web",
  title: "Tasks",
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "test",
  worktreePath: "/isolated",
  workspace,
  workspaceCheckouts: [
    {
      repositoryId: "root",
      sourcePath: "/source",
      path: "/isolated",
      baseCommit: "HEAD",
      branch: "test",
      state: "ready",
    },
  ],
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};

it.effect(
  "runs parallel foreground/background dependencies once, resolves isolated cwd, and cancels owned terminals",
  () =>
    Effect.gen(function* () {
      const parsed = parseWorkspaceTasks(
        `{"tasks":[
    {"label":"base","command":"echo base"},
    {"label":"api","command":"echo \\"\u0024{workspaceFolder}\\"","isBackground":true,"dependsOn":"base","options":{"cwd":"\u0024{workspaceFolder}/kasqade-fs"}},
    {"label":"ml","command":"echo ml","dependsOn":"base"},
    {"label":"all","dependsOn":["api","ml"]}
  ]}`,
        "root",
        "tasks.json",
      );
      expect(parsed.errors).toEqual([]);
      const foreground =
        yield* Deferred.make<ProjectSetupScriptRunner.ProjectSetupScriptCompletion>();
      const background =
        yield* Deferred.make<ProjectSetupScriptRunner.ProjectSetupScriptCompletion>();
      const launched: ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput[] = [];
      const closed: string[] = [];
      const layer = WorkspaceActions.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThread: () => Effect.succeed(thread),
            }),
            Layer.mock(ProjectService.ProjectService)({
              getById: () =>
                Effect.succeed(
                  Option.some({
                    id: projectId,
                    title: "Tasks",
                    workspaceRoot: "/source",
                    scripts: [],
                    repositoryIdentity: null,
                    faviconPath: null,
                    defaultModelSelection: null,
                    createdAt: "2026-01-01",
                    updatedAt: "2026-01-01",
                    deletedAt: null,
                  }),
                ),
            }),
            Layer.mock(MultiRepoWorkspace.MultiRepoWorkspace)({
              tasks: () => Effect.succeed(parsed),
            }),
            Layer.mock(TerminalManager.TerminalManager)({
              close: (input) =>
                Effect.sync(() => {
                  closed.push(input.terminalId!);
                }),
            }),
            Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
              runForThread: (input) =>
                Effect.sync(() => {
                  launched.push(input);
                  return {
                    status: "started",
                    terminalId: input.preferredTerminalId!,
                    scriptId: input.scriptOverride!.id,
                    scriptName: input.scriptOverride!.name,
                    scriptCommand: input.scriptOverride!.command,
                    cwd: input.worktreePath,
                    async: input.scriptOverride!.async ?? false,
                    completion:
                      input.scriptOverride!.name === "api"
                        ? Deferred.await(background)
                        : input.scriptOverride!.name === "ml"
                          ? Deferred.await(foreground)
                          : Effect.succeed({ exitCode: 0, durationMs: 1 }),
                  };
                }),
            }),
            NodeServices.layer,
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* WorkspaceActions.WorkspaceActions;
        yield* service.start({ threadId, taskId: parsed.tasks[3]!.id });
        for (let attempt = 0; attempt < 100 && launched.length < 3; attempt++)
          yield* Effect.yieldNow;
        expect(launched.map((entry) => entry.scriptOverride!.name).sort()).toEqual([
          "api",
          "base",
          "ml",
        ]);
        expect(launched.find((entry) => entry.scriptOverride!.name === "api")?.worktreePath).toBe(
          "/isolated/kasqade-fs",
        );
        yield* Deferred.succeed(foreground, { exitCode: 0, durationMs: 1 });
        for (let attempt = 0; attempt < 100; attempt++) yield* Effect.yieldNow;
        expect(
          (yield* service.snapshot(threadId)).runs.find((run) => run.label === "api")?.status,
        ).toBe("running");
        yield* service.cancel(threadId);
        expect(closed).toHaveLength(1);
        expect(
          (yield* service.snapshot(threadId)).runs.find((run) => run.label === "api")?.status,
        ).toBe("cancelled");
      }).pipe(Effect.provide(layer));
    }),
);
