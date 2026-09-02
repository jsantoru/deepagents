import clsx from 'clsx'
import { MessageSquare, Network, Plus, Trash2 } from 'lucide-react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'

import { deleteSession, type SessionSummary } from '@/lib/api'

interface SidebarProps {
  sessions: SessionSummary[]
  refreshSessions: () => void
}

export function Sidebar({ sessions, refreshSessions }: SidebarProps) {
  const { sessionId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const onMemory = location.pathname === '/memory'

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    await deleteSession(id).catch(() => undefined)
    refreshSessions()
    if (sessionId === id) navigate('/')
  }

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col border-r border-ink-800 bg-ink-900">
      <div className="flex items-center gap-2.5 px-4 pt-5 pb-4">
        <div className="flex size-7 items-center justify-center rounded-lg bg-ink-100">
          <Network className="size-4 text-ink-950" strokeWidth={2.2} />
        </div>
        <span className="text-[15px] font-semibold tracking-tight text-ink-50">Cortex</span>
      </div>

      <div className="px-3">
        <Link
          to="/"
          className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-[13px] font-medium text-ink-100 transition-colors hover:border-ink-600 hover:bg-ink-800"
        >
          <Plus className="size-4" />
          New research
        </Link>
      </div>

      <nav className="mt-4 px-3">
        <Link
          to="/memory"
          className={clsx(
            'flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition-colors',
            onMemory
              ? 'bg-ink-800 font-medium text-ink-50'
              : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100',
          )}
        >
          <Network className="size-4" />
          Memory graph
        </Link>
      </nav>

      <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <p className="px-3 pb-2 text-[11px] font-medium uppercase tracking-wider text-ink-400">
          Sessions
        </p>
        <div className="space-y-0.5">
          {sessions.map((session) => (
            <Link
              key={session.id}
              to={`/s/${session.id}`}
              className={clsx(
                'group flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition-colors',
                session.id === sessionId
                  ? 'bg-ink-800 text-ink-50'
                  : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100',
              )}
            >
              <MessageSquare className="size-3.5 shrink-0 opacity-60" />
              <span className="min-w-0 flex-1 truncate">{session.title}</span>
              <button
                onClick={(e) => handleDelete(session.id, e)}
                className="hidden shrink-0 rounded p-0.5 text-ink-400 hover:text-rose group-hover:block"
                aria-label="Delete session"
              >
                <Trash2 className="size-3.5" />
              </button>
            </Link>
          ))}
          {sessions.length === 0 && (
            <p className="px-3 py-2 text-[12.5px] text-ink-400">No sessions yet</p>
          )}
        </div>
      </div>
    </aside>
  )
}
