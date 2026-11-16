# Execution Readiness Guard

## Overview

The Execution Readiness Guard is a decision skill that evaluates whether a route is safe and eligible for execution.

It consumes consolidated state from multiple upstream skills and determines if execution should proceed, be blocked, or considered degraded.

## Purpose

This skill acts as a final safety checkpoint before execution.

It ensures that:

- Blocked routes are never executed
- Degraded routes are identified and prevented from execution
- Only healthy routes are eligible

## Input

```json
{
  "route": "string",
  "state": "object"
}
