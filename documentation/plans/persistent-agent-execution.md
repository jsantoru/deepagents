# Persistent Agent Execution Plan

## Problem Statement

Currently, when a user closes their browser during an agent execution:
1. The SSE connection is lost
2. The backend cancels the agent task (`routes.py:85-88`)
3. The user loses all progress and must restart the request

**Goal:** Agent executions should continue running in the background even if the browser is closed. When the user returns, they should be able to reconnect and see any new updates that occurred while they were away.

## Design Requirements

1. **Persistence**: Agent runs must persist across browser sessions
2. **Reconnection**: Users can reconnect to in-progress or completed runs
3. **Event History**: All trace events must be stored and retrievable
4. **Status Tracking**: Clear status for each run (pending, running, completed, failed)
5. **No New Dependencies**: Use existing PostgreSQL + asyncio, avoid adding Redis/Celery
6. **Scalability Consideration**: Design should work with single server initially but be extensible for multi-server deployments

## Architecture Overview

### Current Flow
```
User submits message
  → POST /chat/stream
    → Create conversation/message
    → Start agent.astream() in asyncio.Task
    → Stream events via SSE
    → On disconnect: cancel task
```

### Proposed Flow
```
User submits message
  → POST /chat/stream
    → Create conversation/message
    → Create AgentRun record (status="pending")
    → Start background execution task
    → Subscribe to event queue
    → Stream events via SSE
    → On disconnect: unsubscribe (task continues)

User reconnects
  → GET /chat/stream/{run_id}
    → Load persisted trace events (send all)
    → If run still in progress: subscribe to new events
    → Stream new events as they occur
```

## Database Schema Changes

### 1. Add Status Fields to `AgentRun`

```python
class AgentRun(Base):
    # ... existing fields ...
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending", index=True)
    # Status values: "pending" | "running" | "completed" | "failed"

    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # New relationship
    trace_events: Mapped[list["TraceEvent"]] = relationship(back_populates="run", cascade="all, delete-orphan")
```

**Migration path:**
- Add nullable columns first
- Backfill existing runs with status="completed"
- Make columns non-nullable (except error_message, completed_at)

### 2. Create `TraceEvent` Table

Persist all trace events to the database instead of only streaming them.

```python
class TraceEvent(Base):
    __tablename__ = "trace_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("agent_runs.id"), nullable=False, index=True)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)  # Order of events
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)  # "tool", "assistant", "final", etc.
    title: Mapped[str] = mapped_column(String(512), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    metadata: Mapped[str] = mapped_column(Text, nullable=False, default="{}")  # JSON string
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    run: Mapped["AgentRun"] = relationship(back_populates="trace_events")
```

**Indexes:**
- `(run_id, sequence)` for efficient ordered retrieval
- `run_id` alone for fast lookups

**Size considerations:**
- Average trace event: ~500 bytes (title + content + metadata)
- Average run: 10-50 events = 5-25 KB per run
- 10,000 runs = 50-250 MB (acceptable)

## Backend Implementation

### 1. Background Agent Runner Service

Create `services/background_runner.py`:

```python
class BackgroundAgentRunner:
    """Manages background agent executions."""

    def __init__(self):
        self._running_tasks: Dict[str, asyncio.Task] = {}
        self._event_queues: Dict[str, list[asyncio.Queue]] = {}

    async def start_agent_run(
        self,
        run_id: str,
        conversation_id: str,
        payload: ChatRequest,
        conversation_messages: list[dict[str, str]],
        agent_service: AgentService,
    ) -> None:
        """Start agent execution in background task."""

    async def subscribe_to_run(self, run_id: str) -> asyncio.Queue:
        """Subscribe to live events from a running agent."""

    async def _execute_agent_run(self, ...):
        """
        Main execution loop:
        1. Mark run status="running"
        2. Execute agent with streaming
        3. For each event:
           - Persist to TraceEvent table
           - Broadcast to all subscribers
        4. On completion:
           - Update AgentRun with final metrics
           - Create assistant Message
           - Mark status="completed"
        5. On error:
           - Mark status="failed"
           - Store error_message
        """
```

**Key design decisions:**

- **In-memory queues for live subscribers**: Use `asyncio.Queue` to fan out events to multiple SSE connections
- **Database persistence for history**: All events written to `TraceEvent` table
- **Task lifecycle**: Tasks continue even if all subscribers disconnect
- **Error handling**: Exceptions don't crash the server, stored in `error_message`
- **Cleanup**: Remove completed tasks from `_running_tasks` after 5 minutes

**Global singleton pattern:**
```python
_background_runner: BackgroundAgentRunner | None = None

def get_background_runner() -> BackgroundAgentRunner:
    global _background_runner
    if _background_runner is None:
        _background_runner = BackgroundAgentRunner()
    return _background_runner
```

