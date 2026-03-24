/**
 * Sync view — the main screen after a project is configured.
 * Shows the current project, pull/push actions, and status.
 */

import { useState, useCallback } from 'react'
import type { Project } from '../App'
import { fetchTokenFiles, createTokenPR } from '../hooks/useGitHub'
import { useSendMessage, usePluginMessage } from '../hooks/usePlugin'
import type { PluginMessage, FigmaVariableCollection } from '../../shared/messages'

type Status =
  | { kind: 'idle' }
  | { kind: 'loading'; message: string }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string }

interface Props {
  project: Project
  onEditProject: () => void
}

export function Sync({ project, onEditProject }: Props) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [collections, setCollections] = useState<FigmaVariableCollection[]>([])
  const send = useSendMessage()

  // Listen for messages from the plugin sandbox
  usePluginMessage(
    useCallback(
      (msg: PluginMessage) => {
        if (msg.type === 'COLLECTIONS_LOADED') {
          setCollections(msg.collections)
          setStatus({ kind: 'success', message: `Loaded ${msg.collections.length} collection(s) from Figma` })
        }
        if (msg.type === 'TOKENS_APPLIED') {
          setStatus({ kind: 'success', message: `Applied ${msg.count} variables to Figma` })
        }
        if (msg.type === 'ERROR') {
          setStatus({ kind: 'error', message: msg.message })
        }
      },
      [],
    ),
  )

  async function handlePull() {
    try {
      setStatus({ kind: 'loading', message: 'Fetching tokens from GitHub…' })

      const files = await fetchTokenFiles({
        pat: project.pat,
        repo: project.repo,
        branch: project.branch,
        tokensPath: project.tokensPath,
      })

      setStatus({ kind: 'loading', message: `Fetched ${files.length} files. Reading Figma collections…` })
      send({ type: 'GET_COLLECTIONS' })

      // TODO Phase 4: show diff between GitHub tokens and Figma variables, then apply
      setStatus({ kind: 'success', message: `Fetched ${files.length} token files from GitHub. Diff view coming soon.` })
      console.log('[TokenSync] files from GitHub:', files.map((f) => f.path))
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  async function handlePush() {
    try {
      setStatus({ kind: 'loading', message: 'Reading Figma variables…' })
      send({ type: 'GET_COLLECTIONS' })

      // TODO Phase 4: convert Figma variables → token format → GitHub PR
      setStatus({ kind: 'success', message: 'Push flow coming in Phase 4. Collections loaded for development.' })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <div style={styles.projectName}>{project.name}</div>
          <div style={styles.projectMeta}>{project.repo} · {project.branch}</div>
        </div>
        <button style={styles.editBtn} onClick={onEditProject}>
          Settings
        </button>
      </div>

      {/* Actions */}
      <div style={styles.actions}>
        <ActionCard
          title="Pull from GitHub"
          description="Fetch token changes from GitHub and apply them to Figma Variables."
          buttonLabel="Pull"
          buttonStyle="secondary"
          onClick={handlePull}
          disabled={status.kind === 'loading'}
        />
        <ActionCard
          title="Push to GitHub"
          description="Export Figma Variables as tokens and open a Pull Request on GitHub."
          buttonLabel="Push → PR"
          buttonStyle="primary"
          onClick={handlePush}
          disabled={status.kind === 'loading'}
        />
      </div>

      {/* Status */}
      {status.kind !== 'idle' && (
        <div style={{ ...styles.status, ...statusStyle(status.kind) }}>
          {status.kind === 'loading' && <span style={styles.spinner}>⟳</span>}
          {status.message}
        </div>
      )}

      {/* Collections list (debug / info) */}
      {collections.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Figma collections</div>
          {collections.map((c) => (
            <div key={c.id} style={styles.collectionRow}>
              <span>{c.name}</span>
              <span style={styles.modeCount}>{c.modes.length} mode{c.modes.length !== 1 ? 's' : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ActionCard({
  title,
  description,
  buttonLabel,
  buttonStyle,
  onClick,
  disabled,
}: {
  title: string
  description: string
  buttonLabel: string
  buttonStyle: 'primary' | 'secondary'
  onClick: () => void
  disabled: boolean
}) {
  return (
    <div style={styles.card}>
      <div style={styles.cardText}>
        <div style={styles.cardTitle}>{title}</div>
        <div style={styles.cardDesc}>{description}</div>
      </div>
      <button
        style={{ ...styles.actionBtn, ...(buttonStyle === 'primary' ? styles.primaryBtn : styles.secondaryBtn) }}
        onClick={onClick}
        disabled={disabled}
      >
        {buttonLabel}
      </button>
    </div>
  )
}

function statusStyle(kind: Status['kind']): React.CSSProperties {
  if (kind === 'error')   return { background: '#fff0f0', color: '#c00', borderColor: '#fcc' }
  if (kind === 'success') return { background: '#f0faf3', color: '#127030', borderColor: '#b8e8c7' }
  return { background: '#f5f5f5', color: '#444', borderColor: '#e0e0e0' }
}

const styles: Record<string, React.CSSProperties> = {
  container:    { padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' },
  header:       { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  projectName:  { fontWeight: 600, fontSize: '15px' },
  projectMeta:  { fontSize: '11px', color: '#888', marginTop: '2px' },
  editBtn:      { fontSize: '12px', color: '#555', background: 'none', border: '1px solid #ddd', borderRadius: '6px', padding: '4px 10px', cursor: 'pointer' },
  actions:      { display: 'flex', flexDirection: 'column', gap: '12px' },
  card:         { border: '1px solid #e8e8e8', borderRadius: '10px', padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' },
  cardText:     { display: 'flex', flexDirection: 'column', gap: '4px' },
  cardTitle:    { fontWeight: 500, fontSize: '13px' },
  cardDesc:     { fontSize: '11px', color: '#666', lineHeight: 1.4 },
  actionBtn:    { flexShrink: 0, border: 'none', borderRadius: '6px', padding: '8px 14px', fontSize: '12px', fontWeight: 500, cursor: 'pointer' },
  primaryBtn:   { background: '#1a52d8', color: '#fff' },
  secondaryBtn: { background: '#f0f0f0', color: '#222' },
  status: {
    fontSize: '12px',
    padding: '10px 14px',
    borderRadius: '8px',
    border: '1px solid',
    lineHeight: 1.4,
    display: 'flex',
    gap: '6px',
    alignItems: 'center',
  },
  spinner:      { display: 'inline-block', animation: 'spin 1s linear infinite' },
  section:      { display: 'flex', flexDirection: 'column', gap: '6px' },
  sectionTitle: { fontSize: '11px', fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em' },
  collectionRow: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '6px 10px', background: '#f8f8f8', borderRadius: '6px' },
  modeCount:    { color: '#888' },
}
