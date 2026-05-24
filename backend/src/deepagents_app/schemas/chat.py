from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, model_validator

ResearchMode = Literal["light", "standard"]
MAX_TEXT_ATTACHMENT_COUNT = 6
MAX_TEXT_ATTACHMENT_BYTES = 200_000
MAX_TOTAL_TEXT_ATTACHMENT_BYTES = 600_000
ALLOWED_TEXT_ATTACHMENT_EXTENSIONS = {
    ".c",
    ".cc",
    ".cpp",
    ".css",
    ".csv",
    ".go",
    ".html",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".log",
    ".md",
    ".py",
    ".rb",
    ".rs",
    ".sql",
    ".svg",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}


class ChatAttachmentInput(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=255)
    mime_type: str = Field(min_length=1, max_length=255)
    size_bytes: int = Field(gt=0, le=MAX_TEXT_ATTACHMENT_BYTES)
    text_content: str = Field(min_length=1, max_length=MAX_TEXT_ATTACHMENT_BYTES)

    @model_validator(mode="after")
    def validate_text_attachment(self) -> "ChatAttachmentInput":
        extension = Path(self.name).suffix.lower()
        if extension not in ALLOWED_TEXT_ATTACHMENT_EXTENSIONS:
            raise ValueError(f"Unsupported text attachment type: {self.name}")

        content_size = len(self.text_content.encode("utf-8"))
        if content_size > MAX_TEXT_ATTACHMENT_BYTES:
            raise ValueError(f"Attachment exceeds the {MAX_TEXT_ATTACHMENT_BYTES} byte limit.")

        if self.size_bytes != content_size:
            raise ValueError("Attachment size does not match the provided text content.")

        return self


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    conversation_id: str | None = None
    research_mode: ResearchMode = "standard"
    attachments: list[ChatAttachmentInput] = Field(default_factory=list, max_length=MAX_TEXT_ATTACHMENT_COUNT)

    @model_validator(mode="after")
    def validate_attachment_limits(self) -> "ChatRequest":
        total_bytes = sum(attachment.size_bytes for attachment in self.attachments)
        if total_bytes > MAX_TOTAL_TEXT_ATTACHMENT_BYTES:
            raise ValueError(
                f"Combined attachment size exceeds the {MAX_TOTAL_TEXT_ATTACHMENT_BYTES} byte limit."
            )
        return self


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


class ConversationAttachment(BaseModel):
    id: str
    name: str
    mime_type: str
    size_bytes: int
    sha256: str
    text_content: str
    created_at: str
