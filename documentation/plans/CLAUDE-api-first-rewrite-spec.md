# DeepAgents — Rewrite Design Spec

## Philosophy

The current implementation treats the HTTP connection as the unit of execution. If the connection drops, observability drops with it. Reconnection is bolted on after the fact.

The rewrite inverts this: **execution is primary, delivery is a projection**. A turn exists independently of any HTTP connection. The event log is the source of truth. SSE — added in Phase 2 — is a streaming read of that log from wherever the client left off. A new connection replays from the beginning; a reconnect replays from a sequence offset. The logic is identical.

### Core principles

1. **Append-only event log is the source of truth.** No dual storage. `trace_data` JSON columns do not exist. Reads and writes both go to the same `run_events` table.
2. **The HTTP layer never owns execution.** A request creates a turn and returns immediately. The worker owns the run lifetime.
3. **One canonical read path per resource.** No "reconstruct from raw tables at query time" patterns. Dedicated queries for each read shape.
4. **Typed event payloads.** Events have explicit types with known payloads. No merging heuristics on the consumer side.
5. **Sequence numbers are DB-generated.** No `max(sequence) + 1` in application code.
6. **Fail fast on misconfiguration.** Missing API keys abort startup, not the first request.

---

## Phase 1: API Only

Phase 1 ships a complete, production-quality REST API with no frontend and no SSE. Every feature is accessible via `curl`. Tests run without a browser.

---

## Data Model

### `conversations`

```sql
CREATE TABLE conversations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

No `title` column. Titles are derived at read time from the first turn's user message. If we decide to store them later, that is an additive migration.

### `turns`

One row per user→agent exchange. Replaces the current `AgentRun` + `Message` (user) + `Message` (assistant) triad.

```sql
CREATE TABLE turns (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id),
    position        INTEGER NOT NULL,               -- ordinal within conversation, 1-based
    status          TEXT NOT NULL DEFAULT 'pending', -- pending | running | completed | failed | cancelled
    research_mode   TEXT NOT NULL DEFAULT 'standard',
    user_message    TEXT NOT NULL,
    answer          TEXT,                           -- NULL until status = completed
    model_name      TEXT,                           -- NULL until agent responds
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    total_tokens    INTEGER NOT NULL DEFAULT 0,
    search_calls    INTEGER NOT NULL DEFAULT 0,
    latency_ms      INTEGER,                        -- NULL until completed
    cost_usd        NUMERIC(12, 8) NOT NULL DEFAULT 0,
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,

    UNIQUE (conversation_id, position)
);

CREATE INDEX idx_turns_conversation_id ON turns(conversation_id);
CREATE INDEX idx_turns_status ON turns(status) WHERE status IN ('pending', 'running');
```

`position` is assigned by the application when creating a turn. See [Turn Creation](#turn-creation) for the locking strategy.

`status` transitions:

```
pending → running → completed
                 → failed
                 → cancelled
pending → cancelled  (cancelled before worker picks it up)
```

### `attachments`

```sql
CREATE TABLE attachments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    turn_id     UUID NOT NULL REFERENCES turns(id),
    position    INTEGER NOT NULL,   -- ordering within the turn
    name        TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    content     TEXT NOT NULL,      -- full UTF-8 text content
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (turn_id, position)
);

