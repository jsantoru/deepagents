# Async Session Flow

This document explains how the chat app manages an "active session" while a run is in progress, how streaming works, how reconnect works, and where the main state transitions live.

## High-level model

The system separates three related concepts:

1. `conversation`
   A durable chat thread containing user and assistant messages.

2. `run`
   A single agent execution within a conversation.
   A conversation can have many runs over time.

3. `stream`
   A temporary SSE connection used to observe a run while it is active.
   Streams can disconnect and reconnect without losing the run.

The important design choice is:

- the run continues on the backend even if the browser stream drops
- the frontend treats the SSE connection as a view onto backend state, not the owner of backend execution

## Frontend responsibilities

Main file:

- [frontend/src/pages/chat-page.tsx](/C:/Users/Joe/Documents/coding/deepagents/frontend/src/pages/chat-page.tsx:136)

### Core frontend state

The page keeps these pieces of state:

- `conversationId`
  The client-side notion of the currently active conversation.

- `routeConversationId`
  The conversation id encoded in the URL `/chat/:id`.
  This is treated as the routing source of truth for "which session is open".

- `messages`
  The currently loaded transcript for the open session.

- `sessions`
  The sidebar summaries returned by `/conversations`.

- `activeRun`
  The currently in-progress run, if any.
  Stored both in React state and in local storage so refresh/reconnect can resume it.

- `isSending`
  UI flag meaning "this page is currently attached to an in-progress run or initiating one".

- `activeStreamAbortRef`
  Holds the live `AbortController` for the current SSE connection.

- `promotedConversationIdRef`
  A small coordination flag used during the "new chat becomes a real conversation" transition.

### Why route state and local state both exist

The app allows two phases:

1. Pre-conversation phase
   The user is on `/` and has not yet received a backend `conversation_id`.

2. Persisted conversation phase
   Once the backend starts the run, the frontend gets a `conversation_id` and navigates to `/chat/:id`.

That means a new session starts before the route exists, then gets promoted into a URL-backed session after the first stream status event arrives.

### Session list loading

`loadConversationSummaries()` fetches sidebar conversation summaries from the backend.

Relevant code:

- [frontend/src/pages/chat-page.tsx](/C:/Users/Joe/Documents/coding/deepagents/frontend/src/pages/chat-page.tsx:195)

The page does this:

- on initial mount, fetch summaries once
- if any summary reports an `active_run`, poll summaries every 3 seconds

That polling is not the source of transcript truth.
It only keeps the sidebar fresh and lets the UI know whether a conversation still has an active run.

### Opening a session

Clicking a session in the sidebar does not directly load data.
It only navigates:

- [frontend/src/pages/chat-page.tsx](/C:/Users/Joe/Documents/coding/deepagents/frontend/src/pages/chat-page.tsx:241)

The route effect then decides what to do:

- if there is no route conversation id, it may preserve the in-memory pending session or reset to a blank new-chat state
- if there is a route conversation id and it differs from the current conversation, it fetches that conversation detail

Relevant route effect:

- [frontend/src/pages/chat-page.tsx](/C:/Users/Joe/Documents/coding/deepagents/frontend/src/pages/chat-page.tsx:271)

This indirection is intentional.
It keeps navigation and data loading coupled to the route instead of click handlers.

### Loading a selected conversation

When the route points at `/chat/:id`, the page:

1. fetches `/conversations/:id`
2. sets `conversationId`
3. loads `messages`
4. checks `active_run`

If the conversation has an active run with status `pending` or `running`, the page immediately reconnects to that run instead of treating the conversation as fully complete.

Relevant code:

- [frontend/src/pages/chat-page.tsx](/C:/Users/Joe/Documents/coding/deepagents/frontend/src/pages/chat-page.tsx:272)

### Submitting a new message

`handleSubmit()` performs an optimistic UI update first:

1. append the user message locally
2. append a placeholder assistant message
3. clear the composer
4. create a fresh `AbortController`
5. call `streamChatMessage(...)`

Relevant code:

- [frontend/src/pages/chat-page.tsx](/C:/Users/Joe/Documents/coding/deepagents/frontend/src/pages/chat-page.tsx:499)

During the SSE lifecycle:

- `onStatus`
  Receives `conversation_id` and `run_id`
  Promotes the new chat into a real routed session
  Stores active-run metadata
  Inserts a temporary sidebar summary

- `onTrace`
  Merges incremental trace events into the pending assistant message

- `onFinal`
  Replaces the pending assistant placeholder with the final assistant message
  Clears active-run state
  Refreshes sidebar summaries

### Why `promotedConversationIdRef` exists

For a new chat, the page starts on `/`.
Once the backend returns `conversation_id`, the frontend navigates to `/chat/:id`.

That route change would normally trigger the route effect and potentially re-fetch or reset at the wrong moment.
`promotedConversationIdRef` marks the conversation that was just born from the current in-memory draft so the route effect knows:

- this is not a different session
- preserve the current in-memory messages
- do not stomp the live stream state

