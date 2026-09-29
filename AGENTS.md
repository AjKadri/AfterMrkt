# AfterMrkt engineering rules

## Working agreement

- Read this file and the current `.agent/TASK.md` before changing the project.
- Work in small, verified milestones.
- Use meaningful Conventional Commits after completed milestones.
- Never rewrite Git history or force-push without explicit authorization.
- Keep `.agent/` coordination files, evidence captures, secrets, credentials, and machine-specific settings local and ignored.
- Use `rg` for repository search and preserve the existing user-owned work.
- Report exact checks run and distinguish deferred checks from passing checks.
- Do not modify, restyle, or build product UI without explicit authorization.

## Provider and safety boundaries

- Verify before guessing.
- Investigate failures instead of bypassing them.
- Never hide incomplete functionality behind mocks.
- Never claim a test passed unless it actually ran.
- Preserve evidence for external assumptions, including requests, timestamps, normalized responses, and raw-response hashes.
- Distinguish live, replay, demo, simulated, and unavailable states.
- Keep exact provider symbols returned by Bitget. Never reconstruct a Reality symbol from a native ticker.
- Keep Qwen out of financial calculations, execution decisions, balances, thresholds, and order construction.
- Do not use live credentials or place live orders in this phase.
- Never log API keys, secrets, passphrases, signatures, or authorization headers.
- Do not weaken correctness merely to make the demo pass.

> We will continue until this is done properly. We will treat every run as if it will be successful because we will learn from failures and consult the best available information before proceeding, such that we are confident the result will be a success. We will not plan for failure.

Practical behavior for that principle:

- Verify before guessing.
- Investigate failures rather than bypassing them.
- Do not hide incomplete functionality behind mocks.
- Never claim a test passed unless it actually ran.
- Keep source evidence for external assumptions.
- Do not weaken correctness to make a demo pass.

## Phase boundary

The current phase is repository foundation and external capability proof. It includes typed read-only probes for Bitget Reality public data, Bitget's U.S.-equities MCP, and Qwen `qwen3.8-max`. It does not include UI screens, wallets, live account connections, live trading, or product execution UX.
