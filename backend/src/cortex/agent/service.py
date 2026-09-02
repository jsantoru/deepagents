"""Deep agent execution with live trace streaming."""

import json
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Literal
from uuid import uuid4

from deepagents import create_deep_agent
from tavily import TavilyClient

from cortex.agent.prompts import build_system_prompt
from cortex.config import get_settings
from cortex.schemas import ResearchMode, TraceEvent

OnEvent = Callable[[TraceEvent], Awaitable[None]]


@dataclass(slots=True)
class AgentRunResult:
    answer: str
    model_name: str
    input_tokens: int
    output_tokens: int
    search_calls: int


class AgentService(ABC):
    @abstractmethod
    async def stream_chat(
        self,
        messages: Sequence[dict[str, str]],
        mode: ResearchMode,
        memory_context: str,
        on_event: OnEvent,
    ) -> AgentRunResult: ...


class DeepAgentsService(AgentService):
    def __init__(self) -> None:
        self.settings = get_settings()
        self._tools = self._build_tools()

    def _build_tools(self):
        tavily_client = TavilyClient(api_key=self.settings.tavily_api_key)

        def internet_search(
            query: str,
            max_results: int | None = None,
            topic: Literal["general", "news", "finance"] = "general",
        ):
            """Run a Tavily web search."""
            count = max_results or self.settings.agent_max_search_results
            raw = tavily_client.search(query, max_results=count, topic=topic)
            # Cap content to stay under the deepagents tool-result size limit.
            return {
                "query": raw.get("query", query),
                "results": [
                    {
                        "title": r.get("title", ""),
                        "url": r.get("url", ""),
                        "content": (r.get("content") or "")[:1500],
                    }
                    for r in raw.get("results", [])
                ],
            }

        return [internet_search]

    async def stream_chat(
        self,
        messages: Sequence[dict[str, str]],
        mode: ResearchMode,
        memory_context: str,
        on_event: OnEvent,
    ) -> AgentRunResult:
        # Memory context changes every turn, so agents are built per run (cheap:
        # graph construction, no network).
        agent = create_deep_agent(
            model=self.settings.agent_model,
            tools=self._tools,
            system_prompt=build_system_prompt(mode, memory_context),
        )
        last_values: dict | None = None
        seen_message_ids: set[str] = set()

        async for part in agent.astream(
            {"messages": list(messages)},
            stream_mode=["messages", "tools", "values"],
        ):
            stream_mode, data = _unpack_stream_part(part)

            if stream_mode == "messages":
                message, metadata = data
                delta = _normalize_content(getattr(message, "content", ""))
                if not delta.strip():
                    continue
                message_id = str(
                    getattr(message, "id", None) or metadata.get("run_id") or uuid4()
                )
                is_new = message_id not in seen_message_ids
                seen_message_ids.add(message_id)
                await on_event(
                    TraceEvent(
                        id=message_id,
                        type="note" if is_new else "note_delta",
                        title="Reasoning",
                        content=delta,
                        metadata={"node": str(metadata.get("langgraph_node", ""))} if is_new else {},
                    )
                )
                continue

            if stream_mode == "tools":
                event = _tool_event(data)
                if event is not None:
                    await on_event(event)
                continue

            if stream_mode == "values":
                last_values = data

        if last_values is None:
            raise RuntimeError("Agent stream completed without final state.")
        return _build_result(last_values, self.settings.agent_model)


def _build_result(values: dict, default_model: str) -> AgentRunResult:
    answer_message = values["messages"][-1]
    usage = getattr(answer_message, "usage_metadata", {}) or {}
    model_name = (getattr(answer_message, "response_metadata", {}) or {}).get(
        "model_name", default_model
    )
    search_calls = sum(
        1 for m in values["messages"] if getattr(m, "name", None) == "internet_search"
    )
    return AgentRunResult(
        answer=_normalize_content(answer_message.content),
        model_name=model_name,
        input_tokens=usage.get("input_tokens", 0),
        output_tokens=usage.get("output_tokens", 0),
        search_calls=search_calls,
    )


def _unpack_stream_part(part: object) -> tuple[str, object]:
    if isinstance(part, tuple) and len(part) == 2:
        return str(part[0]), part[1]
    if isinstance(part, tuple) and len(part) == 3:
        return str(part[1]), part[2]
    raise TypeError(f"Unexpected stream part shape: {type(part)!r}")


def _normalize_content(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, Sequence) and not isinstance(content, (str, bytes, bytearray)):
        chunks: list[str] = []
        for item in content:
            if isinstance(item, str):
                chunks.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                chunks.append(item["text"])
        if chunks:
            return "\n".join(c.strip() for c in chunks if c.strip())
    return json.dumps(content, ensure_ascii=True, default=str)


def _tool_event(data: object) -> TraceEvent | None:
    if not isinstance(data, dict):
        return None
    tool_call_id = str(data.get("tool_call_id") or uuid4())
    event_name = str(data.get("event") or "")
    tool_name = str(data.get("tool_name") or "tool")

    if event_name == "tool-started":
        return TraceEvent(
            id=tool_call_id,
            type="tool",
            title=tool_name,
            content=json.dumps(data.get("input", {}), ensure_ascii=True, default=str),
            metadata={"tool_name": tool_name},
        )

    if event_name == "tool-finished":
        output = data.get("output", "")
        output_dict: dict | None = None
        if isinstance(output, dict):
            output_dict = output
        else:
            raw = output if isinstance(output, str) else getattr(output, "content", None)
            if isinstance(raw, str):
                try:
                    parsed = json.loads(raw)
                    if isinstance(parsed, dict):
                        output_dict = parsed
                except (json.JSONDecodeError, ValueError):
                    pass

        metadata: dict[str, object] = {"tool_name": tool_name}
        if output_dict is not None:
            results = output_dict.get("results", [])
            if isinstance(results, list):
                metadata["results"] = [
                    {
                        "title": r.get("title", ""),
                        "url": r.get("url", ""),
                        "snippet": (r.get("content") or "")[:240],
                    }
                    for r in results[:8]
                    if isinstance(r, dict) and r.get("url")
                ]
            content_str = json.dumps(output_dict, ensure_ascii=True, default=str)
        else:
            content_str = _normalize_content(
                output if isinstance(output, (str, list)) else getattr(output, "content", output)
            )
        return TraceEvent(
            id=tool_call_id,
            type="tool_result",
            title=tool_name,
            content=content_str[:4000],
            metadata=metadata,
        )

    if event_name == "tool-error":
        return TraceEvent(
            id=tool_call_id,
            type="tool_error",
            title=tool_name,
            content=_normalize_content(data.get("message", "")),
            metadata={"tool_name": tool_name},
        )

    return None
