/**
 * Sync view — main screen after a project is configured.
 * Manages the pull and push flows.
 */

import { useState, useCallback, useRef } from 'react'
import type { Project } from '../App'
import { fetchTokenFiles, createTokenPR } from '../hooks/useGitHub'
import { useSendMessage, usePluginMessage } from '../hooks/usePlugin'
import { buildFigmaFlatMaps } from '../hooks/useFigmaValues'
import { parseRepository } from '../../shared/token-merger'
import type { ParsedRepository } from '../../shared/token-merger'
import { buildCollectionDiff } from '../../shared/token-diff'
import { figmaToCollections } from '../../shared/figma-to-tokens'
import type { CollectionDiff } from '../../shared/token-diff'
import { runTransformers } from '../../shared/transformer'
import type { PluginMessage, FigmaVariableCollection, FigmaVariable } from '../../shared/messages'
import { PullDiff } from './PullDiff'
import { PushDiff } from './PushDiff'

type View = 'main' | 'pull-diff' | 'push-diff'

type Status =
  | { kind: 'idle' }
  | { kind: 'loading'; message: string }
  | { kind: 'success'; message: string; url?: string }
  | { kind: 'error'; message: string }

interface Props {
  project: Project
  onEditProject: () => void
  onDeleteProject: () => void
}

// Stored between the GET_COLLECTIONS call and the plugin response
type PendingAction = 'pull' | 'push'

