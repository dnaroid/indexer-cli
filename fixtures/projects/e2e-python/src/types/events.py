from dataclasses import dataclass, field


@dataclass(slots=True)
class EventEnvelope:
    name: str
    payload: dict[str, str]
    metadata: dict[str, str] = field(default_factory=dict)


@dataclass(slots=True)
class RetryPolicy:
    attempts: int
    backoff_seconds: float


def with_trace(event: EventEnvelope, trace_id: str) -> EventEnvelope:
    metadata = dict(event.metadata)
    metadata["trace_id"] = trace_id
    return EventEnvelope(
        name=event.name, payload=dict(event.payload), metadata=metadata
    )
