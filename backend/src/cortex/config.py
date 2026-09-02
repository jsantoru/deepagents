from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    openai_api_key: str = ""
    tavily_api_key: str = ""

    database_url: str = "sqlite+aiosqlite:///./cortex.db"
    agent_model: str = "openai:gpt-5-nano"
    extractor_model: str = ""  # defaults to agent_model when empty
    agent_max_search_results: int = 5

    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    @property
    def memory_model(self) -> str:
        return self.extractor_model or self.agent_model


@lru_cache
def get_settings() -> Settings:
    return Settings()
