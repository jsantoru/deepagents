# API-First Rewrite Specification

## Purpose

This document defines a ground-up rewrite of the DeepAgents application with these goals:

1. make agent execution independent from any UI transport
2. make the event log the primary source of truth
3. ship an API-only system in phase 1
4. add a UI in phase 2 as a pure consumer of the API and event stream

The design intentionally treats SSE as a projection over durable execution state, not as the execution mechanism itself.

## Executive Summary

The rewritten system will revolve around five durable concepts:

1. `conversation`
   A logical thread of user work.

2. `turn`
   A single user submission within a conversation, including attachments and execution parameters.

3. `run`
   A concrete execution attempt for a turn.

4. `event`
   An append-only record emitted by a run while it progresses.

5. `artifact`
   A derived output such as the final answer, metrics snapshot, or summarized transcript.

Phase 1 will expose these concepts through a clean HTTP API and durable background execution model.
Phase 2 will add a frontend that reads the same data and attaches to SSE streams for live updates.

## Design Principles

### 1. Execution is primary

Agent execution must continue regardless of browser connections, page refreshes, or UI availability.

### 2. Event log is the source of truth

Progress, reasoning, tool activity, errors, and completion state are modeled as ordered run events.
Derived read models may exist, but the event log is canonical.

### 3. API before UI

The system must be testable, scriptable, and operable through HTTP clients alone.
The UI is a client of the platform, not a special execution surface.

### 4. Separation of write and read concerns

Commands create or mutate domain state.
Queries return optimized read models.
Streaming exposes ordered event projections.

### 5. Replaceability at the execution boundary

The worker implementation may evolve from single-process to distributed queue execution without breaking the API contract.

### 6. Explicit lifecycle states

Runs must move through well-defined statuses with constrained transitions.

### 7. Operational honesty

If phase 1 starts as single-process, the system must state that constraint directly in code and documentation.

## Non-Goals

### Phase 1 non-goals

- no web UI
- no SSE requirement for basic correctness
- no multi-tenant billing system
- no advanced auth provider integration
- no human-in-the-loop workflow orchestration
- no vector memory or long-term semantic retrieval layer

### Phase 2 non-goals

- no UI-owned execution state
- no client-side event reconciliation heuristics
- no bespoke streaming protocol separate from the API event model

## System Context

The rewritten platform has four runtime roles:

1. `API service`
   Accepts commands, exposes read APIs, serves SSE event streams, and never directly owns long-running agent execution.

2. `executor`
   Consumes pending runs, invokes the agent stack, emits run events, and finalizes outcomes.

3. `database`
   Stores domain records, event log, attachments, and read-model projections.

4. `clients`
   Phase 1 clients are scripts, tests, CLI tools, or external systems.
   Phase 2 clients include the web UI.

## Architecture Overview

### High-level flow

```text
Client submits turn
  -> API persists conversation turn + run request
  -> API marks run pending
  -> API enqueues work
  -> Executor claims run
  -> Executor emits ordered run events
  -> Executor writes final artifacts and terminal status
  -> Clients query state or attach to SSE event stream
```

### Transport model

The system supports three read patterns:

1. point-in-time HTTP reads
2. paginated event reads
3. SSE tailing of the event stream

All three read from the same persisted state model.

## Domain Model

### Conversation

Represents a logical thread.

Required fields:

- `id`
- `created_at`
- `updated_at`
- `title`
- `archived_at` nullable
- `metadata_json`

Notes:

- title may be derived initially from the first user turn
- conversations are durable containers; they do not store transient run state

### Turn

Represents one user submission within a conversation.

Required fields:

- `id`
- `conversation_id`
- `sequence`
- `role`
- `content_text`
- `research_mode`
- `submitted_at`
- `metadata_json`

Notes:

- in phase 1, `role` will primarily be `user`
- assistant output is not stored as another turn until finalization writes the resolved assistant artifact or message

### Attachment

Represents a text attachment submitted with a turn.

Required fields:

- `id`
- `turn_id`
- `name`
- `mime_type`
- `size_bytes`
- `sha256`
- `text_content`
- `order_index`
- `created_at`

### Run

Represents a single execution attempt for a turn.

Required fields:

