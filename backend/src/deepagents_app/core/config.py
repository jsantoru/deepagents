from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: str = "development"
    app_name: str = "DeepAgents Chat Platform"
    api_v1_prefix: str = "/api/v1"
    backend_cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])

    database_url: str = "postgresql+asyncpg://deepagents:deepagents@localhost:5432/deepagents"

    openai_api_key: str = ""
    tavily_api_key: str = ""
    agent_model: str = "openai:gpt-5-nano"
    agent_max_search_results: int = 5

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
