import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { type Project, type ProjectScript, WorkspaceOperationError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import { WorkspaceWorktrees, type WorkspaceWorktreeManifest } from "./WorkspaceWorktrees.ts";

const SetupValue = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
const CursorSetupFile = Schema.Struct({
  "setup-worktree": Schema.optional(SetupValue),
  "setup-worktree-unix": Schema.optional(SetupValue),
  "setup-worktree-windows": Schema.optional(SetupValue),
});

export function cursorSetupCommands(contents: string, windows: boolean) {
  const file = Schema.decodeSync(fromLenientJson(CursorSetupFile))(contents);
  return (
    file[windows ? "setup-worktree-windows" : "setup-worktree-unix"] ?? file["setup-worktree"] ?? []
  );
}

export class WorkspaceSetup extends Context.Service<
  WorkspaceSetup,
  {
    readonly run: (input: {
      readonly threadId: string;
      readonly project: Project;
      readonly manifest: WorkspaceWorktreeManifest;
      readonly onOutputLine?: (line: string) => Effect.Effect<void>;
      readonly persistState?: boolean;
    }) => Effect.Effect<void, WorkspaceOperationError>;
    readonly runSingle: (input: {
      threadId: string;
      project: Project;
      destination: string;
      onOutputLine?: (line: string) => Effect.Effect<void>;
    }) => Effect.Effect<boolean, WorkspaceOperationError>;
  }
>()("t3/workspace/WorkspaceSetup") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const worktrees = yield* WorkspaceWorktrees;
  const scripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const terminals = yield* TerminalManager.TerminalManager;
  const crypto = yield* Crypto.Crypto;
  const sessionId = (yield* crypto.randomUUIDv4().pipe(Effect.orDie)).slice(0, 8);
  let attempt = 0;
  const run: WorkspaceSetup["Service"]["run"] = (input) =>
    Effect.gen(function* () {
      for (const [index, checkout] of input.manifest.checkouts.entries()) {
        if (checkout.state === "ready") continue;
        if (input.persistState !== false)
          yield* worktrees.markSetup(input.manifest.destination, checkout.repositoryId, "setup");
        yield* Effect.gen(function* () {
          const runScript = Effect.fn(function* (
            phase: "cursor" | "t3",
            scriptOverride?: ProjectScript,
          ) {
            if (checkout.completedSetupPhases?.includes(phase)) return;
            const result = yield* scripts.runForThread({
              threadId: input.threadId,
              project: {
                id: input.project.id,
                workspaceRoot: checkout.sourcePath,
                scripts: input.project.scripts,
              },
              worktreePath: checkout.path,
              preferredTerminalId: `workspace-setup-${sessionId}-${index}-${phase}-${++attempt}`,
              ...(scriptOverride ? { scriptOverride } : {}),
              waitForCompletion: true,
              extraEnv: {
                ROOT_WORKTREE_PATH: checkout.sourcePath,
                T3CODE_WORKSPACE_ROOT: input.manifest.destination,
              },
              observeCompletion: {
                ...(input.onOutputLine
                  ? {
                      onOutputLine: (line) =>
                        input.onOutputLine!(`[${path.basename(checkout.path)} / ${phase}] ${line}`),
                    }
                  : {}),
              },
            });
            if (result.status === "started" && result.completion) {
              const completion = yield* result.completion.pipe(
                Effect.onInterrupt(() =>
                  terminals
                    .close({ threadId: input.threadId, terminalId: result.terminalId })
                    .pipe(Effect.ignore),
                ),
              );
              if (completion.exitCode !== 0)
                return yield* new WorkspaceOperationError({
                  operation: "setup",
                  path: checkout.path,
                  message: `${phase} setup failed in ${path.basename(checkout.path)} (exit ${completion.exitCode ?? "unknown"}).`,
                });
            }
            if (input.persistState !== false)
              yield* worktrees.markSetup(
                input.manifest.destination,
                checkout.repositoryId,
                "setup",
                phase,
              );
          });
          let cursorFile = path.join(checkout.path, ".cursor", "worktrees.json");
          if (!(yield* fs.exists(cursorFile)))
            cursorFile = path.join(checkout.sourcePath, ".cursor", "worktrees.json");
          if (yield* fs.exists(cursorFile)) {
            const contents = yield* fs.readFileString(cursorFile);
            const configured = yield* Effect.try(() =>
              cursorSetupCommands(contents, platform === "win32"),
            );
            let command: string;
            if (typeof configured === "string") {
              const scriptPath = path.resolve(path.dirname(cursorFile), configured);
              command =
                platform === "win32"
                  ? `& '${scriptPath.replaceAll("'", "''")}'`
                  : `'${scriptPath.replaceAll("'", "'\\''")}'`;
            } else {
              command = configured
                .map((entry) =>
                  platform === "win32" ? `${entry}\nif (-not $?) { exit 1 }` : `{\n${entry}\n}`,
                )
                .join(platform === "win32" ? "\n" : " &&\n");
            }
            if (command.trim())
              yield* runScript("cursor", {
                id: `cursor-${index}`,
                name: "Cursor worktree setup",
                command,
                icon: "configure",
                runOnWorktreeCreate: true,
                async: false,
              });
          }
          if (checkout.sourcePath === input.project.workspaceRoot) {
            yield* runScript("t3");
          } else {
            const t3File = path.join(checkout.path, "t3.json");
            if (yield* fs.exists(t3File)) {
              const file = parseT3ProjectFile(yield* fs.readFileString(t3File));
              if (file === null)
                return yield* new WorkspaceOperationError({
                  operation: "setup",
                  path: t3File,
                  message: "Invalid t3.json; fix the configuration and retry setup.",
                });
              const script = file?.scripts?.find((candidate) => candidate.runOnWorktreeCreate);
              if (script)
                yield* runScript("t3", {
                  ...script,
                  id: `t3-${index}`,
                  icon: script.icon ?? "configure",
                  runOnWorktreeCreate: true,
                  async: false,
                });
            }
          }
          if (input.persistState !== false)
            yield* worktrees.markSetup(input.manifest.destination, checkout.repositoryId, "ready");
        }).pipe(
          Effect.tapError(() =>
            input.persistState === false
              ? Effect.void
              : worktrees.markSetup(input.manifest.destination, checkout.repositoryId, "failed"),
          ),
        );
      }
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(WorkspaceOperationError)(cause)
          ? cause
          : new WorkspaceOperationError({
              operation: "setup",
              path: input.manifest.destination,
              message: "Workspace setup failed. Inspect the setup terminals and retry.",
              cause,
            }),
      ),
    );
  const runSingle: WorkspaceSetup["Service"]["runSingle"] = (input) =>
    Effect.gen(function* () {
      const exists =
        (yield* fs.exists(path.join(input.destination, ".cursor/worktrees.json"))) ||
        (yield* fs.exists(path.join(input.project.workspaceRoot, ".cursor/worktrees.json")));
      if (!exists) return false;
      yield* run({
        ...input,
        persistState: false,
        manifest: {
          destination: input.destination,
          branch: "",
          workspace: {
            filePath: null,
            folders: [
              {
                id: input.project.workspaceRoot,
                name: input.project.title,
                path: input.project.workspaceRoot,
              },
            ],
            repositories: [],
            scanDepth: 0,
            detectSubfolders: false,
          },
          checkouts: [
            {
              repositoryId: input.project.workspaceRoot,
              sourcePath: input.project.workspaceRoot,
              path: input.destination,
              baseCommit: "HEAD",
              branch: "",
              state: "created",
            },
          ],
        },
      });
      return true;
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(WorkspaceOperationError)(cause)
          ? cause
          : new WorkspaceOperationError({
              operation: "setup",
              path: input.destination,
              message: "Could not read Cursor setup configuration.",
              cause,
            }),
      ),
    );
  return WorkspaceSetup.of({ run, runSingle });
});

export const layer = Layer.effect(WorkspaceSetup, make);
