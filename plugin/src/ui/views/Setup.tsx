/**
 * Setup view — shown when no project is configured or on first run.
 * Collects GitHub PAT and project details.
 */

import { useState } from 'react'
import type { Project } from '../App'

interface Props {
  onSave: (project: Project) => void
  onCancel?: () => void
  existing?: Project | null
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9)
}

export function Setup({ onSave, onCancel, existing }: Props) {
  const [name, setName] = useState(existing?.name ?? '')
  const [pat, setPat] = useState(existing?.pat ?? '')
  const [repo, setRepo] = useState(existing?.repo ?? '')
  const [branch, setBranch] = useState(existing?.branch ?? 'main')
  const [tokensPath, setTokensPath] = useState(existing?.tokensPath ?? 'tokens/')
  const [figmaFileKey, setFigmaFileKey] = useState(existing?.figmaFileKey ?? '')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (!name.trim()) return setError('Project name is required')
    if (!pat.trim()) return setError('GitHub Personal Access Token is required')
    if (!repo.trim() || !repo.includes('/'))
      return setError('Repository must be in format org/repo-name')
    setSaved(true)
    setTimeout(() => {
      onSave({
        id: existing?.id ?? generateId(),
        name: name.trim(),
        pat: pat.trim(),
        repo: repo.trim(),
        branch: branch.trim() || 'main',
        tokensPath: tokensPath.trim() || 'tokens/',
        figmaFileKey: figmaFileKey.trim(),
      })
    }, 400)
  }

  return (
    <div style={styles.container}>
      <div style={styles.headingRow}>
        {onCancel && (
          <button style={styles.backBtn} onClick={onCancel}>← Back</button>
        )}
        <h2 style={styles.heading}>{existing ? 'Edit project' : 'Add project'}</h2>
      </div>
      <p style={styles.subtext}>
        Connect a GitHub repository to this Figma file. Token files will be
        read from and written to the repository via Pull Request.
      </p>

      <form onSubmit={handleSubmit} style={styles.form}>
        <Field label="Project name" hint="Used only in this plugin">
          <input
            style={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Design System"
          />
        </Field>

        <Field
          label="GitHub Personal Access Token"
          hint="Needs repo read + write permissions. Stored in Figma clientStorage."
        >
          <input
            style={styles.input}
            type="password"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            placeholder="ghp_xxxxxxxxxxxx"
          />
        </Field>

        <Field label="Repository" hint="org/repo-name">
          <input
            style={styles.input}
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="your-org/design-tokens"
          />
        </Field>

        <Field label="Default branch">
          <input
            style={styles.input}
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="main"
          />
        </Field>

        <Field label="Tokens path" hint="Folder inside the repo containing the tokens/ structure">
          <input
            style={styles.input}
            value={tokensPath}
            onChange={(e) => setTokensPath(e.target.value)}
            placeholder="tokens/"
          />
        </Field>

        <Field
          label="Figma file key"
          hint="Optional. Found in the URL: figma.com/design/FILE_KEY/..."
        >
          <input
            style={styles.input}
            value={figmaFileKey}
            onChange={(e) => setFigmaFileKey(e.target.value)}
            placeholder="abc123xyz"
          />
        </Field>

        {error && <p style={styles.error}>{error}</p>}

        <button type="submit" style={{ ...styles.button, ...(saved ? styles.buttonSaved : {}) }} disabled={saved}>
          {saved ? '✓ Saved' : 'Save project'}
        </button>
      </form>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div style={styles.field}>
      <label style={styles.label}>{label}</label>
      {hint && <span style={styles.hint}>{hint}</span>}
      {children}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container:   { padding: '24px', display: 'flex', flexDirection: 'column', gap: '8px' },
  headingRow:  { display: 'flex', alignItems: 'center', gap: '8px' },
  heading:     { margin: 0, fontSize: '16px', fontWeight: 600 },
  backBtn:     { background: 'none', border: 'none', fontSize: '12px', color: '#555', cursor: 'pointer', padding: '2px 0' },
  subtext:   { margin: 0, fontSize: '12px', color: '#666', lineHeight: 1.5 },
  form:      { display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '8px' },
  field:     { display: 'flex', flexDirection: 'column', gap: '4px' },
  label:     { fontSize: '12px', fontWeight: 500 },
  hint:      { fontSize: '11px', color: '#888' },
  input: {
    border: '1px solid #ddd',
    borderRadius: '6px',
    padding: '8px 10px',
    fontSize: '12px',
    outline: 'none',
  },
  button: {
    background: '#1a52d8',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    padding: '10px 16px',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
  },
  error:       { margin: 0, fontSize: '12px', color: '#c00' },
  buttonSaved: { background: '#12702f' },
}