### 2. Updated API Routes

#### POST `/chat/stream` (modified)

```python
@api_router.post("/chat/stream", tags=["chat"])
async def chat_stream(
    payload: ChatRequest,
    agent_service: AgentService = Depends(get_agent_service),
    db_session: AsyncSession = Depends(get_db_session),
) -> StreamingResponse:
    metrics_service = MetricsService(db_session)
    runner = get_background_runner()

    # Prepare conversation and create AgentRun with status="pending"
    conversation = await metrics_service.prepare_chat(payload)
    run = await metrics_service.create_agent_run(conversation.id, payload)
    conversation_messages = await metrics_service.build_conversation_messages(conversation.id)

    # Start background execution
    await runner.start_agent_run(
        run_id=run.id,
        conversation_id=conversation.id,
        payload=payload,
        conversation_messages=conversation_messages,
        agent_service=agent_service,
    )

    # Subscribe and stream events
    async def event_generator():
        queue = await runner.subscribe_to_run(run.id)
        try:
            yield _format_sse("status", {
                "state": "started",
                "conversation_id": conversation.id,
                "run_id": run.id
            })

            while True:
                event = await queue.get()
                if event is None:  # Completion signal
                    # Load final state from database
                    final_response = await metrics_service.get_final_response(run.id)
                    yield _format_sse("final", final_response)
                    break

                yield _format_sse("trace", event)
        finally:
            runner.unsubscribe_from_run(run.id, queue)

    return StreamingResponse(event_generator(), media_type="text/event-stream")
```

**Changes:**
- Create `AgentRun` record immediately with `status="pending"`
- Return `run_id` in initial status event
- Background task continues even after SSE disconnect
- No task cancellation on client disconnect

#### GET `/chat/stream/{run_id}` (new endpoint)

Allow reconnection to an existing run:

```python
@api_router.get("/chat/stream/{run_id}", tags=["chat"])
async def reconnect_to_stream(
    run_id: str,
    last_sequence: int = 0,  # Client sends last event sequence they received
    db_session: AsyncSession = Depends(get_db_session),
) -> StreamingResponse:
    metrics_service = MetricsService(db_session)
    runner = get_background_runner()

    # Load run status
    run = await metrics_service.get_agent_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")

    async def event_generator():
        # Send current status
        yield _format_sse("status", {
            "state": run.status,
            "run_id": run.id,
            "conversation_id": run.conversation_id
        })

        # Send all historical events since last_sequence
        historical_events = await metrics_service.get_trace_events(run_id, after_sequence=last_sequence)
        for event in historical_events:
            yield _format_sse("trace", event)

        if run.status == "completed":
            # Send final response
            final_response = await metrics_service.get_final_response(run.id)
            yield _format_sse("final", final_response)

        elif run.status == "failed":
            # Send error
            yield _format_sse("error", {"message": run.error_message})

        elif run.status in ("pending", "running"):
            # Subscribe to live updates
            queue = await runner.subscribe_to_run(run.id)
            try:
                while True:
                    event = await queue.get()
                    if event is None:
                        final_response = await metrics_service.get_final_response(run.id)
                        yield _format_sse("final", final_response)
                        break
                    yield _format_sse("trace", event)
            finally:
                runner.unsubscribe_from_run(run.id, queue)

    return StreamingResponse(event_generator(), media_type="text/event-stream")
```

**Features:**
- Client can reconnect at any time
- `last_sequence` parameter for deduplication
- Historical events sent immediately
- Live events streamed if still running
- Works even if run completed while user was offline

### 3. MetricsService Extensions

Add methods to `MetricsService`:

```python
async def create_agent_run(
    self,
    conversation_id: str,
    payload: ChatRequest,
) -> AgentRun:
    """Create AgentRun record with status='pending'."""
    run = AgentRun(
        conversation_id=conversation_id,
        status="pending",
        model_name=self.settings.agent_model,
    )
    self.session.add(run)
    await self.session.commit()
    return run

async def get_agent_run(self, run_id: str) -> AgentRun | None:
    """Get AgentRun by ID."""
    return await self.session.get(AgentRun, run_id)

async def get_trace_events(
    self,
    run_id: str,
    after_sequence: int = 0,
) -> list[ChatTraceEvent]:
    """Get trace events for a run, optionally filtered by sequence."""
    events = (
        await self.session.execute(
            select(TraceEvent)
            .where(TraceEvent.run_id == run_id)
            .where(TraceEvent.sequence > after_sequence)
            .order_by(TraceEvent.sequence.asc())
        )
    ).scalars().all()

    return [
        ChatTraceEvent(
            id=event.id,
            type=event.event_type,
            title=event.title,
            content=event.content,
            metadata=json.loads(event.metadata),
        )
        for event in events
    ]

async def get_final_response(self, run_id: str) -> ChatResponse:
    """Build final ChatResponse from completed run."""
    run = await self.get_agent_run(run_id)
    if run is None:
        raise ValueError(f"Run {run_id} not found")

    message = (
        await self.session.execute(
            select(Message)
            .where(Message.run_id == run_id)
            .where(Message.role == "assistant")
        )
    ).scalar_one()

    trace = await self.get_trace_events(run_id)

    return ChatResponse(
        conversation_id=run.conversation_id,
        run_id=run.id,
        answer=message.content,
        trace=trace,
        metrics=self._to_metrics(run),
    )
```

