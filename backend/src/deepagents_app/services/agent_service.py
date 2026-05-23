import asyncio
from abc import ABC, abstractmethod
from typing import Literal

from deepagents import create_deep_agent
from tavily import TavilyClient

from deepagents_app.core.config import get_settings
from deepagents_app.schemas.chat import ChatRequest, ChatResponse


class AgentService(ABC):
    @abstractmethod
    async def chat(self, payload: ChatRequest) -> ChatResponse:
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

    async def chat(self, payload: ChatRequest) -> ChatResponse:
        result = await asyncio.to_thread(
            self._agent.invoke,
            {"messages": [{"role": "user", "content": payload.message}]},
        )
        answer = result["messages"][-1].content
        return ChatResponse(answer=answer)
