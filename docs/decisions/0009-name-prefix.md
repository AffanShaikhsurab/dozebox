# 0009. `name_prefix` for legacy stacks

Status: accepted (2026-11-25).

## Context

A live stack built by the old runner must adopt the module without renaming or replacing anything.

## Decision

The module takes `name_prefix`, `ssm_prefix` and `tag_prefix` (default `dozebox`). An old stack sets its old prefix and moves state with `moved` blocks.

## Alternatives

Renaming resources during adoption (replaces the instance, volume and roles).

## Consequences

The defaults stay clean for new users; the old names live only in the adopting stack's configuration.
