import clsx from 'clsx'
import { ArrowLeft, GitBranch, History, Play, Sparkles, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { EntityChips } from '@/components/ActivityTrace'
import { MemoryGraphCanvas } from '@/components/MemoryGraphCanvas'
import {
  ENTITY_COLORS,
  entityColor,
  fetchEntity,
  fetchGraph,
  fetchMemoryEvents,
  fetchMemoryStats,
  fetchTimeline,
  type EntityDetail,
  type GraphEventOut,
  type GraphNode,
  type GraphOut,
  type MemoryStats,
  type TimelinePoint,
} from '@/lib/api'

export function MemoryPage() {
  const [graph, setGraph] = useState<GraphOut>({ nodes: [], edges: [] })
  const [timeline, setTimeline] = useState<TimelinePoint[]>([])
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [events, setEvents] = useState<GraphEventOut[]>([])
  const [selected, setSelected] = useState<EntityDetail | null>(null)
  const [cursor, setCursor] = useState<number>(-1) // -1 = now (full graph)

  useEffect(() => {
    fetchGraph().then(setGraph).catch(() => undefined)
    fetchTimeline().then(setTimeline).catch(() => undefined)
    fetchMemoryStats().then(setStats).catch(() => undefined)
    fetchMemoryEvents(40).then(setEvents).catch(() => undefined)
  }, [])

  const visibleNodeIds = useMemo(() => {
    if (cursor < 0 || cursor >= timeline.length - 1 || timeline.length === 0) return null
    const cutoff = new Date(timeline[cursor].created_at).getTime() + 1000
    return new Set(
      graph.nodes.filter((n) => new Date(n.created_at).getTime() <= cutoff).map((n) => n.id),
    )
  }, [cursor, timeline, graph.nodes])

  const handleSelect = (node: GraphNode | null) => {
    if (!node) {
      setSelected(null)
      return
    }
    fetchEntity(node.id).then(setSelected).catch(() => undefined)
  }

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of graph.nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1)
    return counts
  }, [graph.nodes])

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-ink-800 px-5">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="flex items-center gap-1.5 text-[12.5px] text-ink-300 transition-colors hover:text-ink-100"
          >
            <ArrowLeft className="size-3.5" />
            Back to chat
          </Link>
          <span className="text-ink-600">/</span>
          <span className="text-[13px] font-medium text-ink-100">Long-term memory</span>
        </div>
        {stats && (
          <div className="flex items-center gap-2 font-mono text-[11.5px] text-ink-300">
            <StatPill label="entities" value={stats.entities} />
            <StatPill label="relations" value={stats.relations} />
            <StatPill label="sessions" value={stats.sessions} />
            <StatPill label="runs" value={stats.runs} />
          </div>
        )}
      </header>

      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {graph.nodes.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <Sparkles className="size-6 text-ink-400" />
              <p className="text-[13.5px] text-ink-300">The knowledge graph is empty.</p>
              <p className="max-w-xs text-[12.5px] text-ink-400">
                Run a research session and Cortex will start extracting entities and relationships
                it can reuse later.
              </p>
            </div>
          ) : (
            <MemoryGraphCanvas
              nodes={graph.nodes}
              edges={graph.edges}
              visibleNodeIds={visibleNodeIds}
              selectedId={selected?.node.id ?? null}
              onSelect={handleSelect}
            />
          )}

          {/* Legend */}
          <div className="pointer-events-none absolute top-4 left-4 rounded-lg border border-ink-800 bg-ink-900/85 px-3 py-2.5 backdrop-blur">
            <div className="space-y-1">
              {Object.entries(ENTITY_COLORS).map(([type, color]) => (
                <div key={type} className="flex items-center gap-2 text-[11px] text-ink-300">
                  <span className="size-2 rounded-full" style={{ background: color }} />
                  {type}
                  <span className="ml-auto pl-3 font-mono text-ink-400">
                    {typeCounts.get(type) ?? 0}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <aside className="flex w-[320px] shrink-0 flex-col border-l border-ink-800 bg-ink-900/40">
          {selected ? (
            <EntityInspector detail={selected} onClose={() => setSelected(null)} />
          ) : (
            <EventFeed events={events} />
          )}
        </aside>
      </div>

      {timeline.length > 0 && (
        <GrowthTimeline timeline={timeline} cursor={cursor} onCursor={setCursor} />
      )}
    </div>
  )
}

function StatPill({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded-full border border-ink-700 bg-ink-850 px-2.5 py-1">
      <span className="text-ink-100">{value}</span> {label}
    </span>
  )
}

function EntityInspector({ detail, onClose }: { detail: EntityDetail; onClose: () => void }) {
  const { node, neighbors, edges, events } = detail
  const neighborName = (id: string) =>
    id === node.id ? node.name : (neighbors.find((n) => n.id === id)?.name ?? '?')

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      <div className="mb-1 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-full" style={{ background: entityColor(node.type) }} />
          <h2 className="text-[15px] font-semibold text-ink-50">{node.name}</h2>
        </div>
        <button onClick={onClose} className="rounded p-1 text-ink-400 hover:text-ink-100">
          <X className="size-4" />
        </button>
      </div>
      <p className="font-mono text-[11px] text-ink-400">
        {node.type} · seen {node.mention_count}× · {node.degree} connections
      </p>
      {node.summary && (
        <p className="mt-3 text-[13px] leading-relaxed text-ink-200">{node.summary}</p>
      )}

      {edges.length > 0 && (
        <section className="mt-5">
          <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-400">
            <GitBranch className="size-3" /> Relations
          </h3>
          <ul className="space-y-1.5">
            {edges.map((edge) => (
              <li key={edge.id} className="rounded-lg border border-ink-800 bg-ink-900 px-2.5 py-2">
                <p className="text-[12.5px] text-ink-200">
                  {neighborName(edge.source)}{' '}
                  <span className="font-mono text-[11px] text-accent">
                    {edge.type.replace(/_/g, ' ')}
                  </span>{' '}
                  {neighborName(edge.target)}
                  {edge.weight > 1 && (
                    <span className="ml-1 font-mono text-[10.5px] text-ink-400">×{edge.weight}</span>
                  )}
                </p>
                {edge.description && (
                  <p className="mt-0.5 text-[11.5px] text-ink-400">{edge.description}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {neighbors.length > 0 && (
        <section className="mt-5">
          <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-400">
            Connected entities
          </h3>
          <EntityChips entities={neighbors} />
        </section>
      )}

      {events.length > 0 && (
        <section className="mt-5">
          <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-400">
            <History className="size-3" /> History
          </h3>
          <ul className="space-y-1">
            {events.slice(0, 12).map((event) => (
              <li key={event.id} className="flex items-baseline gap-2 text-[11.5px]">
                <span
                  className={clsx(
                    'shrink-0 font-mono',
                    event.kind.endsWith('added') ? 'text-mint' : 'text-ink-400',
                  )}
                >
                  {event.kind.endsWith('added') ? 'added' : 'reinforced'}
                </span>
                <span className="text-ink-400">
                  {new Date(event.created_at).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function EventFeed({ events }: { events: GraphEventOut[] }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <h3 className="mb-3 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-400">
        <History className="size-3" /> Recent memory events
      </h3>
      {events.length === 0 ? (
        <p className="text-[12.5px] text-ink-400">Nothing recorded yet.</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {events.map((event) => (
            <li key={event.id} className="text-[12px] leading-snug">
              <span
                className={clsx(
                  'mr-1.5 font-mono text-[10.5px]',
                  event.kind.endsWith('added') ? 'text-mint' : 'text-ink-400',
                )}
              >
                {event.kind.replace(/_/g, ' ')}
              </span>
              <span className="text-ink-200">{event.label}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 border-t border-ink-800 pt-3 text-[11.5px] text-ink-400">
        Click a node to inspect it. Drag to rearrange, scroll to zoom, use the timeline below to
        replay how memory grew.
      </p>
    </div>
  )
}

function GrowthTimeline({
  timeline,
  cursor,
  onCursor,
}: {
  timeline: TimelinePoint[]
  cursor: number
  onCursor: (index: number) => void
}) {
  const width = 640
  const height = 56
  const maxEntities = Math.max(1, ...timeline.map((p) => p.total_entities))
  const effective = cursor < 0 ? timeline.length - 1 : cursor
  const point = timeline[effective]

  const path = (accessor: (p: TimelinePoint) => number) =>
    timeline
      .map((p, i) => {
        const x = timeline.length === 1 ? width : (i / (timeline.length - 1)) * width
        const y = height - (accessor(p) / maxEntities) * (height - 6) - 3
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')

  return (
    <footer className="shrink-0 border-t border-ink-800 bg-ink-900/60 px-5 py-3">
      <div className="flex items-center gap-4">
        <div className="w-40 shrink-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
            Memory growth
          </p>
          <p className="mt-0.5 font-mono text-[12px] text-ink-200">
            {point ? `${point.total_entities} entities · ${point.total_relations} relations` : '—'}
          </p>
          <p className="font-mono text-[10.5px] text-ink-400">
            {point &&
              new Date(point.created_at).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
          </p>
        </div>
        <div className="min-w-0 flex-1">
          <svg viewBox={`0 0 ${width} ${height}`} className="h-14 w-full" preserveAspectRatio="none">
            <path d={path((p) => p.total_entities)} fill="none" stroke="#6ea8fe" strokeWidth="1.5" />
            <path d={path((p) => p.total_relations)} fill="none" stroke="#6fd8b2" strokeWidth="1.5" />
            {timeline.length > 1 && (
              <line
                x1={(effective / (timeline.length - 1)) * width}
                x2={(effective / (timeline.length - 1)) * width}
                y1="0"
                y2={height}
                stroke="rgba(244,244,246,0.4)"
                strokeWidth="1"
              />
            )}
          </svg>
          <input
            type="range"
            min={0}
            max={timeline.length - 1}
            value={effective}
            onChange={(e) => {
              const v = Number(e.target.value)
              onCursor(v >= timeline.length - 1 ? -1 : v)
            }}
            className="mt-1 w-full accent-ink-100"
          />
        </div>
        <button
          onClick={() => onCursor(-1)}
          className={clsx(
            'flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors',
            cursor < 0
              ? 'border-ink-700 bg-ink-800 text-ink-100'
              : 'border-ink-700 text-ink-300 hover:text-ink-100',
          )}
        >
          <Play className="size-3" />
          Now
        </button>
      </div>
    </footer>
  )
}