CREATE INDEX idx_attachments_turn_id ON attachments(turn_id);
```

### `run_events`

Append-only. `id` is a `BIGSERIAL` — monotonically increasing across the entire table, DB-assigned, no application involvement.

```sql
CREATE TABLE run_events (
    id         BIGSERIAL PRIMARY KEY,    -- global monotonic sequence
    turn_id    UUID NOT NULL REFERENCES turns(id),
    type       TEXT NOT NULL,
    payload    JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_run_events_turn_id ON run_events(turn_id);
CREATE INDEX idx_run_events_turn_id_id ON run_events(turn_id, id);
```

No `sequence` column separate from `id`. Use `id` directly as the cursor for pagination and SSE replay. `WHERE turn_id = $1 AND id > $2 ORDER BY id` is the only query shape needed.

---

## Event Schema

Events have three categories: **agent progress**, **tool lifecycle**, and **control**.

### Agent progress

```
type: "thinking"
payload: { "content": "<agent's intermediate reasoning text>" }
```

Emitted as the agent narrates its research steps between tool calls. Replaces the current `assistant` / `assistant_delta` split — the backend accumulates the full thinking content and emits one event when a reasoning segment is complete. No delta merging on the client.

### Tool lifecycle

```
type: "search_call"
payload: {
    "query": "...",
    "topic": "general" | "news" | "finance",
    "max_results": 5
}

type: "search_result"
payload: {
    "query": "...",
    "results": [
        { "title": "...", "url": "...", "snippet": "..." }
    ]
}

type: "tool_error"
payload: {
    "tool_name": "internet_search",
    "message": "..."
}
```

These are semantically typed. The client knows what a `search_call` means without inspecting content or metadata heuristics.

### Control

```
type: "done"
payload: { "status": "completed" | "failed" | "cancelled" }
```

Emitted by the SSE layer (Phase 2), not the worker. Signals that the stream is closing and what terminal state was reached. The final answer is not in this event — it is fetched from `GET /turns/{id}`.

The answer is **not** a stream event. It lives on `turns.answer`. This eliminates the current `final` event type and its ambiguity.

---

## Agent Service Interface

The agent service emits typed events and returns a typed result. No `raw_payload`, no dict introspection, no `getattr` fallbacks.

```python
from dataclasses import dataclass
from typing import Protocol

@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str

@dataclass
class ThinkingEvent:
    content: str

@dataclass
class SearchCallEvent:
    query: str
    topic: str = "general"
    max_results: int = 5

@dataclass
class SearchResultEvent:
    query: str
    results: list[SearchResult]

@dataclass
class ToolErrorEvent:
    tool_name: str
    message: str

AgentEvent = ThinkingEvent | SearchCallEvent | SearchResultEvent | ToolErrorEvent

@dataclass
class TurnResult:
    answer: str
    model_name: str
    input_tokens: int
    output_tokens: int
    total_tokens: int
    search_calls: int

class AgentService(Protocol):
    async def run(
        self,
        user_message: str,
        attachments: list[Attachment],
        history: list[HistoryTurn],
        research_mode: ResearchMode,
        on_event: Callable[[AgentEvent], Awaitable[None]],
    ) -> TurnResult: ...
```

`HistoryTurn` is a lightweight read model: `(user_message, answer, attachments)`. The service is responsible for building the prompt; the orchestration layer is responsible for loading history from the DB and passing it in.

The `deepagents` library adapter maps LangChain stream events into the typed `AgentEvent` union. That mapping lives entirely inside the adapter and is not visible to anything else.

---

## Phase 1: REST API

### Base URL

`/api/v1`

### Error format

All errors return the same shape:

```json
{
    "error": "turn_not_found",
    "message": "Turn abc123 does not exist.",
    "status": 404
}
```

Error codes are snake_case strings, not HTTP status phrases. This gives clients something stable to `switch` on without parsing message text.

Standard codes:
- `not_found` — resource does not exist
- `conflict` — state conflict (e.g. cancelling an already-completed turn)
- `validation_error` — request body failed validation
- `internal_error` — unhandled server error

### Endpoints

---

#### `POST /conversations`

Create a new conversation.

**Request body:** empty or `{}`

**Response `201`:**
```json
{
    "id": "uuid",
    "created_at": "2026-05-24T10:00:00Z"
}
```

---

#### `GET /conversations`

List conversations, most-recently-active first.

**Query params:**
- `limit` — int, 1–100, default 50
- `before` — conversation ID to paginate before (cursor-based)

**Response `200`:**
```json
{
    "conversations": [
        {
            "id": "uuid",
            "title": "Compare the latest US inflation...",
            "preview": "Based on current data, the three indicators show...",
            "turn_count": 3,
            "last_turn_at": "2026-05-24T10:01:00Z",
            "active_turn": null
        }
    ],
    "next_cursor": "uuid or null"
}
```

`title` — first 60 characters of the first turn's `user_message`, ellipsized.
`preview` — first 140 characters of the most recent turn's `answer`.
`active_turn` — present and non-null only when a turn is in `pending` or `running` status:

```json
"active_turn": {
    "id": "uuid",
    "status": "running"
}
```

This is computed with two queries: one `SELECT` for conversations, one `SELECT DISTINCT ON (conversation_id)` for active turns. Not N+1.

---

#### `GET /conversations/{id}`

Full conversation detail with all turns.

**Response `200`:**
```json
{
    "id": "uuid",
    "created_at": "2026-05-24T09:58:00Z",
    "title": "Compare the latest US inflation...",
    "turns": [
        {
            "id": "uuid",
            "position": 1,
            "status": "completed",
            "research_mode": "standard",
            "user_message": "Compare the latest US inflation...",
            "answer": "# Macroeconomic Indicators...",
            "attachments": [],
            "metrics": {
                "model_name": "openai:gpt-5-nano",
                "latency_ms": 34200,
                "input_tokens": 1840,
                "output_tokens": 920,
                "total_tokens": 2760,
                "search_calls": 4,
                "cost_usd": 0.000506
            },
            "created_at": "2026-05-24T09:58:05Z",
            "started_at": "2026-05-24T09:58:06Z",
            "completed_at": "2026-05-24T10:00:20Z"
        }
    ],
    "active_turn": null
}
```

Events are **not** included in this response. Events are fetched separately via `GET /turns/{id}/events`. This keeps the conversation detail response bounded in size regardless of how many events a turn generated.

---

#### `POST /conversations/{id}/turns`

Create a new turn (enqueues the agent run).

**Request body:**
```json
{
    "message": "string, 1–32000 chars",
    "research_mode": "standard",
    "attachments": [
        {
            "name": "report.pdf.txt",
            "mime_type": "text/plain",
            "size_bytes": 4821,
            "content": "full UTF-8 text..."
        }
    ]
}
```

Attachment constraints (same as current):
- Max 6 attachments per turn
- Max 200 000 bytes per attachment
- Max 600 000 bytes total across all attachments
- Extension must be in the allowed set (`.txt`, `.py`, `.ts`, etc.)

**Response `202`:**
```json
{
    "id": "uuid",
    "conversation_id": "uuid",
    "position": 2,
    "status": "pending",
    "research_mode": "standard",
    "user_message": "string",
    "created_at": "2026-05-24T10:01:00Z"
}
```

`202 Accepted` signals that the run has been queued but not yet started. The client polls `GET /turns/{id}` or connects to the event stream to follow progress.

**Side effects:**
1. Validate conversation exists (404 if not).
2. Validate no other turn for this conversation is `pending` or `running` (409 if so — one active turn per conversation at a time).
3. Assign `position = MAX(position) + 1` for this conversation (see [Turn Creation](#turn-creation)).
4. Persist turn + attachments in a single transaction.
5. Enqueue the worker task.

**Turn Creation**

Position assignment uses `SELECT ... FOR UPDATE` on the conversation row to prevent two concurrent requests from assigning the same position:

```sql
BEGIN;
SELECT id FROM conversations WHERE id = $1 FOR UPDATE;
INSERT INTO turns (conversation_id, position, ...) 
    VALUES ($1, (SELECT COALESCE(MAX(position), 0) + 1 FROM turns WHERE conversation_id = $1), ...);
COMMIT;
```

This is a short lock on one row. Acceptable for a chat app where concurrent turn creation in the same conversation is pathological rather than normal.

---

#### `GET /turns/{id}`

Get a single turn by ID (does not require the conversation ID in the path — turns have globally unique IDs).

**Response `200`:**
```json
{
    "id": "uuid",
    "conversation_id": "uuid",
    "position": 2,
    "status": "completed",
    "research_mode": "standard",
    "user_message": "string",
    "answer": "string or null",
    "attachments": [...],
    "metrics": { ... },
    "error_message": null,
    "created_at": "...",
    "started_at": "...",
    "completed_at": "..."
}
```

`answer` is null when `status` is `pending` or `running`. `metrics` fields are 0/null until `completed`.

---

#### `DELETE /turns/{id}`

Cancel a turn. No-ops gracefully if the turn is already in a terminal state.

**Response `200`:**
```json
{ "cancelled": true }
```

**Response `200`** (already terminal):
```json
{ "cancelled": false }
```

Never returns 4xx for "already completed" — that is not an error, it is a harmless race.

---

#### `GET /turns/{id}/events`

Phase 1: returns the full event log as JSON.

**Query params:**
- `after_id` — bigint, return only events with `id > after_id` (default 0)

**Response `200`:**
```json
{
    "events": [
        {
            "id": 142,
            "type": "thinking",
            "payload": { "content": "Found 4 sources on X — now cross-checking claims about Y." },
            "created_at": "2026-05-24T10:01:03Z"
        },
        {
            "id": 143,
            "type": "search_call",
            "payload": { "query": "US CPI June 2026", "topic": "news", "max_results": 5 },
            "created_at": "2026-05-24T10:01:05Z"
        }
    ],
    "turn_status": "running",
    "next_after_id": 143
}
```

`turn_status` tells the client whether to poll again. If `completed`, `failed`, or `cancelled`, all events have been written and no further polling is needed. `next_after_id` is the `id` of the last event returned, ready to pass back as `after_id` on the next poll.

In Phase 1, clients that want live updates poll this endpoint every 1–2 seconds with `after_id`. No SSE required.

---

#### Admin endpoints

```
GET /admin/overview
GET /admin/turns?limit=20
```

`/admin/overview`:
```json
{
    "conversation_count": 12,
    "turn_count": 34,
    "total_tokens": 189430,
    "total_cost_usd": 0.024781,
    "average_latency_ms": 28340
}
```

These are aggregate queries over the `turns` table. No join gymnastics required.

`/admin/turns` returns a list of recent completed turns with a preview of the answer and full metrics. Backed by a single query with a join to conversations for context.

---

## Execution Model

### Worker

The worker is an `asyncio.Task` created when a turn is enqueued. It is started within the same process (Phase 1). The critical distinction from the current design: **the worker writes to the DB; it has no in-memory subscriber queues**.

```python
async def execute_turn(turn_id: str, agent_service: AgentService) -> None:
    session_factory = get_session_factory()

    # 1. Mark running
    async with session_factory() as session:
        turn = await session.get(Turn, turn_id)
        if turn is None or turn.status != "pending":
            return
        if turn_id in _cancel_requested:
            await _mark_cancelled(session, turn)
            return
        turn.status = "running"
        turn.started_at = now()
        await session.commit()

    # 2. Load history and attachments
    history = await load_conversation_history(turn.conversation_id, before_position=turn.position)

    # 3. Run agent
    started_at = perf_counter()
    try:
        result = await agent_service.run(
            user_message=turn.user_message,
            attachments=await load_attachments(turn.id),
            history=history,
            research_mode=turn.research_mode,
            on_event=lambda event: persist_event(turn_id, event),
        )
        latency_ms = int((perf_counter() - started_at) * 1000)

        # 4. Mark completed
        async with session_factory() as session:
            turn = await session.get(Turn, turn_id)
            turn.status = "completed"
            turn.answer = result.answer
            turn.model_name = result.model_name
            turn.input_tokens = result.input_tokens
            turn.output_tokens = result.output_tokens
            turn.total_tokens = result.total_tokens
            turn.search_calls = result.search_calls
            turn.latency_ms = latency_ms
            turn.cost_usd = estimate_cost(result.model_name, result.input_tokens, result.output_tokens)
            turn.completed_at = now()
            await session.commit()

    except asyncio.CancelledError:
        async with session_factory() as session:
            turn = await session.get(Turn, turn_id)
            turn.status = "cancelled"
            turn.completed_at = now()
            await session.commit()
        raise

    except Exception as exc:
        async with session_factory() as session:
            turn = await session.get(Turn, turn_id)
            turn.status = "failed"
            turn.error_message = str(exc)
            turn.completed_at = now()
            await session.commit()
```

### Event persistence

```python
async def persist_event(turn_id: str, event: AgentEvent) -> None:
    event_type, payload = serialize_event(event)
    async with get_session_factory()() as session:
        session.add(RunEvent(turn_id=turn_id, type=event_type, payload=payload))
        await session.commit()
    # Phase 2: pg_notify here
```

This still opens one session per event. Acceptable for Phase 1. For Phase 2 (or before), batch events with a short-lived buffer (100ms flush interval) to collapse adjacent `thinking` events. The connection-per-event concern applies but is manageable with PostgreSQL's connection pool at typical agent event rates (5–20 events per run).

### Startup recovery

On app startup, find turns stuck in `running` or `pending` and mark them `failed`. This prevents stale status from persisting across deploys.

```python
async def recover_stuck_turns() -> None:
    async with get_session_factory()() as session:
        result = await session.execute(
            select(Turn).where(Turn.status.in_(["pending", "running"]))
        )
        for turn in result.scalars():
            turn.status = "failed"
            turn.error_message = "Server restarted during execution."
            turn.completed_at = now()
        await session.commit()
```

Called in `lifespan` before `yield`. Logged so operators know when recovery happened.

### Cancellation

Cancellation is stored as a set of turn IDs on the runner singleton. The worker checks this set before transitioning to `running` and at yield points during streaming. The HTTP handler writes to this set and also cancels the `asyncio.Task`:

```python
async def cancel_turn(turn_id: str) -> bool:
    _cancel_requested.add(turn_id)
    task = _running_tasks.get(turn_id)
    if task and not task.done():
        task.cancel()
        return True
    return False
```

This is the same single-process constraint as the current design. Acceptable for Phase 1. Phase 2 replaces `_cancel_requested` with a DB column (`turns.cancel_requested BOOLEAN DEFAULT FALSE`) checked by the worker on each event, enabling multi-process operation.

---

## Schema Management

Alembic from day one. No `create_all` in production paths.

Directory layout:
```
backend/
  alembic/
    env.py
    versions/
      0001_initial_schema.py
  alembic.ini
```

`alembic upgrade head` runs in the Docker entrypoint before the app starts. Local dev also uses this — `create_all` is not used anywhere.

---

## Configuration

`pydantic-settings` as now, but with validation:

```python
class Settings(BaseSettings):
    database_url: str
    openai_api_key: str = Field(min_length=1)   # fails startup if empty
    tavily_api_key: str = Field(min_length=1)   # fails startup if empty
    agent_model: str = "openai:gpt-5-nano"
    agent_max_search_results: int = Field(default=5, ge=1, le=20)
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])
```

No silent empty defaults for secrets.

---

## Project Layout

```
backend/
  src/
    app/
      api/
        routes/
          conversations.py   # /conversations endpoints
          turns.py           # /turns endpoints
          admin.py           # /admin endpoints
        deps.py
      core/
        config.py
        db.py
        pricing.py
      models/
        conversation.py
        turn.py
        attachment.py
        run_event.py
      repositories/
        conversation_repo.py
        turn_repo.py
        event_repo.py
      services/
        agent_service.py     # Protocol + DeepAgents adapter
        turn_executor.py     # Worker logic
        runner.py            # Task management
      schemas/
        conversations.py
        turns.py
        events.py
        admin.py
      main.py
  alembic/
  tests/
