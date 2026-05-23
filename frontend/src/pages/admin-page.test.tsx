import { render, screen } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { AdminPage } from '@/pages/admin-page'

describe('AdminPage', () => {
  it('renders overview metrics from the backend', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          conversation_count: 4,
          run_count: 8,
          total_tokens: 4200,
          total_estimated_cost_usd: 0.02421,
          average_latency_ms: 512.4,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          runs: [
            {
              run_id: 'run-1',
              conversation_id: 'conversation-1',
              answer_preview: 'The agent summarized the latest framework changes.',
              created_at: '2026-05-23T18:00:00Z',
              metrics: {
                model_name: 'openai:gpt-4.1-mini',
                latency_ms: 410,
                input_tokens: 120,
                output_tokens: 90,
                total_tokens: 210,
                estimated_cost_usd: 0.00019,
                search_calls: 2,
              },
            },
          ],
        }),
      })

    vi.stubGlobal('fetch', fetchMock)

    render(
      <BrowserRouter>
        <AdminPage />
      </BrowserRouter>,
    )

    expect(await screen.findByText('4')).toBeVisible()
    expect(await screen.findByText('$0.02421')).toBeVisible()
    expect(
      await screen.findByText('The agent summarized the latest framework changes.'),
    ).toBeVisible()
  })
})
