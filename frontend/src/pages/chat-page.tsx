import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  AlertCircle,
  ArrowUp,
  Bot,
  ChartColumnBig,
  Clock3,
  Coins,
  ExternalLink,
  FolderOpen,
  Globe,
  LibraryBig,
  LoaderCircle,
  MessageSquarePlus,
  Mic,
  PanelsTopLeft,
  Plus,
  ScrollText,
  Search,
  Sigma,
  Sparkles,
  Square,
  Wrench,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { NavLink } from 'react-router-dom'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  type ChatMetrics,
  type ChatTraceEvent,
  fetchConversationDetail,
  fetchConversationSummaries,
  type ConversationSummary,
  type ResearchMode,
  streamChatMessage,
} from '@/lib/api'

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
    text: 'Compare the latest US inflation, unemployment, and wage growth trends and explain where they conflict',
  },
  {
    icon: Globe,
    text: 'Research the current competitive landscape for AI coding agents and summarize the top vendors',
  },
  {
    icon: Sparkles,
    text: 'Build a source-backed brief on whether nuclear energy capacity is growing or shrinking globally',
  },
]

const chromeItems = [
  { icon: LibraryBig, label: 'Deep research' },
  { icon: Globe, label: 'Web sources' },
  { icon: ScrollText, label: 'Citations ready' },
]

