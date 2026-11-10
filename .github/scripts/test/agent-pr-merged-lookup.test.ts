import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('../workflows/agent-pr-merged-reusable.yml', 'utf8');
const caller = readFileSync('../workflows/agent-pr-merged.yml', 'utf8');
const block = workflow.split('      - name: Find linked issue through GitHub')[1]
  .split('        run: |\n')[1].split('\n  remove-developer-label:')[0];
const script = block.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');

function runLookup(nodes: unknown, fail = false) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-lookup-'));
  try {
    const output = join(dir, 'output');
    writeFileSync(output, '');
    writeFileSync(join(dir, 'gh'), '#!/bin/bash\nif [ "$FAIL" = 1 ]; then exit 1; fi\nprintf "%s" "$RESPONSE"\n', { mode: 0o755 });
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: {
      ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: output,
      REPOSITORY: 'owner/repo', PR_NUMBER: '123', FAIL: fail ? '1' : '0',
      RESPONSE: JSON.stringify({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes } } } } }),
    } });
    return { ...result, outputs: readFileSync(output, 'utf8') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('closed PR issue lookup', () => {
  it('uses GitHub references, ignores body text and keeps the no-link log', () => {
    const result = runLookup([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PR body does not contain a 'Closes #N' reference; skipping.");
    expect(result.outputs).toBe('proceed=false\n');
    expect(script).toContain('closingIssuesReferences(first: 1)');
    expect(script).not.toContain('PR_BODY');
  });
  it('selects the first linked issue and its repository', () => {
    const result = runLookup([{ number: 42, repository: { nameWithOwner: 'other/repo' } }, { number: 43, repository: { nameWithOwner: 'owner/repo' } }]);
    expect(result.status).toBe(0);
    expect(result.outputs).toBe('proceed=true\nissue_number=42\nissue_repository=other/repo\n');
    expect(workflow).toContain('GITHUB_REPO: ${{ needs.gate.outputs.issue_repository }}');
  });
  it('fails on API errors or malformed data', () => {
    expect(runLookup([], true).status).not.toBe(0);
    expect(runLookup(null).status).not.toBe(0);
  });
  it('never checks out either workflow', () => {
    for (const text of [workflow, caller]) expect(text).not.toMatch(/uses:\s*actions\/checkout@/);
  });
});