```

`repositories/` owns all DB queries. `services/` owns business logic and orchestration. `api/routes/` owns HTTP concerns only (parsing, validation, response shaping).

---

## Type Contract

FastAPI generates an OpenAPI schema automatically. In Phase 2, the frontend generates TypeScript types from this schema at build time:

```bash
npx openapi-typescript http://localhost:8000/openapi.json -o src/lib/api-types.ts
```

No hand-maintained TypeScript interfaces. One source of truth.

---

## Phase 2: SSE + UI

### Events endpoint upgrade

The `GET /turns/{id}/events` endpoint gains SSE support gated on the `Accept` header:

```python
@router.get("/turns/{turn_id}/events")
async def turn_events(
    turn_id: str,
    after_id: int = 0,
    request: Request,
):
    accepts_sse = "text/event-stream" in request.headers.get("accept", "")

    if not accepts_sse:
        # Phase 1 behavior unchanged
        events = await event_repo.list(turn_id, after_id=after_id)
        turn = await turn_repo.get(turn_id)
        return {"events": events, "turn_status": turn.status, "next_after_id": ...}

    return StreamingResponse(_event_stream(turn_id, after_id), media_type="text/event-stream")
```

The SSE generator:

```python
async def _event_stream(turn_id: str, after_id: int):
    # 1. Replay history
    last_id = after_id
    for event in await event_repo.list(turn_id, after_id=last_id):
        yield _sse("event", event)
        last_id = event.id

    # 2. Check if already terminal
    turn = await turn_repo.get(turn_id)
    if turn.status in ("completed", "failed", "cancelled"):
        yield _sse("done", {"status": turn.status})
        return

    # 3. Tail live events via Postgres LISTEN/NOTIFY
    async with pg_listen(f"turn_{turn_id}") as notifications:
        while True:
            turn = await turn_repo.get(turn_id)
            if turn.status in ("completed", "failed", "cancelled"):
                for event in await event_repo.list(turn_id, after_id=last_id):
                    yield _sse("event", event)
                    last_id = event.id
                yield _sse("done", {"status": turn.status})
                return

            try:
                await asyncio.wait_for(notifications.get(), timeout=30)
                for event in await event_repo.list(turn_id, after_id=last_id):
                    yield _sse("event", event)
                    last_id = event.id
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
```

The worker calls `pg_notify(f"turn_{turn_id}")` after each event insert. The SSE handler wakes up, reads new events from DB, streams them. No in-memory queue. No `BackgroundAgentRunner`. The DB is the buffer.

SSE event format:
```
event: event
data: {"id": 143, "type": "search_call", "payload": {...}, "created_at": "..."}

