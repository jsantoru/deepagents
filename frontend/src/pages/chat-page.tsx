import { useState, type FormEvent } from 'react'
import {
  ArrowUpRight,
  Clock3,
  Coins,
  ExternalLink,
  Search,
  Sigma,
  Bot,
  Wrench,
  Sparkles,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { type ChatMetrics, type ChatTraceEvent, streamChatMessage } from '@/lib/api'

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
    const pendingAssistantId = crypto.randomUUID()
    const pendingAssistant: TranscriptMessage = {
      id: pendingAssistantId,
      role: 'assistant',
      content: '',
      trace: [],
    }

    setMessages((currentMessages) => [...currentMessages, optimisticMessage, pendingAssistant])
    setDraft('')
    setError(undefined)
    setIsSending(true)

    try {
      const response = await streamChatMessage(trimmedDraft, conversationId, {
        onTrace: (event) => {
          setMessages((currentMessages) =>
            currentMessages.map((message) =>
              message.id === pendingAssistantId
                ? {
                    ...message,
                    content: updateAssistantContent(message.content, event),
                    trace: applyTraceEvent(message.trace ?? [], event),
                  }
                : message,
            ),
          )
        },
        onFinal: (finalResponse) => {
          setConversationId(finalResponse.conversation_id)
          setMessages((currentMessages) =>
            currentMessages.map((message) =>
              message.id === pendingAssistantId
                ? {
                    id: finalResponse.run_id,
                    role: 'assistant',
                    content: finalResponse.answer,
                    trace: mergeFinalTrace(message.trace ?? [], finalResponse.trace),
                    metrics: finalResponse.metrics,
                  }
                : message,
            ),
          )
        },
      })
      setConversationId(response.conversation_id)
    } catch (requestError) {
      setMessages((currentMessages) =>
        currentMessages.filter((message) => message.id !== pendingAssistantId),
      )
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
                  <MessageBody message={message} />
                  {message.trace?.length ? <TraceTimeline trace={message.trace} /> : null}
                  {message.metrics ? <RunMetrics metrics={message.metrics} /> : null}
                </article>
              ))
            )}

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

function MessageBody({ message }: { message: TranscriptMessage }) {
  if (message.role === 'assistant' && message.trace?.length) {
    return null
  }

  if (!message.content.trim()) {
    if (message.role === 'assistant') {
      return (
        <p className="text-sm italic leading-7 text-stone-500">
          Working through the request...
        </p>
      )
    }

    return null
  }

  if (message.role === 'assistant') {
    return (
      <div className="prose prose-sm max-w-none whitespace-pre-wrap prose-headings:mt-4 prose-headings:text-stone-950 prose-p:leading-7 prose-li:leading-7 prose-strong:text-stone-950 prose-code:rounded prose-code:bg-stone-100 prose-code:px-1 prose-code:py-0.5 prose-pre:bg-stone-950 prose-pre:text-stone-50">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
      </div>
    )
  }

  return <p className="whitespace-pre-wrap text-sm leading-7">{message.content}</p>
}

