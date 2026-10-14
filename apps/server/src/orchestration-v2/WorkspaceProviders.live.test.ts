import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ResetCreditCoordinator from "../provider/resetCreditCoordinator.ts";
import { FetchHttpClient } from "effect/http";
import { describe } from "vite-plus/test";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderInstanceRegistryHydration from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as MultiRepoWorkspace from "../workspace/MultiRepoWorkspace.ts";
import * as WorkspaceWorktrees from "../workspace/WorkspaceWorktrees.ts";
import { fixture } from "../workspace/workspace.testkit.ts";

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfigBase = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-workspace-providers-live-",
});

// Optional read-only credential copy into disposable state; never bind the runtime to live state.
const layerServerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = process.env.T3_WORKSPACE_CURSOR_CREDENTIAL_FILE;
    if (source) {
      yield* fs.makeDirectory(config.secretsDir, { recursive: true });
      const target = path.join(
        config.secretsDir,
        "provider-auth-02a8ae355046b982b21f46e0b092be604758b64fa8ae971800289f628c780a54.bin",
      );
      yield* fs.copyFile(source, target);
      yield* fs.chmod(target, 0o600);
    }
    return config;
  }),
).pipe(Layer.provide(layerServerConfigBase), Layer.provide(NodeServices.layer));

const layerVcsDriverRegistry = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStore = CheckpointStore.layer.pipe(Layer.provide(layerVcsDriverRegistry));

const layerServerSettings = ServerSettings.layerTest({
  providerInstances: Object.fromEntries(
    ["codex", "claudeAgent", "cursor"].map((driver) => [
      driver,
      { driver: ProviderDriverKind.make(driver), enabled: true },
    ]),
  ),
});
const layerBackgroundPolicy = BackgroundPolicy.layer.pipe(
  Layer.provide(Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make())),
  Layer.provide(layerServerSettings),
);
const layerProviderInstanceRegistry = ProviderInstanceRegistryHydration.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerServerConfig.pipe(Layer.provide(layerPlatformTest)),
      layerServerSettings,
      ServerSecretStore.layer.pipe(
        Layer.provide(layerServerConfig),
        Layer.provide(layerPlatformTest),
      ),
      NodeServices.layer,
      FetchHttpClient.layer,
      OpenCodeRuntime.layer.pipe(
        Layer.provide(OpenCodeServerLedger.layerTest),
        Layer.provide(layerPlatformTest),
      ),
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
      ProviderLatestVersions.layer,
      ModelManifest.layerTest,
      AntigravityInstallation.AntigravityInstallation.layer.pipe(
        Layer.provide(layerServerConfig.pipe(Layer.provide(layerPlatformTest))),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(layerPlatformTest),
      ),
      // Use installed provider authentication, while all app state remains disposable.
      CodexInstallation.CodexInstallation.layer.pipe(
        Layer.provide(ModelManifest.layerTest),
        Layer.provide(layerServerConfig),
        Layer.provide(layerPlatformTest),
        Layer.provide(FetchHttpClient.layer),
      ),
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
    ),
  ),
);

const layerLive = Layer.mergeAll(
  RuntimeLayer.layer,
  MultiRepoWorkspace.layer.pipe(Layer.provide(VcsProcess.layer)),
  WorkspaceWorktrees.layer.pipe(Layer.provide(VcsProcess.layer)),
  VcsProcess.layer,
).pipe(
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStore),
  Layer.provide(layerServerConfig),
  Layer.provide(layerServerSettings),
  Layer.provide(layerProviderInstanceRegistry),
  Layer.provide(ResetCreditCoordinator.layer),
  Layer.provide(layerBackgroundPolicy),
  Layer.provideMerge(layerPlatformTest),
  Layer.provide(McpProviderSessions.layer),
);

const waitForIdle = Effect.fn("WorkspaceProvidersLive.waitForIdle")(function* (threadId: ThreadId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return yield* orchestrator.streamStoredEvents.pipe(
    Stream.filter((stored) => stored.event.threadId === threadId),
    Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    Stream.filter(
      (projection) =>
        projection.runs.length > 0 &&
        projection.runs.every(
          (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
        ),
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.timeout("180 seconds"),
  );
});

describe.runIf(process.env.T3_WORKSPACE_LIVE === "1")("workspace live providers", () => {
  it.live.each([
    ["codex", "gpt-6.1-sol"],
    ["claudeAgent", "claude-sonnet-5-5"],
    ["cursor", "auto-smart"],
  ] as const)(
    "%s edits parent and two children in one conversation",
    ([provider, model]) =>
      Effect.gen(function* () {
        const { root, temp } = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspace = yield* (yield* MultiRepoWorkspace.MultiRepoWorkspace).discover({
          path: root,
        });
        const manifest = yield* (yield* WorkspaceWorktrees.WorkspaceWorktrees).create({
          workspace,
          destination: path.join(temp, "isolated"),
          branch: `verify-${provider}`,
        });
        yield* EffectWorker.runDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(`workspace-live-${provider}`);
        const modelSelection = { instanceId: ProviderInstanceId.make(provider), model };
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${provider}-create`),
          threadId,
          projectId: ProjectId.make(`workspace-${provider}`),
          title: "Workspace provider verification",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: manifest.branch,
          worktreePath: manifest.destination,
        });
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`${provider}-mapping`),
          threadId,
          workspace,
          workspaceCheckouts: manifest.checkouts,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${provider}-edit`),
          threadId,
          messageId: MessageId.make(`${provider}-edit`),
          text: "Acceptance test in a disposable fixture: replace README.md, kasqade-fs/README.md, and kasqade-ml/README.md with exactly WORKSPACE_VERIFIED followed by a newline. These are three independent Git repositories. Do not use subagents, network, or commit changes. Only edit these three files, then report done.",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const projection = yield* waitForIdle(threadId);
        yield* Console.log(`${provider}: ${projection.runs.map((run) => run.status).join(", ")}`);
        for (const file of ["README.md", "kasqade-fs/README.md", "kasqade-ml/README.md"]) {
          assert.equal(
            yield* fs.readFileString(path.join(manifest.destination, file)),
            "WORKSPACE_VERIFIED\n",
          );
          assert.equal(yield* fs.readFileString(path.join(root, file)), "initial\n");
        }
        const checkpoint = projection.checkpoints.at(-1);
        assert.equal(checkpoint?.status, "ready");
        assert.equal(new Set(checkpoint?.files.map((file) => file.repositoryId)).size, 3);
        assert.deepEqual(checkpoint?.files.map((file) => file.path).sort(), [
          "README.md",
          "kasqade-fs/README.md",
          "kasqade-ml/README.md",
        ]);
      }).pipe(Effect.provide(layerLive), Effect.scoped),
    240_000,
  );
});
