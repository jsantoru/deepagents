import clsx from 'clsx'
import { BrainCircuit, Check, FileText, Loader2, Search, Sparkles } from 'lucide-react'

import { EntityChips, type EntityChip } from '@/components/ActivityTrace'

export interface RunMetrics {
  latency_ms?: number
  search_calls?: number
  input_tokens?: number
  output_tokens?: number
  model?: string
}

export interface MemoryDelta {
  added: EntityChip[]
  reinforced: EntityChip[]
  addedRelations: number
  reinforcedRelations: number
}

export type Phase =
  | 'idle'
  | 'recalling'
  | 'researching'
  | 'synthesizing'
  | 'memorizing'
  | 'done'

const STEPS: { key: Phase; label: string; icon: typeof Search }[] = [
  { key: 'recalling', label: 'Recall memory', icon: BrainCircuit },
  { key: 'researching', label: 'Research', icon: Search },
  { key: 'synthesizing', label: 'Synthesize', icon: FileText },
  { key: 'memorizing', label: 'Memorize', icon: Sparkles },
]

const ORDER: Phase[] = ['idle', 'recalling', 'researching', 'synthesizing', 'memorizing', 'done']

interface RunPanelProps {
  phase: Phase
  running: boolean
  recall: EntityChip[]
  memory: MemoryDelta | null
  metrics: RunMetrics | null
}

export function RunPanel({ phase, running, recall, memory, metrics }: RunPanelProps) {
  const phaseIndex = ORDER.indexOf(phase)

  return (
    <aside className="hidden h-full w-[300px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-ink-800 bg-ink-900/40 p-4 xl:flex">
      <section>
        <h3 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-ink-400">
          Agent state
        </h3>
        <ol className="space-y-1">
          {STEPS.map((step) => {
            const stepIndex = ORDER.indexOf(step.key)
            const active = running && phase === step.key
            const complete = phaseIndex > stepIndex || phase === 'done'
            const Icon = step.icon
            return (
              <li
                key={step.key}
                className={clsx(
                  'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors',
                  active && 'bg-ink-800 text-ink-50',
                  complete && !active && 'text-ink-200',
                  !active && !complete && 'text-ink-400',
                )}
              >
                <span className="flex size-5 items-center justify-center">
                  {active ? (
                    <Loader2 className="size-4 animate-spin text-accent" />
                  ) : complete ? (
                    <Check className="size-4 text-mint" />
                  ) : (
                    <Icon className="size-4" />
                  )}
                </span>
                {step.label}
              </li>
            )
          })}
        </ol>
      </section>

      {recall.length > 0 && (
        <section>
          <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-400">
            Recalled from memory
          </h3>
          <EntityChips entities={recall} />
        </section>
      )}

      {memory && (
        <section>
          <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-400">
            Memory delta
          </h3>
          <div className="space-y-2.5 text-[12.5px] text-ink-300">
            {memory.added.length > 0 && (
              <div>
                <p className="mb-1.5 text-mint">+{memory.added.length} new entities</p>
                <EntityChips entities={memory.added} />
              </div>
            )}
            {memory.reinforced.length > 0 && (
              <div>
                <p className="mb-1.5">{memory.reinforced.length} reinforced</p>
                <EntityChips entities={memory.reinforced} />
              </div>
            )}
            <p className="text-ink-400">
              +{memory.addedRelations} relations · {memory.reinforcedRelations} strengthened
            </p>
          </div>
        </section>
      )}

      {metrics && (
        <section>
          <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-400">
            Last run
          </h3>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 font-mono text-[12px]">
            <Metric label="latency" value={metrics.latency_ms ? `${(metrics.latency_ms / 1000).toFixed(1)}s` : '—'} />
            <Metric label="searches" value={String(metrics.search_calls ?? 0)} />
            <Metric label="tokens in" value={String(metrics.input_tokens ?? 0)} />
            <Metric label="tokens out" value={String(metrics.output_tokens ?? 0)} />
          </dl>
          {metrics.model && <p className="mt-2 font-mono text-[11px] text-ink-400">{metrics.model}</p>}
        </section>
      )}
    </aside>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900 px-2.5 py-1.5">
      <dt className="text-[10px] uppercase tracking-wider text-ink-400">{label}</dt>
      <dd className="mt-0.5 text-ink-100">{value}</dd>
    </div>
  )
}
