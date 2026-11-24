# 0003. DynamoDB for the lease, idempotency keys and the outbox

Status: accepted (2026-11-25).

## Context

The control function can run concurrently (schedule, HTTP, EC2 events). Two reconcile ticks acting at once caused real incidents.

## Decision

One on-demand DynamoDB table per stack holds a lease with a fencing token, idempotency keys and the alert outbox. Every tick takes the lease or skips.

## Alternatives

SSM parameters with version checks (no conditional writes on value, throttled at low rates); Step Functions (second state store and IAM surface).

## Consequences

One more resource per stack, costing cents a month. Conditional writes give fencing for free.
