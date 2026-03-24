/**
 * Sync view — main screen after a project is configured.
 * Manages the pull and push flows.
 */

import { useState, useCallback } from 'react'
import type { Project } from '../App'
import { fetchTokenFiles } from '../hooks/useGitHub'
import { useSendMessage, usePluginMessage } from '../hooks/usePlugin'
import { buildFigmaFlatMaps } from '../hooks/useFigmaValues'
import { parseRepository } from '../../shared/token-merger'
import { buildCollectionDiff } from '../../shared/token-diff'
import type { CollectionDiff } from '../../shared/token-diff'
import type { PluginMessage, FigmaVariableCollection, FigmaVariable } from '../../shared/messages'
import { PullDiff } from './PullDiff'

type View = 'main' | 'pull-diff'

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
  const [view, setView] = useState<View>('main')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [applying, setApplying] = useState(false)
  const [diffs, setDiffs] = useState<CollectionDiff[]>([])

  const send = useSendMessage()

  // Holds GitHub data while waiting for Figma response
  const [pendingCollections, setPendingCollections] = useState<ReturnType<typeof parseRepository> | null>(null)

  usePluginMessage(
    useCallback(
      (msg: PluginMessage) => {
        if (msg.type === 'COLLECTIONS_LOADED') {
          handleCollectionsLoaded(msg.collections, msg.variables)
        }
        if (msg.type === 'TOKENS_APPLIED') {
          setApplying(false)
          setView('main')
          setStatus({ kind: 'success', message: `Applied ${msg.count} variable(s) to Figma` })
        }
        if (msg.type === 'ERROR') {
          setApplying(false)
          setStatus({ kind: 'error', message: msg.message })
        }
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [pendingCollections],
    ),
  )

  function handleCollectionsLoaded(
    figmaCollections: FigmaVariableCollection[],
    figmaVariables: FigmaVariable[],
  ) {
    if (!pendingCollections) return

    setStatus({ kind: 'loading', message: 'Calculating diff…' })

    const figmaMaps = buildFigmaFlatMaps(figmaCollections, figmaVariables)

    const result: CollectionDiff[] = pendingCollections.collections.map((githubCol) => {
      const figmaMap = figmaMaps.find(
        (m) => m.collectionName === githubCol.collectionName && m.modeName === githubCol.modeName,
      )
      return buildCollectionDiff(
        githubCol.collectionName,
        githubCol.modeName,
        githubCol.tokens,
        figmaMap?.values ?? {},
      )
    })

    const totalChanges = result.reduce((n, d) => n + d.counts.total, 0)

    if (totalChanges === 0) {
      setStatus({ kind: 'success', message: 'Figma is already up to date with GitHub' })
    } else {
      setStatus({ kind: 'idle' })
      setDiffs(result.filter((d) => d.counts.total > 0))
      setView('pull-diff')
    }

    setPendingCollections(null)
  }

  // ---------------------------------------------------------------------------
  // Pull flow
  // ---------------------------------------------------------------------------

  async function handlePull() {
    try {
      setStatus({ kind: 'loading', message: 'Fetching tokens from GitHub…' })

      const files = await fetchTokenFiles({
        pat: project.pat,
        repo: project.repo,
        branch: project.branch,
        tokensPath: project.tokensPath,
      })

      setStatus({ kind: 'loading', message: `Parsing ${files.length} token files…` })

      const parsed = parseRepository(files, project.tokensPath)
      setPendingCollections(parsed)

      setStatus({ kind: 'loading', message: 'Reading Figma variables…' })
      send({ type: 'GET_COLLECTIONS' })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  // ---------------------------------------------------------------------------
  // Apply (after seeing diff)
  // ---------------------------------------------------------------------------

  function handleApply(collectionName: string, modeName: string) {
    const diff = diffs.find(
      (d) => d.collectionName === collectionName && d.modeName === modeName,
    )
    if (!diff) return

    setApplying(true)

    // Build a simple token tree from the diff entries to apply
    // Only send tokens that are added or changed
    const tokensToApply = diff.entries
      .filter((e) => e.status === 'added' || e.status === 'changed')
      .reduce<Record<string, { $type: string; $value: string }>>((acc, entry) => {
        if (entry.githubValue) {
          acc[entry.path] = { $type: entry.type, $value: entry.githubValue }
        }
        return acc
      }, {})

    // We need the collection + mode IDs from Figma — for now, send name-based lookup
    // The plugin will find the collection/mode by name
    send({
      type: 'APPLY_TOKENS',
      tokens: tokensToApply,
      collectionId: collectionName,  // plugin resolves name → id
      modeId: modeName,              // plugin resolves name → id
    })
  }

  // ---------------------------------------------------------------------------
  // Push flow (Phase 5)
  // ---------------------------------------------------------------------------

  async function handlePush() {
    setStatus({ kind: 'success', message: 'Push flow is coming in Phase 5. GitHub integration is ready.' })
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (view === 'pull-diff') {
    return (
      <PullDiff
        diffs={diffs}
        onApply={handleApply}
        onBack={() => { setView('main'); setStatus({ kind: 'idle' }) }}
        applying={applying}
      />
    )
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <div style={styles.projectName}>{project.name}</div>
          <div style={styles.projectMeta}>{project.repo} · {project.branch}</div>
        </div>
        <button style={styles.editBtn} onClick={onEditProject}>Settings</button>
      </div>

      {/* Actions */}
      <div style={styles.actions}>
        <ActionCard
          title="Pull from GitHub"
          description="Fetch token changes from GitHub and review before applying to Figma Variables."
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
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ActionCard({
  title, description, buttonLabel, buttonStyle, onClick, disabled,
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
    fontSize: '12px', padding: '10px 14px', borderRadius: '8px',
    border: '1px solid', lineHeight: 1.4, display: 'flex', gap: '6px', alignItems: 'center',
  },
  spinner: { display: 'inline-block', animation: 'spin 1s linear infinite' },
}
