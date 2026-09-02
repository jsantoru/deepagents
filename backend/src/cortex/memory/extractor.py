"""LLM-based entity/relation extraction that feeds the knowledge graph."""

import json
import re

from langchain.chat_models import init_chat_model

from cortex.config import get_settings
from cortex.memory.graph import ExtractedEntity, ExtractedRelation

EXTRACTION_PROMPT = """You are a knowledge-graph builder for a research agent's long-term memory.

From the exchange below, extract the durable knowledge worth remembering across sessions.

Rules:
- Extract concrete entities: people, organizations, products, technologies, places, events, concepts.
- Use canonical names ("OpenAI", not "the company"). Merge obvious duplicates.
- Types must be one of: person, organization, product, technology, place, event, concept.
- Each entity gets a one-sentence factual summary grounded in the exchange.
- Extract relations only between entities you listed, with a short snake_case type
  (e.g. founded_by, acquired, competes_with, based_in, works_on, part_of, uses).
- Skip filler, meta-discussion, and anything about the assistant itself.
- 3 to 10 entities, 0 to 12 relations. Quality over quantity.

Return ONLY valid JSON, no markdown fences, in exactly this shape:
{"entities": [{"name": "...", "type": "...", "summary": "..."}],
 "relations": [{"source": "...", "target": "...", "type": "...", "description": "..."}]}

Exchange:
USER: {user_message}

ASSISTANT (research findings): {assistant_message}
"""


class EntityExtractor:
    def __init__(self) -> None:
        self._model = None

    def _get_model(self):
        if self._model is None:
            self._model = init_chat_model(get_settings().memory_model)
        return self._model

    async def extract(
        self, user_message: str, assistant_message: str
    ) -> tuple[list[ExtractedEntity], list[ExtractedRelation]]:
        prompt = EXTRACTION_PROMPT.replace("{user_message}", user_message[:4000]).replace(
            "{assistant_message}", assistant_message[:12000]
        )
        try:
            response = await self._get_model().ainvoke(prompt)
            content = response.content if isinstance(response.content, str) else str(response.content)
        except Exception:
            return [], []
        return parse_extraction(content)


def parse_extraction(raw: str) -> tuple[list[ExtractedEntity], list[ExtractedRelation]]:
    payload = _load_json(raw)
    if not isinstance(payload, dict):
        return [], []

    entities: list[ExtractedEntity] = []
    for item in payload.get("entities", []) or []:
        if isinstance(item, dict) and str(item.get("name", "")).strip():
            entities.append(
                ExtractedEntity(
                    name=str(item["name"]).strip()[:255],
                    type=str(item.get("type", "concept")).strip()[:64],
                    summary=str(item.get("summary", "")).strip()[:1000],
                )
            )

    relations: list[ExtractedRelation] = []
    for item in payload.get("relations", []) or []:
        if (
            isinstance(item, dict)
            and str(item.get("source", "")).strip()
            and str(item.get("target", "")).strip()
        ):
            relations.append(
                ExtractedRelation(
                    source=str(item["source"]).strip()[:255],
                    target=str(item["target"]).strip()[:255],
                    type=str(item.get("type", "related_to")).strip()[:96],
                    description=str(item.get("description", "")).strip()[:1000],
                )
            )
    return entities[:12], relations[:16]


def _load_json(raw: str) -> object:
    text = raw.strip()
    # Strip markdown fences if the model added them anyway.
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        pass
    # Last resort: grab the outermost JSON object.
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except (json.JSONDecodeError, ValueError):
            return None
    return None