- `id`
- `conversation_id`
- `turn_id`
- `attempt_number`
- `status`
- `requested_model`
- `requested_research_mode`
- `requested_at`
- `started_at` nullable
- `completed_at` nullable
- `error_code` nullable
- `error_message` nullable
- `cancellation_reason` nullable
- `executor_lease_owner` nullable
- `executor_lease_expires_at` nullable
- `metadata_json`

Allowed statuses:

- `pending`
- `claimed`
- `running`
- `completed`
- `failed`
- `cancel_requested`
- `cancelled`
- `timed_out`

### Run Event

Append-only ordered events emitted by a run.

Required fields:

- `id`
- `run_id`
- `sequence`
- `event_type`
- `occurred_at`
- `payload_json`

Constraints:

- unique `(run_id, sequence)`
- sequence generated by the persistence layer, not by `max(sequence) + 1` in application code

### Run Artifact

Stores derived terminal data for efficient reads.

Required fields:

- `id`
- `run_id`
- `artifact_type`
- `content_json`
- `created_at`

Artifact types in phase 1:

- `final_answer`
- `metrics_summary`
- `agent_summary`

## Event Model

### Event categories

The event schema must be stable, typed, and versioned.

Core event types:

1. `run.created`
2. `run.claimed`
3. `run.started`
4. `run.progress`
5. `run.message.delta`
6. `run.message.completed`
7. `run.tool.started`
8. `run.tool.delta`
9. `run.tool.completed`
10. `run.warning`
11. `run.error`
12. `run.cancel_requested`
13. `run.cancelled`
14. `run.completed`

### Event envelope

Every event returned by API or SSE should follow one envelope:

```json
{
  "id": "evt_123",
  "run_id": "run_123",
  "sequence": 17,
  "event_type": "run.tool.completed",
  "occurred_at": "2026-05-24T22:00:00Z",
  "schema_version": 1,
  "payload": {}
}
```

### Event payload examples

#### `run.progress`

```json
{
  "label": "Searching for recent filings",
  "stage": "research",
  "message": "Cross-checking SEC and company sources."
}
```

#### `run.message.delta`

```json
{
  "message_id": "msg_agent_1",
  "channel": "assistant",
  "delta_text": "The company reported"
}
```

#### `run.tool.started`

```json
{
  "tool_call_id": "tool_1",
  "tool_name": "internet_search",
  "input": {
    "query": "latest SEC filing"
  }
}
```

#### `run.tool.completed`

```json
{
  "tool_call_id": "tool_1",
  "tool_name": "internet_search",
  "output": {
    "query": "latest SEC filing",
    "results": []
  }
}
```

#### `run.completed`

```json
{
  "final_answer_artifact_id": "art_1",
  "metrics_artifact_id": "art_2",
  "summary": "Execution completed successfully."
}
```

## Persistence Model

### Canonical persistence rule

`run_events` is the only canonical trace store.

The system must not duplicate the full event stream into a second JSON blob on `runs`.

### Read-model rule

Final answer and metrics may be denormalized into artifacts or query tables for efficient retrieval, but those are explicitly derived from the event stream and terminal run state.

### Recommended database

PostgreSQL remains the primary database.

Recommended storage details:

- `payload_json` as `JSONB`
- `metadata_json` as `JSONB`
- typed timestamps with timezone
- explicit indexes for common reads

### Indexes

Minimum indexes:

- `conversations(created_at desc)`
- `turns(conversation_id, sequence)`
- `runs(conversation_id, requested_at desc)`
- `runs(turn_id, attempt_number)`
- `runs(status, requested_at)`
- `run_events(run_id, sequence)`
- `attachments(turn_id, order_index)`

## Execution Model

### Phase 1 executor

Phase 1 may use a single-process executor if needed for delivery speed, but the seam must be explicit.

Executor responsibilities:

1. claim one pending run
2. mark it `claimed`
3. emit `run.started`
4. execute the agent
5. append events during execution
6. write terminal artifacts
7. mark terminal status

### Claiming protocol

Run claiming must be safe against duplicate execution.

Recommended options:

1. `SELECT ... FOR UPDATE SKIP LOCKED`
2. lease ownership columns with expiry
3. unique attempt semantics enforced in DB

### Cancellation

Cancellation is part of phase 1.

Model:

1. API marks `cancel_requested`
2. executor polls or checks cooperative cancellation state
3. executor emits `run.cancel_requested`
4. executor emits `run.cancelled` if cancellation succeeds

