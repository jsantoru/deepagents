const API_BASE =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:8000/api'

export type ResearchMode = 'light' | 'standard'

export interface TraceEvent {
  id: string
  type: string
  title: string
  content: string
  metadata: Record<string, unknown>
}

export interface MessageOut {
  id: string
  role: 'user' | 'assistant'
  content: string
  run_id: string | null
  created_at: string
}

export interface RunOut {
  id: string
  status: string
  model: string
  latency_ms: number
  input_tokens: number
  output_tokens: number
  search_calls: number
  entities_added: number
  relations_added: number
  created_at: string
}

export interface SessionSummary {
  id: string
  title: string
  created_at: string
  updated_at: string
  message_count: number
}

export interface SessionDetail extends Omit<SessionSummary, 'message_count'> {
  messages: MessageOut[]
  runs: RunOut[]
}

export interface GraphNode {
  id: string
  name: string
  type: string
  summary: string
  mention_count: number
  degree: number
  first_session_id: string | null
  created_at: string
  updated_at: string
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  type: string
  description: string
  weight: number
  created_at: string
}

export interface GraphOut {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface TimelinePoint {
  run_id: string
  session_id: string
  created_at: string
  entities_added: number
  relations_added: number
  total_entities: number
  total_relations: number
}

export interface GraphEventOut {
  id: string
  kind: string
  label: string
  session_id: string | null
  created_at: string
}

export interface MemoryStats {
  entities: number
  relations: number
  sessions: number
  runs: number
  events: number
  top_entities: GraphNode[]
}

export interface EntityDetail {
  node: GraphNode
  neighbors: GraphNode[]
  edges: GraphEdge[]
  events: GraphEventOut[]
}

async function get<T>(path: string): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`)
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`)
  return resp.json() as Promise<T>
}

export const fetchSessions = () => get<SessionSummary[]>('/sessions')
export const fetchSession = (id: string) => get<SessionDetail>(`/sessions/${id}`)
export const fetchGraph = () => get<GraphOut>('/memory/graph')
export const fetchTimeline = () => get<TimelinePoint[]>('/memory/timeline')
export const fetchMemoryStats = () => get<MemoryStats>('/memory/stats')
export const fetchMemoryEvents = (limit = 100) =>
  get<GraphEventOut[]>(`/memory/events?limit=${limit}`)
export const fetchEntity = (id: string) => get<EntityDetail>(`/memory/entities/${id}`)

export async function deleteSession(id: string): Promise<void> {
  const resp = await fetch(`${API_BASE}/sessions/${id}`, { method: 'DELETE' })
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`)
}

export interface ChatStreamHandlers {
  onEvent: (event: TraceEvent) => void
  onDone: () => void
  onError: (error: Error) => void
}

/** POST /chat/stream and parse the SSE response incrementally. */
export async function streamChat(
  payload: { message: string; session_id?: string | null; research_mode: ResearchMode },
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const resp = await fetch(`${API_BASE}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
    if (!resp.ok || !resp.body) throw new Error(`${resp.status} ${resp.statusText}`)

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
        if (!dataLine) continue
        try {
          const parsed = JSON.parse(dataLine.slice(6)) as TraceEvent
          if (parsed && parsed.type) handlers.onEvent(parsed)
        } catch {
          // ignore malformed frames
        }
      }
    }
    handlers.onDone()
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      handlers.onDone()
      return
    }
    handlers.onError(err as Error)
  }
}

export const ENTITY_COLORS: Record<string, string> = {
  person: '#e5b567',
  organization: '#6ea8fe',
  product: '#6fd8b2',
  technology: '#b394e6',
  place: '#5ec5d4',
  event: '#e77c8d',
  concept: '#9a9aa4',
}

export const entityColor = (type: string): string => ENTITY_COLORS[type] ?? ENTITY_COLORS.concept
