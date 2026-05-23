import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import App from '@/App'

describe('App chat flow', () => {
  it('submits a prompt and renders the assistant response', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        conversation_id: 'conversation-1',
        run_id: 'run-1',
        answer: 'LangGraph is the runtime beneath DeepAgents.',
        trace: [
          {
            type: 'assistant',
            title: 'Agent note',
            content: 'I am checking the framework structure first.',
            metadata: {},
          },
          {
            type: 'tool',
            title: 'Tool call: internet_search',
            content: '{"query":"What is LangGraph?"}',
            metadata: { tool_name: 'internet_search' },
          },
          {
            type: 'final',
            title: 'Final answer',
            content: 'LangGraph is the runtime beneath DeepAgents.',
            metadata: {},
          },
        ],
        metrics: {
          model_name: 'openai:gpt-4.1-mini',
          latency_ms: 340,
          input_tokens: 12,
          output_tokens: 18,
          total_tokens: 30,
          estimated_cost_usd: 0.000021,
          search_calls: 1,
        },
      }),
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
