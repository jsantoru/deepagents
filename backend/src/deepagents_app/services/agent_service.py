import asyncio
import json
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Literal
from uuid import uuid4

from deepagents import create_deep_agent
from tavily import TavilyClient

from deepagents_app.core.config import get_settings
from deepagents_app.schemas.chat import ChatRequest, ChatTraceEvent


@dataclass(slots=True)
class AgentRunResult:
    answer: str
    trace: list[ChatTraceEvent]
    model_name: str
    input_tokens: int
    output_tokens: int
    total_tokens: int
    search_calls: int
    raw_payload: dict


class AgentService(ABC):
    @abstractmethod
    async def chat(self, payload: ChatRequest) -> AgentRunResult:
        """Execute a chat request."""

    @abstractmethod
    async def stream_chat(
        self,
        payload: ChatRequest,
        on_event: Callable[[ChatTraceEvent], Awaitable[None]],
    ) -> AgentRunResult:
        """Execute a chat request while streaming trace events."""


class DeepAgentsService(AgentService):
    def __init__(self) -> None:
        self.settings = get_settings()
        self._agent = self._build_agent()

    def _build_agent(self):
        tavily_client = TavilyClient(api_key=self.settings.tavily_api_key)

        def internet_search(
            query: str,
            max_results: int | None = None,
            topic: Literal["general", "news", "finance"] = "general",
            include_raw_content: bool = False,
        ):
            """Run a Tavily web search."""
            result_count = max_results or self.settings.agent_max_search_results
            return tavily_client.search(
                query,
                max_results=result_count,
                include_raw_content=include_raw_content,
                topic=topic,
            )

        system_prompt = (
            "You are a helpful research assistant. Use web search when it improves the answer. "
            "Cite concrete findings and keep the response concise."
        )

        return create_deep_agent(
            model=self.settings.agent_model,
            tools=[internet_search],
            system_prompt=system_prompt,
        )

    async def chat(self, payload: ChatRequest) -> AgentRunResult:
        result = await asyncio.to_thread(
            self._agent.invoke,
            {"messages": [{"role": "user", "content": payload.message}]},
        )
        return _build_run_result(result, self.settings.agent_model)

    async def stream_chat(
        self,
        payload: ChatRequest,
        on_event: Callable[[ChatTraceEvent], Awaitable[None]],
    ) -> AgentRunResult:
        stream_input = {"messages": [{"role": "user", "content": payload.message}]}
        last_values: dict | None = None
        active_message_ids: set[str] = set()

        async for part in self._agent.astream(
            stream_input,
            stream_mode=["messages", "tools", "values"],
        ):
            mode, data = _unpack_stream_part(part)
            if mode == "messages":
                message, metadata = data
                delta = _normalize_message_content(getattr(message, "content", ""))
                if not delta.strip():
                    continue

                message_id = getattr(message, "id", None) or metadata.get("run_id") or str(uuid4())
                title = "Agent note"
                if message_id not in active_message_ids:
                    active_message_ids.add(message_id)
                    await on_event(
                        ChatTraceEvent(
                            id=str(message_id),
                            type="assistant",
                            title=title,
                            content=delta,
                            metadata=_sanitize_metadata(
                                {
                                    "node": metadata.get("langgraph_node"),
                                    "step": metadata.get("langgraph_step"),
                                }
                            ),
                        )
                    )
                else:
                    await on_event(
                        ChatTraceEvent(
                            id=str(message_id),
                            type="assistant_delta",
                            title=title,
                            content=delta,
                            metadata={},
                        )
                    )
                continue

            if mode == "tools":
                tool_event = _tool_stream_to_trace_event(data)
                if tool_event is not None:
                    await on_event(tool_event)
                continue

            if mode == "values":
                last_values = data

        if last_values is None:
            raise RuntimeError("Agent stream completed without final state.")

        return _build_run_result(last_values, self.settings.agent_model)


def _normalize_message_content(content: object) -> str:
    if isinstance(content, str):
        return content

    if isinstance(content, Sequence) and not isinstance(content, (str, bytes, bytearray)):
        text_chunks: list[str] = []
        for item in content:
            if isinstance(item, str):
                text_chunks.append(item)
                continue

            if isinstance(item, dict):
                if item.get("type") == "text" and isinstance(item.get("text"), str):
                    text_chunks.append(item["text"])
                    continue

                text_value = item.get("text")
                if isinstance(text_value, str):
                    text_chunks.append(text_value)
                    continue

        if text_chunks:
            return "\n".join(chunk.strip() for chunk in text_chunks if chunk and chunk.strip())

    return json.dumps(content, ensure_ascii=True, default=str)