Relevant code:

- [frontend/src/pages/chat-page.tsx](/C:/Users/Joe/Documents/coding/deepagents/frontend/src/pages/chat-page.tsx:349)

### Reconnecting to an active run

`reconnectToActiveRun()` is used when:

- the user opens a conversation that still has an active run
- the page reloads while a run is still active

It:

1. aborts any current stream
2. creates a new `AbortController`
3. ensures a placeholder assistant message exists
4. sets `isSending = true`
5. calls `reconnectChatRun(runId, afterSequence, ...)`

Relevant code:

- [frontend/src/pages/chat-page.tsx](/C:/Users/Joe/Documents/coding/deepagents/frontend/src/pages/chat-page.tsx:391)

Today the reconnect path uses `afterSequence = 0`, which means:

- the backend replays all persisted trace events for that run
- then keeps streaming live events if the run is still active

That is simpler and safer than trying to compute a client-side resume cursor, at the cost of some duplicated replay work.

## Frontend API layer

Main file:

- [frontend/src/lib/api.ts](/C:/Users/Joe/Documents/coding/deepagents/frontend/src/lib/api.ts:1)

### `streamChatMessage(...)`

Starts a brand-new run by POSTing to:

- `/api/v1/chat/stream`

### `reconnectChatRun(...)`

Reconnects to an existing run by GETting:

- `/api/v1/chat/stream/{runId}?after_sequence=...`

### Shared event consumption

Both paths use `consumeEventStream(...)`, which:

- reads the SSE stream incrementally
- dispatches `status`, `trace`, `final`, and `error` events
- throws if the stream ends before a `final` event arrives
- honors `AbortSignal` cancellation

This is why the frontend can treat both "fresh start" and "reconnect" the same way after transport setup.

## Backend responsibilities

Main files:

- [backend/src/deepagents_app/api/routes.py](/C:/Users/Joe/Documents/coding/deepagents/backend/src/deepagents_app/api/routes.py:1)
- [backend/src/deepagents_app/services/background_runner.py](/C:/Users/Joe/Documents/coding/deepagents/backend/src/deepagents_app/services/background_runner.py:1)
- [backend/src/deepagents_app/services/metrics_service.py](/C:/Users/Joe/Documents/coding/deepagents/backend/src/deepagents_app/services/metrics_service.py:1)

### Starting a streaming run

`POST /chat/stream` does not execute the agent inline inside the request handler.

Instead it:

1. creates or loads the conversation
2. persists the new user message and attachments
3. creates a pending run row
4. builds the replayable conversation context
5. subscribes the client to a queue for that run
6. asks the background runner to start the run
7. begins streaming SSE events back to the client

Relevant code:

- [backend/src/deepagents_app/api/routes.py](/C:/Users/Joe/Documents/coding/deepagents/backend/src/deepagents_app/api/routes.py:34)

This is the key simplification:

- HTTP request = attach to run stream
- background runner = actually execute the run

### Background runner

The background runner is an in-process async coordinator.

Relevant code:

- [backend/src/deepagents_app/services/background_runner.py](/C:/Users/Joe/Documents/coding/deepagents/backend/src/deepagents_app/services/background_runner.py:10)

It owns:

- `_running_tasks`
  One async task per live run id

- `_subscriber_queues`
  Zero or more SSE subscribers per run id

- `_lock`
  Prevents races between starting runs, subscribing, unsubscribing, and cleanup

### Runner execution lifecycle

`start_run(...)` is idempotent per run id:

- if a task already exists and is not done, it does nothing
- otherwise it spawns `_execute_run(...)`

`_execute_run(...)` does this:

1. mark run `running`
2. call `agent_service.stream_chat(...)`
3. for every trace event, persist it and broadcast it
4. when the agent finishes, finalize the run and broadcast `final`
5. if anything fails, mark run `failed` and broadcast `error`
6. always broadcast `done`
7. clean up task bookkeeping

Important detail:

- trace events are persisted before broadcast

That means reconnect always has a durable replay source, even if a client disconnects at the worst possible time.

### Why queues are per-subscriber

Each connected browser tab gets its own `asyncio.Queue`.

That allows:

- multiple listeners for the same run
- independent consumer timing
- reconnect without mutating the running task

The run task only publishes to queues.
It does not care which specific HTTP connection is reading from them.

## Persistence and replay

### Conversation persistence

`prepare_chat(...)` stores:

- the user message
- any uploaded text attachments

Relevant code:

- [backend/src/deepagents_app/services/metrics_service.py](/C:/Users/Joe/Documents/coding/deepagents/backend/src/deepagents_app/services/metrics_service.py:62)

### Run persistence

`create_pending_run(...)` creates a run with status `pending`.

Later transitions:

- `mark_run_running(...)`
- `mark_run_failed(...)`
- `finalize_run(...)`

### Trace persistence

Each streamed trace event is stored in `TraceEvent` with an increasing `sequence`.

Relevant code:

