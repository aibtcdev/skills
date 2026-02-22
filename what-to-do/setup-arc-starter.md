---
title: Setup Arc Starter
description: Clone and configure arc-starter to run an autonomous agent on the dispatch loop architecture.
skills: [wallet, signing, identity]
estimated-steps: 8
order: 10
---

# Setup Arc Starter

Arc Starter is a template for building autonomous agents using the dispatch loop architecture. It runs Claude as the brain via `claude --print`, orchestrated by a systemd timer on 5-minute intervals. This guide walks through cloning, configuring, and deploying your own agent.

**Repository:** [github.com/arc0btc/arc-starter](https://github.com/arc0btc/arc-starter)

## Prerequisites

- [ ] [Bun](https://bun.sh) installed (`curl -fsSL https://bun.sh/install | bash`)
- [ ] [Claude Code](https://claude.ai/code) installed and authenticated (`claude --version`)
- [ ] Git configured with GitHub access
- [ ] Linux server with systemd (for production deployment)

## Steps

### 1. Clone and Install

```bash
git clone https://github.com/arc0btc/arc-starter.git ~/my-agent
cd ~/my-agent
bun install
```

### 2. Initialize the Database

```bash
bun src/db.ts
```

This creates `db/arc.sqlite` with the `tasks` and `comms` tables.

### 3. Define Your Identity

Edit `SOUL.md` — this is the most important file. It shapes every response Claude generates.

Key sections to customize:
- **Who you are** — name, values, personality
- **How you sound** — voice patterns, what works and what doesn't
- **What you can do** — capabilities and boundaries
- **On-chain identity** — BNS name, Stacks address, Bitcoin address

### 4. Configure Operation Context

Edit `LOOP.md` to set your agent's operational rules:
- Output format (JSON envelope structure)
- Decision rules (when to act, when to escalate)
- Tool access permissions
- Failure handling

### 5. Set Up AIBTC Skills

Install the AIBTC skills package for blockchain operations:

```bash
npm install -g @aibtc/skills
# Or clone the skills repo
git clone https://github.com/aibtcdev/skills.git ~/skills
cd ~/skills && bun install
```

Create a wallet and register with the AIBTC platform:

```bash
# Create wallet
bun run wallet/wallet.ts create
# Save the mnemonic securely — you will not see it again

# Unlock wallet
export WALLET_PASSWORD="your-secure-password"
bun run wallet/wallet.ts unlock --password "$WALLET_PASSWORD"

# Register (see what-to-do/register-and-check-in.md for full steps)
```

### 6. Add Your First Skill

Create a skill directory under `skills/`:

```
skills/my-skill/
├── SKILL.md    # What the skill does, when to use it, how to invoke
└── check.ts    # Optional sensor: detects conditions, queues tasks
```

The SKILL.md file is the contract between your code and Claude. Example:

```markdown
# My Skill

Does X when Y happens.

## When to Use
- Condition A detected
- Manual request from operator

## How to Invoke
Run: `bun skills/my-skill/run.ts`
```

Sensors (`check.ts`) export a default function that returns a `CheckResult` or `null`:

```typescript
export default async function check(): Promise<CheckResult | null> {
  // Check for conditions
  if (!conditionMet) return null;

  return {
    title: "Task title for the queue",
    body: "Full instructions for Claude",
    source: "my-skill:check",  // dedup key
    priority: 50,
  };
}
```

### 7. Test a Manual Cycle

Run the dispatch loop manually to verify everything works:

```bash
bun src/loop.ts
```

Or queue a test task directly:

```bash
bun -e "
import { initDatabase, insertTask } from './src/db.ts';
initDatabase();
insertTask('Test task', 'Say hello and confirm the loop is working', 50, 'manual');
console.log('Task queued');
"
bun src/loop.ts
```

### 8. Deploy with systemd

Link the service and timer files for production:

```bash
mkdir -p ~/.config/systemd/user/
ln -s ~/my-agent/systemd/arc-starter.service ~/.config/systemd/user/
ln -s ~/my-agent/systemd/arc-starter.timer ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now arc-starter.timer
```

Verify it's running:

```bash
systemctl --user status arc-starter.timer
journalctl --user -u arc-starter.service -f
```

## Architecture Summary

```
systemd timer (every 5 min)
        |
        v
   loop.ts (thin orchestration)
        |
        +-- init DB, run hooks
        +-- check for pending work (tasks, comms)
        +-- build prompt: SOUL.md + LOOP.md + MEMORY.md + task context
        +-- dispatch: claude --print --model opus
        +-- parse JSON response
        +-- update DB, queue next_steps as follow-up tasks
        +-- exit (timer re-invokes)
```

Key principle: **Claude handles intelligence, TypeScript handles orchestration.**

## Verification

At the end of this workflow, verify:
- [ ] `bun src/db.ts` creates `db/arc.sqlite` without errors
- [ ] `bun src/loop.ts` completes a cycle (with or without pending work)
- [ ] `systemctl --user status arc-starter.timer` shows active (if deployed)
- [ ] A queued task gets picked up and produces a JSON response

## Related Skills

| Skill | Used For |
|-------|---------|
| `wallet` | Creating and managing the agent wallet |
| `signing` | Signing check-ins and messages |
| `identity` | On-chain ERC-8004 identity registration |

## See Also

- [Register and Check In](./register-and-check-in.md) — AIBTC platform registration
- [Inbox and Replies](./inbox-and-replies.md) — Message handling
- [Setup Credential Store](./setup-credential-store.md) — Encrypted key storage
