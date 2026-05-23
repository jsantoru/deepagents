import { lazy, Suspense } from 'react'
import { BrowserRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { Bot, ChartColumnBig, SearchCode } from 'lucide-react'

import { Skeleton } from '@/components/ui/skeleton'

const ChatPage = lazy(async () => {
  const module = await import('@/pages/chat-page')
  return { default: module.ChatPage }
})

const AdminPage = lazy(async () => {
  const module = await import('@/pages/admin-page')
  return { default: module.AdminPage }
})

const navigationItems = [
  { to: '/', label: 'Chat', icon: SearchCode },
  { to: '/admin', label: 'Admin', icon: ChartColumnBig },
]

function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  )
}

function AppShell() {
  const location = useLocation()
  const isChatRoute = location.pathname === '/'

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.96),_rgba(249,249,247,0.96)_42%,_rgba(241,241,238,0.98)_100%)] text-foreground">
      <div
        className={[
          'mx-auto flex min-h-screen w-full flex-col px-4 sm:px-6 lg:px-8',
          isChatRoute ? 'max-w-none px-0 sm:px-0 lg:px-0 mx-0' : 'max-w-7xl py-4',
        ].join(' ')}
      >
        {!isChatRoute ? (
          <header className="mb-4 flex items-center justify-between rounded-[28px] border border-black/10 bg-white/70 px-5 py-4 shadow-[0_18px_60px_rgba(60,52,37,0.08)] backdrop-blur">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-black text-white">
                <Bot className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-muted-foreground">
                  DeepAgents
                </p>
                <h1 className="text-lg font-semibold tracking-tight">Research Console</h1>
              </div>
            </div>
            <nav className="flex items-center gap-2 rounded-full bg-stone-950/5 p-1">
              {navigationItems.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    [
                      'flex items-center gap-2 rounded-full px-4 py-2 text-sm transition',
                      isActive ? 'bg-stone-950 text-white' : 'text-stone-700 hover:bg-white/70',
                    ].join(' ')
                  }
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </NavLink>
              ))}
            </nav>
          </header>
        ) : null}

        <main className="flex-1">
          <Suspense fallback={<RouteSkeleton />}>
            <Routes>
              <Route path="/" element={<ChatPage />} />
              <Route path="/admin" element={<AdminPage />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </div>
  )
}

function RouteSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
      <Skeleton className="h-[620px] rounded-[32px]" />
      <Skeleton className="h-[620px] rounded-[32px]" />
    </div>
  )
}

export default App
