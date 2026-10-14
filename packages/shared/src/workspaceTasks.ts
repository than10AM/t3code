import * as Schema from "effect/Schema";
import { WorkspaceTask } from "@t3tools/contracts/multiRepoWorkspace";
import { fromLenientJson } from "./schemaJson.ts";

const TaskFile = Schema.Struct({
  version: Schema.optional(Schema.String),
  tasks: Schema.Array(Schema.Unknown),
});
const Task = Schema.Struct({
  label: Schema.String,
  type: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  options: Schema.optional(Schema.Struct({ cwd: Schema.optional(Schema.String) })),
  isBackground: Schema.optional(Schema.Boolean),
  dependsOn: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  dependsOrder: Schema.optional(Schema.Literals(["parallel", "sequence"])),
  problemMatcher: Schema.optional(Schema.Array(Schema.Unknown)),
  presentation: WorkspaceTask.fields.presentation,
});

export function workspaceTaskId(folderId: string, source: string, label: string): string {
  return JSON.stringify([folderId, source, label]);
}

/** Only editor variables are expanded; shell $VAR and ${VAR} expressions stay literal. */
export function resolveWorkspaceVariables(
  value: string,
  folder: string,
  folders: ReadonlyMap<string, string>,
): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, key: string) => {
    if (key === "workspaceFolder") return folder;
    if (key.startsWith("workspaceFolder:")) {
      const name = key.slice("workspaceFolder:".length);
      const resolved = folders.get(name);
      if (resolved === undefined) throw new Error(`Unknown workspace folder: ${name}`);
      return resolved;
    }
    if (
      /^(env|config|command|input):/.test(key) ||
      [
        "file",
        "fileBasename",
        "fileBasenameNoExtension",
        "fileExtname",
        "relativeFileDirname",
        "fileWorkspaceFolder",
        "fileDirnameBasename",
        "columnNumber",
        "defaultBuildTask",
        "execInstallFolder",
        "/",
        "fileDirname",
        "relativeFile",
        "selectedText",
        "lineNumber",
        "execPath",
        "cwd",
        "pathSeparator",
        "userHome",
        "workspaceFolderBasename",
      ].includes(key)
    )
      throw new Error(`Unsupported task variable: ${match}`);
    return match;
  });
}

export function parseWorkspaceTasks(contents: string, folderId: string, source: string) {
  const file = Schema.decodeSync(fromLenientJson(TaskFile))(contents);
  const tasks: WorkspaceTask[] = [];
  const errors: string[] = [];
  for (const entry of file.tasks) {
    try {
      const task = Schema.decodeUnknownSync(Task)(entry);
      if (task.type !== undefined && task.type !== "shell")
        throw new Error(`${task.label}: only shell tasks are supported`);
      const raw = entry as Record<string, unknown>;
      if (["windows", "linux", "osx", "inputs"].some((key) => key in raw))
        throw new Error(`${task.label}: platform overrides and input resolvers are not supported`);
      if (raw.options && Object.keys(raw.options as object).some((key) => key !== "cwd"))
        throw new Error(
          `${task.label}: only options.cwd is supported; put environment and shell settings in the command`,
        );
      if (
        raw.presentation &&
        Object.keys(raw.presentation as object).some(
          (key) => !["reveal", "panel", "group", "close"].includes(key),
        )
      )
        throw new Error(
          `${task.label}: supported presentation options are reveal, panel, group, and close`,
        );
      if (raw.runOptions && Object.keys(raw.runOptions as object).length)
        throw new Error(`${task.label}: runOptions are not supported; imported tasks are manual`);
      if (task.problemMatcher?.length)
        throw new Error(`${task.label}: problem matchers are not supported`);
      const dependencies =
        typeof task.dependsOn === "string" ? [task.dependsOn] : (task.dependsOn ?? []);
      if (!task.command && dependencies.length === 0)
        throw new Error(`${task.label}: no command or dependencies`);
      const id = workspaceTaskId(folderId, source, task.label);
      if (tasks.some((existing) => existing.id === id))
        throw new Error(`${task.label}: duplicate task label`);
      tasks.push({
        id,
        label: task.label,
        folderId,
        source,
        ...(task.command === undefined ? {} : { command: task.command }),
        ...(task.args ? { args: task.args } : {}),
        cwd: task.options?.cwd ?? "${workspaceFolder}",
        background: task.isBackground ?? false,
        dependencies: dependencies.map((label) => workspaceTaskId(folderId, source, label)),
        order: task.dependsOrder ?? "parallel",
        ...(task.presentation === undefined ? {} : { presentation: task.presentation }),
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Invalid task definition");
    }
  }
  return { tasks, errors };
}

/** Validate the whole reachable graph before starting any process. */
export function workspaceTaskGraph(
  tasks: readonly WorkspaceTask[],
  taskId: string,
): WorkspaceTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: WorkspaceTask[] = [];
  const hasBackground = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const task = byId.get(id);
    return (
      task?.background === true ||
      task?.dependencies.some((dep) => hasBackground(dep, seen)) === true
    );
  };
  const visit = (id: string): void => {
    const task = byId.get(id);
    if (!task) throw new Error(`Missing task dependency: ${id}`);
    if (visiting.has(id)) throw new Error(`Task dependency cycle: ${task.label}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of task.dependencies) {
      if ((task.order === "sequence" || task.command !== undefined) && hasBackground(dependency)) {
        throw new Error(
          `${task.label}: sequential background dependencies require a readiness matcher`,
        );
      }
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(task);
  };
  visit(taskId);
  return ordered;
}