event: done
data: {"status": "completed"}
```

Two event names: `event` (a run event) and `done` (terminal signal). Simple.

### Reconnection

```
GET /turns/{id}/events?after_id=142
```

Replays from ID 143 onwards, then tails. Identical code path. The client tracks `last_event_id` from each received event and passes it on reconnect.

### UI architecture

The UI is a pure consumer of the REST + SSE API. It has no knowledge of internal streaming mechanics.

**Component tree:**
```
<App>
  <ConversationLayout>
    <Sidebar>
      <ConversationList />         // GET /conversations
    </Sidebar>
    <ChatView>
      <TurnList>
        <TurnItem />               // renders user message + answer + metrics
      </TurnList>
      <LiveTurnView>               // only when a turn is streaming
        <EventTimeline />          // renders run_events as they arrive
      </LiveTurnView>
      <MessageComposer />          // POST /conversations/{id}/turns
    </ChatView>
  </ConversationLayout>
  <AdminView />                    // GET /admin/*
```

**State model — one hook per concern:**

```typescript
// Conversation list — no polling. Refresh on navigation and after turn creation.
function useConversationList(): { conversations, isLoading, refresh }

// Single conversation — fetched once on mount, not polled.
function useConversation(id: string): { conversation, isLoading }

// Single turn — fetched when stream closes to get final answer.
function useTurn(id: string): { turn, isLoading, refetch }

