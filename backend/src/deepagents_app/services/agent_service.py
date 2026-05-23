import asyncio
import json
from abc import ABC, abstractmethod
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

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
        answer_message = result["messages"][-1]
        answer = _normalize_message_content(answer_message.content)
        usage = getattr(answer_message, "usage_metadata", {}) or {}
        model_name = getattr(answer_message, "response_metadata", {}).get(
            "model_name",
            self.settings.agent_model,
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
                    type=event_type,
                    title=title,
                    content=content,
                )
            )
            continue

        events.append(
            ChatTraceEvent(
                type=str(role or "message"),
                title=f"Agent event {index + 1}",
                content=content,
            )
        )

    return events
