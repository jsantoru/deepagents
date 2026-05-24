# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DeepAgents Chat Platform is a monorepo combining a Python FastAPI backend with a React/Vite frontend. The backend uses LangChain's DeepAgents framework to create an OSIR-style (Open Source Intelligence Research) agent with web search capabilities via Tavily. All conversations, messages, and agent runs are persisted to PostgreSQL with detailed metrics tracking (tokens, cost, latency, search calls).

## Commands

### Full Stack (Docker Compose)
```bash
# Start all services (postgres, backend, frontend)
docker compose up --build

# Services will be available at:
# - frontend: http://localhost:5173
# - backend: http://localhost:8000
# - postgres: localhost:5432
```

### Backend Development
```bash
cd backend

# Install dependencies (uses uv package manager)
uv sync

# Run backend server
uv run uvicorn deepagents_app.main:app --reload --port 8000

# Run linter
uv run ruff check

# Run all tests
uv run pytest

# Run specific test file
uv run pytest tests/test_chat.py

# Run specific test function
uv run pytest tests/test_chat.py::test_function_name
```

### Frontend Development
```bash
cd frontend

# Install dependencies
npm install

# Run dev server
npm run dev

# Run linter
npm run lint

# Run tests
npm run test

# Run tests in watch mode
npm run test:watch

# Build for production
npm run build
```

## Architecture

### Backend Structure

**Core application flow:**
- `main.py` → FastAPI app with CORS, lifespan (init_db, dispose_engine), and API router
- `api/routes.py` → All endpoints: `/chat`, `/chat/stream`, `/admin/*`, `/conversations/*`
- `api/deps.py` → Dependency injection for agent service and database sessions
- `core/config.py` → Pydantic settings loaded from `.env`
- `core/db.py` → SQLAlchemy async engine and session factory

**Agent execution pattern:**
- `AgentService` (abstract base in `services/agent_service.py`)
  - `DeepAgentsService` implementation wraps LangChain's `create_deep_agent`
  - Builds Tavily `internet_search` tool with configurable max results
  - Maintains separate agent instances per research mode (light/standard)
  - Research modes control system prompt depth and time expectations
- System prompts in `agent_service.py`:
  - `ANALYST_SYSTEM_PROMPT_BASE` defines OSIR-style analyst behavior
  - `LIGHT_RESEARCH_ADDENDUM` (under 1 min, focused)
  - `STANDARD_RESEARCH_ADDENDUM` (up to 5 min, comprehensive)
- Agent returns `AgentRunResult` with answer, trace events, tokens, model name, search calls

**Persistence and metrics:**
- `MetricsService` (`services/metrics_service.py`) orchestrates conversation lifecycle:
  1. `prepare_chat()` → Get/create conversation, save user message and attachments
  2. `build_conversation_messages()` → Load full conversation history for agent context
  3. Call agent (via `AgentService.chat()` or `stream_chat()`)
  4. `_finalize_chat()` → Persist `AgentRun` with metrics, save assistant message
- Models (`models/chat.py`):
  - `Conversation` → Top-level container
  - `AgentRun` → Metrics for each agent invocation (tokens, cost, latency, search_calls)
  - `Message` → User/assistant messages linked to conversation and optionally to run
  - `MessageAttachment` → File attachments with text content, SHA-256, order
- Cost estimation in `core/pricing.py` maps model names to token pricing

**Streaming architecture:**
- `/chat/stream` endpoint uses `StreamingResponse` with SSE
- Agent streams via `agent.astream()` with modes: `["messages", "tools", "values"]`
- Stream processor emits `ChatTraceEvent` objects for:
  - `assistant` / `assistant_delta` → Agent reasoning notes
  - `tool` / `tool_delta` / `tool_result` / `tool_error` → Tool call lifecycle
  - `final` → Complete answer (from last message in `values` mode)
- Events queued via `asyncio.Queue` and formatted as SSE in `_format_sse()`

**Database:**
- SQLAlchemy async with PostgreSQL
- Schema created automatically on app startup via `init_db()` (runs `Base.metadata.create_all`)
- No migrations framework; schema changes require manual intervention or fresh database

**Testing:**
- Tests in `backend/tests/` using pytest with `pytest-asyncio`
- `conftest.py` provides fixtures for in-memory SQLite and mock agent service
- Key test files: `test_chat.py`, `test_chat_stream.py`, `test_agent_service.py`, `test_admin.py`

### Frontend Structure

**React app with React Router:**
- `main.tsx` → Entry point, sets up `BrowserRouter`
- `App.tsx` → Routes: `/` (chat), `/admin` (metrics)
- `pages/chat-page.tsx` → Main chat interface with conversation history sidebar
- `pages/admin-page.tsx` → Metrics dashboard (overview stats, recent runs)

**API client:**
- `lib/api.ts` → All backend communication
  - `sendChatMessage()` → Non-streaming chat
  - `streamChatMessage()` → SSE streaming with callbacks
  - `fetchConversationSummaries()`, `fetchConversationDetail()` → History
  - `fetchAdminOverview()`, `fetchAdminRuns()` → Metrics
- API base URL from `VITE_API_BASE_URL` env var (defaults to `http://localhost:8000/api/v1`)

**Research modes:**
- Two modes: `light` (fast, < 1 min) and `standard` (thorough, up to 5 min)
- Controlled by system prompt addendum in backend
- Selected via UI in `chat-page.tsx`

**UI components:**
- Uses shadcn/ui components in `components/ui/`
- Tailwind CSS (v4) for styling
- `lucide-react` for icons
- `react-markdown` with `remark-gfm` for rendering agent responses

### Key Patterns

**Conversation continuity:**
- User can continue conversations by passing `conversation_id`
- Backend loads full message history and sends to agent as context
- Attachments are persisted per-message and reconstructed for multi-turn context

**Attachment handling:**
- Frontend sends text content directly in `ChatAttachment` objects
- Backend hashes with SHA-256 and stores as `MessageAttachment`
- On subsequent turns, attachments are re-formatted into user message for agent

**Research mode selection:**
- Light mode: narrow search, concise, under 1 minute
- Standard mode: broader search, corroboration, up to 5 minutes
- Agent instances are cached per mode in `DeepAgentsService._agents`

**Trace events:**
- Provide transparency into agent reasoning and tool usage
- Captured during streaming and also extracted from final agent result
- Frontend displays them in collapsible sections during agent execution

## Environment Variables

Backend requires (set in `.env`):
- `OPENAI_API_KEY` → For LLM model
- `TAVILY_API_KEY` → For web search tool
- `DATABASE_URL` → PostgreSQL connection (defaults work with docker-compose)
- `AGENT_MODEL` → Model name (default: `openai:gpt-5-nano`)
- `AGENT_MAX_SEARCH_RESULTS` → Max results per search (default: 5)

Frontend optional:
- `VITE_API_BASE_URL` → Backend API URL (defaults to `http://localhost:8000/api/v1`)

## Database Schema

**Relationships:**
- `Conversation` 1:N `AgentRun`
- `Conversation` 1:N `Message`
- `Conversation` 1:N `MessageAttachment`
- `AgentRun` 1:N `Message` (messages optionally link to the run that generated them)
- `Message` 1:N `MessageAttachment`

**Key fields:**
- `AgentRun` tracks: model_name, latency_ms, input/output/total tokens, estimated_cost_usd, search_calls
- `Message` has: role (user/assistant), content (text), conversation_id, optional run_id
- `MessageAttachment` has: name, mime_type, size_bytes, sha256, text_content, order_index
