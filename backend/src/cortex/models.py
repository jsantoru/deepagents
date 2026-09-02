import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _now() -> datetime:
    return datetime.now(UTC)


def _uuid() -> str:
    return uuid.uuid4().hex


class Base(DeclarativeBase):
    pass


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    title: Mapped[str] = mapped_column(String(255), default="New research")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    messages: Mapped[list["Message"]] = relationship(
        back_populates="session", cascade="all, delete-orphan", order_by="Message.created_at"
    )
    runs: Mapped[list["Run"]] = relationship(
        back_populates="session", cascade="all, delete-orphan", order_by="Run.created_at"
    )


class Run(Base):
    """One agent invocation: metrics + memory delta bookkeeping."""

    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(String(16), default="running")  # running|done|error
    model: Mapped[str] = mapped_column(String(128), default="")
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    search_calls: Mapped[int] = mapped_column(Integer, default=0)
    entities_added: Mapped[int] = mapped_column(Integer, default=0)
    relations_added: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    session: Mapped[Session] = relationship(back_populates="runs")


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    run_id: Mapped[str | None] = mapped_column(
        ForeignKey("runs.id", ondelete="SET NULL"), nullable=True
    )
    role: Mapped[str] = mapped_column(String(16))  # user|assistant
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    session: Mapped[Session] = relationship(back_populates="messages")


# ---------------------------------------------------------------------------
# Knowledge graph — the long-term memory store.
# ---------------------------------------------------------------------------


class Entity(Base):
    __tablename__ = "entities"
    __table_args__ = (UniqueConstraint("name_key", name="uq_entity_name_key"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255))
    name_key: Mapped[str] = mapped_column(String(255), index=True)  # normalized dedupe key
    type: Mapped[str] = mapped_column(String(64), default="concept")
    summary: Mapped[str] = mapped_column(Text, default="")
    mention_count: Mapped[int] = mapped_column(Integer, default=1)
    salience: Mapped[float] = mapped_column(Float, default=1.0)
    first_session_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Relation(Base):
    __tablename__ = "relations"
    __table_args__ = (
        UniqueConstraint("source_id", "target_id", "type", name="uq_relation_triple"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    source_id: Mapped[str] = mapped_column(ForeignKey("entities.id", ondelete="CASCADE"))
    target_id: Mapped[str] = mapped_column(ForeignKey("entities.id", ondelete="CASCADE"))
    type: Mapped[str] = mapped_column(String(96), default="related_to")
    description: Mapped[str] = mapped_column(Text, default="")
    weight: Mapped[int] = mapped_column(Integer, default=1)
    first_session_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class GraphEvent(Base):
    """Append-only log of graph mutations — powers the memory-evolution timeline."""

    __tablename__ = "graph_events"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    kind: Mapped[str] = mapped_column(String(32))  # entity_added|entity_reinforced|relation_added|relation_reinforced
    entity_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    relation_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    session_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    run_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    label: Mapped[str] = mapped_column(String(512), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
