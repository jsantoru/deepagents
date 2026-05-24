import asyncio
from collections import defaultdict
from collections.abc import Sequence
from contextlib import suppress
from time import perf_counter

from deepagents_app.core.db import get_session_factory
from deepagents_app.schemas.chat import ChatRequest, ChatTraceEvent
from deepagents_app.services.agent_service import AgentService
from deepagents_app.services.metrics_service import MetricsService


class BackgroundAgentRunner:
    def __init__(self) -> None:
        self._running_tasks: dict[str, asyncio.Task[None]] = {}
        self._subscriber_queues: dict[str, list[asyncio.Queue[tuple[str, object | None]]]] = defaultdict(list)
        self._lock = asyncio.Lock()

    async def start_run(
        self,
        run_id: str,
        payload: ChatRequest,
        conversation_messages: Sequence[dict[str, str]],
        agent_service: AgentService,
    ) -> None:
        async with self._lock:
            existing = self._running_tasks.get(run_id)
            if existing is not None and not existing.done():
                return
            task = asyncio.create_task(
                self._execute_run(run_id, payload, list(conversation_messages), agent_service)
            )
            self._running_tasks[run_id] = task

    async def subscribe(self, run_id: str) -> asyncio.Queue[tuple[str, object | None]]:
        queue: asyncio.Queue[tuple[str, object | None]] = asyncio.Queue()
        async with self._lock:
            self._subscriber_queues[run_id].append(queue)
        return queue

    async def unsubscribe(self, run_id: str, queue: asyncio.Queue[tuple[str, object | None]]) -> None:
        async with self._lock:
            subscribers = self._subscriber_queues.get(run_id, [])
            with suppress(ValueError):
                subscribers.remove(queue)
            if not subscribers and run_id not in self._running_tasks:
                self._subscriber_queues.pop(run_id, None)

    async def shutdown(self) -> None:
        async with self._lock:
            tasks = list(self._running_tasks.values())
            self._running_tasks.clear()
            queues = list(self._subscriber_queues.items())
            self._subscriber_queues.clear()

        for task in tasks:
            if not task.done():
                task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError):
                await task
        for _run_id, subscribers in queues:
            for queue in subscribers:
                await queue.put(("done", None))

    async def _execute_run(
        self,
        run_id: str,
        payload: ChatRequest,
        conversation_messages: list[dict[str, str]],
        agent_service: AgentService,
    ) -> None:
        session_factory = get_session_factory()

        async def persist_and_broadcast(event: ChatTraceEvent) -> None:
            async with session_factory() as session:
                metrics_service = MetricsService(session)
                persisted_event = await metrics_service.append_trace_event(run_id, event)
            await self._broadcast(run_id, "trace", persisted_event)

        try:
            async with session_factory() as session:
                metrics_service = MetricsService(session)
                await metrics_service.mark_run_running(run_id)

            started_at = perf_counter()
            agent_result = await agent_service.stream_chat(
                payload,
                persist_and_broadcast,
                conversation_messages=conversation_messages,
            )
            latency_ms = int((perf_counter() - started_at) * 1000)

            async with session_factory() as session:
                metrics_service = MetricsService(session)
                final_response = await metrics_service.finalize_run(run_id, agent_result, latency_ms)

            await self._broadcast(run_id, "final", final_response)
        except Exception as exc:
            async with session_factory() as session:
                metrics_service = MetricsService(session)
                await metrics_service.mark_run_failed(run_id, str(exc))
            await self._broadcast(run_id, "error", {"message": str(exc)})
        finally:
            await self._broadcast(run_id, "done", None)
            async with self._lock:
                self._running_tasks.pop(run_id, None)
                if not self._subscriber_queues.get(run_id):
                    self._subscriber_queues.pop(run_id, None)

    async def _broadcast(self, run_id: str, event_type: str, payload: object | None) -> None:
        async with self._lock:
            subscribers = list(self._subscriber_queues.get(run_id, []))
        for queue in subscribers:
            await queue.put((event_type, payload))


_background_runner: BackgroundAgentRunner | None = None


def get_background_runner() -> BackgroundAgentRunner:
    global _background_runner
    if _background_runner is None:
        _background_runner = BackgroundAgentRunner()
    return _background_runner


async def shutdown_background_runner() -> None:
    global _background_runner
    if _background_runner is not None:
        await _background_runner.shutdown()
        _background_runner = None
