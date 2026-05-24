# Trace Events Persistence Fix

## Problem
When users restored a conversation (by clicking on it in the sidebar), they would only see:
- ✅ User messages
- ✅ Assistant final answers
- ✅ Metrics (tokens, cost, latency)
- ❌ **Missing:** Trace events (tool calls, thinking/reasoning steps, search queries)

The trace events were being generated and streamed during the initial chat but **never persisted to the database**, so they were lost when reloading the conversation.

## Solution Implemented

### Backend Changes

#### 1. Database Schema (`models/chat.py`)
Added `trace_data` field to `AgentRun` table to store trace events as JSON:

```python
class AgentRun(Base):
    # ... existing fields ...
    trace_data: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
```

**Migration needed:** Add this column to existing `agent_runs` table:
```sql
ALTER TABLE agent_runs ADD COLUMN trace_data TEXT NOT NULL DEFAULT '[]';
```

#### 2. Persist Trace Events (`services/metrics_service.py`)
Updated `_persist_run()` to serialize and save trace events:

```python
trace_data=json.dumps([event.model_dump() for event in agent_result.trace])
```

Added helper method to deserialize trace events when loading:

```python
@staticmethod
def _deserialize_trace(trace_data: str) -> list[ChatTraceEvent]:
    """Deserialize trace events from JSON string."""
    try:
        trace_list = json.loads(trace_data)
        return [ChatTraceEvent(**event) for event in trace_list]
    except (json.JSONDecodeError, TypeError, ValueError):
        return []
```

#### 3. API Schema (`schemas/admin.py`)
Added `trace` field to `ConversationMessage`:

```python
class ConversationMessage(BaseModel):
    # ... existing fields ...
    trace: list[ChatTraceEvent] = []
```

#### 4. Load Trace Events (`services/metrics_service.py`)
Updated `get_conversation()` to deserialize and return trace events:

```python
trace=self._deserialize_trace(runs_by_id[message.run_id].trace_data)
if message.run_id and message.run_id in runs_by_id
else [],
```

### Frontend Changes

#### 1. TypeScript Types (`lib/api.ts`)
Added `trace` field to `ConversationMessage` type:

```typescript
export type ConversationMessage = {
  // ... existing fields ...
  trace?: ChatTraceEvent[]
}
```

#### 2. Conversation Loading (`pages/chat-page.tsx`)
Updated `handleOpenConversation()` to map the trace field:

```typescript
setMessages(
  response.messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    attachments: message.attachments ?? [],
    metrics: message.metrics ?? undefined,
    trace: message.trace ?? [],  // ← Added this line
  })),
)
```

The existing `ConversationMessages` component already knows how to render trace events via the `TraceTimeline` component, so no other frontend changes were needed!

## Database Migration

### For Development (Docker Compose)

If you're using Docker Compose with a fresh database, the schema will be created automatically on startup.

If you have existing data:

1. **Option A: Reset database** (loses all data)
   ```bash
   docker compose down -v
   docker compose up --build
   ```

2. **Option B: Manual migration** (preserves data)
   ```bash
   # Connect to the database
   docker exec -it deepagents-postgres psql -U deepagents -d deepagents

   # Run the migration
   ALTER TABLE agent_runs ADD COLUMN trace_data TEXT NOT NULL DEFAULT '[]';

   # Exit
   \q
   ```

### For Production

Use a proper migration tool or run the SQL manually:

```sql
-- Add the trace_data column
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS trace_data TEXT NOT NULL DEFAULT '[]';

-- Verify
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'agent_runs' AND column_name = 'trace_data';
```

## Testing the Fix

1. **Start a new chat** with a research question
2. **Wait for completion** - you should see tool calls and thinking steps
3. **Reload the page** or click on the conversation in the sidebar
4. **Verify** that the tool calls and thinking steps are still visible

### What You Should See

When restoring a conversation, assistant messages should now show:
- ✅ Final markdown-formatted answer
- ✅ Collapsible trace timeline with:
  - Tool calls (searches)
  - Search results with links
  - Agent reasoning/thinking
  - Metadata (tokens, response times)
- ✅ Metrics panel (tokens, latency, cost)

## Files Changed

### Backend
- `backend/src/deepagents_app/models/chat.py` - Added `trace_data` field
- `backend/src/deepagents_app/services/metrics_service.py` - Persist and deserialize trace
- `backend/src/deepagents_app/schemas/admin.py` - Added `trace` to ConversationMessage

### Frontend
- `frontend/src/lib/api.ts` - Added `trace` to ConversationMessage type
- `frontend/src/pages/chat-page.tsx` - Map trace when loading conversations

## Size Considerations

**Average trace event storage:**
- Typical run: 10-50 trace events
- Average event size: ~500 bytes (title + content + metadata)
- Per run: 5-25 KB
- 1,000 runs: 5-25 MB
- 10,000 runs: 50-250 MB

This is acceptable overhead for the improved user experience. If needed, future optimizations could include:
- Compressing trace_data JSON
- Archiving old trace events
- Implementing retention policies

## Related to Persistent Execution Plan

This fix complements the "Persistent Agent Execution" plan (`documentation/plans/persistent-agent-execution.md`) but solves a different problem:

- **This fix:** Persists trace events that were already generated
- **Future plan:** Keeps agent running even after browser closes

When implementing the persistent execution plan, the `TraceEvent` table proposed there would replace this `trace_data` JSON field with a proper relational structure.
