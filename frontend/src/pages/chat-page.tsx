import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  AlertCircle,
  ArrowUp,
  Bot,
  Clock3,
  Coins,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Globe,
  LoaderCircle,
  Mic,
  Monitor,
  Plus,
  Search,
  Sigma,
  Sparkles,
  Square,
  Wrench,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
  {
    icon: Search,
    text: 'Review my recent commits for correctness risks and maintainability concerns',
  },
  {
    icon: GitBranch,
    text: 'Unblock my most recent open PR',
  },
  {
    icon: Sparkles,
    text: 'Connect your favorite apps to Codex',
  },
]

const chromeItems = [
  { icon: FolderGit2, label: 'deepagents' },
  { icon: Monitor, label: 'Work locally' },
  { icon: GitBranch, label: 'main' },
]

export function ChatPage() {
  const [conversationId, setConversationId] = useState<string>()
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<TranscriptMessage[]>([])
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState<string>()
  const [lastSubmittedPrompt, setLastSubmittedPrompt] = useState('')
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null)

  const hasMessages = messages.length > 0
  const isComposerDocked = hasMessages || isSending

  useEffect(() => {
    if (isComposerDocked && typeof bottomAnchorRef.current?.scrollIntoView === 'function') {
      bottomAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [isComposerDocked, messages.length])

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
    setLastSubmittedPrompt(trimmedDraft)
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
    <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 pb-6 pt-10 sm:px-6">
      <div
        className={[
          'transition-all duration-300',
          isComposerDocked ? 'flex-1 pb-56' : 'flex flex-1 flex-col justify-center pb-16',
        ].join(' ')}
      >
        {!isComposerDocked ? (
          <section className="mx-auto w-full max-w-5xl">
            <h1 className="mb-10 text-center text-4xl font-medium tracking-tight text-stone-900 sm:text-5xl">
              What should we build in deepagents?
            </h1>
            <PromptComposer
              draft={draft}
              error={error}
              isDocked={false}
              isSending={isSending}
              lastSubmittedPrompt={lastSubmittedPrompt}
              onChange={setDraft}
              onSubmit={handleSubmit}
            />
            <div className="mt-6">
              {starterPrompts.map(({ icon: Icon, text }) => (
                <button
                  key={text}
                  type="button"
                  className="flex w-full items-center gap-3 border-t border-stone-200/90 py-5 text-left text-lg text-stone-500 transition hover:text-stone-900"
                  onClick={() => setDraft(text)}
                >
                  <Icon className="h-5 w-5 text-stone-400" />
                  <span>{text}</span>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <section className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6">
            <ConversationMessages messages={messages} />
            <div ref={bottomAnchorRef} />
          </section>
        )}
      </div>

      {isComposerDocked ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-4 pb-4 sm:px-6">
          <div className="mx-auto w-full max-w-5xl rounded-[32px] bg-[linear-gradient(180deg,rgba(249,249,247,0),rgba(249,249,247,0.94)_24%,rgba(249,249,247,0.98)_100%)] pt-8">
            <div className="pointer-events-auto">
              <PromptComposer
                draft={draft}
                error={error}
                isDocked
                isSending={isSending}
                lastSubmittedPrompt={lastSubmittedPrompt}
                onChange={setDraft}
                onSubmit={handleSubmit}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

type PromptComposerProps = {
  draft: string
  error?: string
  isDocked: boolean
  isSending: boolean
  lastSubmittedPrompt: string
  onChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

function PromptComposer({
  draft,
  error,
  isDocked,
  isSending,
  lastSubmittedPrompt,
  onChange,
  onSubmit,
}: PromptComposerProps) {
  const disabled = isSending
  const placeholder = isDocked ? 'Ask for follow-up changes' : 'Message Codex'

  return (
    <form className="space-y-3" onSubmit={onSubmit}>
      <div className="overflow-hidden rounded-[30px] border border-stone-300 bg-white shadow-[0_8px_28px_rgba(15,23,42,0.08)]">
        <Textarea
          aria-label="Message"
          className="min-h-[128px] resize-none border-0 bg-transparent px-5 py-4 text-[1.05rem] leading-8 text-stone-900 shadow-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:bg-transparent disabled:text-stone-400 disabled:opacity-100"
          disabled={disabled}
          placeholder={placeholder}
          value={disabled ? '' : draft}
          onChange={(event) => onChange(event.target.value)}
        />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 px-4 py-3">
          <div className="flex flex-wrap items-center gap-3 text-sm text-stone-500">
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-500 transition hover:bg-stone-100 hover:text-stone-900"
            >
              <Plus className="h-5 w-5" />
            </button>
            <div className="inline-flex items-center gap-2 text-orange-600">
              <AlertCircle className="h-4 w-4" />
              <span>Full access</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm text-stone-500">
            {isSending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
            <div className="inline-flex items-center gap-1">
              <span>GPT-5.4</span>
            </div>
            <div className="inline-flex items-center gap-1">
              <span>Medium</span>
            </div>
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-500 transition hover:bg-stone-100 hover:text-stone-900"
            >
              <Mic className="h-4 w-4" />
            </button>
            <Button
              aria-label={isSending ? 'Processing request' : 'Send prompt'}
              className="h-12 w-12 rounded-full bg-stone-950 p-0 hover:bg-stone-800 disabled:bg-stone-950/90 disabled:opacity-100"
              disabled={!isSending && !draft.trim()}
              type="submit"
            >
              {isSending ? <Square className="h-4 w-4 fill-current" /> : <ArrowUp className="h-5 w-5" />}
            </Button>
          </div>
        </div>
      </div>

      <div className="rounded-[0_0_26px_26px] bg-stone-100/95 px-5 py-3 text-sm text-stone-500 shadow-[0_10px_24px_rgba(15,23,42,0.04)]">
        <div className="flex flex-wrap items-center gap-5">
          {chromeItems.map(({ icon: Icon, label }) => (
            <div key={label} className="inline-flex items-center gap-2">
              <Icon className="h-4 w-4 text-stone-400" />
              <span>{label}</span>
            </div>
          ))}
        </div>
      </div>

      {error ? <div className="text-sm text-red-600">{error}</div> : null}
      {isSending && lastSubmittedPrompt ? (
        <div className="text-sm text-stone-500">Processing: {lastSubmittedPrompt}</div>
      ) : null}
    </form>
  )
}

function ConversationMessages({ messages }: { messages: TranscriptMessage[] }) {
  return (
    <div className="space-y-4">
      {messages.map((message) => (
        <article
          key={message.id}
          className={[
            'rounded-[28px] border p-5 shadow-sm',
            message.role === 'user'
              ? 'ml-auto max-w-3xl border-stone-950 bg-stone-950 text-stone-50'
              : 'max-w-4xl border-stone-200 bg-white/92 text-stone-900',
          ].join(' ')}
        >
          <div className="mb-2 text-xs uppercase tracking-[0.28em] text-current/60">
            {message.role === 'user' ? 'You' : 'Codex'}
          </div>
          <MessageBody message={message} />
          {message.trace?.length ? <TraceTimeline trace={message.trace} /> : null}
          {message.metrics ? <RunMetrics metrics={message.metrics} /> : null}
        </article>
      ))}
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
        if (!display) {
          return null
        }
        return (
          <div
            key={`${event.type}-${index}-${event.title}`}
            className="rounded-3xl border border-current/10 bg-black/3 px-4 py-4"
          >
            <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-current/60">
              <Icon className="h-3.5 w-3.5" />
              {display.title}
            </div>
            {display.summary ? (
              <TraceSummary
                animatePulse={display.animatePulse}
                event={event}
                summary={display.summary}
              />
            ) : null}
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
            {Object.keys(filterDisplayMetadata(display.metadata)).length ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {Object.entries(filterDisplayMetadata(display.metadata)).map(([key, value]) => (
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

function TraceSummary({
  animatePulse = false,
  event,
  summary,
}: {
  animatePulse?: boolean
  event: ChatTraceEvent
  summary: string
}) {
  if (event.type === 'final') {
    return (
      <div className="prose prose-sm max-w-none whitespace-pre-wrap prose-headings:mt-4 prose-headings:text-stone-950 prose-p:leading-7 prose-li:leading-7 prose-strong:text-stone-950 prose-code:rounded prose-code:bg-stone-100 prose-code:px-1 prose-code:py-0.5 prose-pre:bg-stone-950 prose-pre:text-stone-50">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown>
      </div>
    )
  }

  return (
    <p
      className={[
        'whitespace-pre-wrap text-sm leading-6',
        animatePulse ? 'animate-pulse text-current/70' : '',
      ].join(' ')}
    >
      {summary}
    </p>
  )
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
  animatePulse?: boolean
}

function formatTraceEvent(event: ChatTraceEvent): TraceDisplay | null {
  const resolvedToolName = resolveToolName(event)

  if (event.type === 'assistant' || event.type === 'assistant_delta') {
    const normalizedContent = normalizeStructuredPayloadText(
      unwrapStructuredToolContent(event.content),
    )
    const parsed = tryParseJson(normalizedContent)
    if (Array.isArray(parsed)) {
      const toolCalls = parsed.filter(isFunctionCallRecord)
      const reasoningSteps = parsed.filter(
        (item) => isRecord(item) && item.type === 'reasoning',
      )
      if (toolCalls.length || reasoningSteps.length) {
        const reasoningSummary = extractReasoningSummary(reasoningSteps)
        if (!toolCalls.length && !reasoningSummary) {
          return {
            title: 'Thinking',
            summary: 'Thinking...',
            bullets: [],
            links: [],
            metadata: {},
            animatePulse: true,
          }
        }
        return {
          title: toolCalls.length ? 'Planning next steps' : 'Reasoning',
          summary:
            toolCalls.length > 0
              ? `Preparing ${toolCalls.length} web search${toolCalls.length > 1 ? 'es' : ''}.`
              : reasoningSummary,
          bullets: toolCalls.map((call) => {
            const args = tryParseJson(String(call.arguments))
            const query = isRecord(args) && typeof args.query === 'string' ? args.query : 'Search'
            return `Search: ${query}`
          }),
          links: [],
          metadata:
            reasoningSummary && reasoningSteps.length > 0
              ? { reasoning_steps: reasoningSteps.length }
              : {},
          animatePulse: false,
        }
      }
    }

    if (looksLikeJsonFragment(normalizedContent)) {
      const queries = extractSearchQueriesFromJsonText(normalizedContent)
      if (queries.length > 0) {
        return {
          title: 'Planning next steps',
          summary: `Preparing ${queries.length} web search${queries.length > 1 ? 'es' : ''}.`,
          bullets: queries.map((query) => `Search: ${query}`),
          links: [],
          metadata: event.metadata,
          animatePulse: false,
        }
      }
    }

    return null
  }

  if (event.type === 'tool' || event.type === 'tool_result' || event.type === 'tool_delta') {
    const normalizedContent = normalizeStructuredPayloadText(
      unwrapStructuredToolContent(event.content),
    )
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
          title: resolveToolTitle(event, resolvedToolName),
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
          animatePulse: false,
        }
      }

      if ('query' in parsed) {
        return {
          title: resolveToolTitle(event, resolvedToolName),
          summary:
            typeof parsed.query === 'string' ? `Query: ${parsed.query}` : 'Preparing search.',
          bullets: [],
          links: [],
          metadata: withResolvedToolName(event.metadata, resolvedToolName),
          animatePulse: event.type !== 'tool_result',
        }
      }
    }

    if (looksLikeJsonFragment(normalizedContent)) {
      const queries = extractSearchQueriesFromJsonText(normalizedContent)
      return {
        title: resolveToolTitle(event, resolvedToolName),
        summary:
          queries[0]
            ? `Query: ${queries[0]}`
            : event.type === 'tool_result'
              ? 'Search results received.'
              : 'Receiving search results...',
        bullets: [],
        links: [],
        metadata: withResolvedToolName(event.metadata, resolvedToolName),
        animatePulse: event.type !== 'tool_result',
      }
    }
  }

  return {
    title: event.title,
    summary: event.content,
    bullets: [],
    links: [],
    metadata: event.metadata,
    animatePulse: false,
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

function extractReasoningSummary(reasoningSteps: unknown[]): string {
  const summaries: string[] = []

  for (const step of reasoningSteps) {
    if (!isRecord(step) || !Array.isArray(step.summary)) {
      continue
    }

    for (const summaryItem of step.summary) {
      if (typeof summaryItem === 'string' && summaryItem.trim()) {
        summaries.push(summaryItem.trim())
        continue
      }

      if (isRecord(summaryItem) && typeof summaryItem.text === 'string' && summaryItem.text.trim()) {
        summaries.push(summaryItem.text.trim())
      }
    }
  }

  return summaries.join(' ')
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) {
    return normalized
  }
  return `${normalized.slice(0, maxLength - 1)}...`
}

function filterDisplayMetadata(
  metadata: Record<string, string | number>,
): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key, value]) => {
      if (key === 'tool_name' && value === 'tool') {
        return false
      }

      return true
    }),
  )
}

function resolveToolName(event: ChatTraceEvent): string | undefined {
  const metadataToolName = typeof event.metadata.tool_name === 'string' ? event.metadata.tool_name : undefined
  if (metadataToolName && metadataToolName !== 'tool') {
    return metadataToolName
  }

  return extractWrappedToolName(event.content)
}

function extractWrappedToolName(value: string): string | undefined {
  const singleQuotedMatch = value.match(/\sname='([^']+)'/)
  if (singleQuotedMatch?.[1]) {
    return singleQuotedMatch[1]
  }

  const doubleQuotedMatch = value.match(/\sname="([^"]+)"/)
  if (doubleQuotedMatch?.[1]) {
    return doubleQuotedMatch[1]
  }

  return undefined
}

function resolveToolTitle(event: ChatTraceEvent, toolName?: string): string {
  if (event.type === 'tool_result') {
    return toolName ? `Search results: ${toolName}` : 'Search results'
  }

  if (event.type === 'tool') {
    return toolName ? `Using tool: ${toolName}` : 'Searching the web'
  }

  if (event.type === 'tool_delta') {
    return toolName ? `Using tool: ${toolName}` : 'Searching the web'
  }

  if (event.type === 'tool_error') {
    return toolName ? `Tool error: ${toolName}` : 'Tool error'
  }

  return event.title
}

function withResolvedToolName(
  metadata: Record<string, string | number>,
  toolName?: string,
): Record<string, string | number> {
  if (!toolName) {
    return metadata
  }

  return {
    ...metadata,
    tool_name: toolName,
  }
}

function looksLikeJsonFragment(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.includes('"query"')
}

function extractSearchQueriesFromJsonText(value: string): string[] {
  return Array.from(value.matchAll(/"query"\s*:\s*"([^"]+)"/g), (match) => match[1])
}

function extractPrimaryQuery(value: string): string | undefined {
  const normalizedContent = normalizeStructuredPayloadText(unwrapStructuredToolContent(value))
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

function normalizeStructuredPayloadText(value: string): string {
  return value
    .replace(/^\s*\d+\t/, '')
    .replace(/(?:\r?\n)\s*\d+\t/g, '\n')
    .trim()
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
    {
      icon: Globe,
      label: 'Input',
      value: metrics.input_tokens.toLocaleString(),
    },
  ]

  return (
    <div className="mt-5 grid gap-2 border-t border-current/10 pt-4 sm:grid-cols-2 lg:grid-cols-4">
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