// Live event stream — connects to SSE, returns events array and stream status.
function useEventStream(turnId: string | null): {
    events: RunEvent[],
    status: 'idle' | 'connecting' | 'streaming' | 'done' | 'error',
    lastEventId: number,
}
```

`useEventStream` uses the browser's native `EventSource` API. No custom SSE parser.

```typescript
function useEventStream(turnId: string | null) {
    const [events, setEvents] = useState<RunEvent[]>([])
    const [status, setStatus] = useState<StreamStatus>('idle')

    useEffect(() => {
        if (!turnId) return
        setStatus('connecting')
        const source = new EventSource(`/api/v1/turns/${turnId}/events`)

        source.addEventListener('event', (e) => {
            const event = JSON.parse(e.data) as RunEvent
            setEvents(prev => [...prev, event])
            setStatus('streaming')
        })

        source.addEventListener('done', (e) => {
            const { status } = JSON.parse(e.data)
            setStatus(status === 'completed' ? 'done' : 'error')
            source.close()
        })

        source.onerror = () => {
            setStatus('error')
            source.close()
        }

        return () => source.close()
    }, [turnId])

    return { events, status }
}
```

No `AbortController`, no chunk parser, no `reconnectChatRun` function. `EventSource` handles reconnection natively using the `Last-Event-ID` header if we set `id:` fields in the SSE output.

**Turn lifecycle in the UI:**

```
user submits → POST /turns → get back { id, status: "pending" }
             → activate useEventStream(turn.id)
             → render EventTimeline from events
             → on "done" event → refetch useTurn(turn.id) → render answer
             → refresh useConversationList()
