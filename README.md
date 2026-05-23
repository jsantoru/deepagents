# DeepAgents Chat Platform

Monorepo for a Python DeepAgents backend and a React/Vite frontend. The project starts as a simple chat agent with Tavily web search, PostgreSQL-backed persistence, automated tests, and an admin dashboard for costs, latency, and token usage.

## Stack

- Python 3.12
- FastAPI
- LangChain DeepAgents
- Tavily search
- PostgreSQL
- React 19 + Vite
- shadcn/ui
- Pytest + Vitest

## Project layout

- `backend/` FastAPI service, DeepAgents integration, persistence, and admin APIs
- `frontend/` React app with chat UI and metrics dashboard
- `docker-compose.yml` local PostgreSQL, backend, and frontend services

## Local setup

### 1. Configure env files

```bash
cd backend
copy .env.example .env

cd ..\frontend
copy .env.example .env
```

Set at least in `backend/.env`:

- `OPENAI_API_KEY`
- `TAVILY_API_KEY`

### 2. Start the full stack with Docker Compose

```bash
docker compose up --build
```

Services:

- frontend: `http://localhost:5173`
- backend: `http://localhost:8000`
- postgres: `localhost:5432`

### 3. Run the backend locally without Docker if needed

```bash
cd backend
uv python install 3.12
uv sync

uv run uvicorn deepagents_app.main:app --reload --port 8000
```

### 4. Run the frontend locally without Docker if needed

```bash
cd frontend
npm install
npm run dev
```

The frontend expects the backend at `http://localhost:8000/api/v1` by default.

## Tests

Backend:

```bash
cd backend
uv run ruff check
uv run pytest
```

Frontend:

```bash
cd frontend
npm run lint
npm run test
npm run build
```

## Current capabilities

- Chat endpoint backed by DeepAgents and Tavily search
- Persisted conversations, messages, and run metrics
- Admin API for aggregate metrics and recent runs
- Chat UI with tracked responses
- Dashboard for conversations, runs, estimated spend, latency, and token trends
