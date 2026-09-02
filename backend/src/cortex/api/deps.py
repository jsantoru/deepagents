from functools import lru_cache

from cortex.agent.service import AgentService, DeepAgentsService
from cortex.memory.extractor import EntityExtractor


@lru_cache
def get_agent_service() -> AgentService:
    return DeepAgentsService()


@lru_cache
def get_extractor() -> EntityExtractor:
    return EntityExtractor()
