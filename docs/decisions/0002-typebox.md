# 0002. TypeBox for every schema

Status: accepted (2026-11-25).

## Context

The protocol, records, control API, config and payload definition need runtime validation, TypeScript types and language-neutral JSON Schema files.

## Decision

TypeBox (`typebox` 1.x). Schema objects are JSON Schema (draft 2020-12); the JSON files in `packages/protocol/schema` are generated from them and committed, and CI fails on drift.

## Alternatives

Zod 4 (JSON Schema is a derived output), Effect Schema (pulls the Effect runtime into the agent and Lambda), Valibot (JSON Schema needs a second package), Ajv over hand-written JSON Schema (types written twice).

## Consequences

Zero runtime dependencies. Error messages need a small formatter.