### Timeouts

Executor-enforced max run duration must exist in phase 1.

Recommended default:

- light mode: 2 minutes
- standard mode: 10 minutes

### Retries

Phase 1 should support explicit retry by creating a new run attempt for the same turn.

Automatic retry should be limited to transient infrastructure failures, not semantic agent failures.

## API Design

## API Conventions

- JSON request and response bodies
- RFC 3339 timestamps
- stable ids as opaque strings
- typed error envelope
- cursor- or sequence-based pagination

### Error envelope

```json
{
  "error": {
    "code": "run_not_found",
    "message": "Run not found.",
    "details": {}
  }
}
```

## Phase 1 API Surface

### Health

#### `GET /health`

Purpose:

- liveness signal

Response:

```json
{
  "status": "ok"
}
```

### Conversations

#### `POST /v1/conversations`

Purpose:

- create an empty conversation

Request:

```json
{
  "title": "Optional title"
}
```

Response:

```json
{
  "conversation_id": "conv_123",
  "created_at": "2026-05-24T22:00:00Z"
}
```

#### `GET /v1/conversations`

Purpose:

- list conversations for the current principal

Query params:

- `limit`
- `cursor`

Response:

```json
{
  "items": [],
  "next_cursor": null
}
```

#### `GET /v1/conversations/{conversation_id}`

Purpose:

- fetch conversation detail plus turn summaries

### Turns

#### `POST /v1/conversations/{conversation_id}/turns`

Purpose:

- create a turn
- create its initial run
- enqueue execution

Request:

```json
{
  "message": "Research the latest changes.",
  "research_mode": "standard",
  "attachments": []
}
```

Response:

```json
{
  "conversation_id": "conv_123",
  "turn_id": "turn_123",
  "run_id": "run_123",
  "status": "pending",
  "requested_at": "2026-05-24T22:00:00Z"
}
```

#### `GET /v1/conversations/{conversation_id}/turns`

Purpose:

- list turns in order

#### `GET /v1/conversations/{conversation_id}/turns/{turn_id}`

Purpose:

- fetch one turn and its latest run summary

### Runs

#### `GET /v1/runs/{run_id}`

Purpose:

- fetch run status and terminal summary

Response while pending:

```json
{
  "run_id": "run_123",
  "status": "running",
  "conversation_id": "conv_123",
  "turn_id": "turn_123",
  "requested_at": "2026-05-24T22:00:00Z",
  "started_at": "2026-05-24T22:00:01Z",
  "completed_at": null
}
```

Response when completed:

```json
{
  "run_id": "run_123",
  "status": "completed",
  "conversation_id": "conv_123",
  "turn_id": "turn_123",
  "requested_at": "2026-05-24T22:00:00Z",
  "started_at": "2026-05-24T22:00:01Z",
  "completed_at": "2026-05-24T22:00:24Z",
  "final_answer": {
    "content": "Final answer text"
  },
  "metrics": {
    "model_name": "openai:gpt-5-nano",
    "input_tokens": 100,
    "output_tokens": 80,
    "total_tokens": 180,
    "latency_ms": 23000,
    "estimated_cost_usd": 0.00012,
    "tool_calls": 3
  }
}
```

#### `POST /v1/runs/{run_id}/cancel`

Purpose:

- request cancellation

Response:

```json
{
  "run_id": "run_123",
  "status": "cancel_requested"
}
```

#### `POST /v1/runs/{run_id}/retry`

Purpose:

- create a new run attempt for the same turn

### Events

#### `GET /v1/runs/{run_id}/events`

Purpose:

- return ordered historical events as JSON

Query params:

- `after_sequence`
- `limit`

Response:

```json
{
  "items": [],
  "next_after_sequence": 25,
  "has_more": false
}
```

#### `GET /v1/runs/{run_id}/events/stream`

Purpose:

- stream historical and live events via SSE

Query params:

- `after_sequence`

Behavior:

1. load all events with `sequence > after_sequence`
2. emit them in order
3. if run is terminal, end stream
4. if run is active, tail live events until terminal event

SSE event naming:

- use a single `event: run_event`
- keep event type inside the JSON payload

This avoids multiple frontend code paths for event parsing.

### Admin and Operations

