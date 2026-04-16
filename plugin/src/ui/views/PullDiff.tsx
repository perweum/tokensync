/**
 * Pull diff view.
 * Shows what will change in Figma if the user applies the GitHub tokens.
 * Collections are displayed as vertically stacked expandable sections.
 */

import { useState } from 'react'
import type { CollectionDiff, DiffEntry, DiffStatus } from '../../shared/token-diff'
import { groupByCategory } from '../../shared/token-diff'

interface Props {
  diffs: CollectionDiff[]
  onApply: () => void
  onCleanApply: () => void
  onBack: () => void
  applying: boolean
  error?: string
}

export function PullDiff({ diffs, onApply, onCleanApply, onBack, applying, error }: Props) {
  const [confirmClean, setConfirmClean] = useState(false)

  const hasDiffs = diffs.some((d) => d.counts.total > 0)
  const totalChanges = diffs.reduce((n, d) => n + d.counts.total, 0)

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
          {/* Scrollable collection list */}
          <div style={s.body}>
            {diffs.map((diff) => (
              <CollectionSection
                key={`${diff.collectionName}/${diff.modeName}`}
                diff={diff}
                defaultExpanded={true}
              />
            ))}
          </div>

          {/* Fixed footer */}
          <div style={s.footer}>
            {error && <div style={s.errorMsg}>{error}</div>}

            {confirmClean ? (
              <div style={s.confirmBox}>
                <div style={s.confirmText}>
                  This will delete and recreate all variables in sorted order. Continue?
                </div>
                <div style={s.confirmBtns}>
                  <button
                    style={s.confirmYes}
                    onClick={() => { setConfirmClean(false); onCleanApply() }}
                  >
                    Yes, clean apply
                  </button>
                  <button style={s.confirmNo} onClick={() => setConfirmClean(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button
                  style={{ ...s.applyBtn, ...(applying ? s.btnDisabled : {}) }}
                  onClick={onApply}
                  disabled={applying}
                >
                  {applying ? 'Applying…' : `Apply (${totalChanges})`}
                </button>
                <button
                  style={{ ...s.cleanBtn, ...(applying ? s.btnDisabled : {}) }}
                  onClick={() => setConfirmClean(true)}
                  disabled={applying}
                  title="Deletes all variables and recreates them in sorted order. Use when variable ordering is wrong."
                >
                  Clean apply
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Collection section (expandable)
// ---------------------------------------------------------------------------

function CollectionSection({
  diff,
  defaultExpanded,
}: {
  diff: CollectionDiff
  defaultExpanded: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const label =
    diff.modeName === 'Value'
      ? diff.collectionName
      : `${diff.collectionName} / ${diff.modeName}`

  return (
    <div style={s.section}>
      <button style={s.sectionHeader} onClick={() => setExpanded((e) => !e)}>
        <span style={s.chevron}>{expanded ? '▼' : '▶'}</span>
        <span style={s.sectionLabel}>{label}</span>
        <CountBadges counts={diff.counts} />
      </button>

      {expanded && (
        <div style={s.sectionBody}>
          <DiffList entries={diff.entries} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Count badges
// ---------------------------------------------------------------------------

function CountBadges({ counts }: { counts: CollectionDiff['counts'] }) {
  return (
    <div style={s.badges}>
      {counts.changed > 0 && <span style={{ ...s.badge, ...s.badgeChanged }}>{counts.changed} changed</span>}
      {counts.added > 0   && <span style={{ ...s.badge, ...s.badgeAdded }}>{counts.added} added</span>}
      {counts.removed > 0 && <span style={{ ...s.badge, ...s.badgeRemoved }}>{counts.removed} removed</span>}
    </div>
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
    <div>
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
  const label = entry.path.split('.').slice(1).join('.')

  return (
    <div style={{ ...s.diffRow, ...statusBg(entry.status) }}>
      <span style={{ ...s.statusDot, color: statusColor(entry.status) }}>
        {statusIcon(entry.status)}
      </span>

      <div style={s.tokenMeta}>
        <span style={s.tokenPath}>{label}</span>
        {entry.description && (
          <span style={s.tokenDesc}>{entry.description}</span>
        )}
      </div>

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

function Value({ value, isColor, faded }: { value: string; isColor: boolean; faded: boolean }) {
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

function isHex(v: string) { return /^#[0-9a-f]{3,8}$/i.test(v) }
function isRgba(v: string) { return /^rgba?\(/i.test(v) }

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
  container:    { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  header:       { display: 'flex', alignItems: 'center', gap: '8px', padding: '14px 16px', borderBottom: '1px solid #eee', flexShrink: 0 },
  backBtn:      { background: 'none', border: 'none', fontSize: '12px', color: '#555', cursor: 'pointer', padding: '2px 0' },
  title:        { fontWeight: 600, fontSize: '14px' },

  empty:        { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: '6px', color: '#666' },
  emptyIcon:    { fontSize: '28px', color: '#12702f' },
  emptyText:    { fontWeight: 500, fontSize: '14px', color: '#1a1a1a' },
  emptySubtext: { fontSize: '12px' },

  body:         { flex: 1, overflowY: 'auto' },

  section:      { borderBottom: '1px solid #eee' },
  sectionHeader: { width: '100%', display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' },
  chevron:      { fontSize: '9px', color: '#888', flexShrink: 0 },
  sectionLabel: { flex: 1, fontWeight: 600, fontSize: '13px', color: '#1a1a1a' },
  badges:       { display: 'flex', gap: '4px', flexShrink: 0 },
  badge:        { fontSize: '10px', fontWeight: 500, padding: '2px 7px', borderRadius: '10px' },
  badgeChanged: { background: '#1a52d818', color: '#1a52d8' },
  badgeAdded:   { background: '#12702f18', color: '#12702f' },
  badgeRemoved: { background: '#c0000018', color: '#c00000' },

  sectionBody:  {},

  categoryRow:     { width: '100%', display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 16px 6px 32px', background: '#f8f8f8', border: 'none', borderBottom: '1px solid #eee', cursor: 'pointer', textAlign: 'left' },
  categoryChevron: { fontSize: '9px', color: '#888' },
  categoryName:    { flex: 1, fontSize: '12px', fontWeight: 600, color: '#444', textTransform: 'capitalize' },
  categoryCount:   { fontSize: '11px', color: '#888' },

  diffRow:    { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 16px 6px 32px', borderBottom: '1px solid #f0f0f0' },
  statusDot:  { fontWeight: 700, fontSize: '13px', width: '14px', flexShrink: 0, fontFamily: 'monospace' },
  tokenMeta:  { flex: 1, display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 },
  tokenPath:  { fontSize: '11px', color: '#333', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tokenDesc:  { fontSize: '10px', color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  values:     { display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 },
  arrow:      { fontSize: '11px', color: '#aaa' },
  value:      { display: 'flex', alignItems: 'center', gap: '4px' },
  swatch:     { width: '12px', height: '12px', borderRadius: '3px', flexShrink: 0, display: 'inline-block' },
  valueText:  { fontSize: '11px', color: '#555', fontFamily: 'monospace' },

  footer:     { flexShrink: 0, padding: '12px 16px', background: '#fff', borderTop: '1px solid #eee', display: 'flex', flexDirection: 'column', gap: '8px' },
  applyBtn:   { background: '#1a52d8', color: '#fff', border: 'none', borderRadius: '8px', padding: '11px', fontSize: '13px', fontWeight: 500, cursor: 'pointer' },
  cleanBtn:   { background: 'none', color: '#c00000', border: '1px solid #fcc', borderRadius: '8px', padding: '9px', fontSize: '12px', fontWeight: 500, cursor: 'pointer' },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },

  confirmBox:  { background: '#fff8f0', border: '1px solid #f5c6a0', borderRadius: '8px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' },
  confirmText: { fontSize: '12px', color: '#7a3800', lineHeight: 1.4 },
  confirmBtns: { display: 'flex', gap: '8px' },
  confirmYes:  { flex: 1, background: '#c00000', color: '#fff', border: 'none', borderRadius: '6px', padding: '9px', fontSize: '12px', fontWeight: 500, cursor: 'pointer' },
  confirmNo:   { flexShrink: 0, background: 'none', color: '#555', border: '1px solid #ddd', borderRadius: '6px', padding: '9px 14px', fontSize: '12px', cursor: 'pointer' },

  errorMsg:   { fontSize: '12px', color: '#c00', background: '#fff0f0', border: '1px solid #fcc', borderRadius: '6px', padding: '8px 10px' },
}
