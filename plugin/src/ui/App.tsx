/**
 * Root component. Manages project state and routes between views.
 * Projects are persisted in localStorage (in the plugin iframe context).
 */

import { useState, useEffect } from 'react'
import { Setup } from './views/Setup'
import { Sync } from './views/Sync'

export interface Project {
  id: string
  name: string
  pat: string
  repo: string
  branch: string
  tokensPath: string
  figmaFileKey: string
}

const STORAGE_KEY = 'tokensync:projects'
const ACTIVE_KEY = 'tokensync:activeProject'

function loadProjects(): Project[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
  } catch {
    return []
  }
}

function saveProjects(projects: Project[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects))
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>(loadProjects)
  const [activeId, setActiveId] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_KEY),
  )
  const [showSetup, setShowSetup] = useState(false)

  const activeProject = projects.find((p) => p.id === activeId) ?? null

  useEffect(() => {
    saveProjects(projects)
  }, [projects])

  useEffect(() => {
    if (activeId) localStorage.setItem(ACTIVE_KEY, activeId)
  }, [activeId])

  function handleSaveProject(project: Project) {
    setProjects((prev) => {
      const existing = prev.findIndex((p) => p.id === project.id)
      if (existing >= 0) {
        const updated = [...prev]
        updated[existing] = project
        return updated
      }
      return [...prev, project]
    })
    setActiveId(project.id)
    setShowSetup(false)
  }

  function handleDeleteProject(id: string) {
    setProjects((prev) => prev.filter((p) => p.id !== id))
    if (activeId === id) {
      const remaining = projects.filter((p) => p.id !== id)
      setActiveId(remaining[0]?.id ?? null)
    }
  }

  // No projects yet → show setup
  if (projects.length === 0 || showSetup) {
    return <Setup onSave={handleSaveProject} />
  }

  // Active project selected → show sync view
  if (activeProject) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Project switcher (shown only if multiple projects) */}
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
        />
      </div>
    )
  }

  // Fallback — no active project
  return <Setup onSave={handleSaveProject} />
}

function ProjectSwitcher({
  projects,
  activeId,
  onSelect,
  onAdd,
}: {
  projects: Project[]
  activeId: string
  onSelect: (id: string) => void
  onAdd: () => void
}) {
  return (
    <div style={switcherStyles.bar}>
      <select
        style={switcherStyles.select}
        value={activeId}
        onChange={(e) => onSelect(e.target.value)}
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button style={switcherStyles.addBtn} onClick={onAdd}>
        + Add
      </button>
    </div>
  )
}

const switcherStyles: Record<string, React.CSSProperties> = {
  bar:    { display: 'flex', gap: '8px', padding: '12px 20px 0', alignItems: 'center' },
  select: { flex: 1, fontSize: '12px', padding: '6px 8px', borderRadius: '6px', border: '1px solid #ddd' },
  addBtn: { fontSize: '12px', padding: '6px 10px', borderRadius: '6px', border: '1px solid #ddd', background: 'none', cursor: 'pointer' },
}
