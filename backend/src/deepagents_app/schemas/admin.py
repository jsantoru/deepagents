from pydantic import BaseModel

from deepagents_app.schemas.chat import ChatRunMetrics


class AdminOverviewResponse(BaseModel):
    conversation_count: int
    run_count: int
    total_tokens: int
    total_estimated_cost_usd: float
    average_latency_ms: float


class AdminRunSummary(BaseModel):
    run_id: str
    conversation_id: str
    answer_preview: str
    metrics: ChatRunMetrics
    created_at: str


class AdminRunListResponse(BaseModel):
    runs: list[AdminRunSummary]
