import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function readPublicFile(path: string): Promise<string> {
  return readFile(new URL(`../public/${path}`, import.meta.url), 'utf8');
}

describe('integrated AfterMrkt frontend', () => {
  it('ships the approved landing, workspace, replay, docs, and local screenshot assets', async () => {
    const [landing, workspace, replay, docs, client, app] = await Promise.all([
      readPublicFile('index.html'),
      readPublicFile('workspace.html'),
      readPublicFile('replay.html'),
      readPublicFile('docs.html'),
      readPublicFile('lib/aftermrkt-api.js'),
      readPublicFile('app.js'),
    ]);

    expect(landing).toContain('Know the move. Know');
    expect(landing).toContain('/assets/bitget-stock-market.png');
    expect(workspace).toContain('data-page="workspace"');
    expect(replay).toContain('data-page="replay"');
    expect(docs).toContain('data-page="docs"');
    expect(docs).toContain('id="overview"');
    expect(docs).toContain('id="how-it-works"');
    expect(docs).toContain('id="decision-lens"');
    expect(docs).toContain('id="market-data"');
    expect(docs).toContain('id="evidence-qwen"');
    expect(docs).toContain('id="exit-lens"');
    expect(docs).toContain('id="live-replay"');
    expect(docs).toContain('id="provenance"');
    expect(docs).toContain('id="limitations"');
    expect(docs).toContain('id="faq"');
    expect(docs).toContain('id="glossary"');
    expect(client).toContain('/api/execution/simulations');
    expect(client).toContain('/api/replays');
    expect(app).toContain('RNVDAUSDT');
    expect(app).toContain('observed-book estimate');
  });

  it('keeps the homepage FAQ concise and the docs boundaries explicit', async () => {
    const [landing, docs, app] = await Promise.all([
      readPublicFile('index.html'),
      readPublicFile('docs.html'),
      readPublicFile('app.js'),
    ]);

    expect(landing).toContain('id="market-belt-track"');
    expect(landing).toContain('Loading live prices…');
    expect(landing).not.toContain('NOT LIVE');
    expect(landing).not.toContain('$229.14');
    expect(landing).not.toContain('AAPLr');
    expect(
      [...landing.matchAll(/<button[\s\S]*?>\s*<span>([^<]+)<\/span>[\s\S]*?<\/button>/g)].map(
        ([, question]) => question,
      ),
    ).toEqual([
      'What does AfterMrkt actually do?',
      'Does AfterMrkt tell me whether to buy or sell?',
      'How does the Exit Lens work?',
      'What does Qwen do in AfterMrkt?',
    ]);
    const answerIds = [...landing.matchAll(/<p id="(landing-faq-answer-\d+)"(?: hidden)?>/g)].map(
      ([, id]) => id,
    );
    expect(answerIds).toEqual([
      'landing-faq-answer-1',
      'landing-faq-answer-2',
      'landing-faq-answer-3',
      'landing-faq-answer-4',
    ]);
    expect(new Set(answerIds).size).toBe(answerIds.length);
    expect(landing).toMatch(
      /<button[^>]*aria-controls="landing-faq-answer-1"[^>]*aria-expanded="true"[^>]*>/,
    );
    expect(landing).toMatch(
      /<button[^>]*aria-controls="landing-faq-answer-2"[^>]*aria-expanded="false"[^>]*>/,
    );
    expect(landing).toMatch(
      /<button[^>]*aria-controls="landing-faq-answer-3"[^>]*aria-expanded="false"[^>]*>/,
    );
    expect(landing).toMatch(
      /<button[^>]*aria-controls="landing-faq-answer-4"[^>]*aria-expanded="false"[^>]*>/,
    );
    expect(app).toContain("button.addEventListener('click'");
    expect(app).toContain('answer.hidden = !open');
    expect(app).toContain("button.setAttribute('aria-expanded', String(open))");
    expect(app).toContain("icon.textContent = open ? '−' : '+'");
    expect(app).toContain('afterMrktApi.getInstruments(5)');
    expect(app).toContain('moveSinceNativeClosePercent');
    expect(app).toContain('Live prices unavailable');
    expect(docs).toContain('The rToken price around the U.S. regular-session close');
    expect(docs).toContain("not the native stock's closing price");
    expect(docs).toContain('Qwen analyzes source-bound event evidence only');
    expect(docs).toContain('does not calculate market metrics');
    expect(docs).toContain('not a guaranteed fill');
    expect(docs).toContain(
      'Replay cannot use evidence that became available after the replay timestamp',
    );
    expect(docs).toContain('Live execution is disabled');
    expect(docs).toContain('No wallet or account connection is part of the current MVP');
  });

  it('keeps workspace switching, provenance, footer, and replay links bounded', async () => {
    const [landing, workspace, replay, docs, app] = await Promise.all([
      readPublicFile('index.html'),
      readPublicFile('workspace.html'),
      readPublicFile('replay.html'),
      readPublicFile('docs.html'),
      readPublicFile('app.js'),
    ]);
    const pages = `${landing}\n${workspace}\n${replay}\n${docs}`;

    expect(workspace).toContain('id="provenance-toggle"');
    expect(workspace).toContain('aria-expanded="false"');
    expect(workspace).toContain('aria-controls="provenance-details"');
    expect(workspace).toContain('id="provenance-details"');
    expect(app).toContain("toggle.setAttribute('aria-expanded', String(open))");
    expect(app).toContain('state.symbol !== symbol');
    expect(app).toContain("button.classList.remove('is-active')");
    expect(app).toContain('Observed-book estimate, not guaranteed fill. The result is');
    expect(landing).toContain('href="#faq">FAQ</a>');
    expect(workspace).toContain('href="/#faq">FAQ</a>');
    expect(workspace).toContain('href="#evidence">Evidence first</a>');
    expect(landing).toContain(
      'href="/replay?caseId=93ea136a84707931785101d27b4a293921846a20a8cb13dc1631dfecb3c26384"',
    );
    expect(landing).toContain('REPLAY · 20:51 UTC');
    expect(landing).toContain('SEC 8-K source fact available at 20:21 UTC');
    expect(landing).toContain('preserved separately from the historical replay');
    expect(pages).not.toContain('/docs.html');
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

  it('makes the instrument selector and unit-based position input explicit', async () => {
    const [workspace, client, app] = await Promise.all([
      readPublicFile('workspace.html'),
      readPublicFile('lib/aftermrkt-api.js'),
      readPublicFile('app.js'),
    ]);

    expect(workspace).toContain('class="instrument-picker"');
    expect(workspace).toContain('id="instrument-select" aria-label="Select instrument"');
    expect(workspace).toContain('class="workspace-quantity-unit">(units)</span');
    expect(workspace).toContain('placeholder="Enter units"');
    expect(workspace).toContain('aria-label="Position quantity in units"');
    expect(workspace).toContain('id="exit-explanation"');
    expect(workspace).not.toContain('In plain English:');
    expect(client).toContain('server_unreachable');
    expect(client).toContain('The local AfterMrkt server is not reachable.');
    expect(app).toContain('Qwen analysis · not applicable');
    expect(app).toContain('Qwen analysis · unavailable (no validated result)');
    expect(app).toContain('Qwen was not run because no qualifying source event was available');
    expect(app).toContain('no average sale price is available because');
    expect(app).toContain('the captured order book had no executable two-sided market');
    expect(app).not.toContain("lead.textContent = 'In plain English: '");
    expect(app).toContain('Only ${within50Text} of the requested amount');
  });
});
