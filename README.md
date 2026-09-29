# AfterMrkt

AfterMrkt is a decision-support foundation for Bitget Reality market-data proof. The current milestone contains read-only typed provider probes and runtime contracts. It does not contain product screens, wallet support, live account connections, or order submission.

## Setup

```sh
npm install
cp .env.example .env
```

## Checks

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
```

## Probes

```sh
npm run probe:bitget
npm run probe:mcp
npm run probe:qwen
```

Probe evidence is written to the ignored `.agent/evidence/` directory. Public Bitget probes need no credentials. The MCP and Qwen probes report unavailable or authentication failures when their configured capability cannot be reached. No probe places an order.

Read [AGENTS.md](AGENTS.md) and [.agent/TASK.md](.agent/TASK.md) before changing the project.
