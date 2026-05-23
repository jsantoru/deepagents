import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom'
import { Bot, ChartColumnBig, SearchCode } from 'lucide-react'

import { ChatPage } from '@/pages/chat-page'
import { AdminPlaceholderPage } from '@/pages/admin-placeholder-page'

const navigationItems = [
  { to: '/', label: 'Chat', icon: SearchCode },
  { to: '/admin', label: 'Admin', icon: ChartColumnBig },
]

function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(183,244,216,0.9),_transparent_28%),linear-gradient(180deg,_#f9f6ef_0%,_#efe8db_42%,_#e7dece_100%)] text-foreground">
        <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-4 sm:px-6 lg:px-8">
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

          <main className="flex-1">
            <Routes>
              <Route path="/" element={<ChatPage />} />
              <Route path="/admin" element={<AdminPlaceholderPage />} />
            </Routes>
          </main>
        </div>
      </div>
    </BrowserRouter>
  )
}

export default App