#### `GET /v1/admin/runs`

Purpose:

- list recent runs with filters

#### `GET /v1/admin/metrics`

Purpose:

- operational aggregates

#### `GET /v1/admin/queues`

Purpose:

- executor backlog and lease health

## Phase 1 Service Decomposition

The rewrite should avoid a single God object service.

Recommended backend modules:

### Command services

1. `ConversationCommandService`
2. `TurnCommandService`
3. `RunCommandService`
4. `CancellationService`

### Query services

1. `ConversationQueryService`
2. `TurnQueryService`
3. `RunQueryService`
4. `RunEventQueryService`
5. `AdminQueryService`

### Persistence components

1. `ConversationRepository`
2. `TurnRepository`
3. `RunRepository`
4. `RunEventRepository`
5. `AttachmentRepository`
6. `ArtifactRepository`

### Execution components

1. `RunDispatcher`
2. `RunExecutor`
3. `AgentAdapter`
4. `ToolAdapter`
5. `UsageAggregator`

### Streaming components

1. `RunEventStreamer`
2. `RunEventBroadcaster`

## Agent Integration

### AgentAdapter responsibilities

The `deepagents` integration must be isolated behind one adapter.

Responsibilities:

1. build agent request payload
2. normalize stream parts into stable internal events
3. aggregate usage across all model invocations
4. normalize tool call envelopes
5. isolate all library-specific tuple or object-shape quirks

### Internal event normalization

The executor should never expose raw `deepagents` tuple shapes to the rest of the application.

Bad pattern:

- routing logic that inspects tuple lengths or undocumented object internals outside the adapter

Required pattern:

- `AgentAdapter.stream()` yields typed internal events

### Usage accounting

Usage aggregation must sum token and cost data across the entire run, not just the final message.

### Tool accounting

Tool counts must be tool-specific and derived from normalized tool events, not loose message-role checks.

## Authentication and Authorization

### Phase 1 baseline

Phase 1 should include at least a basic auth boundary.

Minimum acceptable option:

- static bearer token for development and internal use

Preferred option:

- principal table with API keys

Authorization scope:

- conversations are owned by one principal
- runs inherit ownership from conversation
- admin endpoints require elevated role

## Validation and Contracts

### Backend

- use Pydantic models for all requests and responses
- validate required secrets at startup
- reject invalid attachment types and sizes before execution

### Frontend phase 2

- use generated TypeScript types from OpenAPI
- use runtime validation at the API boundary with Zod or equivalent

## Observability

### Structured logs

Every command and run transition should log:

- `conversation_id`
- `turn_id`
- `run_id`
- `status`
- `event_sequence` when relevant
- `executor_owner` when relevant

### Metrics

Phase 1 should expose:

- runs created
- runs completed
- runs failed
- runs cancelled
- queue depth
- run duration
- event append latency
- event stream attach count
- token usage by model
- tool call counts by tool

### Tracing

Add request ids and run correlation ids from day 1.

## Phase 1 Operational Model

### Recommended startup validation

Fail startup if these are invalid:

- database connection string
- agent API key
- search API key
- required auth config

### Migrations

Use Alembic from the start.

`create_all()` on application startup is not acceptable for the rewrite.

### Deployment assumptions

Initial supported deployment modes:

1. single API instance + single executor instance
2. single process with co-located executor only if explicitly documented as non-HA

### Data retention

Retention policy should be explicit.

Suggested defaults:

- run events retained 90 days
- conversation records retained until user deletion
- attachments retained with conversation unless policy requires otherwise

## Phase 2 UI and SSE Design

## UI Principles

The phase 2 UI is a consumer of:

1. HTTP queries for baseline state
2. SSE for live event tailing

The UI must not invent state that contradicts backend run state.

## UI Architecture

Recommended frontend modules:

1. `ConversationListPage`
2. `ConversationView`
3. `MessageComposer`
4. `RunTimeline`
5. `RunStatusBanner`
6. `AttachmentPicker`
7. `AdminDashboard`

Recommended hooks:

1. `useConversationList`
2. `useConversation`
3. `useCreateTurn`
4. `useRun`
5. `useRunEvents`
6. `useRunEventStream`

## SSE contract in phase 2

The UI should call:

