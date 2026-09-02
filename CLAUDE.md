# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cortex is a deep-research agent with graph-based long-term memory. A Python FastAPI
backend runs a LangChain DeepAgents research loop (Tavily web search) and, after every
exchange, extracts entities/relations with an LLM and merges them into a knowledge
graph stored in SQLite. Relevant subgraphs are recalled into the agent's context on
future turns, so memory grows and compounds across sessions. A React/Vite frontend
provides a minimal codex-style chat with a live agent trace and a force-directed
memory-graph visualization with a growth-replay timeline.

## Commands

### Full stack
```bash
docker compose up --build   # frontend :5173, backend :8000
```

### Backend (`backend/`, uv package manager)
```bash
uv sync                                            # install
uv run uvicorn cortex.main:app --reload --port 8000
uv run pytest                                      # all tests
uv run pytest tests/test_graph.py::test_name       # one test
uv run ruff check                                  # lint
```
Requires `.env` with `OPENAI_API_KEY` and `TAVILY_API_KEY` (see `backend/.env.example`).

### Frontend (`frontend/`)
```bash
npm install
npm run dev          # dev server :5173
npm run build        # tsc typecheck + vite build (use this to validate changes)
```

## Architecture

### Backend (`backend/src/cortex/`)

- `main.py` — FastAPI app; `init_db()` creates the SQLite schema on startup
  (no migrations framework — schema changes need a fresh DB or manual ALTER).
- `config.py` — pydantic-settings loaded from `.env`. `DATABASE_URL` defaults to
  `sqlite+aiosqlite:///./cortex.db`.
- `models.py` — SQLAlchemy models: `Session`/`Run`/`Message` (chat) and
  `Entity`/`Relation`/`GraphEvent` (memory graph). `GraphEvent` is an append-only
  mutation log with session/run provenance — it powers the memory timeline UI.
- `orchestrator.py` — **the turn pipeline**: recall memory → run agent → persist
  message + run metrics → extract entities → upsert graph. Emits `TraceEvent`s
  (`meta`, `phase`, `recall`, `note`/`note_delta`, `tool`/`tool_result`/`tool_error`,
  `final`, `memory`, `error`) through an `on_event` callback.
- `agent/service.py` — wraps `deepagents.create_deep_agent`, streams via
  `agent.astream(stream_mode=["messages","tools","values"])`. The agent is rebuilt
  per run because the memory context is baked into the system prompt. Tavily tool
  output content is capped to 1500 chars/result (deepagents tool-result size limit).
- `agent/prompts.py` — researcher prompt + light/standard mode addenda + memory block.
- `memory/graph.py` — `GraphStore`: name-normalized entity dedupe
  (`normalize_name` strips all non-alphanumerics), upsert with
  reinforcement (mention_count/weight increments), keyword recall with 1-hop
  neighborhood expansion, `format_memory_context` for the prompt block.
- `memory/extractor.py` — LLM extraction to strict JSON (`parse_extraction` is
  fence/garbage tolerant); returns `ExtractedEntity`/`ExtractedRelation` lists.
- `api/routes.py` — all endpoints under `/api`: `chat/stream` (SSE via asyncio.Queue;
  the worker opens its own DB session), sessions CRUD, and the `/memory/*` graph,
  timeline, events, stats, and entity-detail endpoints.

### Frontend (`frontend/src/`)

- `lib/api.ts` — typed API client; `streamChat()` parses the SSE POST response
  incrementally; `ENTITY_COLORS` maps entity types to graph colors.
- `App.tsx` — `AppShell` (sidebar + outlet context with sessions list). Routes:
  `/` new chat, `/s/:sessionId` existing session, `/memory` graph page.
- `pages/ChatPage.tsx` — SSE event reducer building a `Turn` (phase, trace entries,
  streamed answer, recall chips, memory delta, metrics). On completion the URL is
  updated with `history.replaceState` to avoid remounting mid-stream.
- `components/ActivityTrace.tsx` — collapsible live trace (auto-collapses when the
  run finishes). `RunPanel.tsx` — right rail: phase stepper, recall, memory delta,
  metrics. `Composer.tsx` — input with light/deep mode toggle.
- `pages/MemoryPage.tsx` — stats header, legend, entity inspector, event feed, and
  `GrowthTimeline` (SVG chart + scrub slider; sets a visible-node cutoff by
  `created_at` to replay growth).
- `components/MemoryGraphCanvas.tsx` — d3-force simulation rendered to canvas with
  manual pan/zoom/drag/hover/click (no d3-zoom); nodes sized by mentions + degree,
  ghosted when outside the timeline cutoff.

### Conventions

- Tailwind v4 theme tokens live in `src/index.css` (`--color-ink-*` dark palette,
  Geist fonts). Dark-only UI.
- Backend tests (`backend/tests/`) use in-memory SQLite with a `FakeAgentService` /
  `FakeExtractor` overriding FastAPI deps — see `conftest.py`. Ruff ignores
  `B008` (FastAPI Depends) and `BLE001`.
