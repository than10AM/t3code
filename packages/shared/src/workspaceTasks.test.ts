import { describe, expect, it } from "vite-plus/test";
import {
  parseWorkspaceTasks,
  resolveWorkspaceVariables,
  workspaceTaskGraph,
} from "./workspaceTasks.ts";

describe("workspace tasks", () => {
  it("keeps shell expressions while resolving active workspace folders", () => {
    expect(
      resolveWorkspaceVariables(
        'cd "${workspaceFolder}/kasqade-fs" && echo "$HOME ${SHELL}"',
        "/tmp/thread",
        new Map(),
      ),
    ).toBe('cd "/tmp/thread/kasqade-fs" && echo "$HOME ${SHELL}"');
    expect(
      resolveWorkspaceVariables(
        "${workspaceFolder:api}",
        "/tmp/thread",
        new Map([["api", "/tmp/api"]]),
      ),
    ).toBe("/tmp/api");
    expect(() => resolveWorkspaceVariables("${command:pick}", "/tmp/thread", new Map())).toThrow(
      "Unsupported",
    );
  });
  it("parses JSONC and deduplicates shared dependencies", () => {
    const result = parseWorkspaceTasks(
      `{"tasks":[
      {"label":"base","command":"echo base"},
      {"label":"a","dependsOn":"base"},
      {"label":"b","dependsOn":"base"},
      {"label":"all","dependsOn":["a","b"]}, // comment
    ]}`,
      "root",
      "tasks.json",
    );
    expect(result.errors).toEqual([]);
    expect(workspaceTaskGraph(result.tasks, result.tasks[3]!.id).map((task) => task.label)).toEqual(
      ["base", "a", "b", "all"],
    );
  });
  it("preserves args, sequential foreground order, and rejects unsupported execution settings", () => {
    const parsed = parseWorkspaceTasks(
      '{"tasks":[{"label":"first","command":"echo","args":["a b","$HOME"]},{"label":"all","dependsOn":"first","dependsOrder":"sequence"}]}',
      "root",
      "tasks.json",
    );
    expect(parsed.tasks[0]?.args).toEqual(["a b", "$HOME"]);
    expect(workspaceTaskGraph(parsed.tasks, parsed.tasks[1]!.id).map((task) => task.label)).toEqual(
      ["first", "all"],
    );
    for (const extra of [
      { type: "process" },
      { options: { env: { PORT: "1" } } },
      { problemMatcher: ["$tsc-watch"] },
      { runOptions: { runOn: "folderOpen" } },
    ]) {
      expect(
        parseWorkspaceTasks(
          JSON.stringify({ tasks: [{ label: "unsupported", command: "echo", ...extra }] }),
          "root",
          "tasks.json",
        ).errors,
      ).toHaveLength(1);
    }
  });
  it("rejects cycles, missing dependencies, and sequence readiness ambiguity before launch", () => {
    for (const tasks of [
      [{ label: "a", dependsOn: "a" }],
      [{ label: "a", dependsOn: "missing" }],
      [
        { label: "a", dependsOn: "b", dependsOrder: "sequence" },
        { label: "b", command: "watch", isBackground: true },
      ],
    ]) {
      const result = parseWorkspaceTasks(JSON.stringify({ tasks }), "root", "tasks.json");
      expect(() => workspaceTaskGraph(result.tasks, result.tasks[0]!.id)).toThrow();
    }
  });
});