def _extract_trace_events(messages: Sequence[object]) -> list[ChatTraceEvent]:
    events: list[ChatTraceEvent] = []

    for index, message in enumerate(messages):
        role = getattr(message, "type", None) or getattr(message, "role", None)
        name = getattr(message, "name", None)
        content = _normalize_message_content(getattr(message, "content", ""))
        if not content.strip():
            continue

        if index == 0 and role == "human":
            continue

        if role in {"tool", "tool_message"} or name:
            metadata: dict[str, str | int | float] = {}
            if name:
                metadata["tool_name"] = str(name)
            events.append(
                ChatTraceEvent(
                    id=str(getattr(message, "id", None) or uuid4()),
                    type="tool",
                    title=f"Tool call: {name or 'tool'}",
                    content=content,
                    metadata=metadata,
                )
            )
            continue

        if role in {"ai", "assistant"}:
            title = "Final answer" if index == len(messages) - 1 else "Agent note"
            event_type = "final" if index == len(messages) - 1 else "assistant"
            events.append(
                ChatTraceEvent(
                    id=str(getattr(message, "id", None) or uuid4()),
                    type=event_type,
                    title=title,
                    content=content,
                )
            )
            continue

        events.append(
            ChatTraceEvent(
                id=str(getattr(message, "id", None) or uuid4()),
                type=str(role or "message"),
                title=f"Agent event {index + 1}",
                content=content,
            )
        )

    return events


def _build_run_result(result: dict, default_model_name: str) -> AgentRunResult:
    answer_message = result["messages"][-1]
    answer = _normalize_message_content(answer_message.content)
    usage = getattr(answer_message, "usage_metadata", {}) or {}
    model_name = getattr(answer_message, "response_metadata", {}).get(
        "model_name",
        default_model_name,
    )
    search_calls = sum(
        1
        for message in result["messages"]
        if getattr(message, "name", None) == "internet_search"
        or getattr(message, "type", None) == "tool"
    )
    return AgentRunResult(
        answer=answer,
        trace=_extract_trace_events(result["messages"]),
        model_name=model_name,
        input_tokens=usage.get("input_tokens", 0),
        output_tokens=usage.get("output_tokens", 0),
        total_tokens=usage.get("total_tokens", 0),
        search_calls=search_calls,
        raw_payload=result,
    )


def _unpack_stream_part(part: object) -> tuple[str, object]:
    if isinstance(part, tuple) and len(part) == 2:
        return str(part[0]), part[1]
    if isinstance(part, tuple) and len(part) == 3:
        return str(part[1]), part[2]
    raise TypeError(f"Unexpected stream part shape: {type(part)!r}")


def _sanitize_metadata(metadata: dict[str, object]) -> dict[str, str | int | float]:
    sanitized: dict[str, str | int | float] = {}
    for key, value in metadata.items():
        if isinstance(value, (str, int, float)):
            sanitized[key] = value
    return sanitized


def _tool_stream_to_trace_event(data: object) -> ChatTraceEvent | None:
    if not isinstance(data, dict):
        return None

    tool_call_id = str(data.get("tool_call_id") or uuid4())
    event_name = str(data.get("event") or "")
    tool_name = str(data.get("tool_name") or "tool")

    if event_name == "tool-started":
        return ChatTraceEvent(
            id=tool_call_id,
            type="tool",
            title=f"Tool call: {tool_name}",
            content=json.dumps(data.get("input", {}), ensure_ascii=True, default=str),
            metadata={"tool_name": tool_name},
        )

    if event_name == "tool-output-delta":
        return ChatTraceEvent(
            id=tool_call_id,
            type="tool_delta",
            title=f"Tool call: {tool_name}",
            content=_normalize_message_content(data.get("delta", "")),
            metadata={},
        )

    if event_name == "tool-finished":
        return ChatTraceEvent(
            id=tool_call_id,
            type="tool_result",
            title=f"Tool result: {tool_name}",
            content=_normalize_message_content(data.get("output", "")),
            metadata={"tool_name": tool_name},
        )

    if event_name == "tool-error":
        return ChatTraceEvent(
            id=tool_call_id,
            type="tool_error",
            title=f"Tool error: {tool_name}",
            content=_normalize_message_content(data.get("message", "")),
            metadata={"tool_name": tool_name},
        )

    return None
