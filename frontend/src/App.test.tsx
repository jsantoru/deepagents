import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import App from '@/App'

describe('App chat flow', () => {
  it('submits a prompt and renders the assistant response', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: createSseStream([
        {
          event: 'status',
          data: { state: 'started' },
        },
        {
          event: 'trace',
          data: {
            id: 'note-1',
            type: 'assistant',
            title: 'Agent note',
            content: 'I am checking the framework structure first.',
            metadata: {},
          },
        },
        {
          event: 'trace',
          data: {
            id: 'tool-1',
            type: 'tool',
            title: 'Tool call: internet_search',
            content: '{"query":"What is LangGraph?"}',
            metadata: { tool_name: 'internet_search' },
          },
        },
        {
          event: 'final',
          data: {
            conversation_id: 'conversation-1',
            run_id: 'run-1',
            answer: 'LangGraph is the runtime beneath DeepAgents.',
            trace: [
              {
                id: 'note-1',
                type: 'assistant',
                title: 'Agent note',
                content: 'I am checking the framework structure first.',
                metadata: {},
              },
              {
                id: 'tool-1',
                type: 'tool',
                title: 'Tool call: internet_search',
                content: '{"query":"What is LangGraph?"}',
                metadata: { tool_name: 'internet_search' },
              },
              {
                id: 'final-1',
                type: 'final',
                title: 'Final answer',
                content: 'LangGraph is the runtime beneath DeepAgents.',
                metadata: {},
              },
            ],
            metrics: {
              model_name: 'openai:gpt-5-nano',
              latency_ms: 340,
              input_tokens: 12,
              output_tokens: 18,
              total_tokens: 30,
              estimated_cost_usd: 0.000008,
              search_calls: 1,
            },
          },
        },
      ]),
    })

    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await user.type(await screen.findByLabelText('Message'), 'What is LangGraph?')
    await user.click(screen.getByRole('button', { name: 'Send prompt' }))

    expect(
      await screen.findAllByText('LangGraph is the runtime beneath DeepAgents.'),
    ).toHaveLength(2)
    expect(await screen.findByText('Run trace')).toBeVisible()
    expect(await screen.findByText('Tool call: internet_search')).toBeVisible()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

function createSseStream(events: Array<{ event: string; data: unknown }>) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`),
        )
      }
      controller.close()
    },
  })
}
