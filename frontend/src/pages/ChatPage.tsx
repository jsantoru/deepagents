import { Network, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { useShell } from '@/App'
import {
  ActivityTrace,
  type EntityChip,
  type SearchResult,
  type TraceEntry,
} from '@/components/ActivityTrace'
import { AssistantMessage, UserMessage } from '@/components/ChatMessage'
import { Composer } from '@/components/Composer'
import {
  RunPanel,
  type MemoryDelta,
  type Phase,
  type RunMetrics,
} from '@/components/RunPanel'
import {
  fetchSession,
  streamChat,
  type MessageOut,
  type ResearchMode,
  type RunOut,
  type TraceEvent,
} from '@/lib/api'

interface Turn {
  running: boolean
  phase: Phase
  entries: TraceEntry[]
  answer: string
  recall: EntityChip[]
  memory: MemoryDelta | null
  metrics: RunMetrics | null
}

const IDLE_TURN: Turn = {
  running: false,
  phase: 'idle',
  entries: [],
  answer: '',
  recall: [],
  memory: null,
  metrics: null,
}

const PHASE_LABELS: Record<Phase, string> = {
  idle: '',
  recalling: 'Recalling long-term memory…',
  researching: 'Researching…',
  synthesizing: 'Synthesizing answer…',
  memorizing: 'Updating knowledge graph…',
  done: 'Done',
}

export function ChatPage() {
  const { sessionId: routeSessionId } = useParams()
  const { refreshSessions } = useShell()

  const [messages, setMessages] = useState<MessageOut[]>([])
  const [runsById, setRunsById] = useState<Record<string, RunOut>>({})
  const [turn, setTurn] = useState<Turn>(IDLE_TURN)
  const sessionIdRef = useRef<string | null>(routeSessionId ?? null)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!routeSessionId) return
    fetchSession(routeSessionId)
      .then((detail) => {
        setMessages(detail.messages)
        setRunsById(Object.fromEntries(detail.runs.map((r) => [r.id, r])))
      })
      .catch(() => undefined)
  }, [routeSessionId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, turn.entries.length, turn.answer, turn.phase])

  const handleEvent = useCallback(
    (event: TraceEvent) => {
      setTurn((prev) => {
        const next = { ...prev, entries: [...prev.entries] }
        const meta = event.metadata ?? {}

        switch (event.type) {
          case 'meta': {
            const sid = meta.session_id as string | undefined
            if (sid) sessionIdRef.current = sid
            break
          }
          case 'phase':
            next.phase = (meta.phase as Phase) ?? prev.phase
            break
          case 'recall': {
            const entities = (meta.entities as EntityChip[]) ?? []
            next.recall = entities
            next.entries.push({
              id: event.id,
              kind: 'recall',
              title: `Recalled ${entities.length} entities from memory`,
              content: '',
              entities,
            })
            break
          }
          case 'note':
            next.entries.push({
              id: event.id,
              kind: 'note',
              title: 'Reasoning',
              content: event.content,
            })
            break
          case 'note_delta': {
            const idx = next.entries.findIndex((e) => e.id === event.id)
            if (idx >= 0) {
              next.entries[idx] = {
                ...next.entries[idx],
                content: next.entries[idx].content + event.content,
              }
            }
            break
          }
          case 'tool': {
            let query = ''
            try {
              query = (JSON.parse(event.content) as { query?: string }).query ?? ''
            } catch {
              /* keep empty */
            }
            next.entries.push({
              id: event.id,
              kind: 'tool',
              title: event.title,
              content: '',
              query,
              pending: true,
            })
            break
          }
          case 'tool_result': {
            const idx = next.entries.findIndex((e) => e.id === event.id)
            const results = (meta.results as SearchResult[]) ?? []
            if (idx >= 0) {
              next.entries[idx] = { ...next.entries[idx], pending: false, results }
            }
            break
          }
          case 'tool_error':
            next.entries.push({
              id: event.id,
              kind: 'error',
              title: `Tool error: ${event.title}`,
              content: event.content,
            })
            break
          case 'final':
            next.answer = event.content
            next.metrics = {
              latency_ms: meta.latency_ms as number,
              search_calls: meta.search_calls as number,
              input_tokens: meta.input_tokens as number,
              output_tokens: meta.output_tokens as number,
              model: meta.model as string,
            }
            break
          case 'memory': {
            const memory: MemoryDelta = {
              added: (meta.added_entities as EntityChip[]) ?? [],
              reinforced: (meta.reinforced_entities as EntityChip[]) ?? [],
              addedRelations: (meta.added_relations as number) ?? 0,
              reinforcedRelations: (meta.reinforced_relations as number) ?? 0,
            }
            next.memory = memory
            next.entries.push({
              id: event.id,
              kind: 'memory',
              title: `Memory updated: +${memory.added.length} entities, +${memory.addedRelations} relations`,
              content: '',
              entities: memory.added,
            })
            break
          }
          case 'error':
            next.entries.push({
              id: event.id,
              kind: 'error',
              title: 'Run failed',
              content: event.content,
            })
            break
        }
        return next
      })
    },
    [],
  )

  const finishTurn = useCallback(() => {
    setTurn((prev) => {
      if (prev.answer) {
        setMessages((msgs) => [
          ...msgs,
          {
            id: `local-${Date.now()}`,
            role: 'assistant',
            content: prev.answer,
            run_id: null,
            created_at: new Date().toISOString(),
          },
        ])
      }
      return { ...prev, running: false, phase: prev.answer ? 'done' : prev.phase, entries: prev.entries, answer: '' }
    })
    if (sessionIdRef.current && !routeSessionId) {
      window.history.replaceState(null, '', `/s/${sessionIdRef.current}`)
    }
    refreshSessions()
  }, [refreshSessions, routeSessionId])

  const handleSend = useCallback(
    (message: string, mode: ResearchMode) => {
      setMessages((msgs) => [
        ...msgs,
        {
          id: `local-user-${Date.now()}`,
          role: 'user',
          content: message,
          run_id: null,
          created_at: new Date().toISOString(),
        },
      ])
      setTurn({ ...IDLE_TURN, running: true, phase: 'recalling' })
      const controller = new AbortController()
      abortRef.current = controller
      void streamChat(
        { message, session_id: sessionIdRef.current, research_mode: mode },
        {
          onEvent: handleEvent,
          onDone: finishTurn,
          onError: (error) => {
            handleEvent({
              id: 'stream-error',
              type: 'error',
              title: 'Connection error',
              content: error.message,
              metadata: {},
            })
            finishTurn()
          },
        },
        controller.signal,
      )
    },
    [handleEvent, finishTurn],
  )

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const empty = messages.length === 0 && !turn.running

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-ink-800 px-5">
          <span className="text-[13px] font-medium text-ink-300">
            {routeSessionId ? 'Research session' : 'New research'}
          </span>
          <Link
            to="/memory"
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink-300 transition-colors hover:bg-ink-850 hover:text-ink-100"
          >
            <Network className="size-3.5" />
            View memory
          </Link>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          {empty ? (
            <EmptyState />
          ) : (
            <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
              {messages.map((message) => (
                <div key={message.id}>
                  {message.role === 'user' ? (
                    <UserMessage content={message.content} />
                  ) : (
                    <div className="space-y-2">
                      <AssistantMessage content={message.content} />
                      {message.run_id && runsById[message.run_id] && (
                        <RunFooter run={runsById[message.run_id]} />
                      )}
                    </div>
                  )}
                </div>
              ))}

              {(turn.running || turn.entries.length > 0) && (
                <ActivityTrace
                  entries={turn.entries}
                  running={turn.running}
                  phaseLabel={PHASE_LABELS[turn.phase]}
                />
              )}
              {turn.running && turn.answer && <AssistantMessage content={turn.answer} />}
            </div>
          )}
        </div>

        <Composer running={turn.running} onSend={handleSend} onStop={handleStop} />
      </div>

      <RunPanel
        phase={turn.phase}
        running={turn.running}
        recall={turn.recall}
        memory={turn.memory}
        metrics={turn.metrics}
      />
    </div>
  )
}

function RunFooter({ run }: { run: RunOut }) {
  return (
    <p className="font-mono text-[11px] text-ink-400">
      {(run.latency_ms / 1000).toFixed(1)}s · {run.search_calls} searches · +{run.entities_added}{' '}
      entities · +{run.relations_added} relations
    </p>
  )
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl border border-ink-700 bg-ink-850">
        <Sparkles className="size-5 text-ink-200" />
      </div>
      <h1 className="text-lg font-semibold tracking-tight text-ink-50">
        What should we research?
      </h1>
      <p className="max-w-sm text-[13px] leading-relaxed text-ink-300">
        Cortex searches the web, cites its sources, and grows a knowledge graph that carries what
        it learns into every future session.
      </p>
    </div>
  )
}
