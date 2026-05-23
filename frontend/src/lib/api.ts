export type ChatMetrics = {
  model_name: string
  latency_ms: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  estimated_cost_usd: number
  search_calls: number
}

export type ChatResponse = {
  conversation_id: string
  run_id: string
  answer: string
  metrics: ChatMetrics
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