export function Sync({ project, onEditProject, onDeleteProject: _onDeleteProject }: Props) {
  const [view, setView] = useState<View>('main')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [applying, setApplying] = useState(false)
  const [creating, setCreating] = useState(false)
  const [diffs, setDiffs] = useState<CollectionDiff[]>([])

  const pendingAction = useRef<PendingAction | null>(null)
  const pendingGitHub = useRef<ReturnType<typeof parseRepository> | null>(null)
  const pendingFiles = useRef<Awaited<ReturnType<typeof fetchTokenFiles>> | null>(null)
  const pendingParsed = useRef<ParsedRepository | null>(null)           // push: parsed GitHub repo (metadata + collections)
  const pendingFigmaCollections = useRef<ReturnType<typeof figmaToCollections> | null>(null) // push: Figma resolved collections

  const send = useSendMessage()

  const figmaCollectionNames = {
    primitives: 'Primitives',
    global: 'Global',
    semantic: 'Semantic',
  }

  // ---------------------------------------------------------------------------
  // Plugin message handler
  // ---------------------------------------------------------------------------

  usePluginMessage(
    useCallback(
      (msg: PluginMessage) => {
        if (msg.type === 'COLLECTIONS_LOADED') {
          if (pendingAction.current === 'pull') {
            handlePullCollectionsLoaded(msg.collections, msg.variables)
          } else if (pendingAction.current === 'push') {
            handlePushCollectionsLoaded(msg.collections, msg.variables)
          }
          pendingAction.current = null
        }
        if (msg.type === 'TOKENS_APPLIED') {
          setApplying(false)
          setView('main')
          setStatus({ kind: 'success', message: `Applied ${msg.count} variable(s) to Figma` })
        }
        if (msg.type === 'ERROR') {
          setApplying(false)
          setCreating(false)
          setStatus({ kind: 'error', message: msg.message })
        }
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    ),
  )

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
      pendingGitHub.current = parsed

      setStatus({ kind: 'loading', message: 'Reading Figma variables…' })
      pendingAction.current = 'pull'
      send({ type: 'GET_COLLECTIONS' })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  function handlePullCollectionsLoaded(
    figmaCollections: FigmaVariableCollection[],
    figmaVariables: FigmaVariable[],
  ) {
    const github = pendingGitHub.current
    if (!github) return

    setStatus({ kind: 'loading', message: 'Calculating diff…' })

    const figmaMaps = buildFigmaFlatMaps(figmaCollections, figmaVariables)

    const result = github.collections.map((githubCol) => {
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

    pendingGitHub.current = null
  }

  function handleApplyToFigma(collectionName: string, modeName: string) {
    const diff = diffs.find(
      (d) => d.collectionName === collectionName && d.modeName === modeName,
    )
    if (!diff) return

    setApplying(true)

    const tokensToApply = diff.entries
      .filter((e) => e.status === 'added' || e.status === 'changed')
      .reduce<Record<string, { $type: string; $value: string }>>((acc, entry) => {
        if (entry.githubValue) acc[entry.path] = { $type: entry.type, $value: entry.githubValue }
        return acc
      }, {})

    send({
      type: 'APPLY_TOKENS',
      tokens: tokensToApply,
      collectionId: collectionName,
      modeId: modeName,
    })
  }

  // ---------------------------------------------------------------------------
  // Push flow
  // ---------------------------------------------------------------------------

  async function handlePush() {
    try {
      setStatus({ kind: 'loading', message: 'Fetching current tokens from GitHub…' })

      const files = await fetchTokenFiles({
        pat: project.pat,
        repo: project.repo,
        branch: project.branch,
        tokensPath: project.tokensPath,
      })

      pendingFiles.current = files
      setStatus({ kind: 'loading', message: 'Reading Figma variables…' })
      pendingAction.current = 'push'
      send({ type: 'GET_COLLECTIONS' })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  function handlePushCollectionsLoaded(
    figmaCollections: FigmaVariableCollection[],
    figmaVariables: FigmaVariable[],
  ) {
    const githubFiles = pendingFiles.current
    if (!githubFiles) return

    setStatus({ kind: 'loading', message: 'Calculating diff…' })

    // GitHub side: parse existing token files
    const githubParsed = parseRepository(githubFiles, project.tokensPath)
    pendingParsed.current = githubParsed

    // Figma side: convert to same ResolvedCollection shape
    const figmaCollectionData = figmaToCollections(
      figmaCollections,
      figmaVariables,
      figmaCollectionNames,
    )
    pendingFigmaCollections.current = figmaCollectionData

    // Diff: Figma (new) vs GitHub (current)
    // githubValue = current state in GitHub, figmaValue = new state from Figma
    const result: CollectionDiff[] = figmaCollectionData.map((figmaCol) => {
      const githubCol = githubParsed.collections.find(
        (c) => c.collectionName === figmaCol.collectionName && c.modeName === figmaCol.modeName,
      )
      // Swap: figmaTokens as "github" (what we're proposing), githubTokens as "figma" (current)
      return buildCollectionDiff(
        figmaCol.collectionName,
        figmaCol.modeName,
        figmaCol.tokens,         // proposed (from Figma)
        Object.fromEntries(      // current (from GitHub) — convert TokenValue to plain string
          Object.entries(githubCol?.tokens ?? {}).map(([k, v]) => [k, v.$value]),
        ),
      )
    })

    const totalChanges = result.reduce((n, d) => n + d.counts.total, 0)

    if (totalChanges === 0) {
      setStatus({ kind: 'success', message: 'GitHub is already up to date with Figma' })
    } else {
      setStatus({ kind: 'idle' })
      setDiffs(result.filter((d) => d.counts.total > 0))
      setView('push-diff')
    }

    pendingFiles.current = null
  }

  async function handleCreatePR(prTitle: string) {
    setCreating(true)
    try {
      // Re-read Figma variables to build token files for the PR
      // (We already have them from the push flow — rebuild from diffs)
      const changedFiles = buildFilesFromDiffs()

      const result = await createTokenPR(
        {
          pat: project.pat,
          repo: project.repo,
          branch: project.branch,
          tokensPath: project.tokensPath,
        },
        changedFiles,
        prTitle,
      )

      setCreating(false)
      setView('main')
      setStatus({
        kind: 'success',
        message: `PR #${result.number} created`,
        url: result.url,
      })
    } catch (err) {
      setCreating(false)
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  /**
   * Reconstruct token file content from the push diff entries.
   * Also runs platform transformers (CSS, JS/TS, Dart) if configured in metadata.
   */
  function buildFilesFromDiffs(): Array<{ path: string; content: string }> {
    const tokenFiles = diffs.map((diff) => {
      const { repoPath, tokens } = diffToFile(diff, project.tokensPath)
      return { path: repoPath, content: JSON.stringify(tokens, null, 2) }
    })

    // Run platform transformers using the full Figma collection set
    const figmaCollections = pendingFigmaCollections.current
    const parsed = pendingParsed.current
    if (figmaCollections && parsed) {
      const platformFiles = runTransformers(figmaCollections, parsed.metadata, project.tokensPath)
      return [...tokenFiles, ...platformFiles]
    }

    return tokenFiles
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (view === 'pull-diff') {
    return (
      <PullDiff
        diffs={diffs}
        onApply={handleApplyToFigma}
        onBack={() => { setView('main'); setStatus({ kind: 'idle' }) }}
        applying={applying}
      />
    )
  }

  if (view === 'push-diff') {
    return (
      <PushDiff
        diffs={diffs}
        onCreatePR={handleCreatePR}
        onBack={() => { setView('main'); setStatus({ kind: 'idle' }) }}
        creating={creating}
      />
    )
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div>
          <div style={styles.projectName}>{project.name}</div>
          <div style={styles.projectMeta}>{project.repo} · {project.branch}</div>
        </div>
        <button style={styles.editBtn} onClick={onEditProject}>Settings</button>
      </div>

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

      {status.kind !== 'idle' && (
        <div style={{ ...styles.status, ...statusStyle(status.kind) }}>
          {status.kind === 'loading' && <span style={styles.spinner}>⟳</span>}
          <span>{status.message}</span>
          {status.kind === 'success' && 'url' in status && status.url && (
            <a
              href={status.url}
              target="_blank"
              rel="noreferrer"
              style={styles.prLink}
            >
              View PR →
            </a>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Convert a CollectionDiff back into a token file for the PR
// ---------------------------------------------------------------------------

function diffToFile(
  diff: CollectionDiff,
  tokensPath: string,
): { repoPath: string; tokens: Record<string, unknown> } {
  const { collectionName, modeName } = diff

  const repoPath = inferFilePath(collectionName, modeName, tokensPath)
  const tokens: Record<string, unknown> = {}

  for (const entry of diff.entries) {
    if (entry.status === 'removed') continue  // removed = delete from Figma, not from GitHub
    if (entry.githubValue === null) continue

    const keys = entry.path.split('.')
    let current = tokens
    for (let i = 0; i < keys.length - 1; i++) {
      if (typeof current[keys[i]] !== 'object' || current[keys[i]] === null) {
        current[keys[i]] = {}
      }
      current = current[keys[i]] as Record<string, unknown>
    }
    current[keys[keys.length - 1]] = { $type: entry.type, $value: entry.githubValue }
  }

  return { repoPath, tokens }
}

function inferFilePath(collectionName: string, modeName: string, tokensPath: string): string {
  const base = tokensPath.endsWith('/') ? tokensPath : tokensPath + '/'
  const col = collectionName.toLowerCase()
  if (col === 'primitives') return `${base}primitives/${modeName.toLowerCase()}.json`
  if (col === 'global') return `${base}semantic/global/${modeName.toLowerCase()}.json`
  // Semantic: modeName = "Default/Light" → semantic/default/light.json
  const parts = modeName.split('/')
  const brand = (parts[0] ?? 'default').toLowerCase().replace(/\s+/g, '-')
  const theme = (parts[1] ?? 'light').toLowerCase()
  return `${base}semantic/${brand}/${theme}.json`
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ActionCard({
  title, description, buttonLabel, buttonStyle, onClick, disabled,
}: {
  title: string; description: string; buttonLabel: string
  buttonStyle: 'primary' | 'secondary'; onClick: () => void; disabled: boolean
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
    border: '1px solid', lineHeight: 1.4, display: 'flex', gap: '8px', alignItems: 'center',
  },
  spinner:  { display: 'inline-block', animation: 'spin 1s linear infinite' },
  prLink:   { marginLeft: 'auto', fontSize: '12px', color: '#1a52d8', textDecoration: 'none', fontWeight: 500 },
}
