# 0006. One socket per payload as its identity

Status: accepted (2026-11-25).

## Context

The agent must know which payload made a call, without a token that leaks into child processes.

## Decision

Each payload gets `/run/dozebox/payloads/<payload>.sock`, mode 0600, owned by the payload's user. Whoever can open it is that payload.

## Alternatives

One socket plus a per-payload bearer token in the environment (leaks into children); `SO_PEERCRED` (needs a native module in Node).

## Consequences

File permissions, which Linux already enforces, do the authentication. Jailed agents cannot reach the sockets.
