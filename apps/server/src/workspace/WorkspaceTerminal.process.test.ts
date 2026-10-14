import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";

const terminals = Layer.effect(
  TerminalManager.TerminalManager,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "workspace-terminal-" });
    return yield* TerminalManager.makeWithOptions({
      logsDir: temp,
      ptyAdapter: yield* PtyAdapter.PtyAdapter,
      shellResolver: () => "/bin/sh",
      env: { ...process.env, SHELL: "/bin/sh" },
    });
  }),
).pipe(Layer.provide(NodePtyAdapter.layer));
const layer = ProjectSetupScriptRunner.layer.pipe(
  Layer.provideMerge(terminals),
  Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.live(
  "executes harmless foreground and background commands in owned real terminals",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "workspace-command-" });
      const scripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const manager = yield* TerminalManager.TerminalManager;
      const project = { id: ProjectId.make("terminal-fixture"), workspaceRoot: cwd, scripts: [] };
      const foreground = yield* scripts.runForThread({
        threadId: "fixture",
        project,
        worktreePath: cwd,
        preferredTerminalId: "foreground",
        scriptOverride: {
          id: "fg",
          name: "Foreground",
          command: "printf '%s' \"$PWD\" > cwd.txt",
          icon: "play",
          runOnWorktreeCreate: false,
        },
        observeCompletion: {},
        closeOnSuccess: false,
      });
      expect(foreground.status).toBe("started");
      if (foreground.status !== "started" || !foreground.completion)
        return yield* Effect.die("Missing completion");
      expect((yield* foreground.completion).exitCode).toBe(0);
      expect(yield* fs.readFileString(path.join(cwd, "cwd.txt"))).toBe(cwd);
      const ready = yield* Deferred.make<void>();
      const background = yield* scripts.runForThread({
        threadId: "fixture",
        project,
        worktreePath: cwd,
        preferredTerminalId: "background",
        scriptOverride: {
          id: "bg",
          name: "Background",
          command: "printf 'SERVICE_STARTED\\n'; while :; do sleep 1; done",
          icon: "play",
          async: true,
          runOnWorktreeCreate: false,
        },
        observeCompletion: {
          onOutputLine: (line) =>
            line.trim() === "SERVICE_STARTED"
              ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
              : Effect.void,
        },
      });
      yield* Deferred.await(ready);
      yield* manager.close({ threadId: "fixture", terminalId: "background" });
      if (background.status !== "started" || !background.completion)
        return yield* Effect.die("Missing background completion");
      expect((yield* background.completion).exitCode).not.toBe(0);
      yield* manager.close({ threadId: "fixture", terminalId: "foreground" });
    }).pipe(Effect.provide(layer), Effect.scoped),
  30_000,
);
