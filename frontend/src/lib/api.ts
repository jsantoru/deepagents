export type ChatMetrics = {
  model_name: string
  latency_ms: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  estimated_cost_usd: number
  search_calls: number
}

export type ChatTraceEvent = {
  id: string
  type: string
  title: string
  content: string
  metadata: Record<string, string | number>
}

export type ChatResponse = {
  conversation_id: string
  run_id: string
  answer: string
  trace: ChatTraceEvent[]
  metrics: ChatMetrics
}

export type AdminOverviewResponse = {
  conversation_count: number
  run_count: number
  total_tokens: number
  total_estimated_cost_usd: number
  average_latency_ms: number
}

export type AdminRunSummary = {
  run_id: string
  conversation_id: string
  answer_preview: string
  metrics: ChatMetrics
  created_at: string
}

export type AdminRunsResponse = {
  runs: AdminRunSummary[]
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000/api/v1'

export async function sendChatMessage(
  message: string,
  conversationId?: string,
): Promise<ChatResponse> {
  const response = await fetch(`${API_BASE_URL}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      conversation_id: conversationId,
    }),
  })

  if (!response.ok) {
    throw new Error('The agent request failed.')
  }

  return (await response.json()) as ChatResponse
}

type StreamChatCallbacks = {
  onStatus?: (payload: Record<string, string>) => void
  onTrace?: (event: ChatTraceEvent) => void
  onFinal?: (response: ChatResponse) => void
}

export async function streamChatMessage(
  message: string,
  conversationId: string | undefined,
  callbacks: StreamChatCallbacks,
): Promise<ChatResponse> {
  const response = await fetch(`${API_BASE_URL}/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      conversation_id: conversationId,
    }),
  })

  if (!response.ok || !response.body) {
    throw new Error('The agent stream request failed.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalResponse: ChatResponse | undefined

  while (true) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''

    for (const part of parts) {
      const parsed = parseSseEvent(part)
      if (!parsed) {
        continue
      }

      if (parsed.event === 'status') {
        callbacks.onStatus?.(parsed.data as Record<string, string>)
      } else if (parsed.event === 'trace') {
        callbacks.onTrace?.(parsed.data as ChatTraceEvent)
      } else if (parsed.event === 'final') {
        finalResponse = parsed.data as ChatResponse
        callbacks.onFinal?.(finalResponse)
      } else if (parsed.event === 'error') {
        throw new Error(String((parsed.data as { message?: string }).message ?? 'Unknown stream error.'))
      }
    }
  }

  if (!finalResponse) {
    throw new Error('The agent stream ended before a final response was received.')
  }

  return finalResponse
}

function parseSseEvent(chunk: string): { event: string; data: unknown } | null {
  const lines = chunk.split('\n')
  const eventLine = lines.find((line) => line.startsWith('event: '))
  const dataLine = lines.find((line) => line.startsWith('data: '))
  if (!eventLine || !dataLine) {
    return null
  }

  return {
    event: eventLine.slice(7).trim(),
    data: JSON.parse(dataLine.slice(6)),
  }
}

export async function fetchAdminOverview(): Promise<AdminOverviewResponse> {
  const response = await fetch(`${API_BASE_URL}/admin/overview`)

  if (!response.ok) {
    throw new Error('The admin overview request failed.')
  }

  return (await response.json()) as AdminOverviewResponse
}

export async function fetchAdminRuns(): Promise<AdminRunsResponse> {
  const response = await fetch(`${API_BASE_URL}/admin/runs`)

  if (!response.ok) {
    throw new Error('The admin runs request failed.')
  }

  return (await response.json()) as AdminRunsResponse
}
