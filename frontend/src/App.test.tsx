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

    expect(await screen.findByText('Search results: internet_search')).toBeVisible()
    expect(await screen.findByText('Query: What is LangGraph?')).toBeVisible()
    expect(await screen.findByText(/LangGraph docs:/)).toBeVisible()
    expect(screen.queryByText(/tool_call_id='call_123'/)).not.toBeInTheDocument()
    expect(await screen.findByText('runtime', { selector: 'strong' })).toBeVisible()
    const chatRequest = getChatStreamRequest(fetchMock)
    expect(chatRequest).toBeDefined()
    expect(JSON.parse(String(chatRequest?.[1]?.body))).toMatchObject({
      message: 'What is LangGraph?',
      research_mode: 'standard',
    })
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

  it('shows a thinking state for empty reasoning markers without leaking raw json', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: createSseStream([
        {
          event: 'trace',
          data: {
            id: 'thinking-1',
            type: 'assistant',
            title: 'Agent note',
            content:
              '[{"id":"rs_1","summary":[],"type":"reasoning","index":0}]',
            metadata: {},
          },
        },
        {
          event: 'final',
          data: {
            conversation_id: 'conversation-3',
            run_id: 'run-3',
            answer: 'Done.',
            trace: [
              {
                id: 'thinking-1',
                type: 'assistant',
                title: 'Agent note',
                content:
                  '[{"id":"rs_1","summary":[],"type":"reasoning","index":0}]',
                metadata: {},
              },
              {
                id: 'final-answer-3',
                type: 'final',
                title: 'Final answer',
                content: 'Done.',
                metadata: {},
              },
            ],
            metrics: {
              model_name: 'openai:gpt-5-nano',
              latency_ms: 80,
              input_tokens: 10,
              output_tokens: 6,
              total_tokens: 16,
              estimated_cost_usd: 0.000003,
              search_calls: 0,
            },
          },
        },
      ]),
    })

    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await user.type(await screen.findByLabelText('Message'), 'Think first')
    await user.click(screen.getByRole('button', { name: 'Send prompt' }))

    expect(await screen.findByText('Thinking...')).toBeVisible()
    expect(screen.queryByText(/"summary":\[\]/)).not.toBeInTheDocument()
    expect(screen.queryByText('reasoning_steps: 1')).not.toBeInTheDocument()
  })

  it('sends the selected light research mode to the backend', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: createSseStream([
        {
          event: 'final',
          data: {
            conversation_id: 'conversation-5',
            run_id: 'run-5',
            answer: 'Done.',
            trace: [
              {
                id: 'final-answer-5',
                type: 'final',
                title: 'Final answer',
                content: 'Done.',
                metadata: {},
              },
            ],
            metrics: {
              model_name: 'openai:gpt-5-nano',
              latency_ms: 55,
              input_tokens: 8,
              output_tokens: 4,
              total_tokens: 12,
              estimated_cost_usd: 0.000002,
              search_calls: 0,
            },
          },
        },
      ]),
    })

    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await user.click(await screen.findByRole('button', { name: /Light/i }))
    await user.type(await screen.findByLabelText('Message'), 'Quick check')
    await user.click(screen.getByRole('button', { name: 'Send prompt' }))

    const chatRequest = getChatStreamRequest(fetchMock)
    expect(chatRequest).toBeDefined()
    expect(JSON.parse(String(chatRequest?.[1]?.body))).toMatchObject({
      message: 'Quick check',
      research_mode: 'light',
    })
  })

  it('uploads a text file and sends it as structured attachment context', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: createSseStream([
        {
          event: 'final',
          data: {
            conversation_id: 'conversation-6',
            run_id: 'run-6',
            answer: 'Done.',
            trace: [
              {
                id: 'final-answer-6',
                type: 'final',
                title: 'Final answer',
                content: 'Done.',
                metadata: {},
              },
            ],
            metrics: {
              model_name: 'openai:gpt-5-nano',
              latency_ms: 55,
              input_tokens: 8,
              output_tokens: 4,
              total_tokens: 12,
              estimated_cost_usd: 0.000002,
              search_calls: 0,
            },
          },
        },
      ]),
    })

    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement | null
    expect(fileInput).not.toBeNull()

    const file = new File(['alpha\nbeta'], 'notes.txt', { type: 'text/plain' })
    await user.upload(fileInput!, file)
    expect(await screen.findByText('notes.txt')).toBeVisible()

    await user.type(await screen.findByLabelText('Message'), 'Use this file')
    await user.click(screen.getByRole('button', { name: 'Send prompt' }))

    const chatRequest = getChatStreamRequest(fetchMock)
    expect(chatRequest).toBeDefined()
    expect(JSON.parse(String(chatRequest?.[1]?.body))).toMatchObject({
      message: 'Use this file',
      research_mode: 'standard',
      attachments: [
        {
          name: 'notes.txt',
          mime_type: 'text/plain',
          size_bytes: 10,
          text_content: 'alpha\nbeta',
        },
      ],
    })
  })

  it('suppresses unresolved tool-result placeholders until a query or results can be parsed', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: createSseStream([
        {
          event: 'trace',
          data: {
            id: 'tool-result-early',
            type: 'tool_result',
            title: 'Tool result: internet_search',
            content: '{"status":"ok"}',
            metadata: { tool_name: 'internet_search' },
          },
        },
        {
          event: 'trace',
          data: {
            id: 'tool-call-2',
            type: 'tool',
            title: 'Tool call: internet_search',
            content: '{"query":"Tavily fintech","results":[{"url":"https://example.com/tavily","title":"Tavily raises $25M","content":"Tavily raises $25M to connect AI agents to the web.","score":0.99}]}',
            metadata: { tool_name: 'internet_search' },
          },
        },
        {
          event: 'final',
          data: {
            conversation_id: 'conversation-4',
            run_id: 'run-4',
            answer: 'Done.',
            trace: [
              {
                id: 'tool-call-2',
                type: 'tool',
                title: 'Tool call: internet_search',
                content: '{"query":"Tavily fintech","results":[{"url":"https://example.com/tavily","title":"Tavily raises $25M","content":"Tavily raises $25M to connect AI agents to the web.","score":0.99}]}',
                metadata: { tool_name: 'internet_search' },
              },
              {
                id: 'final-answer-4',
                type: 'final',
                title: 'Final answer',
                content: 'Done.',
                metadata: {},
              },
            ],
            metrics: {
              model_name: 'openai:gpt-5-nano',
              latency_ms: 90,
              input_tokens: 11,
              output_tokens: 7,
              total_tokens: 18,
              estimated_cost_usd: 0.000004,
              search_calls: 1,
            },
          },
        },
      ]),
    })

    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await user.type(await screen.findByLabelText('Message'), 'Check Tavily')
    await user.click(screen.getByRole('button', { name: 'Send prompt' }))

    expect(screen.queryByText('Search results received.')).not.toBeInTheDocument()
    expect(await screen.findByText('Query: Tavily fintech')).toBeVisible()
    expect(await screen.findByText(/Tavily raises \$25M:/)).toBeVisible()
  })

  it('renders plain-text report section labels as headings', async () => {
    const user = userEvent.setup()
    const reportBody = [
      'Executive Summary',
      '',
      'The Yankees and Mets are New York City teams.',
      '',
      'Key Facts and Ground Truth',
      '',
      'World Series titles',
      '',
      'Yankees: 27.',
    ].join('\n')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: createSseStream([
        {
          event: 'final',
          data: {
            conversation_id: 'conversation-6',
            run_id: 'run-6',
            answer: reportBody,
            trace: [
              {
                id: 'final-answer-6',
                type: 'final',
                title: 'Final answer',
                content: reportBody,
                metadata: {},
              },
            ],
            metrics: {
              model_name: 'openai:gpt-5-nano',
              latency_ms: 60,
              input_tokens: 10,
              output_tokens: 12,
              total_tokens: 22,
              estimated_cost_usd: 0.000003,
              search_calls: 0,
            },
          },
        },
      ]),
    })

    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await user.type(await screen.findByLabelText('Message'), 'Format a report')
    await user.click(screen.getByRole('button', { name: 'Send prompt' }))

    expect(await screen.findByRole('heading', { name: 'Executive Summary' })).toBeVisible()
    expect(await screen.findByRole('heading', { name: 'Key Facts and Ground Truth' })).toBeVisible()
    expect(await screen.findByRole('heading', { name: 'World Series titles' })).toBeVisible()
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

function getChatStreamRequest(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.find((call) => String(call[0]).includes('/chat/stream'))
}
