import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const agent = fs.readFileSync(path.join(REPO_ROOT, 'agents/pr-compliance-checker.md'), 'utf8');

describe('PR description guidance', () => {
  it('accepts prose independently of headings and length', () => {
    const description = agent.split('### 2. Description Quality')[1].split('### 3. Focused Changes')[0];
    expect(description).toContain('regardless of headings or length');
    expect(description).toContain('Do not add a heading or invent verification claims');
  });

  it('still reviews missing repository requirements and incomplete templates', () => {
    expect(agent).toContain(
      "Review what changed and why against the target repository's template and documented requirements",
    );
    expect(agent).toContain('flag genuinely missing required information');
    const preservation = agent.split('### 7. Template Preservation')[1].split('## Scoring')[0];
    expect(preservation).toContain('Warning (partial preservation)');
    expect(preservation).toContain('at least one heading is missing');
    expect(preservation).toContain('Critical (template wiped)');
  });
});