- `GET /v1/runs/{run_id}/events` for initial history when needed
- `GET /v1/runs/{run_id}/events/stream?after_sequence=N` for live continuation

The UI should not need:

- merge heuristics based on title or content equality
- tool-query extraction from raw strings
- special separate reconnect logic

## UI state model

For one active conversation, the UI needs:

- conversation detail
- ordered turns
- active run summary
- ordered run events
- final answer artifact

Derived UI state:

- streaming or idle
- latest event sequence seen
- cancellation pending
- retry available

## Event rendering guidance

The UI should render based on event type, not guessed content shape.

Examples:

- `run.progress` -> progress card
- `run.tool.started` -> tool activity row
- `run.tool.completed` -> expandable tool result
- `run.message.delta` -> incremental assistant body
- `run.completed` -> terminal state and final answer

## Sidebar updates

The phase 2 UI should not poll every few seconds for run status if the open conversation already has a live stream.

Suggested approach:

- stream updates for active conversation
- periodically refresh list only when not currently observing the needed runs
- or expose a lightweight conversation-summary stream later if needed

## Shared API Schema Strategy

Generate client types from the server OpenAPI schema.

Recommended tooling:

- FastAPI OpenAPI output
- `openapi-typescript` for client types

This must replace manually duplicated response interfaces.

## Suggested Phase Breakdown

### Phase 1A: Domain and schema foundation

Deliverables:

- new database schema
- Alembic migrations
- command/query service structure
- run event model

### Phase 1B: API-only execution

Deliverables:

- conversation, turn, run, event APIs
- basic executor
- cancellation
- retry
- admin endpoints
- automated integration tests

### Phase 1C: API hardening

Deliverables:

- auth boundary
- observability
- retention jobs
- executor lease handling
- failure recovery policy

### Phase 2A: Minimal operator UI

Deliverables:

- conversation list
- conversation detail
- run timeline
- final answer rendering
- SSE event stream attachment

### Phase 2B: UX and admin improvements

Deliverables:

- better progress rendering
- attachment UX
- retry/cancel controls
- admin dashboards

## Testing Strategy

## Phase 1 tests

### Unit tests

- run lifecycle transitions
- event append ordering
- cancellation state transitions
- usage aggregation
- tool call normalization

### Integration tests

- create conversation and turn
- run executes to completion
- historical events query returns ordered stream
- SSE stream replays history and tails live events
- retry creates new attempt
- cancel produces terminal status

### Failure tests

- executor crash before terminalization
- duplicate claim attempts
- agent adapter malformed stream payload
- DB transient failure during event append

## Phase 2 tests

### UI tests

- render completed conversation from HTTP only
- attach to in-progress run via SSE
- reconnect using `after_sequence`
- cancel from UI and observe terminal update

## Open Questions

1. Should assistant final answers be stored as first-class messages, artifacts, or both?
2. Should phase 1 support multiple concurrent runs within one conversation, or exactly one active run at a time?
3. Do we want server-side conversation summarization for long-thread context management in phase 1, or defer it?
4. Should the executor use PostgreSQL-backed claiming only, or adopt a real queue immediately?
5. What retention policy applies to attachments containing potentially sensitive user data?

## Recommended Decisions

These are the recommended defaults unless a product requirement overrides them:

1. one active run per conversation at a time in phase 1
2. `run_events` as the only canonical trace store
3. Alembic from day 1
4. API key or bearer-token auth from day 1
5. OpenAPI-generated client types before phase 2 starts
6. one stable event envelope for both JSON history and SSE
7. agent integration isolated behind `AgentAdapter`

## Success Criteria

The rewrite is successful if it achieves all of the following:

1. a run completes correctly without any UI connected
2. SSE can attach, detach, and reattach without changing execution behavior
3. no duplicate trace store exists
4. final answer and metrics can be rebuilt from canonical persisted state
5. frontend phase 2 can be implemented without protocol-merging heuristics
6. executor implementation can change without API contract changes
7. integration tests cover the full phase 1 workflow without browser dependencies

## Implementation Notes

This spec does not require preserving the current route structure or service layout.

The rewrite should optimize for:

- correctness of execution lifecycle
- clarity of system boundaries
- durability of event history
- testability without a browser

It should not optimize for:

- minimizing diff size from the current codebase
- preserving current UI-driven assumptions
- keeping current service names if they no longer match the architecture
