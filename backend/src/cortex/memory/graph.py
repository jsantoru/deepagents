"""Lightweight knowledge-graph store backed by SQLite.

Entities and typed relations are first-class rows; every mutation is also
recorded in an append-only ``graph_events`` log so the frontend can replay
how the memory grew across sessions.
"""

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from cortex.models import Entity, GraphEvent, Relation

_STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "in", "on", "for", "to", "with", "about",
    "what", "who", "how", "why", "when", "where", "is", "are", "was", "were", "does",
    "do", "did", "can", "could", "tell", "me", "please", "give", "find", "research",
    "latest", "recent", "news", "info", "information", "more", "their", "its", "it",
}


def normalize_name(name: str) -> str:
    """Dedupe key: lowercase, all separators removed ("Open-AI" == "OpenAI")."""
    return re.sub(r"[^a-z0-9]+", "", name.lower())


@dataclass(slots=True)
class ExtractedEntity:
    name: str
    type: str = "concept"
    summary: str = ""


@dataclass(slots=True)
class ExtractedRelation:
    source: str
    target: str
    type: str = "related_to"
    description: str = ""


@dataclass(slots=True)
class GraphDelta:
    entities_added: list[Entity] = field(default_factory=list)
    entities_reinforced: list[Entity] = field(default_factory=list)
    relations_added: list[Relation] = field(default_factory=list)
    relations_reinforced: list[Relation] = field(default_factory=list)