## Frontend Implementation

### 1. Update `streamChatMessage` in `lib/api.ts`

Current approach: single SSE connection, no reconnection logic

**Proposed changes:**

```typescript
export async function streamChatMessage(
  message: string,
  conversationId: string | undefined,
  researchMode: ResearchMode,
  attachments: ChatAttachment[],
  callbacks: StreamChatCallbacks,
): Promise<ChatResponse> {
  let runId: string | undefined
  let lastSequence = 0

  // Make initial request
  const response = await fetch(`${API_BASE_URL}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      conversation_id: conversationId,
      research_mode: researchMode,
      attachments,
    }),
  })

  if (!response.ok || !response.body) {
    throw new Error('The agent stream request failed.')
  }

  return await consumeEventStream(response.body, callbacks, (eventRunId) => {
    runId = eventRunId
  })
}
```

**Add reconnection helper:**

```typescript
async function consumeEventStream(
  body: ReadableStream<Uint8Array>,
  callbacks: StreamChatCallbacks,
  onRunId: (runId: string) => void,
): Promise<ChatResponse> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalResponse: ChatResponse | undefined

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''

      for (const part of parts) {
        const parsed = parseSseEvent(part)
        if (!parsed) continue

        if (parsed.event === 'status') {
          const data = parsed.data as { run_id?: string }
          if (data.run_id) {
            onRunId(data.run_id)
          }
          callbacks.onStatus?.(data)
        } else if (parsed.event === 'trace') {
          callbacks.onTrace?.(parsed.data as ChatTraceEvent)
        } else if (parsed.event === 'final') {
          finalResponse = parsed.data as ChatResponse
          callbacks.onFinal?.(finalResponse)
        } else if (parsed.event === 'error') {
          throw new Error(String((parsed.data as { message?: string }).message))
        }
      }
    }
  } catch (err) {
    // Connection lost - could implement reconnection here
    throw err
  }

  if (!finalResponse) {
    throw new Error('Stream ended without final response.')
  }

  return finalResponse
}
```

### 2. Add Reconnection Logic (Optional Enhancement)

Store `runId` and `lastSequence` in component state or localStorage:

```typescript
// In chat-page.tsx
useEffect(() => {
  // On mount, check if there's a pending run in localStorage
  const pendingRunId = localStorage.getItem('pending_run_id')
  if (pendingRunId) {
    reconnectToRun(pendingRunId)
  }
}, [])

async function reconnectToRun(runId: string) {
  const lastSequence = Number(localStorage.getItem('last_sequence') || '0')

  const response = await fetch(`${API_BASE_URL}/chat/stream/${runId}?last_sequence=${lastSequence}`)
  // ... handle reconnection stream
}
```

### 3. UI Enhancements

**Show reconnection state:**
- "Reconnecting to agent run..."
- Progress indicator showing which events already received
- Button to manually reconnect if connection drops

**Persist run state:**
- Store active `run_id` in localStorage
- Clear on completion or explicit user action
- Show banner on page load if pending run exists

## Multi-Server Scalability Considerations

**Current limitation:** In-memory `_running_tasks` only works on single server

**Future solutions (when needed):**

### Option 1: Sticky Sessions
- Use load balancer sticky sessions based on `run_id`
- All reconnections route to same server
- Simple, works for small-medium scale

### Option 2: Distributed Task Queue (Celery + Redis)
- Move from `asyncio.Task` to Celery tasks
- Redis for pub/sub event distribution
- Any server can subscribe to any run's events
- More complex, required for large scale

### Option 3: PostgreSQL LISTEN/NOTIFY
- Use PostgreSQL pub/sub for event broadcasting
- All servers listen for events on their active runs
- No additional infrastructure needed
- Limited to PostgreSQL-connected servers

**Recommendation:** Start with single-server design (current plan), add sticky sessions when deploying multiple servers, migrate to Celery only if needed at scale.

## Testing Plan

### 1. Unit Tests

```python
# tests/test_background_runner.py
async def test_agent_run_persists_after_disconnect():
    """Verify agent continues running after client disconnects."""

