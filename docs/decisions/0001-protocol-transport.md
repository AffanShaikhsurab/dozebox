# 0001. Payload protocol over HTTP on Unix sockets

Status: accepted (2026-11-25).

## Context

Payloads need a local, cheap way to tell the box agent about holds, beats, wakes, presence and attention.

## Decision

HTTP/1.1 with JSON bodies over a Unix domain socket, answered from memory in under 100 ms. Nothing in the protocol calls AWS synchronously.

## Alternatives

A line protocol over the socket (no standard error shape, every language writes its own framing); gRPC (heavy dependency, poor shell support).

## Consequences

Any language with an HTTP client can speak it (`curl --unix-socket`, Node `http.request({ socketPath })`, Go `net.Dial("unix")`). The same handler code serves the admin socket.
