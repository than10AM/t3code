import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as MultiRepoWorkspace from "./MultiRepoWorkspace.ts";
import * as WorkspaceWorktrees from "./WorkspaceWorktrees.ts";
import * as WorkspaceSetup from "./WorkspaceSetup.ts";
import { fixture } from "./workspace.testkit.ts";

const runner = Layer.effect(
  ProjectSetupScriptRunner.ProjectSetupScriptRunner,
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    return ProjectSetupScriptRunner.ProjectSetupScriptRunner.of({
      runForThread: (input) =>
        Effect.gen(function* () {
          const script =
            input.scriptOverride ?? input.project?.scripts.find((item) => item.runOnWorktreeCreate);
          if (!script) return { status: "no-script" as const };
          const result = yield* process
            .run({
              operation: "fixture.setup",
              command: "sh",
              args: ["-c", script.command],
              cwd: input.worktreePath,
              ...(input.extraEnv ? { env: input.extraEnv } : {}),
              allowNonZeroExit: true,
            })
            .pipe(Effect.orDie);
          return {
            status: "started" as const,
            scriptId: script.id,
            scriptName: script.name,
            scriptCommand: script.command,
            terminalId: input.preferredTerminalId!,
            cwd: input.worktreePath,
            async: false,
            completion: Effect.succeed({ exitCode: Number(result.exitCode), durationMs: 1 }),
          };
        }),
    });
  }),
);
const layer = Layer.mergeAll(
  WorkspaceSetup.layer.pipe(Layer.provide(runner)),
  MultiRepoWorkspace.layer,
).pipe(
  Layer.provide(Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void })),
  Layer.provideMerge(WorkspaceWorktrees.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);

it("prefers platform-specific Cursor setup and retains relative script paths", () => {
  const config =
    '{"setup-worktree":["generic"],"setup-worktree-unix":["unix-first","unix-second"],"setup-worktree-windows":"setup.ps1",}';
  expect(WorkspaceSetup.cursorSetupCommands(config, false)).toEqual(["unix-first", "unix-second"]);
  expect(WorkspaceSetup.cursorSetupCommands(config, true)).toBe("setup.ps1");
});

it.layer(layer)("workspace setup", (it) => {
  it.effect(
    "runs Cursor before T3 parent-first, retains failure, and resumes without repeating ready repositories",
    () =>
      Effect.gen(function* () {
        const { root, temp, git } = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(
          path.join(root, ".cursor/worktrees.json"),
          '{"setup-worktree":["echo cursor-parent >> .setup-log"]}',
        );
        yield* git(root, ["add", ".cursor/worktrees.json"]);
        yield* git(root, ["commit", "-m", "setup"]);
        const child = path.join(root, "kasqade-fs");
        yield* fs.makeDirectory(path.join(child, ".cursor"));
        yield* fs.writeFileString(
          path.join(child, ".cursor/worktrees.json"),
          '{"setup-worktree":["echo cursor-child >> $T3CODE_WORKSPACE_ROOT/.setup-log", "test -f ready"]}',
        );
        yield* fs.writeFileString(
          path.join(child, "t3.json"),
          '{"scripts":[{"name":"child","command":"echo t3-child >> $T3CODE_WORKSPACE_ROOT/.setup-log","runOnWorktreeCreate":true}]}',
        );
        yield* git(child, ["add", "."]);
        yield* git(child, ["commit", "-m", "setup"]);
        const workspace = yield* (yield* MultiRepoWorkspace.MultiRepoWorkspace).discover({
          path: root,
        });
        const worktrees = yield* WorkspaceWorktrees.WorkspaceWorktrees;
        const manifest = yield* worktrees.create({
          workspace,
          destination: path.join(temp, "isolated"),
          branch: "setup-test",
        });
        const project = {
          id: ProjectId.make("fixture"),
          title: "Fixture",
          workspaceRoot: root,
          workspace,
          repositoryIdentity: null,
          faviconPath: null,
          defaultModelSelection: null,
          scripts: [
            {
              id: "parent",
              name: "parent",
              icon: "configure" as const,
              runOnWorktreeCreate: true,
              command: "echo t3-parent >> .setup-log",
            },
          ],
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          deletedAt: null,
        };
        const setup = yield* WorkspaceSetup.WorkspaceSetup;
        const error = yield* setup.run({ threadId: "setup", project, manifest }).pipe(Effect.flip);
        expect(error.message).toContain("cursor setup failed");
        expect(yield* fs.readFileString(path.join(manifest.destination, ".setup-log"))).toBe(
          "cursor-parent\nt3-parent\ncursor-child\n",
        );
        const failed = (yield* worktrees.read(manifest.destination))!;
        expect(failed.checkouts.find((entry) => entry.sourcePath === child)?.state).toBe("failed");
        yield* fs.writeFileString(path.join(manifest.destination, "kasqade-fs/ready"), "ready");
        yield* setup.run({ threadId: "setup", project, manifest: failed });
        expect(yield* fs.readFileString(path.join(manifest.destination, ".setup-log"))).toBe(
          "cursor-parent\nt3-parent\ncursor-child\ncursor-child\nt3-child\n",
        );
        expect(
          (yield* worktrees.read(manifest.destination))!.checkouts.every(
            (entry) => entry.state === "ready",
          ),
        ).toBe(true);
      }),
  );
});