export function ChatPage() {
  const [conversationId, setConversationId] = useState<string>()
  const [conversationTitle, setConversationTitle] = useState('New chat')
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<TranscriptMessage[]>([])
  const [sessions, setSessions] = useState<ConversationSummary[]>([])
  const [isLoadingSessions, setIsLoadingSessions] = useState(true)
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState<string>()
  const [lastSubmittedPrompt, setLastSubmittedPrompt] = useState('')
  const [researchMode, setResearchMode] = useState<ResearchMode>('standard')
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null)

  const hasMessages = messages.length > 0
  const isComposerDocked = hasMessages || isSending

  useEffect(() => {
    if (isComposerDocked && typeof bottomAnchorRef.current?.scrollIntoView === 'function') {
      bottomAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [isComposerDocked, messages.length])

  useEffect(() => {
    void loadConversationSummaries()
  }, [])

  async function loadConversationSummaries(selectedId?: string) {
    setIsLoadingSessions(true)
    try {
      const response = await fetchConversationSummaries()
      setSessions(response.conversations)

      const activeConversationId = selectedId ?? conversationId
      const activeConversation = response.conversations.find(
        (conversation) => conversation.conversation_id === activeConversationId,
      )
      if (activeConversation) {
        setConversationTitle(activeConversation.title)
      }
    } catch (historyError) {
      setError(
        historyError instanceof Error ? historyError.message : 'Unknown history loading failure.',
      )
    } finally {
      setIsLoadingSessions(false)
    }
  }

  async function handleOpenConversation(targetConversationId: string) {
    if (isSending) {
      return
    }

    setError(undefined)
    const response = await fetchConversationDetail(targetConversationId)
    setConversationId(response.conversation_id)
    setConversationTitle(response.title)
    setMessages(
      response.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        metrics: message.metrics ?? undefined,
      })),
    )
  }

  function handleNewChat() {
    setConversationId(undefined)
    setConversationTitle('New chat')
    setMessages([])
    setDraft('')
    setError(undefined)
    setLastSubmittedPrompt('')
  }

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
    if (!conversationId) {
      setConversationTitle(deriveConversationTitle(trimmedDraft))
    }
    setDraft('')
    setError(undefined)
    setIsSending(true)

    try {
      const response = await streamChatMessage(trimmedDraft, conversationId, researchMode, {
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
          void loadConversationSummaries(finalResponse.conversation_id)
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
    <div className="grid h-screen w-full grid-cols-1 gap-6 overflow-hidden px-4 sm:px-6 lg:grid-cols-[320px_minmax(0,1fr)] lg:gap-0 lg:px-0">
      <aside className="hidden border-r border-stone-200/80 bg-white/72 lg:flex lg:h-screen lg:flex-col lg:overflow-hidden">
        <SidebarNav
          activeConversationId={conversationId}
          conversations={sessions}
          isLoading={isLoadingSessions}
          onNewChat={handleNewChat}
          onOpenConversation={handleOpenConversation}
        />
      </aside>

      <section className="flex h-screen min-h-0 flex-col overflow-hidden pb-4 pt-8 lg:px-8 lg:pt-6">
        {isComposerDocked ? (
          <header className="mb-6 flex items-center justify-between">
            <div className="min-w-0">
              <h2 className="truncate text-2xl font-semibold tracking-tight text-stone-950">
                {conversationTitle}
              </h2>
              <p className="text-sm text-stone-500">deepagents</p>
            </div>
          </header>
        ) : null}

        <div
          className={[
            'min-h-0 transition-all duration-300',
            isComposerDocked
              ? 'flex-1 overflow-y-auto pb-8'
              : 'flex flex-1 flex-col justify-center overflow-y-auto pb-16',
          ].join(' ')}
        >
          {!isComposerDocked ? (
            <section className="mx-auto w-full max-w-5xl">
              <h1 className="mb-10 text-center text-4xl font-medium tracking-tight text-stone-900 sm:text-5xl">
                What are we researching?
              </h1>
              <PromptComposer
                draft={draft}
                error={error}
                isDocked={false}
                isSending={isSending}
                lastSubmittedPrompt={lastSubmittedPrompt}
                onChange={setDraft}
                onModeChange={setResearchMode}
                onSubmit={handleSubmit}
                researchMode={researchMode}
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
          <div className="sticky bottom-0 z-20 pt-8">
            <div className="mx-auto w-full max-w-5xl rounded-[32px] bg-[linear-gradient(180deg,rgba(249,249,247,0),rgba(249,249,247,0.94)_24%,rgba(249,249,247,0.98)_100%)]">
              <div className="pt-6">
              <PromptComposer
                draft={draft}
                error={error}
                isDocked
                isSending={isSending}
                lastSubmittedPrompt={lastSubmittedPrompt}
                onChange={setDraft}
                onModeChange={setResearchMode}
                onSubmit={handleSubmit}
                researchMode={researchMode}
              />
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  )
}

function SidebarNav({
  activeConversationId,
  conversations,
  isLoading,
  onNewChat,
  onOpenConversation,
}: {
  activeConversationId?: string
  conversations: ConversationSummary[]
  isLoading: boolean
  onNewChat: () => void
  onOpenConversation: (conversationId: string) => void
}) {
  return (
    <div className="flex h-full min-h-0 flex-col px-4 py-5">
      <div className="space-y-2">
        <button
          type="button"
          className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-[1.05rem] text-stone-800 transition hover:bg-stone-100"
          onClick={onNewChat}
        >
          <MessageSquarePlus className="h-5 w-5 text-stone-500" />
          <span>New chat</span>
        </button>
        <SidebarUtility icon={Search} label="Search" />
        <SidebarUtility icon={PanelsTopLeft} label="Saved briefs" />
        <SidebarUtility icon={Clock3} label="Automations" />
        <SidebarUtility icon={ChartColumnBig} label="Admin dashboard" to="/admin" />
      </div>

      <div className="mt-10 min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="mb-4 px-3 text-sm font-medium text-stone-400">Projects</div>
        <div className="space-y-5">
          <div>
            <div className="mb-2 flex items-center gap-2 px-3 text-[1.05rem] text-stone-700">
              <FolderOpen className="h-5 w-5 text-stone-400" />
              <span>deepagents</span>
            </div>
            <div className="space-y-1">
              {isLoading ? (
                <div className="px-3 py-2 text-sm text-stone-400">Loading sessions...</div>
              ) : conversations.length === 0 ? (
                <div className="px-3 py-2 text-sm text-stone-400">No sessions yet</div>
              ) : (
                conversations.map((conversation) => (
                  <button
                    key={conversation.conversation_id}
                    type="button"
                    className={[
                      'flex w-full items-center justify-between rounded-2xl px-3 py-3 text-left transition',
                      activeConversationId === conversation.conversation_id
                        ? 'bg-stone-100 text-stone-950'
                        : 'text-stone-700 hover:bg-stone-50',
                    ].join(' ')}
                    onClick={() => onOpenConversation(conversation.conversation_id)}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[1rem]">{conversation.title}</div>
                      <div className="truncate text-sm text-stone-400">{conversation.preview}</div>
                    </div>
                    <div className="ml-3 shrink-0 text-sm text-stone-400">
                      {formatRelativeTime(conversation.last_message_at)}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-stone-200 px-3 py-4 text-sm text-stone-400">
        Session history
      </div>
    </div>
  )
}

function SidebarUtility({
  icon: Icon,
  label,
  to,
}: {
  icon: typeof Search
  label: string
  to?: string
}) {
  if (to) {
    return (
      <NavLink
        to={to}
        className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-[1.05rem] text-stone-700 transition hover:bg-stone-100"
      >
        <Icon className="h-5 w-5 text-stone-500" />
        <span>{label}</span>
      </NavLink>
    )
  }

  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-[1.05rem] text-stone-700 transition hover:bg-stone-100"
    >
      <Icon className="h-5 w-5 text-stone-500" />
      <span>{label}</span>
    </button>
  )
}

type PromptComposerProps = {
  draft: string
  error?: string
  isDocked: boolean
  isSending: boolean
  lastSubmittedPrompt: string
  onChange: (value: string) => void
  onModeChange: (mode: ResearchMode) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  researchMode: ResearchMode
}

function PromptComposer({
  draft,
  error,
  isDocked,
  isSending,
  lastSubmittedPrompt,
  onChange,
  onModeChange,
  onSubmit,
  researchMode,
}: PromptComposerProps) {
  const disabled = isSending
  const placeholder = isDocked ? 'Ask for follow-up changes' : 'Ask anything...'

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) {
      return
    }

    event.preventDefault()

    const form = event.currentTarget.form
    if (!form) {
      return
    }

    form.requestSubmit()
  }

  return (
    <form className="space-y-3" onSubmit={onSubmit}>
      <div className="overflow-hidden rounded-[30px] border border-stone-300 bg-white shadow-[0_8px_28px_rgba(15,23,42,0.08)]">
        <Textarea
          aria-label="Message"
          className="min-h-[92px] max-h-[600px] resize-none overflow-y-auto border-0 bg-transparent px-5 py-4 text-[1.05rem] leading-8 text-stone-900 shadow-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:bg-transparent disabled:text-stone-400 disabled:opacity-100"
          disabled={disabled}
          placeholder={placeholder}
          value={disabled ? '' : draft}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
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
              <span>Deep research</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm text-stone-500">
            {isSending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
            <div className="inline-flex items-center gap-1">
              <span>OpenAI</span>
            </div>
            <div
              aria-label="Research mode"
              className="inline-flex items-center rounded-full border border-stone-200 bg-stone-50 p-1 text-xs text-stone-600"
              role="group"
            >
              <button
                type="button"
                className={[
                  'rounded-full px-3 py-1.5 transition',
                  researchMode === 'light'
                    ? 'bg-white text-stone-900 shadow-sm'
                    : 'text-stone-500 hover:text-stone-900',
                ].join(' ')}
                disabled={disabled}
                onClick={() => onModeChange('light')}
              >
                Light
                <span className="ml-1 text-[11px] text-current/70">&lt;1 min</span>
              </button>
              <button
                type="button"
                className={[
                  'rounded-full px-3 py-1.5 transition',
                  researchMode === 'standard'
                    ? 'bg-white text-stone-900 shadow-sm'
                    : 'text-stone-500 hover:text-stone-900',
                ].join(' ')}
                disabled={disabled}
                onClick={() => onModeChange('standard')}
              >
                Standard
                <span className="ml-1 text-[11px] text-current/70">up to 5 min</span>
              </button>
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
          {message.role === 'user' ? (
            <div className="mb-2 text-xs uppercase tracking-[0.28em] text-current/60">You</div>
          ) : null}
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
    return <MarkdownReport content={message.content} />
  }

  return <p className="whitespace-pre-wrap text-sm leading-7">{message.content}</p>
}

function TraceTimeline({ trace }: { trace: ChatTraceEvent[] }) {
  const orderedTrace = orderTraceEvents(trace)

  return (
    <div className="mt-5 space-y-3 pt-1">
      {orderedTrace.map((event, index) => {
        const Icon = getTraceIcon(event.type)
        const display = formatTraceEvent(event)
        if (!display) {
          return null
        }
        if (display.inlineText) {
          return (
            <div
              key={`${event.type}-${index}-${event.title}`}
              className={[
                'px-1 text-sm leading-6 text-current/70',
                display.animatePulse ? 'animate-pulse' : '',
              ].join(' ')}
            >
              {display.inlineText}
            </div>
          )
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
    return <MarkdownReport content={summary} />
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

function MarkdownReport({ content }: { content: string }) {
  const normalizedContent = normalizeReportMarkdown(content)

  return (
    <div className="prose prose-sm max-w-none text-stone-900 prose-headings:mb-3 prose-headings:font-semibold prose-headings:text-stone-950 prose-h2:mt-8 prose-h2:text-2xl prose-h3:mt-6 prose-h3:text-lg prose-p:my-3 prose-p:leading-7 prose-li:my-1 prose-li:leading-7 prose-strong:text-stone-950 prose-code:rounded prose-code:bg-stone-100 prose-code:px-1 prose-code:py-0.5 prose-pre:rounded-2xl prose-pre:bg-stone-950 prose-pre:text-stone-50 prose-ul:my-3 prose-ol:my-3">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizedContent}</ReactMarkdown>
    </div>
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
  inlineText?: string
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
            title: '',
            summary: '',
            bullets: [],
            links: [],
            metadata: {},
            animatePulse: true,
            inlineText: 'Thinking...',
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
      if (event.type === 'tool_result' && queries.length === 0) {
        return null
      }
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

function normalizeReportMarkdown(value: string): string {
  const lines = value.replace(/\r\n/g, '\n').split('\n')

  return lines
    .map((line, index) => {
      const trimmed = line.trim()
      if (!isPlainSectionHeading(trimmed, lines[index - 1], lines[index + 1])) {
        return line
      }

      return `${headingLevelForLine(trimmed)} ${trimmed}`
    })
    .join('\n')
}

function deriveConversationTitle(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 48) {
    return normalized
  }

  return `${normalized.slice(0, 45).trimEnd()}...`
}

function formatRelativeTime(value: string): string {
  const timestamp = new Date(value).getTime()
  const diffMs = timestamp - Date.now()
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  const month = 30 * day
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

  if (Math.abs(diffMs) < hour) {
    return formatter.format(Math.round(diffMs / minute), 'minute')
  }

  if (Math.abs(diffMs) < day) {
    return formatter.format(Math.round(diffMs / hour), 'hour')
  }

  if (Math.abs(diffMs) < month) {
    return formatter.format(Math.round(diffMs / day), 'day')
  }

  return formatter.format(Math.round(diffMs / month), 'month')
}

function isPlainSectionHeading(
  line: string,
  previousLine?: string,
  nextLine?: string,
): boolean {
  if (!line) {
    return false
  }

  if (/^#{1,6}\s/.test(line) || /^[-*]\s/.test(line) || /^\d+\.\s/.test(line)) {
    return false
  }

  if (/[.:;!?]$/.test(line) || line.includes('[') || line.includes(']')) {
    return false
  }

  const words = line.split(/\s+/)
  if (words.length > 8 || line.length > 80) {
    return false
  }

  const previousTrimmed = previousLine?.trim() ?? ''
  const nextTrimmed = nextLine?.trim() ?? ''
  if (previousTrimmed && nextTrimmed) {
    return false
  }

  const lowercaseSentenceSignals = new Set([
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'have',
    'has',
    'had',
  ])
  if (words.some((word) => lowercaseSentenceSignals.has(word.toLowerCase()))) {
    return false
  }

  return true
}

function headingLevelForLine(line: string): '##' | '###' {
  const majorSectionPatterns = [
    /^Executive Summary$/i,
    /^Key Findings$/i,
    /^Analysis$/i,
    /^Gaps and Uncertainties$/i,
    /^Outlook(?: or Implications)?$/i,
    /^Sources$/i,
  ]

  if (
    majorSectionPatterns.some((pattern) => pattern.test(line)) ||
    line.length >= 24 ||
    /\band\b/i.test(line)
  ) {
    return '##'
  }

  return '###'
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
