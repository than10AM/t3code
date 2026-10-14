import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

/** A folder shown in the editor; it need not itself be a repository. */
export const WorkspaceFolder = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  path: Schema.String,
});
export const WorkspaceRepository = Schema.Struct({
  id: Schema.String,
  folderId: Schema.String,
  name: Schema.String,
  path: Schema.String,
  commonDirectory: Schema.String,
  branch: Schema.NullOr(Schema.String),
  head: Schema.String,
  isWorktree: Schema.Boolean,
  selected: Schema.Boolean,
  baseRef: Schema.optional(Schema.String),
});
export type WorkspaceRepository = typeof WorkspaceRepository.Type;

export const WorkspaceConfiguration = Schema.Struct({
  filePath: Schema.NullOr(Schema.String),
  folders: Schema.Array(WorkspaceFolder),
  repositories: Schema.Array(WorkspaceRepository),
  scanDepth: Schema.Number,
  detectSubfolders: Schema.Boolean,
});
export type WorkspaceConfiguration = typeof WorkspaceConfiguration.Type;

/** Frozen when a thread starts; project refreshes cannot redirect running work. */
export const WorkspaceCheckout = Schema.Struct({
  repositoryId: Schema.String,
  sourcePath: Schema.String,
  path: Schema.String,
  baseCommit: Schema.String,
  branch: Schema.String,
  state: Schema.Literals(["pending", "created", "setup", "ready", "failed", "removed"]),
  completedSetupPhases: Schema.optional(Schema.Array(Schema.Literals(["cursor", "t3"]))),
});
export type WorkspaceCheckout = typeof WorkspaceCheckout.Type;

export const WorkspaceDiscoverInput = Schema.Struct({ path: Schema.String });
export class WorkspaceOperationError extends Schema.TaggedError<WorkspaceOperationError>()(
  "WorkspaceOperationError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const WorkspaceFile = Schema.Struct({
  folders: Schema.Array(
    Schema.Struct({ path: Schema.String, name: Schema.optional(Schema.String) }),
  ),
  settings: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  tasks: Schema.optional(Schema.Unknown),
});

export const WorkspaceTask = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  folderId: Schema.String,
  source: Schema.String,
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.String,
  background: Schema.Boolean,
  dependencies: Schema.Array(Schema.String),
  order: Schema.Literals(["parallel", "sequence"]),
  presentation: Schema.optional(
    Schema.Struct({
      reveal: Schema.optional(Schema.Literals(["always", "never", "silent"])),
      panel: Schema.optional(Schema.Literals(["shared", "dedicated", "new"])),
      group: Schema.optional(Schema.String),
      close: Schema.optional(Schema.Boolean),
    }),
  ),
});
export type WorkspaceTask = typeof WorkspaceTask.Type;

export const WorkspaceTasksInput = Schema.Struct({ path: Schema.String });
export const WorkspaceTasksResult = Schema.Struct({
  tasks: Schema.Array(WorkspaceTask),
  errors: Schema.Array(Schema.String),
});

export const WorkspaceActionInput = Schema.Struct({ threadId: ThreadId, taskId: Schema.String });
export const WorkspaceActionThreadInput = Schema.Struct({ threadId: ThreadId });
export const WorkspaceActionRun = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  taskId: Schema.String,
  label: Schema.String,
  terminalId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["waiting", "running", "succeeded", "failed", "cancelled"]),
  exitCode: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
});
export type WorkspaceActionRun = typeof WorkspaceActionRun.Type;
export const WorkspaceActionsSnapshot = Schema.Struct({
  tasks: Schema.Array(WorkspaceTask),
  errors: Schema.Array(Schema.String),
  runs: Schema.Array(WorkspaceActionRun),
});
