import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId, WorkspaceActionsSnapshot } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { AppText } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";

export function WorkspaceTasksControl({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<typeof WorkspaceActionsSnapshot.Type | null>(null);
  const canOperate = useAtomValue(
    projectEnvironment.workspaceActionStart.permissionAtom(environmentId),
  );
  const read = useAtomCommand(projectEnvironment.workspaceActions, { reportFailure: true });
  const start = useAtomCommand(projectEnvironment.workspaceActionStart, { reportFailure: true });
  const cancel = useAtomCommand(projectEnvironment.workspaceActionCancel, { reportFailure: true });
  const refresh = useCallback(async () => {
    const result = await read({ environmentId, input: { threadId } });
    if (result._tag === "Success") setSnapshot(result.value);
  }, [read, environmentId, threadId]);
  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [open, refresh]);
  const busy = snapshot?.runs.some((run) => run.status === "running" || run.status === "waiting");
  return (
    <View className="px-3">
      <MaterialButton
        label={open ? "Hide workspace tasks" : "Workspace tasks"}
        tone="text"
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <ScrollView style={{ maxHeight: 240 }} contentContainerClassName="gap-2 pb-3">
          {snapshot?.tasks.map((task) => (
            <MaterialButton
              key={task.id}
              label={task.label}
              disabled={!canOperate || busy}
              onPress={() => {
                void start({ environmentId, input: { threadId, taskId: task.id } }).then(refresh);
              }}
            />
          ))}
          {snapshot?.runs.map((run) => (
            <AppText key={run.id} className="text-sm text-foreground">
              {run.label}: {run.status}
              {run.error ? ` · ${run.error}` : ""}
            </AppText>
          ))}
          {snapshot?.errors.map((error) => (
            <AppText key={error} className="text-sm text-danger">
              {error}
            </AppText>
          ))}
          {busy ? (
            <MaterialButton
              label="Stop workspace tasks"
              tone="danger"
              disabled={!canOperate}
              onPress={() => {
                void cancel({ environmentId, input: { threadId } }).then(refresh);
              }}
            />
          ) : null}
          <AppText className="text-xs text-foreground-muted">
            Each task has its own terminal. Running background tasks do not indicate service
            readiness.
          </AppText>
        </ScrollView>
      ) : null}
    </View>
  );
}
