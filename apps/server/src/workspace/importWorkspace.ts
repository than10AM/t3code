import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Console from "effect/Console";
import * as Schema from "effect/Schema";
import { WorkspaceConfiguration, WorkspaceTasksResult } from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as MultiRepoWorkspace from "./MultiRepoWorkspace.ts";

// Read-only diagnostic. It never creates worktrees or executes imported tasks.
const layer = MultiRepoWorkspace.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(ProcessRunner.layer),
  Layer.provide(NodeServices.layer),
);
NodeRuntime.runMain(
  Effect.gen(function* () {
    const service = yield* MultiRepoWorkspace.MultiRepoWorkspace;
    const path = process.argv[2];
    if (!path)
      return yield* Effect.die(
        "Usage: node apps/server/src/workspace/importWorkspace.ts /path/to/workspace.code-workspace",
      );
    const workspace = yield* service.discover({ path });
    const tasks = yield* service.tasks({ path, workspace });
    yield* Console.log(
      yield* Schema.encodeEffect(
        Schema.fromJsonString(
          Schema.Struct({ workspace: WorkspaceConfiguration, tasks: WorkspaceTasksResult }),
        ),
      )({ workspace, tasks }),
    );
  }).pipe(Effect.provide(layer)),
);
