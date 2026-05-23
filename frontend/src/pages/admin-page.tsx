import { useEffect, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Activity, Coins, Database, TimerReset } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  type AdminOverviewResponse,
  type AdminRunSummary,
  fetchAdminOverview,
  fetchAdminRuns,
} from '@/lib/api'

type DashboardState = {
  overview?: AdminOverviewResponse
  runs: AdminRunSummary[]
  isLoading: boolean
  error?: string
}

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 5,
  maximumFractionDigits: 5,
})

const integerFormatter = new Intl.NumberFormat('en-US')

export function AdminPage() {
  const [state, setState] = useState<DashboardState>({
    runs: [],
    isLoading: true,
  })

  useEffect(() => {
    let isActive = true

    async function loadDashboard() {
      try {
        const [overview, runsResponse] = await Promise.all([
          fetchAdminOverview(),
          fetchAdminRuns(),
        ])

        if (!isActive) {
          return
        }

        setState({
          overview,
          runs: runsResponse.runs,
          isLoading: false,
        })
      } catch (dashboardError) {
        if (!isActive) {
          return
        }

        setState({
          runs: [],
          isLoading: false,
          error:
            dashboardError instanceof Error
              ? dashboardError.message
              : 'Unknown dashboard failure.',
        })
      }
    }

    loadDashboard()

    return () => {
      isActive = false
    }
  }, [])

  const chartData = state.runs
    .slice()
    .reverse()
    .map((run, index) => ({
      name: `Run ${index + 1}`,
      tokens: run.metrics.total_tokens,
      cost: run.metrics.estimated_cost_usd,
      latency: run.metrics.latency_ms,
    }))

  return (
    <div className="grid gap-4">
      <Card className="border-black/10 bg-white/80 shadow-[0_24px_80px_rgba(69,57,34,0.08)] backdrop-blur">
        <CardHeader className="space-y-4">
          <Badge className="w-fit rounded-full bg-stone-950 px-3 py-1 text-stone-50">
            Operator dashboard
          </Badge>
          <CardTitle className="max-w-3xl text-4xl tracking-tight text-stone-950">
            Watch cost, latency, and token burn without leaving the app.
          </CardTitle>
          <p className="max-w-2xl text-sm leading-6 text-stone-600">
            This view is backed by persisted run records from the FastAPI service. It gives you a
            fast read on the current chat agent before the deeper multi-agent work starts.
          </p>
        </CardHeader>
      </Card>

      {state.error ? (
        <Card className="border-red-300 bg-red-50 text-red-700">
          <CardContent className="p-6 text-sm">{state.error}</CardContent>
        </Card>
      ) : null}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={Database}
          label="Conversations"
          value={
            state.overview ? integerFormatter.format(state.overview.conversation_count) : undefined
          }
          isLoading={state.isLoading}
        />
        <MetricCard
          icon={Activity}
          label="Runs tracked"
          value={state.overview ? integerFormatter.format(state.overview.run_count) : undefined}
          isLoading={state.isLoading}
        />
        <MetricCard
          icon={Coins}
          label="Est. spend"
          value={
            state.overview
              ? currencyFormatter.format(state.overview.total_estimated_cost_usd)
              : undefined
          }
          isLoading={state.isLoading}
        />
        <MetricCard
          icon={TimerReset}
          label="Avg latency"
          value={state.overview ? `${Math.round(state.overview.average_latency_ms)} ms` : undefined}
          isLoading={state.isLoading}
        />
      </section>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <Card className="border-black/10 bg-white/80 shadow-[0_24px_80px_rgba(69,57,34,0.08)] backdrop-blur">
          <CardHeader>
            <CardTitle>Recent run trend</CardTitle>
          </CardHeader>
          <CardContent className="h-[320px]">
            {state.isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-[240px] w-full rounded-3xl" />
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ left: 0, right: 12, top: 12, bottom: 0 }}>
                  <defs>
                    <linearGradient id="tokensGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#111111" stopOpacity={0.45} />
                      <stop offset="95%" stopColor="#111111" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#d6d3d1" />
                  <XAxis dataKey="name" tickLine={false} axisLine={false} stroke="#78716c" />
                  <YAxis tickLine={false} axisLine={false} stroke="#78716c" />
                  <Tooltip />
                  <Area
                    type="monotone"
                    dataKey="tokens"
                    stroke="#111111"
                    strokeWidth={2}
                    fill="url(#tokensGradient)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="border-black/10 bg-stone-950 text-stone-50 shadow-[0_24px_80px_rgba(69,57,34,0.12)]">
          <CardHeader>
            <CardTitle>Run ledger</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {state.isLoading ? (
              <>
                <Skeleton className="h-18 w-full rounded-3xl bg-white/10" />
                <Skeleton className="h-18 w-full rounded-3xl bg-white/10" />
                <Skeleton className="h-18 w-full rounded-3xl bg-white/10" />
              </>
            ) : (
              state.runs.map((run) => (
                <article
                  key={run.run_id}
                  className="rounded-[28px] border border-white/10 bg-white/5 p-4"
                >
                  <div className="mb-2 flex items-center justify-between gap-4">
                    <div className="text-xs uppercase tracking-[0.22em] text-stone-400">
                      {new Date(run.created_at).toLocaleString()}
                    </div>
                    <Badge className="rounded-full border border-white/10 bg-white/10 px-3 py-1 text-white">
                      {run.metrics.search_calls} search calls
                    </Badge>
                  </div>
                  <p className="mb-3 text-sm leading-6 text-stone-100">{run.answer_preview}</p>
                  <Separator className="bg-white/10" />
                  <div className="mt-3 grid gap-2 text-xs text-stone-300 sm:grid-cols-3">
                    <span>{integerFormatter.format(run.metrics.total_tokens)} tokens</span>
                    <span>{run.metrics.latency_ms} ms</span>
                    <span>{currencyFormatter.format(run.metrics.estimated_cost_usd)}</span>
                  </div>
                </article>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function MetricCard({
  icon: Icon,
  label,
  value,
  isLoading,
}: {
  icon: typeof Database
  label: string
  value?: string
  isLoading: boolean
}) {
  return (
    <Card className="border-black/10 bg-white/80 shadow-[0_24px_80px_rgba(69,57,34,0.08)] backdrop-blur">
      <CardContent className="p-5">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-stone-950 text-white">
          <Icon className="h-5 w-5" />
        </div>
        <div className="text-xs uppercase tracking-[0.22em] text-stone-500">{label}</div>
        {isLoading ? (
          <Skeleton className="mt-3 h-8 w-24" />
        ) : (
          <div className="mt-3 text-3xl font-semibold tracking-tight text-stone-950">{value}</div>
        )}
      </CardContent>
    </Card>
  )
}
