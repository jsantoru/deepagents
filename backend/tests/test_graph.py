from cortex.memory.extractor import parse_extraction
from cortex.memory.graph import (
    ExtractedEntity,
    ExtractedRelation,
    GraphStore,
    format_memory_context,
    normalize_name,
)


def _sample():
    entities = [
        ExtractedEntity(name="Anthropic", type="organization", summary="AI safety company"),
        ExtractedEntity(name="Claude", type="product", summary="LLM assistant by Anthropic"),
    ]
    relations = [
        ExtractedRelation(source="Anthropic", target="Claude", type="builds", description="")
    ]
    return entities, relations


async def test_upsert_creates_and_reinforces(db_session):
    store = GraphStore(db_session)
    entities, relations = _sample()

    delta1 = await store.upsert(entities, relations, session_id="s1", run_id="r1")
    assert len(delta1.entities_added) == 2
    assert len(delta1.relations_added) == 1

    # Same knowledge again → reinforcement, not duplication.
    delta2 = await store.upsert(entities, relations, session_id="s2", run_id="r2")
    assert delta2.entities_added == []
    assert delta2.relations_added == []
    assert len(delta2.entities_reinforced) == 2
    assert delta2.relations_reinforced[0].weight == 2
    assert delta2.entities_reinforced[0].mention_count == 2

    nodes, edges = await store.full_graph()
    assert len(nodes) == 2
    assert len(edges) == 1
    _, _, events = await store.counts()
    assert events == 6  # 3 added + 3 reinforced


async def test_name_dedupe_is_case_and_punct_insensitive(db_session):
    store = GraphStore(db_session)
    await store.upsert([ExtractedEntity(name="OpenAI")], [])
    delta = await store.upsert([ExtractedEntity(name="open-ai")], [])
    assert delta.entities_added == []
    assert len(delta.entities_reinforced) == 1
    assert normalize_name("Open-AI!") == normalize_name("open ai")


async def test_recall_matches_and_expands_neighborhood(db_session):
    store = GraphStore(db_session)
    entities, relations = _sample()
    await store.upsert(entities, relations)

    matched, edges = await store.recall("what do you know about anthropic?")
    names = {e.name for e in matched}
    assert "Anthropic" in names
    assert "Claude" in names  # pulled in via 1-hop edge
    assert len(edges) == 1

    context = format_memory_context(matched, edges)
    assert "Anthropic" in context and "builds" in context

    empty_matched, _ = await store.recall("the of and")
    assert empty_matched == []


def test_parse_extraction_handles_fences_and_garbage():
    ok = '{"entities": [{"name": "X", "type": "person", "summary": "s"}], "relations": []}'
    entities, relations = parse_extraction(f"```json\n{ok}\n```")
    assert entities[0].name == "X"
    assert relations == []

    entities, relations = parse_extraction("total garbage")
    assert entities == [] and relations == []

    entities, _ = parse_extraction(f"Here you go:\n{ok}")
    assert entities[0].name == "X"
