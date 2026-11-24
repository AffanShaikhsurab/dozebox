# 0005. One version for the whole project

Status: accepted (2026-11-25).

## Context

The agent, control function, protocol, CLI and Terraform module are tested together.

## Decision

All packages, the agent artifact, the control bundle and the module share one semver version. Changesets runs in fixed mode.

## Alternatives

Independent versions per package (a compatibility matrix nobody tests).

## Consequences

A fix in one package bumps every package's version.
