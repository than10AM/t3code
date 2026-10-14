import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as MultiRepoWorkspace from "./MultiRepoWorkspace.ts";
import * as WorkspaceWorktrees from "./WorkspaceWorktrees.ts";

const testLayer = Layer.mergeAll(MultiRepoWorkspace.layer, WorkspaceWorktrees.layer).pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);

import { fixture } from "./workspace.testkit.ts";

it.layer(testLayer)("Kasqade workspace", (it) => {
  it.effect("discovers ignored child repositories and separates alternate worktrees", () =>
    Effect.gen(function* () {
      const { root } = yield* fixture;
      const service = yield* MultiRepoWorkspace.MultiRepoWorkspace;
      const workspace = yield* service.discover({ path: root });
      expect(workspace.folders).toHaveLength(1);
      expect(workspace.repositories).toHaveLength(7);
      expect(workspace.repositories.filter((repo) => repo.selected)).toHaveLength(6);
      const main = workspace.repositories.find((repo) => repo.name === "kasqade-fs")!;
      const alternate = workspace.repositories.find(
        (repo) => repo.name === "kasqade-fs-alternate",
      )!;
      expect(alternate.commonDirectory).toBe(main.commonDirectory);
      expect(alternate.isWorktree).toBe(true);
      expect(alternate.selected).toBe(false);
      const tasks = yield* service.tasks({ path: root });
      expect(tasks.errors).toEqual([]);
      expect(tasks.tasks.map((task) => task.label)).toEqual(["Backend", "ML", "Start App"]);
    }),
  );

  it.effect(
    "preserves nested checkouts and skills, resumes creation, and refuses dirty cleanup",
    () =>
      Effect.gen(function* () {
        const { root, temp, git } = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* MultiRepoWorkspace.MultiRepoWorkspace;
        const worktrees = yield* WorkspaceWorktrees.WorkspaceWorktrees;
        const workspace = yield* service.discover({ path: root });
        const destination = path.join(temp, "isolated");
        const input = { workspace, destination, branch: "test/workspace" };
        const manifest = yield* worktrees.create(input);
        expect(manifest.checkouts).toHaveLength(6);
        expect((yield* worktrees.create(input)).checkouts).toEqual(manifest.checkouts);
        expect(yield* fs.readFileString(path.join(destination, ".claude/skills/README.md"))).toBe(
          "shared skills\n",
        );
        expect(
          (yield* git(path.join(destination, "kasqade-fs"), [
            "rev-parse",
            "--show-toplevel",
          ])).stdout.trim(),
        ).toBe(path.join(destination, "kasqade-fs"));
        yield* fs.writeFileString(path.join(destination, "kasqade-fs", "README.md"), "edited\n");
        expect(yield* fs.readFileString(path.join(root, "kasqade-fs", "README.md"))).toBe(
          "initial\n",
        );
        const error = yield* worktrees.remove(destination).pipe(Effect.flip);
        expect(error.message).toContain("changes");
        expect(yield* fs.exists(path.join(destination, ".git"))).toBe(true);
        yield* git(path.join(destination, "kasqade-fs"), ["restore", "README.md"]);
        yield* worktrees.remove(destination);
        expect(yield* fs.exists(destination)).toBe(false);
      }),
  );
  it.effect(
    "honors explicit folders and scan depth, and maps alternate bases to logical repository paths",
    () =>
      Effect.gen(function* () {
        const { root, temp } = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* MultiRepoWorkspace.MultiRepoWorkspace;
        const file = path.join(root, "kasqade.code-workspace");
        const original = yield* fs.readFileString(file);
        yield* fs.writeFileString(
          file,
          original.replace('"git.repositoryScanMaxDepth":1', '"git.repositoryScanMaxDepth":0'),
        );
        expect((yield* service.discover({ path: file })).repositories).toHaveLength(1);
        yield* fs.writeFileString(
          file,
          '{"folders":[{"path":".","name":"Parent"},{"path":"kasqade-fs","name":"Backend"}],"settings":{"git.autoRepositoryDetection":false}}',
        );
        const explicit = yield* service.discover({ path: file });
        expect(explicit.repositories).toHaveLength(2);
        expect(explicit.folders.map((folder) => folder.name)).toEqual(["Parent", "Backend"]);
        yield* fs.writeFileString(file, original);
        const discovered = yield* service.discover({ path: file });
        const workspace = {
          ...discovered,
          repositories: discovered.repositories.map((repo) => ({
            ...repo,
            selected:
              repo.name === "kasqade-fs"
                ? false
                : repo.name === "kasqade-fs-alternate"
                  ? true
                  : repo.selected,
          })),
        };
        const worktrees = yield* WorkspaceWorktrees.WorkspaceWorktrees;
        const manifest = yield* worktrees.create({
          workspace,
          destination: path.join(temp, "alternate-isolated"),
          branch: "test/alternate",
        });
        expect(
          manifest.checkouts.find((entry) => entry.sourcePath.endsWith("-alternate"))?.path,
        ).toBe(path.join(temp, "alternate-isolated", "kasqade-fs"));
      }),
  );

  it.effect("recovers an interrupted creation from its durable pending manifest", () =>
    Effect.gen(function* () {
      const { root, temp } = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* (yield* MultiRepoWorkspace.MultiRepoWorkspace).discover({
        path: root,
      });
      const worktrees = yield* WorkspaceWorktrees.WorkspaceWorktrees;
      const destination = path.join(temp, "interrupted");
      const input = { workspace, destination, branch: "test/interrupted" };
      const manifest = yield* worktrees.create(input);
      const stored = yield* fs.readFileString(`${destination}.t3-workspace.json`);
      // Simulate a crash after Git registered checkouts but before progress was saved.
      yield* fs.writeFileString(
        `${destination}.t3-workspace.json`,
        stored.replaceAll('"created"', '"pending"'),
      );
      expect((yield* worktrees.create(input)).checkouts).toEqual(manifest.checkouts);
      yield* worktrees.remove(destination);
      expect((yield* worktrees.create(input).pipe(Effect.flip)).message).toContain("removed");
    }),
  );
});