- [backend/src/deepagents_app/services/metrics_service.py](/C:/Users/Joe/Documents/coding/deepagents/backend/src/deepagents_app/services/metrics_service.py:307)

That sequence is what makes replay deterministic.

### Final response persistence

When a run completes, `finalize_run(...)`:

1. deduplicates any trace events already persisted during streaming
2. appends missing ones from the final agent payload
3. marks the run completed
4. stores metrics and cost
5. writes the assistant message into the conversation
6. returns the final API response

Relevant code:

- [backend/src/deepagents_app/services/metrics_service.py](/C:/Users/Joe/Documents/coding/deepagents/backend/src/deepagents_app/services/metrics_service.py:372)

## Reconnect flow

`GET /chat/stream/{run_id}` supports late attachment or browser recovery.

It does this:

1. emit a `status` event immediately
2. load persisted trace events after `after_sequence`
3. emit those historical trace events
4. inspect current run status
5. if completed, emit `final` and stop
6. if failed, emit `error` and stop
7. if still active, subscribe to the live queue and continue streaming

Relevant code:

- [backend/src/deepagents_app/api/routes.py](/C:/Users/Joe/Documents/coding/deepagents/backend/src/deepagents_app/api/routes.py:68)

This is what makes reconnect robust:

- history comes from the database
- live continuation comes from the queue

The client does not need to guess what happened while disconnected.

## Conversation context replay into the model

Separate from transport, the backend also rebuilds prior conversation context before each run.

Relevant code:

- [backend/src/deepagents_app/services/metrics_service.py](/C:/Users/Joe/Documents/coding/deepagents/backend/src/deepagents_app/services/metrics_service.py:93)

`build_conversation_messages(...)`:

- loads prior conversation messages in order
- reattaches uploaded file contents onto the user turns they came with
- returns a structured message list for the agent

This is why follow-up prompts can refer to earlier uploaded files without re-uploading them.

## Title and session summary behavior

The session header title used to flicker because it was stored as separate state and updated from multiple async paths.

That has been simplified:

- the header title is now derived from the currently loaded transcript first
- sidebar summary title is only a fallback

This matters because:

- `sessions` is eventually consistent sidebar data
- `messages` is the currently open transcript and is the better source of truth for the active header

Relevant code:

- [frontend/src/pages/chat-page.tsx](/C:/Users/Joe/Documents/coding/deepagents/frontend/src/pages/chat-page.tsx:160)
- [frontend/src/pages/chat-page.tsx](/C:/Users/Joe/Documents/coding/deepagents/frontend/src/pages/chat-page.tsx:1654)

## Typical end-to-end sequence

### New chat

1. User is on `/`
2. User submits prompt
3. Frontend appends optimistic user message and placeholder assistant message
4. Frontend opens SSE to `POST /chat/stream`
5. Backend persists conversation message, attachments, and pending run
6. Backend returns `status` with `conversation_id` and `run_id`
7. Frontend stores active-run info and navigates to `/chat/:conversation_id`
8. Background runner emits trace events
9. Frontend merges trace into the pending assistant message
10. Backend finalizes run and emits `final`
11. Frontend swaps placeholder assistant into the completed assistant message
12. Frontend clears active-run state

### Reopen while still running

1. User loads `/chat/:conversation_id`
2. Frontend fetches conversation detail
3. Response includes `active_run`
4. Frontend calls reconnect endpoint for that run
5. Backend sends historical trace first, then live trace, then final
6. Frontend reconstructs the in-progress assistant state

## Practical simplifications to keep in mind

- A conversation is durable.
- A run is durable.
- A stream is disposable.
- The sidebar is advisory state.
- The transcript is the active session truth.
- The backend owns run continuity.
- The frontend owns presentation continuity.

## Known tradeoffs

- The background runner is in-process.
  If the server process dies, running jobs die with it.
  Reconnect only works while the same app process is still alive.

- Reconnect currently replays from sequence `0` on the frontend side.
  That is simple and reliable but can repeat a lot of history.

- Session summaries are polled every 3 seconds when any active run exists.
  That is adequate for a small app but not ideal for scale.

- Conversation replay into the model currently favors correctness over token-budget sophistication.
  Long threads may eventually need explicit truncation or summarization.

## Files to read first

- [frontend/src/pages/chat-page.tsx](/C:/Users/Joe/Documents/coding/deepagents/frontend/src/pages/chat-page.tsx:136)
- [frontend/src/lib/api.ts](/C:/Users/Joe/Documents/coding/deepagents/frontend/src/lib/api.ts:1)
- [backend/src/deepagents_app/api/routes.py](/C:/Users/Joe/Documents/coding/deepagents/backend/src/deepagents_app/api/routes.py:1)
- [backend/src/deepagents_app/services/background_runner.py](/C:/Users/Joe/Documents/coding/deepagents/backend/src/deepagents_app/services/background_runner.py:1)
- [backend/src/deepagents_app/services/metrics_service.py](/C:/Users/Joe/Documents/coding/deepagents/backend/src/deepagents_app/services/metrics_service.py:1)
