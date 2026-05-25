# DeepAgents — Revised Design Spec

*Synthesized from the Claude and Codex API-first rewrite plans. Where they disagree, this document makes a decision and explains it.*

---

## Philosophy

**Execution is primary. Delivery is a projection.**

A run exists independently of any HTTP connection. The event log is the only canonical trace store. SSE, added in Phase 2, is a streaming read of that log — a new connection replays from sequence 0, a reconnect replays from a known offset. The code path is identical.

The system has four runtime roles:

1. **API service** — accepts commands, serves read models and event streams, never owns long-running execution
2. **Executor** — claims pending runs, invokes the agent, appends events, finalizes outcomes
3. **Database** — stores all domain state, the event log, and read-model projections
4. **Clients** — Phase 1: scripts, tests, curl; Phase 2: web UI

---

## Core Principles

1. **Append-only event log is the single source of truth.** No `trace_data` JSON columns. No duplicate event storage. One table.
2. **Turn and Run are separate concepts.** A turn is the user's submission. A run is one execution attempt. Retry creates a new run for the same turn. Both plans agree on this; the Codex plan names it more precisely.
3. **DB-generated sequence numbers.** `run_events.id` is a `BIGSERIAL` — monotonically increasing, DB-assigned. No `max(sequence) + 1` race in application code.
4. **The HTTP layer never owns execution state.** Requests enqueue work and read results. The executor writes state.
5. **Cancellation is a DB column, not an in-memory set.** `runs.cancel_requested` is `BOOLEAN` from day one. This makes cancellation multi-process safe without Redis.
6. **Auth from Phase 1.** A static bearer token is the minimum. No unauthenticated admin endpoints.
7. **Alembic from day one.** `create_all()` does not exist in the production path.
8. **Fail fast on misconfiguration.** Missing secrets abort startup.
9. **One stable event envelope.** Same shape for JSON polling and SSE streaming.

---

## What This Spec Decides (vs. the Source Plans)

| Topic | Claude plan | Codex plan | Decision |
|---|---|---|---|
| Turn/Run separation | Single `turns` table, no retry | Separate `turn` + `run`, explicit retry | **Adopt Codex.** Retry is real. One-to-one in Phase 1 by convention. |
| Event sequencing | `BIGSERIAL` id, no sequence column | Per-run `sequence` col, application-generated | **Adopt Claude.** `BIGSERIAL` eliminates the race unconditionally. |
| Cancellation mechanism | In-memory set + asyncio cancel | DB column, cooperative polling | **Adopt DB column.** Correct for multi-process, no extra work. |
| SSE endpoint shape | Content-negotiation via `Accept` header | Dedicated `/events/stream` suffix | **Adopt Codex.** Explicit is better than implicit. |
| Event envelope versioning | No version field | `schema_version` field | **Adopt Codex.** Low cost, pays forward. |
| Auth in Phase 1 | Deferred entirely | Static bearer token at minimum | **Adopt Codex.** Admin endpoints expose cost data. |
| Executor timeouts | Not specified | Mode-specific max duration | **Adopt Codex.** No timeout = infinite hang. |
| Retry | Not specified | `POST /runs/{id}/retry` | **Adopt Codex.** Worth the surface area. |
| Final answer storage | `runs.answer` column | `RunArtifact` table | **Keep `runs.answer`.** Artifacts are over-engineering for Phase 1. |
| Observability | Not specified | Structured logs + metrics list | **Adopt Codex.** Costs nothing to specify now. |
| Phase breakdown | Two phases, coarse | 1A / 1B / 1C / 2A / 2B | **Adopt Codex.** Better milestone structure. |

---

## Data Model

### `conversations`

```sql
CREATE TABLE conversations (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

No `title` column. Titles are derived at read time from the first turn's `user_message`. Add a stored title as an additive migration if needed.

### `turns`

One row per user submission. Stores the user's message, the winning answer, and the position within the conversation.

```sql
CREATE TABLE turns (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID        NOT NULL REFERENCES conversations(id),
    position        INTEGER     NOT NULL,        -- 1-based ordinal; assigned with FOR UPDATE
    user_message    TEXT        NOT NULL,
    answer          TEXT,                        -- NULL until a run completes successfully
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (conversation_id, position)
);

CREATE INDEX idx_turns_conversation_id ON turns(conversation_id);
```

Attachments belong to the turn, not the run — they are part of the user's submission and do not change across retries.

### `attachments`

```sql
CREATE TABLE attachments (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    turn_id    UUID        NOT NULL REFERENCES turns(id),
    position   INTEGER     NOT NULL,
    name       TEXT        NOT NULL,
    mime_type  TEXT        NOT NULL,
    size_bytes INTEGER     NOT NULL,
    sha256     TEXT        NOT NULL,
    content    TEXT        NOT NULL,    -- full UTF-8 text
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (turn_id, position)
);

