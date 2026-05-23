import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function AdminPlaceholderPage() {
  return (
    <Card className="border-black/10 bg-white/80 shadow-[0_24px_80px_rgba(69,57,34,0.08)] backdrop-blur">
      <CardHeader className="space-y-4">
        <Badge className="w-fit rounded-full bg-stone-900 px-3 py-1 text-stone-50">
          Coming next
        </Badge>
        <CardTitle className="max-w-2xl text-3xl leading-tight">
          The metrics dashboard lands in the next slice with run history, token burn,
          estimated cost, and latency trends.
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm text-muted-foreground sm:grid-cols-3">
        <div className="rounded-3xl border border-black/10 bg-stone-50 p-5">
          Cost views per run and over time.
        </div>
        <div className="rounded-3xl border border-black/10 bg-stone-50 p-5">
          Token and latency rollups from the backend admin API.
        </div>
        <div className="rounded-3xl border border-black/10 bg-stone-50 p-5">
          Conversation and search activity snapshots for operators.
        </div>
      </CardContent>
    </Card>
  )
}
