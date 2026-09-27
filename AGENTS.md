# AGENTS.md

Keep this file short. Record only project-wide facts and constraints that a capable agent cannot cheaply or safely infer from the repository itself.

## Read when relevant

- Product purpose and durable constraints: `aidlc-docs/project/brief.md`
- Architecture and integration boundaries: `aidlc-docs/project/architecture.md`
- Stack, setup, and non-obvious commands: `aidlc-docs/project/tech-stack.md`
- Verification expectations: `aidlc-docs/project/testing.md`
- Consequential technical decisions: `aidlc-docs/project/decisions/`
- Active structured change: `aidlc-docs/aidlc-state.json`

Load only what is relevant to the current task.

## Project gotchas

Add only non-obvious rules, failures, or conventions that would be expensive to rediscover.

- [project-specific gotcha]

## Protected areas

Preserve unrelated working-tree changes. Never expose secrets, credentials, private logs, or production data. Require explicit authorization before deployment, destructive production operations, access changes, external sends, charges, or other actions with real-world side effects.

## AI-DLC

When an AI-DLC change is active, AI-DLC owns lifecycle state while the active agent/runtime owns execution and delegation. Do not start a competing end-to-end planning/lifecycle workflow. Delegated workers do not edit `aidlc-docs/aidlc-state.json`.
