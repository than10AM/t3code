# Running the workspace fork

This fork starts from `v0.0.46-nightly.20261014.3105`
(`3417bc3856a25fa772f969faeaf8428a58010d47`). Work is on
`feat/multi-repo-workspaces`; the original starter commit is retained separately.

Install Vite+ and the repository dependencies, then use an explicit development
home even when this is a regular checkout:

```sh
vp install
vp run dev --home-dir "$PWD/.t3/dev-web"
```

Read the port and pairing URL printed by the runner. Do not point this fork at
an existing T3 home. For desktop development:

```sh
vp run dev:desktop --home-dir "$PWD/.t3/dev-desktop"
```

Build web, server, and desktop together with:

```sh
vp run --filter @t3tools/desktop build
```

## Reproducible workspace

The generator requires only Node and Git and refuses an existing destination:

```sh
node scripts/create-workspace-fixture.ts .t3/fixtures/kasqade
node apps/server/src/workspace/importWorkspace.ts .t3/fixtures/kasqade/kasqade.code-workspace
```

Import the printed workspace path into the isolated app. It contains a parent,
four ignored child repositories, an additional repository, alternate worktrees,
shared skill symlinks, and harmless shell tasks. Create an isolated conversation,
edit `README.md`, `kasqade-fs/README.md`, and `kasqade-ml/README.md`, and inspect
working-tree changes, conversation checkpoints, and undo. The original fixture
checkouts must remain unchanged. Use a fresh destination to repeat the fixture.

The read-only importer also accepts a real workspace path. It lists repositories
and tasks without executing them. Never use real infrastructure or port-killing
tasks as test commands.

Run focused acceptance tests:

```sh
vp test run apps/server/src/workspace/MultiRepoWorkspace.test.ts apps/server/src/workspace/WorkspaceSetup.test.ts apps/server/src/workspace/WorkspaceActions.test.ts apps/server/src/workspace/WorkspaceTerminal.process.test.ts packages/shared/src/workspaceTasks.test.ts apps/server/src/checkpointing/CheckpointStore.test.ts
T3_WORKSPACE_LIVE=1 vp test run apps/server/src/orchestration-v2/WorkspaceProviders.live.test.ts
```

Live tests use disposable app state and worktrees. Codex and Claude use their
installed authentication. Cursor can use a **copy** of the existing T3 Cursor
credential: set `T3_WORKSPACE_CURSOR_CREDENTIAL_FILE` to that credential file.
The test copies it into disposable state before constructing the provider; it
never starts a server against the source T3 home. Do not print or commit its
contents. Live tests use provider quota and report authentication failures.

Workspace creation progress is kept beside the destination in
`<destination>.t3-workspace.json`. Keep that file with the checkouts so retry and
child-first cleanup can recover interrupted operations. Dirty worktrees and
failed setup are retained for inspection.
