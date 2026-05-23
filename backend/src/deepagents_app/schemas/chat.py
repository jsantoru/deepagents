from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    conversation_id: str | None = None


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
    metrics: ChatRunMetrics