async def test_reconnection_receives_historical_events():
    """Verify reconnecting client gets all past events."""

async def test_multiple_subscribers_to_same_run():
    """Verify multiple clients can watch same run."""

async def test_failed_run_stores_error():
    """Verify failed runs store error message."""
```

### 2. Integration Tests

```python
# tests/test_persistent_execution.py
async def test_full_disconnect_reconnect_flow():
    """
    1. Start agent run
    2. Receive some events
    3. Close connection
    4. Reconnect
    5. Verify all events received
    6. Verify final response correct
    """

async def test_run_completes_while_offline():
    """
    1. Start agent run
    2. Immediately disconnect
    3. Wait for completion
    4. Reconnect
    5. Verify all events in database
    6. Verify final response received
    """
```

### 3. Manual Testing Scenarios

1. **Browser close during execution**
   - Start long research request
   - Close browser tab
   - Wait 30 seconds
   - Reopen conversation
   - Verify agent completed and results visible

2. **Network interruption**
   - Start request
   - Disable network
   - Wait 10 seconds
   - Re-enable network
   - Verify auto-reconnection (if implemented)

3. **Multiple tabs**
   - Open same conversation in two tabs
   - Start request in tab 1
   - Watch updates in tab 2
   - Verify both receive same events

## Migration Path

### Phase 1: Database Schema (Non-Breaking)
1. Add new columns to `AgentRun` (nullable)
2. Create `TraceEvent` table
3. Deploy schema changes
4. Backfill `status="completed"` for existing runs

### Phase 2: Backend Implementation
1. Implement `BackgroundAgentRunner`
2. Add `create_agent_run` to `MetricsService`
3. Update `POST /chat/stream` to create run immediately
4. Persist trace events to database during execution
5. Keep old behavior (cancel on disconnect) initially

### Phase 3: Add Reconnection Endpoint
1. Implement `GET /chat/stream/{run_id}`
2. Add `get_trace_events` to `MetricsService`
3. Test reconnection manually

### Phase 4: Remove Task Cancellation
1. Remove task cancellation from `POST /chat/stream`
2. Tasks now persist after disconnect
3. Monitor for orphaned tasks

### Phase 5: Frontend Enhancement (Optional)
1. Store `run_id` in component state
2. Add reconnection UI
3. Implement auto-reconnection on page load

## Risks and Mitigations

### Risk 1: Orphaned Tasks
**Problem:** Tasks continue forever if agent hangs

**Mitigation:**
- Implement task timeout (e.g., 15 minutes max)
- Add background job to clean up stale runs
- Monitor task count metrics

### Risk 2: Database Growth
**Problem:** `TraceEvent` table grows unbounded

**Mitigation:**
- Archive events older than 30 days
- Implement retention policy
- Add database size monitoring

### Risk 3: Memory Leaks
**Problem:** Event queues not cleaned up properly

**Mitigation:**
- Weak references or TTL for subscriber queues
- Cleanup logic in `finally` blocks
- Memory monitoring and alerting

### Risk 4: Race Conditions
**Problem:** Multiple servers starting same run

**Mitigation:**
- Use database row locking
- Check run status before starting
- Idempotent task execution

## Open Questions

1. **Should we implement automatic reconnection or require user action?**
   - Auto-reconnection: Better UX, more complex
   - Manual reconnection: Simpler, explicit user intent

2. **How long should completed runs remain "watchable"?**
   - Option A: Forever (until user deletes)
   - Option B: 24 hours then require page reload
   - Option C: Until browser session ends

3. **Should we support pausing/canceling running agents?**
   - Useful for expensive mistakes
   - Adds complexity to agent lifecycle
   - Could be future enhancement

4. **Notification system for completed runs?**
   - Email notification when run completes
   - Push notification if browser supports
   - Or just require user to check back

## Success Metrics

- [ ] Agent runs complete successfully even after browser close
- [ ] Users can reconnect and see all historical events
- [ ] No increase in failed runs due to disconnections
- [ ] Database size remains manageable (< 1 GB per 10k runs)
- [ ] Memory usage stable (no leaks from event queues)
- [ ] Latency unchanged for completed runs
- [ ] SSE reconnection time < 500ms

## References

- FastAPI SSE: https://fastapi.tiangolo.com/advanced/custom-response/#streamingresponse
- PostgreSQL LISTEN/NOTIFY: https://www.postgresql.org/docs/current/sql-notify.html
- Asyncio Task Management: https://docs.python.org/3/library/asyncio-task.html
