import clsx from 'clsx'
import {
  AlertTriangle,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  Loader2,
  Search,
  Sparkles,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { entityColor } from '@/lib/api'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface EntityChip {
  id: string
  name: string
  type: string
  mention_count?: number
}

export interface TraceEntry {
  id: string
  kind: 'recall' | 'note' | 'tool' | 'memory' | 'error'
  title: string
  content: string
  pending?: boolean
  query?: string
  results?: SearchResult[]
  entities?: EntityChip[]
}

function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function EntityChips({ entities }: { entities: EntityChip[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {entities.map((e) => (
        <span
          key={e.id}
          className="inline-flex items-center gap-1.5 rounded-full border border-ink-700 bg-ink-850 px-2 py-0.5 text-[11.5px] text-ink-200"
        >
          <span className="size-1.5 rounded-full" style={{ background: entityColor(e.type) }} />
          {e.name}
          {e.mention_count != null && e.mention_count > 1 && (
            <span className="text-ink-400">×{e.mention_count}</span>
          )}
        </span>
      ))}
    </div>
  )
}

function EntryIcon({ entry }: { entry: TraceEntry }) {
  const cls = 'size-3.5'
  if (entry.pending) return <Loader2 className={clsx(cls, 'animate-spin text-ink-300')} />
  switch (entry.kind) {
    case 'recall':
      return <BrainCircuit className={clsx(cls, 'text-accent')} />
    case 'tool':
      return <Search className={clsx(cls, 'text-ink-300')} />
    case 'memory':
      return <Sparkles className={clsx(cls, 'text-mint')} />
    case 'error':
      return <AlertTriangle className={clsx(cls, 'text-rose')} />
    default:
      return <span className="mx-[5px] block size-1 rounded-full bg-ink-400" />
  }
}

function Entry({ entry }: { entry: TraceEntry }) {
  return (
    <div className="relative flex gap-3 pb-4 last:pb-0">
      <div className="relative flex w-4 shrink-0 justify-center pt-0.5">
        <EntryIcon entry={entry} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-medium text-ink-200">
          {entry.kind === 'tool' && entry.query ? (
            <>
              Searched <span className="text-ink-100">“{entry.query}”</span>
            </>
          ) : (
            entry.title
          )}
        </p>
        {entry.kind === 'note' && entry.content && (
          <p className="mt-0.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-300">
            {entry.content.length > 700 ? `${entry.content.slice(0, 700)}…` : entry.content}
          </p>
        )}
        {entry.kind === 'error' && (
          <p className="mt-0.5 font-mono text-[12px] text-rose">{entry.content}</p>
        )}
        {entry.entities && entry.entities.length > 0 && (
          <div className="mt-1.5">
            <EntityChips entities={entry.entities} />
          </div>
        )}
        {entry.results && entry.results.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {entry.results.map((r, i) => (
              <a
                key={i}
                href={r.url}
                target="_blank"
                rel="noreferrer"
                title={r.title}
                className="inline-flex max-w-[220px] items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-[11.5px] text-ink-300 transition-colors hover:border-ink-600 hover:text-ink-100"
              >
                <span className="truncate">{r.title || domain(r.url)}</span>
                <span className="shrink-0 text-ink-400">· {domain(r.url)}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface ActivityTraceProps {
  entries: TraceEntry[]
  running: boolean
  phaseLabel: string
}

export function ActivityTrace({ entries, running, phaseLabel }: ActivityTraceProps) {
  const [open, setOpen] = useState(true)
  const wasRunning = useRef(running)

  useEffect(() => {
    if (wasRunning.current && !running) setOpen(false)
    wasRunning.current = running
  }, [running])

  if (entries.length === 0 && !running) return null

  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900/60">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left"
      >
        {running ? (
          <Loader2 className="size-3.5 animate-spin text-accent" />
        ) : open ? (
          <ChevronDown className="size-3.5 text-ink-400" />
        ) : (
          <ChevronRight className="size-3.5 text-ink-400" />
        )}
        <span
          className={clsx(
            'text-[12.5px] font-medium',
            running ? 'animate-pulse-soft text-ink-100' : 'text-ink-300',
          )}
        >
          {running ? phaseLabel : `Research trace · ${entries.length} steps`}
        </span>
      </button>
      {open && (
        <div className="border-t border-ink-800 px-3.5 py-3">
          {entries.map((entry) => (
            <Entry key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  )
}