CREATE INDEX idx_attachments_turn_id ON attachments(turn_id);
```

### `runs`

One row per execution attempt. Multiple runs can exist for one turn (retries). Phase 1 enforces at most one non-terminal run per turn at a time.

```sql
CREATE TABLE runs (
    id               UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
    turn_id          UUID           NOT NULL REFERENCES turns(id),
    conversation_id  UUID           NOT NULL REFERENCES conversations(id),  -- denormalized
    attempt          INTEGER        NOT NULL DEFAULT 1,
    status           TEXT           NOT NULL DEFAULT 'pending',
    research_mode    TEXT           NOT NULL DEFAULT 'standard',
    model_name       TEXT,                          -- NULL until executor claims
    input_tokens     INTEGER        NOT NULL DEFAULT 0,
    output_tokens    INTEGER        NOT NULL DEFAULT 0,
    total_tokens     INTEGER        NOT NULL DEFAULT 0,
    search_calls     INTEGER        NOT NULL DEFAULT 0,
    latency_ms       INTEGER,                       -- NULL until completed
    cost_usd         NUMERIC(12,8)  NOT NULL DEFAULT 0,
    error_message    TEXT,
    cancel_requested BOOLEAN        NOT NULL DEFAULT false,
    timeout_seconds  INTEGER        NOT NULL DEFAULT 600,
    created_at       TIMESTAMPTZ    NOT NULL DEFAULT now(),
    started_at       TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ,

    UNIQUE (turn_id, attempt)
);

CREATE INDEX idx_runs_turn_id         ON runs(turn_id);
CREATE INDEX idx_runs_conversation_id ON runs(conversation_id);
CREATE INDEX idx_runs_status          ON runs(status) WHERE status IN ('pending', 'running', 'claimed');
```

**Status transitions:**

```
pending → claimed → running → completed
                           → failed
                           → timed_out
                 → cancel_requested → cancelled
