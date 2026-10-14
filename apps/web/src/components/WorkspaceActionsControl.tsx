import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EnvironmentId, ThreadId, WorkspaceActionsSnapshot } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useThreadProjection } from "~/state/entities";
import { terminalEnvironment } from "~/state/terminal";
import GitActionsControl from "./GitActionsControl";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useTerminalUiStateStore } from "~/terminalUiStateStore";
import { randomUUID } from "~/lib/utils";
import { Button } from "./ui/button";

export function WorkspaceActionsControl({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const canOperate = useAtomValue(
    projectEnvironment.workspaceActionStart.permissionAtom(environmentId),
  );
  const checkouts =
    useThreadProjection({ environmentId, threadId })?.projection.thread.workspaceCheckouts ?? [];
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const [repository, setRepository] = useState("");
  const activeCheckout =
    checkouts.find((entry) => entry.repositoryId === repository) ?? checkouts[0];
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<typeof WorkspaceActionsSnapshot.Type | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = useAtomCommand(projectEnvironment.workspaceActions, { reportFailure: false });
  const start = useAtomCommand(projectEnvironment.workspaceActionStart, { reportFailure: false });
  const cancel = useAtomCommand(projectEnvironment.workspaceActionCancel, { reportFailure: false });
  const refresh = useCallback(async () => {
    const result = await read({ environmentId, input: { threadId } });
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else setSnapshot(result.value);
  }, [read, environmentId, threadId]);
  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [open, refresh]);
  const shown = useRef(new Set<string>());
  useEffect(() => {
    if (!snapshot) return;
    const ref = { environmentId, threadId };
    const terminals = useTerminalUiStateStore.getState();
    const groups = new Map<string, string>();
    for (const run of snapshot.runs) {
      if (!run.terminalId) continue;
      const task = snapshot.tasks.find((entry) => entry.id === run.taskId);
      if (!task) continue;
      const group = task.presentation?.group;
      const sibling = group ? groups.get(group) : undefined;
      if (group) groups.set(group, run.terminalId);
      const key = `${threadId}:${run.id}`;
      if (shown.current.has(key)) continue;
      const reveal = task.presentation?.reveal ?? "always";
      if (reveal === "never" || (reveal === "silent" && run.status !== "failed")) continue;
      shown.current.add(key);
      if (task.presentation?.close && run.status === "succeeded") continue;
      if (sibling) {
        terminals.setActiveTerminal(ref, sibling);
        terminals.splitTerminal(ref, run.terminalId);
      } else terminals.ensureTerminal(ref, run.terminalId, { open: true, active: true });
    }
  }, [snapshot, environmentId, threadId]);
  const busy = snapshot?.runs.some((run) => run.status === "running" || run.status === "waiting");
  return (
    <div className="space-y-2">
      {checkouts.length > 1 && activeCheckout ? (
        <div className="space-y-2">
          <select
            aria-label="Active repository"
            value={activeCheckout.repositoryId}
            onChange={(event) => setRepository(event.target.value)}
            className="w-full rounded border bg-background p-2 text-xs"
          >
            {checkouts.map((checkout) => (
              <option key={checkout.repositoryId} value={checkout.repositoryId}>
                {checkout.path.split(/[\\/]/).at(-1)} · {checkout.branch}
              </option>
            ))}
          </select>
          <p className="break-all text-xs text-muted-foreground">{activeCheckout.path}</p>
          <Button
            variant="outline"
            size="sm"
            disabled={!canOperate}
            onClick={async () => {
              const terminalId = `repo-${randomUUID()}`;
              const result = await openTerminal({
                environmentId,
                input: {
                  threadId,
                  terminalId,
                  cwd: activeCheckout.path,
                  worktreePath: activeCheckout.path,
                },
              });
              if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
              else
                useTerminalUiStateStore
                  .getState()
                  .ensureTerminal({ environmentId, threadId }, terminalId, {
                    open: true,
                    active: true,
                  });
            }}
          >
            Open repository terminal
          </Button>
          <GitActionsControl
            gitCwd={activeCheckout.path}
            activeThreadRef={{ environmentId, threadId }}
            displayMode="panel"
          />
        </div>
      ) : null}
      <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>
        Workspace tasks
      </Button>
      {open ? (
        <div className="space-y-2 text-xs">
          {snapshot?.tasks.map((task) => (
            <div key={task.id} className="flex items-center justify-between gap-2">
              <span>
                {task.label}
                {task.background ? " · background" : ""}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !canOperate}
                onClick={async () => {
                  setError(null);
                  const result = await start({
                    environmentId,
                    input: { threadId, taskId: task.id },
                  });
                  if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
                  await refresh();
                }}
              >
                Run
              </Button>
            </div>
          ))}
          {snapshot?.tasks.length === 0 ? <p>No supported workspace tasks found.</p> : null}
          {snapshot?.runs.map((run) => (
            <p key={run.id}>
              {run.terminalId ? (
                <button
                  className="underline"
                  onClick={() =>
                    useTerminalUiStateStore
                      .getState()
                      .ensureTerminal({ environmentId, threadId }, run.terminalId!, {
                        open: true,
                        active: true,
                      })
                  }
                >
                  {run.label}
                </button>
              ) : (
                run.label
              )}
              : {run.status}
              {run.exitCode !== null ? ` (${run.exitCode})` : ""}
              {run.terminalId ? ` · ${run.terminalId}` : ""}
              {run.error ? ` · ${run.error}` : ""}
            </p>
          ))}
          {busy ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!canOperate}
              onClick={async () => {
                const result = await cancel({ environmentId, input: { threadId } });
                if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
                await refresh();
              }}
            >
              Stop workspace tasks
            </Button>
          ) : null}
          <p className="text-muted-foreground">
            Output appears in each task’s terminal. Running background tasks do not indicate service
            readiness.
          </p>
          {snapshot?.errors.map((message) => (
            <p role="alert" key={message}>
              {message}
            </p>
          ))}
          {error ? <p role="alert">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