function TraceTimeline({ trace }: { trace: ChatTraceEvent[] }) {
  const orderedTrace = orderTraceEvents(trace)

  return (
    <div className="mt-5 space-y-3 border-t border-current/10 pt-4">
      <div className="text-xs uppercase tracking-[0.24em] text-current/60">Run trace</div>
      {orderedTrace.map((event, index) => {
        const Icon = getTraceIcon(event.type)
        const display = formatTraceEvent(event)
        return (
          <div
            key={`${event.type}-${index}-${event.title}`}
            className="rounded-3xl border border-current/10 bg-black/3 px-4 py-4"
          >
            <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-current/60">
              <Icon className="h-3.5 w-3.5" />
              {display.title}
            </div>
            {display.summary ? <TraceSummary event={event} summary={display.summary} /> : null}
            {display.bullets.length ? (
              <div className="mt-3 space-y-2">
                {display.bullets.map((bullet) => (
                  <div
                    key={bullet}
                    className="rounded-2xl border border-current/10 bg-white/40 px-3 py-2 text-sm leading-6"
                  >
                    {bullet}
                  </div>
                ))}
              </div>
            ) : null}
            {display.links.length ? (
              <div className="mt-3 space-y-2">
                {display.links.map((link) => (
                  <a
                    key={link.url}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2 rounded-2xl border border-current/10 bg-white/30 px-3 py-2 text-sm leading-6 hover:bg-white/50"
                  >
                    <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{link.label}</span>
                  </a>
                ))}
              </div>
            ) : null}
            {!display.summary && !display.bullets.length && !display.links.length ? (
              <TraceSummary event={event} summary={event.content} />
            ) : null}
            {Object.keys(display.metadata).length ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {Object.entries(display.metadata).map(([key, value]) => (
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

function TraceSummary({ event, summary }: { event: ChatTraceEvent; summary: string }) {
  if (event.type === 'final') {
    return (
      <div className="prose prose-sm max-w-none whitespace-pre-wrap prose-headings:mt-4 prose-headings:text-stone-950 prose-p:leading-7 prose-li:leading-7 prose-strong:text-stone-950 prose-code:rounded prose-code:bg-stone-100 prose-code:px-1 prose-code:py-0.5 prose-pre:bg-stone-950 prose-pre:text-stone-50">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown>
      </div>
    )
  }

  return <p className="whitespace-pre-wrap text-sm leading-6">{summary}</p>
}

function getTraceIcon(type: string) {
  switch (type) {
    case 'tool':
    case 'tool_result':
    case 'tool_delta':
    case 'tool_error':
      return Wrench
    case 'final':
      return Sparkles
    default:
      return Bot
  }
}

type TraceDisplay = {
  title: string
  summary: string
  bullets: string[]
  links: Array<{ label: string; url: string }>
  metadata: Record<string, string | number>
}

function formatTraceEvent(event: ChatTraceEvent): TraceDisplay {
  if (event.type === 'assistant' || event.type === 'assistant_delta') {
    const normalizedContent = unwrapStructuredToolContent(event.content)
    const parsed = tryParseJson(normalizedContent)
    if (Array.isArray(parsed)) {
      const toolCalls = parsed.filter(isFunctionCallRecord)
      const reasoningSteps = parsed.filter(
        (item) => isRecord(item) && item.type === 'reasoning',
      )
      if (toolCalls.length || reasoningSteps.length) {
        return {
          title: toolCalls.length ? 'Planning next steps' : 'Reasoning',
          summary:
            toolCalls.length > 0
              ? `Preparing ${toolCalls.length} web search${toolCalls.length > 1 ? 'es' : ''}.`
              : 'Reasoning through the next step.',
          bullets: toolCalls.map((call) => {
            const args = tryParseJson(String(call.arguments))
            const query = isRecord(args) && typeof args.query === 'string' ? args.query : 'Search'
            return `Search: ${query}`
          }),
          links: [],
          metadata:
            reasoningSteps.length > 0 ? { reasoning_steps: reasoningSteps.length } : {},
        }
      }
    }

    if (looksLikeJsonFragment(normalizedContent)) {
      return {
        title: 'Reasoning',
        summary: 'Reasoning through the next step.',
        bullets: extractSearchQueriesFromJsonText(normalizedContent).map((query) => `Search: ${query}`),
        links: [],
        metadata: event.metadata,
      }
    }
  }

  if (event.type === 'tool' || event.type === 'tool_result' || event.type === 'tool_delta') {
    const normalizedContent = unwrapStructuredToolContent(event.content)
    const parsed = tryParseJson(normalizedContent)
    if (isRecord(parsed)) {
      if ('query' in parsed && Array.isArray(parsed.results)) {
        const bullets = parsed.results
          .slice(0, 3)
          .map((result) => {
            if (!isRecord(result)) {
              return null
            }
            const title = typeof result.title === 'string' ? result.title : 'Untitled result'
            const snippet =
              typeof result.content === 'string' ? compactText(result.content, 120) : ''
            return snippet ? `${title}: ${snippet}` : title
          })
          .filter((value): value is string => Boolean(value))

        const links = parsed.results
          .slice(0, 3)
          .map((result) => {
            if (!isRecord(result) || typeof result.url !== 'string') {
              return null
            }
            return {
              label:
                typeof result.title === 'string' && result.title.trim()
                  ? result.title
                  : result.url,
              url: result.url,
            }
          })
          .filter((value): value is { label: string; url: string } => Boolean(value))

        const domains = Array.from(
          new Set(
            links
              .map((link) => {
                try {
                  return new URL(link.url).hostname.replace(/^www\./, '')
                } catch {
                  return null
                }
              })
              .filter((value): value is string => Boolean(value)),
          ),
        )

        return {
          title:
            event.type === 'tool'
              ? 'Searching the web'
              : event.type === 'tool_result'
                ? 'Search results'
                : event.title,
          summary:
            typeof parsed.query === 'string'
              ? `Query: ${parsed.query}`
              : `${parsed.results.length} search results returned.`,
          bullets,
          links,
          metadata: {
            ...(typeof parsed.response_time === 'number'
              ? { response_time_s: parsed.response_time }
              : {}),
            ...(typeof parsed.results.length === 'number'
              ? { results: parsed.results.length }
              : {}),
            ...(domains.length ? { sources: domains.slice(0, 3).join(', ') } : {}),
          },
        }
      }

      if ('query' in parsed) {
        return {
          title: 'Preparing web search',
          summary:
            typeof parsed.query === 'string' ? `Query: ${parsed.query}` : 'Preparing search.',
          bullets: [],
          links: [],
          metadata: event.metadata,
        }
      }
    }

    if (looksLikeJsonFragment(normalizedContent)) {
      const queries = extractSearchQueriesFromJsonText(normalizedContent)
      return {
        title: event.type === 'tool_result' ? 'Search results' : 'Searching the web',
        summary:
          queries[0]
            ? `Query: ${queries[0]}`
            : event.type === 'tool_result'
              ? 'Search results received.'
              : 'Receiving search results...',
        bullets: [],
        links: [],
        metadata: event.metadata,
      }
    }
  }

  return {
    title: event.title,
    summary: event.content,
    bullets: [],
    links: [],
    metadata: event.metadata,
  }
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFunctionCallRecord(
  value: unknown,
): value is Record<'arguments' | 'name', string> & Record<string, unknown> {
  return isRecord(value) && value.type === 'function_call' && typeof value.arguments === 'string'
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) {
    return normalized
  }
  return `${normalized.slice(0, maxLength - 1)}...`
}

function looksLikeJsonFragment(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.includes('"query"')
}

function extractSearchQueriesFromJsonText(value: string): string[] {
  return Array.from(value.matchAll(/"query"\s*:\s*"([^"]+)"/g), (match) => match[1])
}

function extractPrimaryQuery(value: string): string | undefined {
  const normalizedContent = unwrapStructuredToolContent(value)
  const parsed = tryParseJson(normalizedContent)
  if (isRecord(parsed) && typeof parsed.query === 'string') {
    return parsed.query
  }

  return extractSearchQueriesFromJsonText(normalizedContent)[0]
}

function unwrapStructuredToolContent(value: string): string {
  const singleQuotedMatch = value.match(/content='([\s\S]*?)'\s+(?:name|tool_call_id)=/)
  if (singleQuotedMatch) {
    return singleQuotedMatch[1]
  }

  const doubleQuotedMatch = value.match(/content="([\s\S]*?)"\s+(?:name|tool_call_id)=/)
  if (doubleQuotedMatch) {
    return doubleQuotedMatch[1]
  }

  return value
}

function applyTraceEvent(trace: ChatTraceEvent[], incomingEvent: ChatTraceEvent): ChatTraceEvent[] {
  const eventIndex = trace.findIndex((event) => event.id === incomingEvent.id)
  if (eventIndex === -1) {
    return [...trace, incomingEvent]
  }

  const currentEvent = trace[eventIndex]
  const updatedEvent =
    incomingEvent.type === 'assistant_delta' || incomingEvent.type === 'tool_delta'
      ? {
          ...currentEvent,
          content: `${currentEvent.content}${incomingEvent.content}`,
        }
      : incomingEvent

  return trace.map((event, index) => (index === eventIndex ? updatedEvent : event))
}

function mergeFinalTrace(
  streamedTrace: ChatTraceEvent[],
  finalTrace: ChatTraceEvent[],
): ChatTraceEvent[] {
  const mergedTrace = [...streamedTrace]

  for (const finalEvent of finalTrace) {
    const existingIndex = mergedTrace.findIndex((event) => shouldMergeTraceEvent(event, finalEvent))
    if (existingIndex === -1) {
      mergedTrace.push(finalEvent)
      continue
    }

    mergedTrace[existingIndex] = {
      ...mergedTrace[existingIndex],
      ...finalEvent,
    }
  }

  return mergedTrace
}

function orderTraceEvents(trace: ChatTraceEvent[]): ChatTraceEvent[] {
  const nonFinalEvents = trace.filter((event) => event.type !== 'final')
  const finalEvents = trace.filter((event) => event.type === 'final')
  return [...nonFinalEvents, ...finalEvents]
}

function shouldMergeTraceEvent(currentEvent: ChatTraceEvent, incomingEvent: ChatTraceEvent): boolean {
  if (currentEvent.id === incomingEvent.id) {
    return true
  }

  if (
    isToolTraceType(currentEvent.type) &&
    isToolTraceType(incomingEvent.type) &&
    currentEvent.metadata.tool_name === incomingEvent.metadata.tool_name
  ) {
    const currentQuery = extractPrimaryQuery(currentEvent.content)
    const incomingQuery = extractPrimaryQuery(incomingEvent.content)
    if (currentQuery && incomingQuery && currentQuery === incomingQuery) {
      return true
    }
  }

  if (
    currentEvent.type === incomingEvent.type &&
    currentEvent.title === incomingEvent.title &&
    currentEvent.content === incomingEvent.content
  ) {
    return true
  }

  return false
}

function isToolTraceType(type: string): boolean {
  return type === 'tool' || type === 'tool_delta' || type === 'tool_result' || type === 'tool_error'
}

function updateAssistantContent(content: string, event: ChatTraceEvent): string {
  if (event.type === 'final') {
    return content ? `${content}${event.content}` : event.content
  }

  return content
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
