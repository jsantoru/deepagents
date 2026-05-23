from typing import Literal

from pydantic import BaseModel, Field

ResearchMode = Literal["light", "standard"]


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    conversation_id: str | None = None
    research_mode: ResearchMode = "standard"


class ChatTraceEvent(BaseModel):
    id: str = Field(min_length=1)
    type: str
    title: str
    content: str
    metadata: dict[str, str | int | float] = Field(default_factory=dict)


class ChatRunMetrics(BaseModel):
    model_name: str
    latency_ms: int
    input_tokens: int
    output_tokens: int
    total_tokens: int
    estimated_cost_usd: float
    search_calls: int


class ChatResponse(BaseModel):
    conversation_id: str
    run_id: str
    answer: str
    trace: list[ChatTraceEvent]
    metrics: ChatRunMetrics