class GraphStore:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def upsert(
        self,
        entities: list[ExtractedEntity],
        relations: list[ExtractedRelation],
        session_id: str | None = None,
        run_id: str | None = None,
    ) -> GraphDelta:
        """Merge extracted knowledge into the graph, logging every mutation."""
        delta = GraphDelta()
        now = datetime.now(UTC)
        by_key: dict[str, Entity] = {}

        for extracted in entities:
            key = normalize_name(extracted.name)
            if not key or key in by_key:
                continue
            entity = await self._get_by_key(key)
            if entity is None:
                entity = Entity(
                    name=extracted.name.strip(),
                    name_key=key,
                    type=(extracted.type or "concept").lower().strip() or "concept",
                    summary=extracted.summary.strip(),
                    first_session_id=session_id,
                )
                self.db.add(entity)
                await self.db.flush()
                delta.entities_added.append(entity)
                self.db.add(GraphEvent(
                    kind="entity_added", entity_id=entity.id, session_id=session_id,
                    run_id=run_id, label=entity.name,
                ))
            else:
                entity.mention_count += 1
                entity.updated_at = now
                if extracted.summary.strip() and len(extracted.summary) > len(entity.summary):
                    entity.summary = extracted.summary.strip()
                delta.entities_reinforced.append(entity)
                self.db.add(GraphEvent(
                    kind="entity_reinforced", entity_id=entity.id, session_id=session_id,
                    run_id=run_id, label=entity.name,
                ))
            by_key[key] = entity

        for rel in relations:
            src = await self._resolve(rel.source, by_key)
            dst = await self._resolve(rel.target, by_key)
            if src is None or dst is None or src.id == dst.id:
                continue
            rel_type = (rel.type or "related_to").lower().strip().replace(" ", "_") or "related_to"
            existing = await self.db.scalar(
                select(Relation).where(
                    Relation.source_id == src.id,
                    Relation.target_id == dst.id,
                    Relation.type == rel_type,
                )
            )
            if existing is None:
                relation = Relation(
                    source_id=src.id, target_id=dst.id, type=rel_type,
                    description=rel.description.strip(), first_session_id=session_id,
                )
                self.db.add(relation)
                await self.db.flush()
                delta.relations_added.append(relation)
                self.db.add(GraphEvent(
                    kind="relation_added", relation_id=relation.id, session_id=session_id,
                    run_id=run_id, label=f"{src.name} —{rel_type}→ {dst.name}",
                ))
            else:
                existing.weight += 1
                existing.updated_at = now
                if rel.description.strip() and not existing.description:
                    existing.description = rel.description.strip()
                delta.relations_reinforced.append(existing)
                self.db.add(GraphEvent(
                    kind="relation_reinforced", relation_id=existing.id, session_id=session_id,
                    run_id=run_id, label=f"{src.name} —{rel_type}→ {dst.name}",
                ))

        await self.db.flush()
        return delta

    async def recall(self, text: str, limit: int = 8) -> tuple[list[Entity], list[Relation]]:
        """Find entities relevant to ``text`` plus their 1-hop neighborhood."""
        terms = [
            t for t in re.findall(r"[a-z0-9][a-z0-9\-\.]+", text.lower())
            if len(t) > 2 and t not in _STOPWORDS
        ]
        if not terms:
            return [], []
        clauses = [Entity.name_key.like(f"%{term}%") for term in terms[:12]]
        matched = list(await self.db.scalars(
            select(Entity).where(or_(*clauses))
            .order_by(Entity.mention_count.desc()).limit(limit)
        ))
        if not matched:
            return [], []
        ids = {e.id for e in matched}
        edges = list(await self.db.scalars(
            select(Relation).where(
                or_(Relation.source_id.in_(ids), Relation.target_id.in_(ids))
            ).order_by(Relation.weight.desc()).limit(limit * 4)
        ))
        neighbor_ids = {e.source_id for e in edges} | {e.target_id for e in edges}
        extra_ids = neighbor_ids - ids
        if extra_ids:
            matched += list(await self.db.scalars(select(Entity).where(Entity.id.in_(extra_ids))))
        return matched, edges

    async def full_graph(self) -> tuple[list[Entity], list[Relation]]:
        nodes = list(await self.db.scalars(select(Entity).order_by(Entity.created_at)))
        edges = list(await self.db.scalars(select(Relation).order_by(Relation.created_at)))
        return nodes, edges

    async def entity_with_neighborhood(
        self, entity_id: str
    ) -> tuple[Entity | None, list[Entity], list[Relation], list[GraphEvent]]:
        entity = await self.db.get(Entity, entity_id)
        if entity is None:
            return None, [], [], []
        edges = list(await self.db.scalars(
            select(Relation).where(
                or_(Relation.source_id == entity_id, Relation.target_id == entity_id)
            ).order_by(Relation.weight.desc())
        ))
        neighbor_ids = {e.source_id for e in edges} | {e.target_id for e in edges}
        neighbor_ids.discard(entity_id)
        neighbors = (
            list(await self.db.scalars(select(Entity).where(Entity.id.in_(neighbor_ids))))
            if neighbor_ids else []
        )
        events = list(await self.db.scalars(
            select(GraphEvent).where(GraphEvent.entity_id == entity_id)
            .order_by(GraphEvent.created_at.desc()).limit(50)
        ))
        return entity, neighbors, edges, events

    async def counts(self) -> tuple[int, int, int]:
        entities = await self.db.scalar(select(func.count(Entity.id))) or 0
        relations = await self.db.scalar(select(func.count(Relation.id))) or 0
        events = await self.db.scalar(select(func.count(GraphEvent.id))) or 0
        return entities, relations, events

    async def _get_by_key(self, key: str) -> Entity | None:
        return await self.db.scalar(select(Entity).where(Entity.name_key == key))

    async def _resolve(self, name: str, staged: dict[str, Entity]) -> Entity | None:
        key = normalize_name(name)
        if not key:
            return None
        return staged.get(key) or await self._get_by_key(key)


def format_memory_context(entities: list[Entity], relations: list[Relation]) -> str:
    """Render recalled graph knowledge as a context block for the agent prompt."""
    if not entities:
        return ""
    by_id = {e.id: e for e in entities}
    lines = ["LONG-TERM MEMORY (knowledge graph recall from prior sessions):", "", "Entities:"]
    for e in sorted(entities, key=lambda x: -x.mention_count)[:12]:
        summary = f" — {e.summary}" if e.summary else ""
        lines.append(f"- {e.name} ({e.type}, seen {e.mention_count}x){summary}")
    rel_lines = []
    for r in relations[:16]:
        src, dst = by_id.get(r.source_id), by_id.get(r.target_id)
        if src and dst:
            desc = f" ({r.description})" if r.description else ""
            rel_lines.append(f"- {src.name} → {r.type.replace('_', ' ')} → {dst.name}{desc}")
    if rel_lines:
        lines += ["", "Known relationships:"] + rel_lines
    lines += [
        "",
        (
            "Use this memory to stay consistent with prior findings, but verify anything "
            "time-sensitive with fresh searches."
        ),
    ]
    return "\n".join(lines)
