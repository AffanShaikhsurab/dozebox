# 0010. Build-time plugins, no dynamic loading

Status: accepted (2026-11-25).

## Context

Alert sinks, wake sources and presence sources are extension points.

## Decision

Built-ins are registered in one table per host. A third party adds one by building a custom bundle; nothing is loaded at run time.

## Alternatives

Dynamic plugin loading at run time (larger attack surface, Lambda cold-start cost).

## Consequences

The supply chain is auditable: the Lambda and the agent run only what was bundled.
