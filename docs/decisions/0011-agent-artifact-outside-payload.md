# 0011. The agent ships as its own artifact

Status: accepted (2026-11-25).

## Context

The box agent must update and roll back independently of whatever payload the box runs.

## Decision

The agent is a tarball on GitHub Releases with `SHA256SUMS`; stage 0 downloads the version in the config and checks its hash. Payloads bring their own runtime.

## Alternatives

Baking the agent into an image or into the payload (couples their release cycles).

## Consequences

The agent can self-update with rollback; an image rebuild is never needed for an agent fix.
