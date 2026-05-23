from deepagents_app.services.agent_service import AgentService, DeepAgentsService


def get_agent_service() -> AgentService:
    return DeepAgentsService()
