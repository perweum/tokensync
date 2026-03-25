/**
 * Pull diff view.
 * Shows what will change in Figma if the user applies the GitHub tokens.
 */

import { useState } from 'react'
import type { CollectionDiff, DiffEntry, DiffStatus } from '../../shared/token-diff'
import { groupByCategory } from '../../shared/token-diff'

interface Props {
  diffs: CollectionDiff[]
  onApply: (collectionName: string, modeName: string) => void
  onApplyAll: () => void
  onCleanApply: (collectionName: string, modeName: string) => void
  onCleanApplyAll: () => void
  onBack: () => void
  applying: boolean
  error?: string
}

export function PullDiff({ diffs, onApply, onApplyAll, onCleanApply, onCleanApplyAll, onBack, applying, error }: Props) {
  const [selectedCollection, setSelectedCollection] = useState(0)

  const hasDiffs = diffs.some((d) => d.counts.total > 0)

  return (
    <div style={s.container}>
      {/* Header */}
      <div style={s.header}>
        <button style={s.backBtn} onClick={onBack}>← Back</button>
        <span style={s.title}>Pull from GitHub</span>
      </div>

      {!hasDiffs ? (
        <div style={s.empty}>
          <div style={s.emptyIcon}>✓</div>
          <div style={s.emptyText}>Figma is up to date with GitHub</div>
          <div style={s.emptySubtext}>No token changes detected</div>
        </div>
      ) : (
        <>
          {/* Collection tabs */}
          {diffs.length > 1 && (
            <div style={s.tabs}>
              {diffs.map((diff, i) => (
                <button
                  key={`${diff.collectionName}/${diff.modeName}`}
                  style={{
                    ...s.tab,
                    ...(selectedCollection === i ? s.tabActive : {}),
                  }}
                  onClick={() => setSelectedCollection(i)}
                >
                  {diff.modeName === 'Value'
                    ? diff.collectionName
                    : `${diff.collectionName} / ${diff.modeName}`}
                  {diff.counts.total > 0 && (
                    <span style={s.tabBadge}>{diff.counts.total}</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Summary bar */}
          {(() => {
            const diff = diffs[selectedCollection]
            if (!diff) return null
            return (
              <>
                <SummaryBar counts={diff.counts} />
                <DiffList entries={diff.entries} />
                <div style={s.footer}>
                  {error && <div style={s.errorMsg}>{error}</div>}
                  <div style={s.footerBtns}>
                    <button
                      style={{ ...s.applyBtn, ...(applying ? s.applyBtnDisabled : {}) }}
                      onClick={() => onApply(diff.collectionName, diff.modeName)}
                      disabled={applying || diff.counts.total === 0}
                    >
                      {applying ? 'Applying…' : `Apply changes (${diff.counts.total})`}
                    </button>
                    {diffs.length > 1 && (
                      <button
                        style={{ ...s.applyAllBtn, ...(applying ? s.applyBtnDisabled : {}) }}
                        onClick={onApplyAll}
                        disabled={applying}
                      >
                        Apply All
                      </button>
                    )}
                  </div>
                  <div style={s.footerBtns}>
                    <button
                      style={{ ...s.cleanBtn, ...(applying ? s.applyBtnDisabled : {}) }}
                      onClick={() => onCleanApply(diff.collectionName, diff.modeName)}
                      disabled={applying}
                      title="Deletes all variables in this collection and recreates them in sorted order"
                    >
                      Clean apply
                    </button>
                    {diffs.length > 1 && (
                      <button
                        style={{ ...s.cleanBtn, ...(applying ? s.applyBtnDisabled : {}) }}
                        onClick={onCleanApplyAll}
                        disabled={applying}
                        title="Clean apply for all collections"
                      >
                        Clean apply all
                      </button>
                    )}
                  </div>
                </div>
              </>
            )
          })()}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Summary bar
// ---------------------------------------------------------------------------

function SummaryBar({
  counts,
}: {
  counts: CollectionDiff['counts']
}) {
  return (
    <div style={s.summary}>
      {counts.changed > 0 && <Chip color="#1a52d8" label={`${counts.changed} changed`} />}
      {counts.added > 0   && <Chip color="#12702f" label={`${counts.added} added`} />}
      {counts.removed > 0 && <Chip color="#c00000" label={`${counts.removed} removed`} />}
    </div>
  )
}

function Chip({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ ...s.chip, background: color + '18', color }}>
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Diff list (grouped by category)
// ---------------------------------------------------------------------------

function DiffList({ entries }: { entries: DiffEntry[] }) {
  const grouped = groupByCategory(entries)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  function toggle(cat: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(cat) ? next.delete(cat) : next.add(cat)
      return next
    })
  }

  return (
    <div style={s.diffList}>
      {[...grouped.entries()].map(([category, catEntries]) => (
        <div key={category}>
          <button style={s.categoryRow} onClick={() => toggle(category)}>
            <span style={s.categoryChevron}>{collapsed.has(category) ? '▶' : '▼'}</span>
            <span style={s.categoryName}>{category}</span>
            <span style={s.categoryCount}>{catEntries.length}</span>
          </button>

          {!collapsed.has(category) && catEntries.map((entry) => (
            <DiffRow key={entry.path} entry={entry} />
          ))}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Single diff row
// ---------------------------------------------------------------------------

function DiffRow({ entry }: { entry: DiffEntry }) {
  const isColor = entry.type === 'color'
  const label = entry.path.split('.').slice(1).join('.') // strip category prefix

  return (
    <div style={{ ...s.diffRow, ...statusBg(entry.status) }}>
      <span style={{ ...s.statusDot, color: statusColor(entry.status) }}>
        {statusIcon(entry.status)}
      </span>

      <span style={s.tokenPath}>{label}</span>

      <div style={s.values}>
        {entry.figmaValue !== null && (
          <Value value={entry.figmaValue} isColor={isColor} faded={entry.status === 'changed'} />
        )}
        {entry.status === 'changed' && <span style={s.arrow}>→</span>}
        {entry.githubValue !== null && (
          <Value value={entry.githubValue} isColor={isColor} faded={false} />
        )}
      </div>
    </div>
  )
}

function Value({
  value,
  isColor,
  faded,
}: {
  value: string
  isColor: boolean
  faded: boolean
}) {
  return (
    <span style={{ ...s.value, opacity: faded ? 0.45 : 1 }}>
      {isColor && (isHex(value) || isRgba(value)) && (
        <span
          style={{
            ...s.swatch,
            background: value,
            border: isHex(value) && isLight(value) ? '1px solid #ddd' : '1px solid #e0e0e0',
          }}
        />
      )}
      <span style={s.valueText}>{shortValue(value)}</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

function isHex(v: string) {
  return /^#[0-9a-f]{3,8}$/i.test(v)
}

function isRgba(v: string) {
  return /^rgba?\(/i.test(v)
}

function isLight(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return r * 0.299 + g * 0.587 + b * 0.114 > 200
}

function shortValue(v: string): string {
  if (v.length > 20) return v.slice(0, 18) + '…'
  return v
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function statusIcon(s: DiffStatus) {
  if (s === 'added')   return '+'
  if (s === 'removed') return '−'
  return '~'
}

function statusColor(s: DiffStatus) {
  if (s === 'added')   return '#12702f'
  if (s === 'removed') return '#c00000'
  return '#1a52d8'
}

function statusBg(s: DiffStatus): React.CSSProperties {
  if (s === 'added')   return { background: '#f0faf3' }
  if (s === 'removed') return { background: '#fff5f5' }
  return {}
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s: Record<string, React.CSSProperties> = {
  container:   { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  header:      { display: 'flex', alignItems: 'center', gap: '8px', padding: '14px 16px', borderBottom: '1px solid #eee' },
  backBtn:     { background: 'none', border: 'none', fontSize: '12px', color: '#555', cursor: 'pointer', padding: '2px 0' },
  title:       { fontWeight: 600, fontSize: '14px' },

  empty:       { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: '6px', color: '#666' },
  emptyIcon:   { fontSize: '28px', color: '#12702f' },
  emptyText:   { fontWeight: 500, fontSize: '14px', color: '#1a1a1a' },
  emptySubtext: { fontSize: '12px' },

  tabs:        { display: 'flex', gap: '2px', padding: '8px 16px 0', borderBottom: '1px solid #eee', overflowX: 'auto' },
  tab:         { background: 'none', border: 'none', fontSize: '12px', padding: '6px 10px', cursor: 'pointer', color: '#666', borderRadius: '6px 6px 0 0', display: 'flex', alignItems: 'center', gap: '5px' },
  tabActive:   { background: '#f0f0f0', color: '#1a1a1a', fontWeight: 500 },
  tabBadge:    { background: '#1a52d8', color: '#fff', borderRadius: '8px', padding: '1px 5px', fontSize: '10px' },

  summary:     { display: 'flex', gap: '6px', padding: '10px 16px', flexWrap: 'wrap' },
  chip:        { fontSize: '11px', fontWeight: 500, padding: '3px 8px', borderRadius: '12px' },

  diffList:    { flex: 1, overflowY: 'auto', padding: '0 0 80px' },

  categoryRow:  { width: '100%', display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 16px', background: '#f8f8f8', border: 'none', borderBottom: '1px solid #eee', cursor: 'pointer', textAlign: 'left' },
  categoryChevron: { fontSize: '9px', color: '#888' },
  categoryName: { flex: 1, fontSize: '12px', fontWeight: 600, color: '#444', textTransform: 'capitalize' },
  categoryCount: { fontSize: '11px', color: '#888' },

  diffRow:     { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 16px', borderBottom: '1px solid #f0f0f0' },
  statusDot:   { fontWeight: 700, fontSize: '13px', width: '14px', flexShrink: 0, fontFamily: 'monospace' },
  tokenPath:   { flex: 1, fontSize: '11px', color: '#333', fontFamily: 'monospace' },
  values:      { display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 },
  arrow:       { fontSize: '11px', color: '#aaa' },
  value:       { display: 'flex', alignItems: 'center', gap: '4px' },
  swatch:      { width: '12px', height: '12px', borderRadius: '3px', flexShrink: 0, display: 'inline-block' },
  valueText:   { fontSize: '11px', color: '#555', fontFamily: 'monospace' },

  footer:      { position: 'sticky', bottom: 0, padding: '12px 16px', background: '#fff', borderTop: '1px solid #eee', display: 'flex', flexDirection: 'column', gap: '6px' },
  footerBtns:  { display: 'flex', gap: '8px' },
  applyBtn:        { flex: 1, background: '#1a52d8', color: '#fff', border: 'none', borderRadius: '8px', padding: '11px', fontSize: '13px', fontWeight: 500, cursor: 'pointer' },
  applyAllBtn:     { flexShrink: 0, background: '#222', color: '#fff', border: 'none', borderRadius: '8px', padding: '11px 16px', fontSize: '13px', fontWeight: 500, cursor: 'pointer' },
  applyBtnDisabled: { background: '#aaa', cursor: 'not-allowed', borderColor: '#aaa' },
  cleanBtn:         { flex: 1, background: 'none', color: '#c00000', border: '1px solid #fcc', borderRadius: '8px', padding: '9px', fontSize: '12px', fontWeight: 500, cursor: 'pointer' },
  errorMsg:        { fontSize: '12px', color: '#c00', background: '#fff0f0', border: '1px solid #fcc', borderRadius: '6px', padding: '8px 10px', marginBottom: '8px' },
}
