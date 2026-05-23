import { useState, type FormEvent } from 'react'
import {
  ArrowUpRight,
  Clock3,
  Coins,
  Search,
  Sigma,
  Bot,
  Wrench,
  Sparkles,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { type ChatMetrics, type ChatTraceEvent, sendChatMessage } from '@/lib/api'

type TranscriptMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  trace?: ChatTraceEvent[]
  metrics?: ChatMetrics
}

const starterPrompts = [
  'What changed in LangChain DeepAgents recently?',
  'Summarize the top AI agent framework releases this week.',
  'Compare Tavily with Brave Search for agentic research.',
]

export function ChatPage() {
  const [conversationId, setConversationId] = useState<string>()
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<TranscriptMessage[]>([])
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState<string>()

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const trimmedDraft = draft.trim()
    if (!trimmedDraft || isSending) {
      return
    }

    const optimisticMessage: TranscriptMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmedDraft,
    }

    setMessages((currentMessages) => [...currentMessages, optimisticMessage])
    setDraft('')
    setError(undefined)
    setIsSending(true)

    try {
      const response = await sendChatMessage(trimmedDraft, conversationId)
      setConversationId(response.conversation_id)
      setMessages((currentMessages) => [
        ...currentMessages,
        {
          id: response.run_id,
          role: 'assistant',
          content: response.answer,
          trace: response.trace,
          metrics: response.metrics,
        },
      ])
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unknown request failure.')
    } finally {
      setIsSending(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <Card className="overflow-hidden border-black/10 bg-white/75 shadow-[0_24px_80px_rgba(69,57,34,0.08)] backdrop-blur">
        <CardHeader className="border-b border-black/5 pb-5">
          <Badge className="w-fit rounded-full bg-emerald-200/80 px-3 py-1 text-emerald-950">
            Python agent + Tavily search
          </Badge>
          <CardTitle className="max-w-3xl text-4xl tracking-tight text-stone-950">
            Start with a focused research chat, then grow it into a deeper multi-step agent.
          </CardTitle>
          <p className="max-w-2xl text-sm leading-6 text-stone-600">
            The backend already persists runs, token usage, latency, estimated cost, and search
            counts. This screen is the first operator-facing surface over that stack.
          </p>
        </CardHeader>
        <CardContent className="space-y-5 p-5">
          <div className="grid gap-3 md:grid-cols-3">
            {starterPrompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="rounded-3xl border border-black/10 bg-stone-950 px-4 py-4 text-left text-sm text-stone-50 transition hover:-translate-y-0.5 hover:bg-stone-800"
                onClick={() => setDraft(prompt)}
              >
                <div className="mb-3 flex items-center justify-between">
                  <Search className="h-4 w-4" />
                  <ArrowUpRight className="h-4 w-4 text-stone-400" />
                </div>
                {prompt}
              </button>
            ))}
          </div>

          <Separator />

          <div className="space-y-4">
            {messages.length === 0 ? (
              <div className="rounded-[28px] border border-dashed border-black/15 bg-stone-50 p-10 text-sm text-stone-500">
                Ask a question that benefits from web search. The first response will create a
                tracked conversation and store its metrics in Postgres.
              </div>
            ) : (
              messages.map((message) => (
                <article
                  key={message.id}
                  className={[
                    'rounded-[28px] border p-5 shadow-sm',
                    message.role === 'user'
                      ? 'ml-auto max-w-2xl border-stone-950 bg-stone-950 text-stone-50'
                      : 'max-w-3xl border-black/10 bg-white',
                  ].join(' ')}
                >
                  <div className="mb-2 text-xs uppercase tracking-[0.28em] text-current/60">
                    {message.role === 'user' ? 'You' : 'Agent'}
                  </div>
                  <p className="whitespace-pre-wrap text-sm leading-7">{message.content}</p>
                  {message.trace?.length ? <TraceTimeline trace={message.trace} /> : null}
                  {message.metrics ? <RunMetrics metrics={message.metrics} /> : null}
                </article>
              ))
            )}

            {isSending ? (
              <div className="space-y-3 rounded-[28px] border border-black/10 bg-white p-5">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
              </div>
            ) : null}
          </div>

          <form className="space-y-3" onSubmit={handleSubmit}>
            <Textarea
              aria-label="Message"
              className="min-h-32 rounded-[28px] border-black/10 bg-white/90 px-5 py-4 text-base shadow-none"
              placeholder="Ask the research agent a question..."
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm text-red-600">{error}</div>
              <Button
                className="rounded-full bg-stone-950 px-6 hover:bg-stone-800"
                disabled={isSending || !draft.trim()}
                type="submit"
              >
                {isSending ? 'Thinking...' : 'Send prompt'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

function TraceTimeline({ trace }: { trace: ChatTraceEvent[] }) {
  return (
    <div className="mt-5 space-y-3 border-t border-current/10 pt-4">
      <div className="text-xs uppercase tracking-[0.24em] text-current/60">Run trace</div>
      {trace.map((event, index) => {
        const Icon = getTraceIcon(event.type)
        return (
          <div
            key={`${event.type}-${index}-${event.title}`}
            className="rounded-3xl border border-current/10 bg-black/3 px-4 py-4"
          >
            <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-current/60">
              <Icon className="h-3.5 w-3.5" />
              {event.title}
            </div>
            <p className="whitespace-pre-wrap text-sm leading-6">{event.content}</p>
            {Object.keys(event.metadata).length ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {Object.entries(event.metadata).map(([key, value]) => (
                  <Badge
                    key={key}
                    className="rounded-full border border-current/10 bg-transparent px-3 py-1 text-[11px] tracking-[0.18em] text-current/70"
                    variant="outline"
                  >
                    {key}: {String(value)}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function getTraceIcon(type: string) {
  switch (type) {
    case 'tool':
      return Wrench
    case 'final':
      return Sparkles
    default:
      return Bot
  }
}

function RunMetrics({ metrics }: { metrics: ChatMetrics }) {
  const items = [
    {
      icon: Sigma,
      label: 'Tokens',
      value: metrics.total_tokens.toLocaleString(),
    },
    {
      icon: Clock3,
      label: 'Latency',
      value: `${metrics.latency_ms} ms`,
    },
    {
      icon: Coins,
      label: 'Est. cost',
      value: `$${metrics.estimated_cost_usd.toFixed(5)}`,
    },
  ]

  return (
    <div className="mt-5 grid gap-2 border-t border-current/10 pt-4 sm:grid-cols-3">
      {items.map(({ icon: Icon, label, value }) => (
        <div
          key={label}
          className="rounded-2xl border border-current/10 bg-black/3 px-3 py-3 text-xs uppercase tracking-[0.18em]"
        >
          <div className="mb-2 flex items-center gap-2 text-current/60">
            <Icon className="h-3.5 w-3.5" />
            {label}
          </div>
          <div className="text-sm tracking-normal">{value}</div>
        </div>
      ))}
    </div>
  )
}
