# 0007. Health-only mode for payloads that ignore the protocol

Status: accepted (2026-11-25).

## Context

Many programs worth running (a plain agent CLI session) will never speak the protocol.

## Decision

A payload definition with `"protocol": "none"` gets activity from outside: its health check, its cgroup CPU use, TCP connections to declared ports and SSH sessions.

## Alternatives

Requiring every payload to speak the protocol (shuts out most programs); counting terminal output as activity (keepalive traffic would keep boxes awake).

## Consequences

`dozebox run -- <command>` is the middle path: it holds the box while the command runs.
