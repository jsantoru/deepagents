import { useCallback, useEffect, useState } from 'react'
import { Outlet, Route, Routes, useOutletContext } from 'react-router-dom'

import { fetchSessions, type SessionSummary } from '@/lib/api'
import { Sidebar } from '@/components/Sidebar'
import { ChatPage } from '@/pages/ChatPage'
import { MemoryPage } from '@/pages/MemoryPage'

export interface ShellContext {
  sessions: SessionSummary[]
  refreshSessions: () => void
}

function AppShell() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])

  const refreshSessions = useCallback(() => {
    fetchSessions()
      .then(setSessions)
      .catch(() => setSessions([]))
  }, [])

  useEffect(() => {
    refreshSessions()
  }, [refreshSessions])

  return (
    <div className="flex h-full">
      <Sidebar sessions={sessions} refreshSessions={refreshSessions} />
      <main className="min-w-0 flex-1">
        <Outlet context={{ sessions, refreshSessions } satisfies ShellContext} />
      </main>
    </div>
  )
}

export function useShell(): ShellContext {
  return useOutletContext<ShellContext>()
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<ChatPage key="new" />} />
        <Route path="/s/:sessionId" element={<ChatPage />} />
        <Route path="/memory" element={<MemoryPage />} />
      </Route>
    </Routes>
  )
}
