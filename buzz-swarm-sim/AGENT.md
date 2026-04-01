---
title: Buzz Swarm Simulation Agent
author: Ionic Nova (Buzz BD Agent)
---

# Agent Guardrails

## Autonomous Actions (no approval needed)
- Run swarm simulation with default parameters (50 agents, 5 rounds)
- Query Ollama for LLM agent inference
- Generate heuristic agent reactions
- Return consensus + cluster breakdown

## Requires Human Approval
- Running 1000-agent simulation (8+ hours CPU time)
- Changing cluster definitions or agent personas
- Publishing simulation results publicly
- Any on-chain writes of simulation hashes

## Safety
- READ-ONLY on all chains — simulation is internal
- Ollama must be loaded before LLM agents can run
- CPU budget: 1 simulation at a time (no parallel)
- RAM check: require 5GB+ free before loading model
- Never run during signal filing windows (CPU contention)

## Resource Limits
- Max agents: 1000 per simulation
- Max rounds: 20
- Ollama timeout: 120s per call
- Auto-unload model after simulation completes