```

The answer is never in the stream. After `done`, one `GET /turns/{id}` fetches the complete turn with answer and metrics. Clean separation.

**No sidebar polling.** The sidebar refreshes after: (a) creating a new conversation, (b) posting a new turn, (c) receiving the `done` SSE event. Zero interval timers.

---

## Migration from Current Implementation

The current `AgentRun + Message + TraceEvent` model maps to the new model as:

| Current | New |
|---|---|
| `AgentRun` | `turns` (status, metrics) |
| `Message` (user) | `turns.user_message` |
| `Message` (assistant) | `turns.answer` |
| `MessageAttachment` | `attachments` |
| `TraceEvent` | `run_events` |
| `AgentRun.trace_data` | deleted |
| `BackgroundAgentRunner` | `runner.py` (no subscriber queues) |

Data can be migrated via a one-time script: for each `AgentRun`, create a `turn` with `user_message` from the preceding user `Message`, `answer` from the following assistant `Message`, and copy `TraceEvent` rows to `run_events`.

---

## Out of Scope (for both phases)

- Authentication / user model — single-user deployment assumed. If multi-user is needed, it is an orthogonal concern added later (API key in headers → user lookup → scope all queries by user_id).
- Rate limiting — add at the reverse proxy (nginx, Caddy) layer.
- Attachment binary upload — attachments are text only, sent inline in the request body.
- Turn editing or branching — linear conversation only.
- Pricing updates — pricing table is hardcoded. Add an external config file or environment override if prices change frequently.
