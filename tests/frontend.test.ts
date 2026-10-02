import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function readPublicFile(path: string): Promise<string> {
  return readFile(new URL(`../public/${path}`, import.meta.url), 'utf8');
}

describe('integrated AfterMrkt frontend', () => {
  it('ships the approved landing, workspace, replay, and local screenshot assets', async () => {
    const [landing, workspace, replay, client, app] = await Promise.all([
      readPublicFile('index.html'),
      readPublicFile('workspace.html'),
      readPublicFile('replay.html'),
      readPublicFile('lib/aftermrkt-api.js'),
      readPublicFile('app.js'),
    ]);

    expect(landing).toContain('Know the move. Know');
    expect(landing).toContain('/assets/bitget-stock-market.png');
    expect(workspace).toContain('data-page="workspace"');
    expect(replay).toContain('data-page="replay"');
    expect(client).toContain('/api/execution/simulations');
    expect(client).toContain('/api/replays');
    expect(app).toContain('RNVDAUSDT');
    expect(app).toContain('observed-book estimate');
  });

  it('does not retain prototype workspace values or external workspace paths', async () => {
    const [workspace, app] = await Promise.all([
      readPublicFile('workspace.html'),
      readPublicFile('app.js'),
    ]);
    const combined = `${workspace}\n${app}`;

    expect(combined).not.toContain('/Users/admin/Documents/Codex/');
    expect(combined).not.toContain('$189.54');
    expect(combined).not.toContain('12.7 bps');
    expect(combined).not.toContain('49 bps');
    expect(combined).not.toContain('31.8k');
  });
});
