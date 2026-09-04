/**
 * Root component. Manages project state and routes between views.
 *
 * Projects are persisted via figma.clientStorage (through the plugin sandbox),
 * because localStorage is disabled in Figma's data: URL iframe environment.
 */

import { useState, useEffect, useCallback } from "react";
import { Setup } from "./views/Setup";
import { Sync } from "./views/Sync";
import { useSendMessage, usePluginMessage } from "./hooks/usePlugin";
import type { PluginMessage } from "../shared/messages";
import { Button } from "./components/Button";
import { IconPlus } from "./icons";
import { color, font, radius, space } from "./theme";

export interface Project {
  id: string;
  name: string;
  pat: string;
  repo: string;
  branch: string;
  tokensPath: string;
  figmaFileKey: string;
}

const PROJECTS_KEY = "tokensync:projects";
const ACTIVE_KEY = "tokensync:activeProject";

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [loading, setLoading] = useState(true); // waiting for clientStorage

  const send = useSendMessage();

  // -------------------------------------------------------------------------
  // Bootstrap: load persisted state from figma.clientStorage
  // -------------------------------------------------------------------------

  useEffect(() => {
    send({ type: "LOAD_STORAGE", key: PROJECTS_KEY });
    send({ type: "LOAD_STORAGE", key: ACTIVE_KEY });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track how many keys have loaded (need both before we stop the spinner)
  const [loadedKeys, setLoadedKeys] = useState(0);

  usePluginMessage(
    useCallback((msg: PluginMessage) => {
      if (msg.type === "STORAGE_LOADED") {
        if (msg.key === PROJECTS_KEY) {
          try {
            const parsed = JSON.parse(msg.value ?? "[]") as Project[];
            setProjects(parsed);
          } catch {
            setProjects([]);
          }
        }
        if (msg.key === ACTIVE_KEY) {
          setActiveId(msg.value);
        }
        setLoadedKeys((n) => n + 1);
      }
    }, []),
  );

  useEffect(() => {
    if (loadedKeys >= 2) setLoading(false);
  }, [loadedKeys]);

  // -------------------------------------------------------------------------
  // Persist on change
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (loading) return;
    send({ type: "SAVE_STORAGE", key: PROJECTS_KEY, value: JSON.stringify(projects) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, loading]);

  useEffect(() => {
    if (loading || activeId === null) return;
    send({ type: "SAVE_STORAGE", key: ACTIVE_KEY, value: activeId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, loading]);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  function handleSaveProject(project: Project) {
    setProjects((prev) => {
      const idx = prev.findIndex((p) => p.id === project.id);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = project;
        return updated;
      }
      return [...prev, project];
    });
    setActiveId(project.id);
    setShowSetup(false);
  }

  function handleDeleteProject(id: string) {
    setProjects((prev) => {
      const remaining = prev.filter((p) => p.id !== id);
      if (activeId === id) setActiveId(remaining[0]?.id ?? null);
      return remaining;
    });
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          color: color.text.muted,
          fontSize: font.size.md,
        }}
      >
        Loading…
      </div>
    );
  }

  const activeProject = projects.find((p) => p.id === activeId) ?? null;

  if (projects.length === 0 || showSetup) {
    return (
      <Setup
        onSave={handleSaveProject}
        onCancel={projects.length > 0 ? () => setShowSetup(false) : undefined}
        existing={showSetup ? activeProject : null}
      />
    );
  }

  if (activeProject) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        {projects.length > 1 && (
          <ProjectSwitcher
            projects={projects}
            activeId={activeId!}
            onSelect={setActiveId}
            onAdd={() => setShowSetup(true)}
          />
        )}
        <Sync
          project={activeProject}
          onEditProject={() => setShowSetup(true)}
          onDeleteProject={() => handleDeleteProject(activeProject.id)}
        />
      </div>
    );
  }

  return <Setup onSave={handleSaveProject} />;
}

function ProjectSwitcher({
  projects,
  activeId,
  onSelect,
  onAdd,
}: {
  projects: Project[];
  activeId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div style={s.bar}>
      <select style={s.select} value={activeId} onChange={(e) => onSelect(e.target.value)}>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <Button variant="secondary" size="compact" icon={<IconPlus size={11} />} onClick={onAdd}>
        Add
      </Button>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  bar: {
    display: "flex",
    gap: space.sm,
    padding: `${space.md}px ${space.xl}px 0`,
    alignItems: "center",
  },
  select: {
    flex: 1,
    fontSize: font.size.md,
    padding: `${space.xs}px ${space.sm}px`,
    borderRadius: radius.sm,
    border: `1px solid ${color.border.default}`,
    fontFamily: font.family,
  },
};
