# Cortex

A deep-research agent that **remembers**. Cortex pairs a LangChain DeepAgents research
loop (with Tavily web search) with a lightweight knowledge-graph memory: after every
exchange it extracts entities and typed relations, merges them into a graph stored in
SQLite, and recalls the relevant subgraph into the agent's context on future turns —
across sessions.

The web UI is a minimal, codex-style chat with two live visualizations:

- **Agent state** — a live trace of each run: memory recall, reasoning notes, every web
  search with its sources, the synthesized answer, and the resulting memory update.
- **Memory graph** — a force-directed view of everything Cortex knows, with a growth
  timeline you can scrub to replay how the graph evolved session by session.

## Stack

- **Backend** — Python 3.12, FastAPI, SQLite (SQLAlchemy async + aiosqlite),
  LangChain DeepAgents, Tavily search, SSE streaming.
- **Memory** — entity/relation extraction via LLM, graph tables (`entities`,
  `relations`) plus an append-only `graph_events` log powering the evolution timeline.
- **Frontend** — React 19, Vite, Tailwind v4, lucide icons, d3-force graph on canvas.

## Quick start

```bash
cp .env.example .env      # add OPENAI_API_KEY and TAVILY_API_KEY
docker compose up --build
# frontend: http://localhost:5173  ·  backend: http://localhost:8000
```

### Local development

```bash
# backend
cd backend
cp .env.example .env      # add your keys
uv sync
uv run uvicorn cortex.main:app --reload --port 8000
uv run pytest             # tests
uv run ruff check         # lint

# frontend
cd frontend
npm install
npm run dev               # http://localhost:5173
npm run build             # typecheck + production build
```

## How memory works

1. **Recall** — the user's message is matched against entity names in the graph; hits
   plus their 1-hop neighborhood are rendered into a `LONG-TERM MEMORY` block in the
   agent's system prompt.
2. **Research** — the deep agent plans, searches the web via Tavily, and synthesizes a
   cited answer, streaming every step over SSE.
3. **Memorize** — an extraction pass pulls entities (person, organization, product,
   technology, place, event, concept) and typed relations from the exchange. New
   knowledge is inserted; repeated knowledge reinforces mention counts and edge
   weights. Every mutation is logged to `graph_events` with session/run provenance.

The memory page reads `/api/memory/graph`, `/api/memory/timeline`, and
`/api/memory/events` to draw the graph, the cumulative growth chart, and the replay
slider.

## API surface

| Endpoint | Purpose |
| --- | --- |
| `POST /api/chat/stream` | Run a research turn, streaming SSE trace events |
| `GET /api/sessions` / `GET,DELETE /api/sessions/{id}` | Session history |
| `GET /api/memory/graph` | Full knowledge graph (nodes + edges) |
| `GET /api/memory/timeline` | Cumulative graph size after each run |
| `GET /api/memory/events` | Recent graph mutations |
| `GET /api/memory/stats` | Totals + most-mentioned entities |
| `GET /api/memory/entities/{id}` | Entity detail: neighbors, relations, history |
