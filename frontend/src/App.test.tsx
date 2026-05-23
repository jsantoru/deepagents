import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from '@/App'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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
            type: 'tool_result',
            title: 'Tool result: internet_search',
            content:
              `content='     1\t{"query":"What is LangGraph?","results":[{"url":"https://example.com/langgraph","title":"LangGraph docs","content":"LangGraph is the runtime for stateful agent workflows.","score":0.99}],"response_time":0.42}' name='internet_search' tool_call_id='call_123'`,
            metadata: { tool_name: 'internet_search' },
          },
        },
        {
          event: 'final',
          data: {
            conversation_id: 'conversation-1',
            run_id: 'run-1',
            answer: 'LangGraph is the **runtime** beneath DeepAgents.',
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
                type: 'tool_result',
                title: 'Tool result: internet_search',
                content:
                  `content='     1\t{"query":"What is LangGraph?","results":[{"url":"https://example.com/langgraph","title":"LangGraph docs","content":"LangGraph is the runtime for stateful agent workflows.","score":0.99}],"response_time":0.42}' name='internet_search' tool_call_id='call_123'`,
                metadata: { tool_name: 'internet_search' },
              },
              {
                id: 'final-1',
                type: 'final',
                title: 'Final answer',
                content: 'LangGraph is the **runtime** beneath DeepAgents.',
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

    expect(await screen.findByText('Run trace')).toBeVisible()
    expect(await screen.findByText('Search results: internet_search')).toBeVisible()
    expect(await screen.findByText('Query: What is LangGraph?')).toBeVisible()
    expect(await screen.findByText(/LangGraph docs:/)).toBeVisible()
    expect(screen.queryByText(/tool_call_id='call_123'/)).not.toBeInTheDocument()
    expect(await screen.findByText('runtime', { selector: 'strong' })).toBeVisible()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('preserves streamed trace order when the final snapshot arrives', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: createSseStream([
        {
          event: 'trace',
          data: {
            id: 'stream-note-1',
            type: 'assistant',
            title: 'Agent note',
            content: '[{"type":"function_call","arguments":"{\\"query\\":\\"latest langgraph release\\"}","name":"internet_search"}]',
            metadata: {},
          },
        },
        {
          event: 'trace',
          data: {
            id: 'tool-call-1',
            type: 'tool',
            title: 'Tool call: internet_search',
            content: '{"query":"latest langgraph release"}',
            metadata: { tool_name: 'internet_search' },
          },
        },
        {
          event: 'final',
          data: {
            conversation_id: 'conversation-2',
            run_id: 'run-2',
            answer: 'Done.',
            trace: [
              {
                id: 'final-note-9',
                type: 'assistant',
                title: 'Agent note',
                content: 'Reviewing the search results.',
                metadata: {},
              },
              {
                id: 'final-tool-9',
                type: 'tool_result',
                title: 'Tool result: internet_search',
                content:
                  `content='{"query":"latest langgraph release","results":[{"url":"https://example.com/release","title":"Release notes","content":"LangGraph shipped a new release.","score":0.95}]}' name='internet_search' tool_call_id='call_final'`,
                metadata: { tool_name: 'internet_search' },
              },
              {
                id: 'final-answer-9',
                type: 'final',
                title: 'Final answer',
                content: 'Done.',
                metadata: {},
              },
            ],
            metrics: {
              model_name: 'openai:gpt-5-nano',
              latency_ms: 120,
              input_tokens: 100,
              output_tokens: 50,
              total_tokens: 150,
              estimated_cost_usd: 0.000025,
              search_calls: 1,
            },
          },
        },
      ]),
    })

    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await user.type(await screen.findByLabelText('Message'), 'What changed?')
    await user.click(screen.getByRole('button', { name: 'Send prompt' }))

    expect(await screen.findByText('Planning next steps')).toBeVisible()
    expect(await screen.findByText('Search: latest langgraph release')).toBeVisible()
    expect(await screen.findByText('Search results: internet_search')).toBeVisible()
    expect(await screen.findByText(/Release notes:/)).toBeVisible()
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