pending → cancel_requested → cancelled
```

`claimed` is the state between a worker picking up a run and the agent actually starting. This prevents a race where two workers claim the same run. See [Executor claiming](#executor-claiming).

`cancel_requested` is set by the API. The executor polls `runs.cancel_requested` and transitions to `cancelled` at a safe yield point.

### `run_events`

Append-only. `id` is `BIGSERIAL` — globally monotonic, DB-assigned, no application code involved.

```sql
CREATE TABLE run_events (
    id             BIGSERIAL    PRIMARY KEY,     -- global monotonic; use as cursor
    run_id         UUID         NOT NULL REFERENCES runs(id),
    type           TEXT         NOT NULL,
    schema_version INTEGER      NOT NULL DEFAULT 1,
    payload        JSONB        NOT NULL DEFAULT '{}',
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_run_events_run_id    ON run_events(run_id);
CREATE INDEX idx_run_events_run_id_id ON run_events(run_id, id);
```

The pagination query for events is always: `WHERE run_id = $1 AND id > $2 ORDER BY id`. No other query shape is needed.

### Indexes summary

```sql
-- Conversations
CREATE INDEX idx_conversations_created_at ON conversations(created_at DESC);

-- Turns (above)
-- Attachments (above)
-- Runs (above)
-- Run events (above)
```

---

## Event Schema

All events share one envelope:

```json
{
    "id": 143,
    "run_id": "uuid",
    "type": "search_call",
    "schema_version": 1,
    "payload": { ... },
    "created_at": "2026-05-24T10:01:05Z"
}
```

`id` is the `BIGSERIAL` primary key — it is the stable cursor for pagination and SSE replay.

### Event types

**Agent progress**

```
type: "thinking"
payload: { "content": "Found 4 sources — now cross-checking claims about Y." }
```

The executor accumulates the agent's intermediate reasoning text and emits one `thinking` event when a reasoning segment is complete. No delta merging required on the client in Phase 1.

Phase 2 may add `thinking_delta` events for incremental text during live streaming. These are persisted to `run_events` the same way; the SSE layer streams them without special handling.

**Tool lifecycle**

```
type: "search_call"
payload: {
    "query": "US CPI June 2026",
    "topic": "general" | "news" | "finance",
    "max_results": 5
}

type: "search_result"
payload: {
    "query": "US CPI June 2026",
    "results": [{ "title": "...", "url": "...", "snippet": "..." }]
}

type: "tool_error"
payload: {
    "tool_name": "internet_search",
    "message": "Rate limit exceeded."
}
```

**Run lifecycle events** (emitted by the executor, persisted to `run_events`)

```
type: "run.started"
payload: { "model_name": "openai:gpt-5-nano", "research_mode": "standard" }

type: "run.completed"
payload: { "latency_ms": 34200, "total_tokens": 2760 }

type: "run.failed"
payload: { "error": "Agent returned empty response." }

type: "run.cancelled"
payload: { "reason": "User requested cancellation." }

type: "run.timed_out"
payload: { "timeout_seconds": 600 }
```

**The final answer is not a stream event.** It is set on `turns.answer` when a run completes. Clients fetch it from `GET /turns/{id}` after the stream closes. This eliminates the current `final` event type and all its ambiguity.

---

## Agent Service Interface

The `deepagents` library is isolated behind one adapter. Nothing outside the adapter sees LangChain tuple shapes, stream modes, or message-role conventions.

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
class ThinkingDeltaEvent:   # Phase 2 only; worker emits if agent streams deltas
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

AgentEvent = ThinkingEvent | ThinkingDeltaEvent | SearchCallEvent | SearchResultEvent | ToolErrorEvent

@dataclass
class RunResult:
    answer: str
    model_name: str
    input_tokens: int      # summed across ALL model calls in the run, not just the last
    output_tokens: int
    total_tokens: int
    search_calls: int      # counted from normalized tool events only

class AgentAdapter(Protocol):
    async def run(
        self,
        user_message: str,
        attachments: list[Attachment],
        history: list[HistoryTurn],
        research_mode: ResearchMode,
        on_event: Callable[[AgentEvent], Awaitable[None]],
    ) -> RunResult: ...
```

`HistoryTurn` is `(user_message: str, answer: str, attachments: list[Attachment])`. The executor loads history from the DB and passes it in. The adapter builds the prompt.

Token counts must be summed across all LLM calls in the run, not read only from the final message. The current implementation only captures the last call's tokens; this is a known bug that must be fixed in the rewrite.

Search calls must be counted from normalized `SearchCallEvent` instances only — not from loose message-role checks that would miscount any future additional tools.

---

## Phase 1: REST API

### Base URL

`/api/v1`

### Authentication

All endpoints require a bearer token:

```
Authorization: Bearer <token>
```

Phase 1: static token configured via `API_SECRET_KEY` env var. Returns `401` on missing or invalid token. Admin endpoints additionally require `ADMIN_SECRET_KEY`.

This is the minimum. Multi-user principal tables are an additive concern for later.

### Error format

```json
{
    "error": "run_not_found",
    "message": "Run run_abc123 does not exist.",
    "status": 404
}
```

Standard codes: `not_found`, `conflict`, `validation_error`, `unauthorized`, `internal_error`.

---

### Conversations

#### `POST /conversations`

**Response `201`:**
```json
{ "id": "uuid", "created_at": "2026-05-24T10:00:00Z" }
```

#### `GET /conversations?limit=50&before=<cursor>`

Returns conversations most-recently-active first. Computed with two queries — one `SELECT` for conversations, one `SELECT DISTINCT ON (conversation_id)` for active runs. Not N+1.

**Response `200`:**
```json
{
    "conversations": [
        {
            "id": "uuid",
            "title": "Compare the latest US inflation...",
            "preview": "Based on current data...",
            "turn_count": 3,
            "last_turn_at": "2026-05-24T10:01:00Z",
            "active_run": { "id": "uuid", "status": "running" }
        }
    ],
    "next_cursor": "uuid or null"
}
```

`active_run` is non-null only when a run for this conversation is `pending`, `claimed`, `running`, or `cancel_requested`.

#### `GET /conversations/{id}`

Full detail with all turns and their latest run summaries. Events are **not** included — fetch separately. Keeps response size bounded.

**Response `200`:**
```json
{
    "id": "uuid",
    "created_at": "...",
    "title": "...",
    "turns": [
        {
            "id": "uuid",
            "position": 1,
            "user_message": "...",
            "answer": "# Macroeconomic Indicators...",
            "attachments": [],
            "latest_run": {
                "id": "uuid",
                "attempt": 1,
                "status": "completed",
                "metrics": {
                    "model_name": "openai:gpt-5-nano",
                    "latency_ms": 34200,
                    "input_tokens": 1840,
                    "output_tokens": 920,
                    "total_tokens": 2760,
                    "search_calls": 4,
                    "cost_usd": 0.000506
                },
                "created_at": "...",
                "started_at": "...",
                "completed_at": "..."
            },
            "created_at": "..."
        }
    ],
    "active_run": null
}
```

---

### Turns

#### `POST /conversations/{id}/turns`

Creates a turn and its first run. Returns both IDs.

**Request body:**
```json
{
    "message": "string, 1–32000 chars",
    "research_mode": "standard",
    "attachments": [
        {
            "name": "report.txt",
            "mime_type": "text/plain",
            "size_bytes": 4821,
            "content": "full UTF-8 text..."
        }
    ]
}
```

Attachment constraints: max 6, max 200,000 bytes each, max 600,000 bytes total, extension must be in the allowed set.

**Response `202`:**
```json
{
    "turn_id": "uuid",
    "run_id": "uuid",
    "conversation_id": "uuid",
    "position": 2,
    "status": "pending",
    "research_mode": "standard",
    "created_at": "2026-05-24T10:01:00Z"
}
```

`202 Accepted` — run is queued, not yet started.

**Side effects, in one transaction:**
1. `SELECT id FROM conversations WHERE id = $1 FOR UPDATE` — prevents duplicate position assignment
2. Assign `position = COALESCE(MAX(position), 0) + 1`
3. Validate no other run for this conversation is in a non-terminal status (`409` if so)
4. Insert turn + attachments
5. Insert run with `status = 'pending'`
6. Commit, then enqueue executor task

#### `GET /conversations/{id}/turns`

Lists turns in position order with latest run summary per turn.

#### `GET /turns/{id}`

Single turn with all run attempts listed, most recent first.

```json
{
    "id": "uuid",
    "conversation_id": "uuid",
    "position": 2,
    "user_message": "...",
    "answer": "string or null",
    "attachments": [...],
    "runs": [
        {
            "id": "uuid",
            "attempt": 2,
            "status": "completed",
            "metrics": { ... },
            "created_at": "...",
            "started_at": "...",
            "completed_at": "..."
        },
        {
            "id": "uuid",
            "attempt": 1,
            "status": "failed",
            "error_message": "Agent returned empty response.",
            ...
        }
    ],
    "created_at": "..."
}
```

---

### Runs

#### `GET /runs/{id}`

Full run detail.

```json
{
    "id": "uuid",
    "turn_id": "uuid",
    "conversation_id": "uuid",
    "attempt": 1,
    "status": "completed",
    "research_mode": "standard",
    "metrics": {
        "model_name": "openai:gpt-5-nano",
        "latency_ms": 34200,
        "input_tokens": 1840,
        "output_tokens": 920,
        "total_tokens": 2760,
        "search_calls": 4,
        "cost_usd": 0.000506
    },
    "error_message": null,
    "created_at": "...",
    "started_at": "...",
    "completed_at": "..."
}
```

#### `POST /runs/{id}/cancel`

Sets `cancel_requested = true` on the run. The executor checks this flag cooperatively and transitions to `cancelled`.

**Response `200`:**
```json
{ "run_id": "uuid", "status": "cancel_requested" }
```

No-ops gracefully if the run is already terminal — returns the current status without error.

#### `POST /runs/{id}/retry`

Creates a new run attempt for the same turn. Rejected if the turn already has a non-terminal run (`409`).

**Response `202`:**
```json
{ "run_id": "uuid", "turn_id": "uuid", "attempt": 2, "status": "pending" }
```

---

### Events

#### `GET /runs/{id}/events?after_id=0&limit=100`

Returns the event log as JSON. Used for polling in Phase 1 and for history replay in Phase 2.

**Response `200`:**
```json
{
    "events": [
        {
            "id": 142,
            "run_id": "uuid",
            "type": "thinking",
            "schema_version": 1,
            "payload": { "content": "Found 4 sources — now cross-checking." },
            "created_at": "2026-05-24T10:01:03Z"
        },
        {
            "id": 143,
            "type": "search_call",
            "schema_version": 1,
            "payload": { "query": "US CPI June 2026", "topic": "news", "max_results": 5 },
            "created_at": "2026-05-24T10:01:05Z"
        }
    ],
    "run_status": "running",
    "next_after_id": 143,
    "has_more": false
}
```

`run_status` tells the poller whether to continue. If terminal, no further polling needed. `next_after_id` is ready to use as the next `after_id`.

#### `GET /runs/{id}/events/stream?after_id=0`

Phase 2: SSE stream. A dedicated endpoint rather than content negotiation — explicit is clearer.

Behavior:
1. Replay all events with `id > after_id` from DB, in order
2. If run is already terminal, emit a `done` control event and close
3. If run is active, subscribe to Postgres `LISTEN/NOTIFY` and tail live events
4. Emit `done` when the run reaches a terminal status
5. Send keepalive comments every 30 seconds to prevent proxy timeouts

SSE wire format:

```
id: 143
event: run_event
data: {"id":143,"run_id":"uuid","type":"search_call","schema_version":1,"payload":{...},"created_at":"..."}

event: done
data: {"status":"completed"}
```

Using `id:` in the SSE output enables native `Last-Event-ID` reconnection via `EventSource` — the browser automatically passes `?after_id=` equivalent on reconnect. No custom reconnect logic needed.

---

### Admin

#### `GET /admin/overview`

```json
{
    "conversation_count": 12,
    "turn_count": 34,
    "run_count": 36,
    "total_tokens": 189430,
    "total_cost_usd": 0.024781,
    "average_latency_ms": 28340,
    "pending_runs": 0,
    "running_runs": 1
}
```

Single aggregate query over `runs` and `conversations`.

#### `GET /admin/runs?limit=20&status=completed`

Recent runs with answer preview and full metrics. Supports filtering by status.

#### `GET /admin/queue`

Executor health snapshot: pending count, oldest pending age, running count.

---

## Execution Model

### Executor claiming

The executor uses `SELECT ... FOR UPDATE SKIP LOCKED` to claim runs safely. Multiple executor instances (or workers) can run without duplicate execution:

```sql
SELECT id FROM runs
WHERE status = 'pending'
ORDER BY created_at ASC
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

After claiming: update `status = 'claimed'`, set `started_at = now()`. Then begin agent execution and transition to `running`.

### Worker lifecycle

```python
async def execute_run(run_id: str, adapter: AgentAdapter) -> None:
    # 1. Claim
    async with session_factory() as session:
        run = await session.get(Run, run_id)
        if run is None or run.status != "pending":
            return
        if run.cancel_requested:
            run.status = "cancelled"
            run.completed_at = now()
            await session.commit()
            return
        run.status = "claimed"
        run.started_at = now()
        await session.commit()

    # 2. Emit run.started
    await persist_event(run_id, "run.started", {"model_name": settings.agent_model, ...})

    # 3. Load context
    turn = await load_turn(run.turn_id)
    history = await load_conversation_history(run.conversation_id, before_position=turn.position)
    attachments = await load_attachments(run.turn_id)

    # 4. Mark running
    async with session_factory() as session:
        run = await session.get(Run, run_id)
        run.status = "running"
        await session.commit()

    # 5. Execute with timeout
    started_at = perf_counter()
    try:
        async with asyncio.timeout(run.timeout_seconds):
            result = await adapter.run(
                user_message=turn.user_message,
                attachments=attachments,
                history=history,
                research_mode=run.research_mode,
                on_event=lambda event: persist_and_notify(run_id, event),
            )
        latency_ms = int((perf_counter() - started_at) * 1000)

        # 6. Finalize
        async with session_factory() as session:
            run = await session.get(Run, run_id)
            if run.cancel_requested:
                run.status = "cancelled"
            else:
                run.status = "completed"
                run.answer_written = True
                # Write answer to the turn
                turn = await session.get(Turn, run.turn_id)
                turn.answer = result.answer
            run.model_name = result.model_name
            run.input_tokens = result.input_tokens
            run.output_tokens = result.output_tokens
            run.total_tokens = result.total_tokens
            run.search_calls = result.search_calls
            run.latency_ms = latency_ms
            run.cost_usd = estimate_cost(result.model_name, result.input_tokens, result.output_tokens)
            run.completed_at = now()
            await session.commit()

        await persist_event(run_id, "run.completed", {"latency_ms": latency_ms, ...})

    except asyncio.TimeoutError:
        await _mark_terminal(run_id, "timed_out", f"Exceeded {run.timeout_seconds}s limit.")
        await persist_event(run_id, "run.timed_out", {"timeout_seconds": run.timeout_seconds})

    except asyncio.CancelledError:
        await _mark_terminal(run_id, "cancelled", "Task cancelled.")
        await persist_event(run_id, "run.cancelled", {})
        raise

    except Exception as exc:
        await _mark_terminal(run_id, "failed", str(exc))
        await persist_event(run_id, "run.failed", {"error": str(exc)})
```

**Cooperative cancellation:** inside `persist_and_notify`, after each event insert, the executor checks `runs.cancel_requested`. If true, it raises `asyncio.CancelledError`. This works across process boundaries — any process that sets `cancel_requested = true` will cause the executor to stop at the next event boundary.

### Timeouts

- Light mode default: 120 seconds
- Standard mode default: 600 seconds
- Configurable via `AGENT_TIMEOUT_LIGHT_SECONDS` and `AGENT_TIMEOUT_STANDARD_SECONDS`

### Event persistence and notify

```python
async def persist_and_notify(run_id: str, event: AgentEvent) -> None:
    event_type, payload = serialize_event(event)

    async with session_factory() as session:
        # Check cancellation cooperatively
        run = await session.get(Run, run_id)
        if run and run.cancel_requested:
            raise asyncio.CancelledError()

        session.add(RunEvent(run_id=run_id, type=event_type, payload=payload))
        await session.commit()
        # NOTIFY for Phase 2 SSE
        await session.execute(text(f"NOTIFY run_{run_id}"))
        await session.commit()
```

### Startup recovery

On startup, find runs stuck in `claimed` or `running` and mark them `failed`. Logged so operators see when recovery occurs.

```python
async def recover_stuck_runs() -> None:
    async with session_factory() as session:
        result = await session.execute(
            select(Run).where(Run.status.in_(["claimed", "running"]))
        )
        for run in result.scalars():
            run.status = "failed"
            run.error_message = "Server restarted during execution."
            run.completed_at = now()
        await session.commit()
```

---

## Service Decomposition

No God objects. Lean but explicit separation:

**Repositories** (DB queries only, no business logic):
- `ConversationRepository`
- `TurnRepository`
- `RunRepository`
- `EventRepository`
- `AttachmentRepository`

**Services** (business logic, orchestration):
- `TurnService` — creates turn + run, enforces one-active-run constraint, loads history
- `RunService` — cancellation, retry, status reads
- `ExecutorService` — the worker loop (claim → run → finalize)
- `AgentAdapter` — deepagents integration, event normalization, usage aggregation

**API routes** (HTTP only — parse, validate, delegate, respond):
- `conversations.py`
- `turns.py`
- `runs.py`
- `admin.py`

---

## Schema Management

Alembic from day one. `create_all()` is not used anywhere in production or dev paths.

```
backend/
  alembic/
    env.py
    versions/
      0001_initial_schema.py
  alembic.ini
```

`alembic upgrade head` runs in the Docker entrypoint before the app starts.

---

## Configuration

```python
class Settings(BaseSettings):
    database_url: str
    api_secret_key: str = Field(min_length=16)      # fails startup if absent
    admin_secret_key: str = Field(min_length=16)     # fails startup if absent
    openai_api_key: str = Field(min_length=1)        # fails startup if absent
    tavily_api_key: str = Field(min_length=1)        # fails startup if absent
    agent_model: str = "openai:gpt-5-nano"
    agent_max_search_results: int = Field(default=5, ge=1, le=20)
    agent_timeout_light_seconds: int = Field(default=120, ge=30, le=600)
    agent_timeout_standard_seconds: int = Field(default=600, ge=60, le=1800)
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])
```

---

## Project Layout

```
backend/
  src/
    app/
      api/
        routes/
          conversations.py
          turns.py
          runs.py
          admin.py
        auth.py              -- bearer token middleware
        deps.py
      core/
        config.py
        db.py
        pricing.py
      models/
        conversation.py
        turn.py
        attachment.py
        run.py
        run_event.py
      repositories/
        conversation_repo.py
        turn_repo.py
        run_repo.py
        event_repo.py
        attachment_repo.py
      services/
        turn_service.py      -- create turn + run, enforce constraints
        run_service.py       -- cancel, retry, status
        executor_service.py  -- worker loop
        agent_adapter.py     -- deepagents integration (all library internals here)
      schemas/
        conversations.py
        turns.py
        runs.py
        events.py
        admin.py
      main.py
  alembic/
  tests/
    unit/
    integration/
    fixtures/

