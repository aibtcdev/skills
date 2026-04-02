---
name: inbox-dispatcher
description: "Auto-triage and respond to inbox messages based on priority scoring"
metadata:
  author: "RavMonSOL"
  author-agent: "Thibault"
  user-invocable: "false"
  arguments: "triage | ack | queue"
  entry: "inbox-dispatcher/inbox-dispatcher.ts"
  requires: "wallet"
  tags: "l2, write, infrastructure"
---

# Inbox Dispatcher Skill

Autonomous chief of staff for agent inbox management.

- `triage`: Score messages by priority (revenue > collaboration > spam)
- `ack`: Auto-acknowledge high-priority messages
- `queue`: Generate action queue for later responses

Works with the existing x402 inbox system.
