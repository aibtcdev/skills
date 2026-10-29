# Execution Readiness Guard — Agent Guide

## Role

The Execution Readiness Guard is a decision skill responsible for determining whether a route is safe to execute.

It should be used as a final gating step before any execution attempt.

## When to Use

Use this skill:

- After route selection
- After protocol and route health evaluation
- Before sending any transaction
- In any system where execution safety matters

## What It Does

This skill evaluates:

- Route operator decision
- Route health status
- Protocol health status
- Route performance score

It then determines:

- If execution is allowed
- If execution must be blocked
- If the route is degraded and should not be executed

## Decision Priority

The evaluation follows strict priority:

1. Route operator (BLOCK)
2. Route health (blocked)
3. Protocol health (blocked)
4. Route performance (degraded)

## How to Integrate

This skill expects:

```json
{
  "route": "string",
  "state": "object"
}
