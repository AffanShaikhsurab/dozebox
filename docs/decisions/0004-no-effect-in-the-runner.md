# 0004. No Effect runtime in the runner

Status: accepted (2026-11-25).

## Context

The project this runner came from uses Effect. The runner is small, runs in Lambda and on a box, and wants contributors who know plain TypeScript.

## Decision

Plain TypeScript with ports passed as parameters. Pure decisions in `core`, shells in `agent`, `control` and `cli`.

## Alternatives

Effect services and Effect Schema (bigger bundles and cold starts, a steep learning curve for contributors).

## Consequences

Payload adapters may use Effect on their side; they speak the protocol and validate with the committed JSON Schema.