frontend/           -- Phase 2 only
  src/
    lib/
      api-types.ts   -- generated from OpenAPI, not hand-maintained
      api.ts         -- fetch wrappers
    hooks/
      useConversationList.ts
      useConversation.ts
      useTurn.ts
      useEventStream.ts
    pages/
      ConversationPage.tsx
      AdminPage.tsx
    components/
      Sidebar.tsx
      TurnList.tsx
      TurnItem.tsx
      LiveTurnView.tsx
      EventTimeline.tsx
      MessageComposer.tsx
      AttachmentPicker.tsx
```

---

## Type Contract

FastAPI generates an OpenAPI schema automatically. The frontend generates TypeScript types from it at build time:

```bash
npx openapi-typescript http://localhost:8000/openapi.json -o src/lib/api-types.ts
```

No hand-maintained TypeScript interfaces. Any field added to a Pydantic schema propagates to the frontend on the next build.

---

## Observability

### Structured logging

Every run transition logs: `conversation_id`, `turn_id`, `run_id`, `attempt`, `status`, `latency_ms` (on completion).

Every request logs: `method`, `path`, `status_code`, `duration_ms`, `run_id` if applicable.

### Metrics (Phase 1 targets)

- `runs_created_total` (by research_mode)
- `runs_completed_total` / `runs_failed_total` / `runs_cancelled_total` / `runs_timed_out_total`
- `run_duration_seconds` (histogram, by research_mode)
- `run_queue_depth` (gauge)
- `tokens_used_total` (by model)
- `search_calls_total`
- `event_append_duration_seconds` (histogram)
- `sse_connections_active` (gauge, Phase 2)

### Correlation IDs

Every request gets a `X-Request-ID` header. Run IDs are propagated through all log lines for a run.

---

## Observability

### Data retention

- `run_events`: 90 days
- `runs`, `turns`, `conversations`: until user or operator deletion
- `attachments`: tied to their turn; deleted with the conversation

Implement as a scheduled cleanup job, not application-layer logic.

---

## Phase 2: SSE + UI

### SSE implementation

The `GET /runs/{id}/events/stream` endpoint:

```python
@router.get("/runs/{run_id}/events/stream")
async def run_event_stream(run_id: str, after_id: int = 0):
    return StreamingResponse(
        _stream(run_id, after_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

async def _stream(run_id: str, after_id: int):
    # 1. Replay history
    last_id = after_id
    for event in await event_repo.list(run_id, after_id=last_id):
        yield _sse(event)
        last_id = event.id

    # 2. Already terminal?
    run = await run_repo.get(run_id)
    if run.status in ("completed", "failed", "cancelled", "timed_out"):
        yield f"event: done\ndata: {json.dumps({'status': run.status})}\n\n"
        return

    # 3. Tail via Postgres LISTEN/NOTIFY
    async with pg_listen(f"run_{run_id}") as notifications:
        while True:
            run = await run_repo.get(run_id)
            if run.status in ("completed", "failed", "cancelled", "timed_out"):
                for event in await event_repo.list(run_id, after_id=last_id):
                    yield _sse(event)
                yield f"event: done\ndata: {json.dumps({'status': run.status})}\n\n"
                return
            try:
                await asyncio.wait_for(notifications.get(), timeout=30)
                for event in await event_repo.list(run_id, after_id=last_id):
                    yield _sse(event)
                    last_id = event.id
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"

def _sse(event: RunEvent) -> str:
    return (
        f"id: {event.id}\n"
        f"event: run_event\n"
        f"data: {json.dumps(event.dict())}\n\n"
    )
```

The `id:` field on each SSE message enables native `EventSource` reconnection via `Last-Event-ID`. The browser appends this automatically on reconnect as a query param (with a small shim) or header.

### Frontend hooks

```typescript
// No polling — refresh on navigation and after turn creation
function useConversationList(): { conversations, isLoading, refresh }

// Fetched once on mount
function useConversation(id: string): { conversation, isLoading }

// Fetched when stream closes, to get final answer
function useTurn(id: string): { turn, isLoading, refetch }

// Connects to SSE, accumulates events
function useEventStream(runId: string | null): {
    events: RunEvent[],
    status: 'idle' | 'connecting' | 'streaming' | 'done' | 'error',
}
```

`useEventStream` uses the native `EventSource` API. No custom chunk parser, no `AbortController` for reconnect.

```typescript
function useEventStream(runId: string | null) {
    const [events, setEvents] = useState<RunEvent[]>([])
    const [status, setStatus] = useState<StreamStatus>('idle')

    useEffect(() => {
        if (!runId) return
        setStatus('connecting')
        const url = `/api/v1/runs/${runId}/events/stream`
        const source = new EventSource(url)

        source.addEventListener('run_event', (e) => {
            setEvents(prev => [...prev, JSON.parse(e.data) as RunEvent])
            setStatus('streaming')
        })

        source.addEventListener('done', (e) => {
            const { status } = JSON.parse(e.data)
            setStatus(status === 'completed' ? 'done' : 'error')
            source.close()
        })

        source.onerror = () => { setStatus('error'); source.close() }
        return () => source.close()
    }, [runId])

    return { events, status }
}
```

### Turn lifecycle in the UI

```
user submits
  → POST /conversations/{id}/turns
  → receive { turn_id, run_id, status: "pending" }
  → activate useEventStream(run_id)
  → render EventTimeline from events as they arrive
  → on "done" event → call useTurn(turn_id).refetch() → render turn.answer
  → refresh useConversationList()
```

The answer is never in the stream. The stream carries only progress events. After `done`, one `GET /turns/{id}` fetches the complete turn with answer and metrics.

**Zero interval timers.** The sidebar refreshes after: (a) creating a new conversation, (b) creating a new turn, (c) receiving the `done` SSE event. No `setInterval` anywhere.

### Event rendering

The UI renders based on `event.type`, not content inspection:

| Event type | UI element |
|---|---|
| `run.started` | Status badge: Running |
| `thinking` | Collapsible reasoning block |
| `thinking_delta` | Incremental text appended to open block |
| `search_call` | Search query chip with query text |
| `search_result` | Expandable result list |
| `tool_error` | Error callout |
| `run.completed` | Status badge: Done |
| `run.failed` | Error banner with message |
| `run.cancelled` | Status badge: Cancelled |
| `run.timed_out` | Error banner with timeout info |

No content-based guessing. No metadata extraction heuristics. If a new event type is added to the backend, the UI renders a generic fallback until a handler is added.

---

## Phase Breakdown

### Phase 1A — Schema and domain foundation
- New database schema (4 tables)
- Alembic migration 0001
- SQLAlchemy models
- Repository layer (no business logic yet)
- Settings validation

### Phase 1B — API-only execution
- All endpoints: conversations, turns, runs, events (JSON), admin
- Executor service with claiming, timeouts, cooperative cancellation
- `AgentAdapter` isolating deepagents
- Startup recovery
- Bearer token auth
- Integration tests: full turn lifecycle, cancellation, retry, history replay

### Phase 1C — Hardening
- Structured logging with correlation IDs
- Metrics instrumentation
- Data retention job
- Failure tests: executor crash recovery, duplicate claim prevention, adapter malformed stream
- Load test: concurrent runs, event throughput

### Phase 2A — Minimal UI
- OpenAPI → TypeScript type generation in build
- Conversation list and detail
- Turn rendering (user message + answer + metrics)
- `useEventStream` hook with native `EventSource`
- `EventTimeline` component
- `MessageComposer` with attachment picker

### Phase 2B — UX and admin improvements
- `thinking_delta` support for incremental reasoning text
- Retry / cancel controls in the UI
- Admin dashboard with run filtering
- Attachment UX improvements

---

## Testing Strategy

### Unit tests
- Run status transition logic
- Attachment validation (size, extension)
- Event serialization / deserialization
- Token and cost aggregation
- Pricing normalization

### Integration tests
- Create conversation → create turn → run executes to completion → answer on turn
- `GET /events` returns ordered events matching what the executor wrote
- Cancel mid-run → status transitions correctly → events include `run.cancelled`
- Retry failed run → new run created → second attempt succeeds
- Startup recovery → stuck `running` run marked `failed`
- Concurrent turn creation in same conversation → exactly one succeeds, one gets 409
- Executor crash simulation → recovery on restart

### Phase 2 UI tests
- Render completed conversation from HTTP only (no SSE needed)
- Attach to in-progress run via SSE → events accumulate → `done` closes stream → answer appears
- Reconnect with `after_id` → replays from correct offset, no duplicates
- Cancel from UI → run transitions to `cancelled` → stream closes

### Success criteria

The rewrite is done when:
1. A run completes correctly with no browser connected
2. SSE can attach, detach, and reattach without affecting execution
3. No duplicate trace storage exists anywhere
4. Final answer and full metrics are derivable from persisted state alone
5. Phase 2 UI has zero event-merging heuristics
6. The executor can be replaced (in-process task → queue worker) without API changes
7. Full Phase 1 workflow is covered by integration tests with no browser

---

## Migration from Current Implementation

| Current | New |
|---|---|
| `AgentRun` | `runs` |
| `Message` (user) | `turns.user_message` |
| `Message` (assistant) | `turns.answer` |
| `MessageAttachment` | `attachments` (references `turn_id`, not `message_id`) |
| `TraceEvent` | `run_events` (references `run_id`) |
| `AgentRun.trace_data` | deleted |
| `BackgroundAgentRunner` | `ExecutorService` (no subscriber queues) |
| `MetricsService` (god object) | `TurnService` + `RunService` + repositories |

Migration script: for each `AgentRun`, create a `turn` (from preceding user `Message`), a `run` (from `AgentRun` fields), copy `TraceEvent` rows to `run_events`. Set `turns.answer` from the following assistant `Message`. One-time, can run offline.

---

## Open Questions (Resolved)

**One active run per conversation at a time?** Yes. Enforced at the API layer (`409` on `POST /turns` if a non-terminal run exists for that conversation). Simpler reasoning, cleaner UX.

**Final answer as message, artifact, or column?** Column on `turns.answer`. Simple, queryable, no join needed to display a conversation. If we need to store multiple drafts or versioned answers, add an `answers` table as an additive migration.

**PostgreSQL-backed claiming or real queue?** PostgreSQL (`FOR UPDATE SKIP LOCKED`) in Phases 1A–1C. The seam is explicit: swap `ExecutorService` internals without touching the API. Add ARQ or Celery when horizontal scaling is needed.

**Server-side conversation summarization for long contexts?** Deferred. Not a Phase 1 concern. Context truncation strategy belongs in the `AgentAdapter`.

---

## Out of Scope

- Multi-user / multi-tenant — single operator deployment. Add as orthogonal concern (principal table, scoped queries).
- Rate limiting — reverse proxy (nginx, Caddy) layer.
- Binary attachment upload — text only, inline in request body.
- Turn editing or branching — linear conversation, append-only.
- Dynamic pricing — hardcoded table; add external config if prices change frequently.
- Vector memory / long-term retrieval — not in scope for either phase.
