import clsx from 'clsx'
import { ArrowUp, Square, Telescope, Zap } from 'lucide-react'
import { useRef, useState } from 'react'

import type { ResearchMode } from '@/lib/api'

interface ComposerProps {
  running: boolean
  onSend: (message: string, mode: ResearchMode) => void
  onStop: () => void
}

export function Composer({ running, onSend, onStop }: ComposerProps) {
  const [value, setValue] = useState('')
  const [mode, setMode] = useState<ResearchMode>('light')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const submit = () => {
    const message = value.trim()
    if (!message || running) return
    setValue('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    onSend(message, mode)
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-5">
      <div className="rounded-2xl border border-ink-700 bg-ink-850 shadow-[0_8px_30px_rgba(0,0,0,0.35)] transition-colors focus-within:border-ink-500">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={1}
          placeholder="Ask anything — Cortex researches and remembers"
          className="w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14px] leading-relaxed text-ink-100 placeholder:text-ink-400 focus:outline-none"
        />
        <div className="flex items-center justify-between px-2.5 pb-2.5">
          <div className="flex items-center gap-1 rounded-full border border-ink-700 p-0.5">
            <ModeButton
              active={mode === 'light'}
              onClick={() => setMode('light')}
              icon={<Zap className="size-3.5" />}
              label="Light"
            />
            <ModeButton
              active={mode === 'standard'}
              onClick={() => setMode('standard')}
              icon={<Telescope className="size-3.5" />}
              label="Deep"
            />
          </div>
          {running ? (
            <button
              onClick={onStop}
              className="flex size-8 items-center justify-center rounded-full bg-ink-100 text-ink-950 transition-opacity hover:opacity-80"
              aria-label="Stop"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!value.trim()}
              className="flex size-8 items-center justify-center rounded-full bg-ink-100 text-ink-950 transition-opacity hover:opacity-80 disabled:opacity-25"
              aria-label="Send"
            >
              <ArrowUp className="size-4" strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      <p className="mt-2 text-center text-[11px] text-ink-400">
        Light ≈ under a minute · Deep researches broadly and cross-checks sources
      </p>
    </div>
  )
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors',
        active ? 'bg-ink-100 text-ink-950' : 'text-ink-300 hover:text-ink-100',
      )}
    >
      {icon}
      {label}
    </button>
  )
}
