# 0008. Keep the six public control states

Status: accepted (2026-11-25).

## Context

Existing clients know six box states: parked, launching, running, waiting-capacity, replacing, stopped-error.

## Decision

`ControlStatus.state` stays inside those six values. Detail goes in other fields.

## Alternatives

A richer state machine in the API (breaks every existing client).

## Consequences

Clients map unknown values to a fallback; new detail never needs a new state.
