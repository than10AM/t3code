import { useState } from "react";
import type { EnvironmentId, ProjectId, WorkspaceConfiguration } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";

export function WorkspaceSettings({
  project,
}: {
  project: {
    environmentId: EnvironmentId;
    id: ProjectId;
    workspaceRoot: string;
    workspace?: WorkspaceConfiguration | null | undefined;
  };
}) {
  const [location, setLocation] = useState(project.workspace?.filePath ?? project.workspaceRoot);
  const [workspace, setWorkspace] = useState(project.workspace ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const discover = useAtomCommand(projectEnvironment.discoverWorkspace, { reportFailure: false });
  const update = useOrchestrationCommand(projectEnvironment.update, { reportFailure: false });
  const refresh = async () => {
    setBusy(true);
    setError(null);
    const result = await discover({
      environmentId: project.environmentId,
      input: { path: location },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    const selected = new Map(workspace?.repositories.map((repo) => [repo.id, repo.selected]));
    setWorkspace({
      ...result.value,
      repositories: result.value.repositories.map((repo) => ({
        ...repo,
        selected: selected.get(repo.id) ?? repo.selected,
        ...(workspace?.repositories.find((entry) => entry.id === repo.id)?.baseRef
          ? { baseRef: workspace!.repositories.find((entry) => entry.id === repo.id)!.baseRef }
          : {}),
      })),
    });
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    const result = await update({
      environmentId: project.environmentId,
      input: { projectId: project.id, workspace },
    });
    setBusy(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
  };
  return (
    <SettingsSection title="Workspace repositories">
      <p className="text-sm text-muted-foreground">
        Import a .code-workspace file or discover repositories in this project. Repository
        selections apply to new threads.
      </p>
      <div className="flex gap-2">
        <Input
          aria-label="Workspace file or folder"
          value={location}
          onChange={(event) => setLocation(event.target.value)}
        />
        <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
          Discover
        </Button>
      </div>
      {workspace?.repositories.map((repo) => (
        <label key={repo.id} className="flex items-start gap-3 py-2 text-sm">
          <input
            type="checkbox"
            checked={repo.selected}
            disabled={busy}
            onChange={(event) =>
              setWorkspace({
                ...workspace,
                repositories: workspace.repositories.map((item) =>
                  item.id === repo.id
                    ? { ...item, selected: event.target.checked }
                    : event.target.checked && item.commonDirectory === repo.commonDirectory
                      ? { ...item, selected: false }
                      : item,
                ),
              })
            }
          />
          <span>
            <span className="font-medium">{repo.name}</span>
            {repo.isWorktree ? " · alternate worktree" : ""} · {repo.branch ?? "detached HEAD"}
            <span className="block text-xs text-muted-foreground">{repo.path}</span>
            {repo.selected ? (
              <Input
                aria-label={`Base ref for ${repo.name}`}
                placeholder="Current checkout commit"
                value={repo.baseRef ?? ""}
                onChange={(event) =>
                  setWorkspace({
                    ...workspace,
                    repositories: workspace.repositories.map((item) =>
                      item.id === repo.id
                        ? { ...item, baseRef: event.target.value || undefined }
                        : item,
                    ),
                  })
                }
              />
            ) : null}
          </span>
        </label>
      ))}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {workspace ? (
        <div>
          <Button disabled={busy} onClick={() => void save()}>
            Save repository selection
          </Button>
        </div>
      ) : null}
    </SettingsSection>
  );
}
