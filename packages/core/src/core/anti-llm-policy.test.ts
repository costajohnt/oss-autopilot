import { describe, it, expect } from 'vitest';
import { scanForAntiLLMPolicy, scanAIDisclosureRequirement } from './anti-llm-policy.js';

describe('scanForAntiLLMPolicy', () => {
  it('returns matched=false for empty text', () => {
    const result = scanForAntiLLMPolicy('');
    expect(result.matched).toBe(false);
    expect(result.matches).toEqual([]);
  });

  it('returns matched=false for text with no policy signals', () => {
    const result = scanForAntiLLMPolicy('Welcome! Please read our contributing guide.');
    expect(result.matched).toBe(false);
    expect(result.matches).toEqual([]);
  });

  describe('explicit LLM ban signals', () => {
    it('matches "no AI-generated code"', () => {
      const result = scanForAntiLLMPolicy('We do not accept no AI-generated code in this repo.');
      expect(result.matched).toBe(true);
      expect(
        result.matches.some((m) => m.category === 'explicit_ban' && m.phrase.toLowerCase().includes('ai-generated')),
      ).toBe(true);
    });

    it('matches "no LLM-generated"', () => {
      const result = scanForAntiLLMPolicy('We accept no LLM-generated code.');
      expect(result.matched).toBe(true);
      expect(result.matches.some((m) => m.category === 'explicit_ban' && m.phrase.toLowerCase().includes('llm'))).toBe(
        true,
      );
    });

    it('matches "no AI contributions"', () => {
      const result = scanForAntiLLMPolicy('This project does not accept no AI contributions.');
      expect(result.matched).toBe(true);
      expect(result.matches.some((m) => m.category === 'explicit_ban')).toBe(true);
    });
  });

  describe('tool-specific bans', () => {
    it('matches "no Copilot"', () => {
      const result = scanForAntiLLMPolicy('Policy: no Copilot-generated code accepted.');
      expect(result.matched).toBe(true);
      expect(result.matches.some((m) => m.category === 'tool_ban')).toBe(true);
    });

    it('matches "no ChatGPT"', () => {
      const result = scanForAntiLLMPolicy('Contributing: no ChatGPT or similar tools.');
      expect(result.matched).toBe(true);
      expect(result.matches.some((m) => m.category === 'tool_ban')).toBe(true);
    });

    it('matches tool bans case-insensitively', () => {
      const result = scanForAntiLLMPolicy('NO COPILOT allowed here.');
      expect(result.matched).toBe(true);
      expect(result.matches.some((m) => m.category === 'tool_ban')).toBe(true);
    });
  });

  describe('reject-framing signals', () => {
    it('matches "AI contributions will be closed"', () => {
      const result = scanForAntiLLMPolicy('Any AI contributions will be closed without review.');
      expect(result.matched).toBe(true);
      expect(result.matches.some((m) => m.category === 'reject_framing')).toBe(true);
    });

    it('matches "we do not accept AI"', () => {
      const result = scanForAntiLLMPolicy('Please note: we do not accept AI-assisted PRs.');
      expect(result.matched).toBe(true);
      expect(result.matches.some((m) => m.category === 'reject_framing')).toBe(true);
    });
  });

  describe('excerpt extraction', () => {
    it('includes an excerpt showing the match in context', () => {
      const text =
        'Lorem ipsum dolor sit amet. We do not accept AI-generated code in this repo. Consectetur adipiscing elit.';
      const result = scanForAntiLLMPolicy(text);
      expect(result.matched).toBe(true);
      expect(result.matches[0].excerpt).toContain('AI-generated');
      expect(result.matches[0].excerpt.length).toBeLessThan(text.length);
    });
  });

  describe('multiple matches', () => {
    it('returns all matched patterns', () => {
      const text = 'We do not accept AI-generated code. Also, no Copilot allowed.';
      const result = scanForAntiLLMPolicy(text);
      expect(result.matched).toBe(true);
      const categories = new Set(result.matches.map((m) => m.category));
      expect(categories.has('explicit_ban') || categories.has('reject_framing')).toBe(true);
      expect(categories.has('tool_ban')).toBe(true);
    });

    it('deduplicates identical phrases that match multiple times in the same text', () => {
      const text = 'no Copilot. no Copilot. no Copilot.';
      const result = scanForAntiLLMPolicy(text);
      expect(result.matched).toBe(true);
      const copilotMatches = result.matches.filter((m) => m.phrase.toLowerCase().includes('copilot'));
      expect(copilotMatches.length).toBe(1);
    });
  });

  describe('false-positive resistance', () => {
    it('does not match a positive statement about AI use', () => {
      const result = scanForAntiLLMPolicy('We welcome AI-assisted contributions! Just disclose them.');
      expect(result.matched).toBe(false);
    });

    it('does not match a mention of Copilot without negation', () => {
      const result = scanForAntiLLMPolicy('This project supports GitHub Copilot integration.');
      expect(result.matched).toBe(false);
    });

    it('does not match "AI will be closed" without a contribution-noun', () => {
      // Business announcement, not a contribution policy.
      const result = scanForAntiLLMPolicy('The AI division will be closed at the end of Q4.');
      expect(result.matched).toBe(false);
    });

    it('does not match an unrelated mention of "closed" near "AI"', () => {
      const result = scanForAntiLLMPolicy('We use AI. The issue tracker was closed for maintenance.');
      expect(result.matched).toBe(false);
    });

    it('does not match "no copilot-style autocomplete"', () => {
      const result = scanForAntiLLMPolicy('no copilot-style autocomplete is enabled by default.');
      expect(result.matched).toBe(false);
    });

    it('does not match "AI PRs are closed to new comments"', () => {
      const result = scanForAntiLLMPolicy('The old AI PRs are closed to new comments.');
      expect(result.matched).toBe(false);
    });

    it('does not match "does not accept AI suggestions from your IDE"', () => {
      const result = scanForAntiLLMPolicy('This plugin does not accept AI suggestions from your IDE as-is.');
      expect(result.matched).toBe(false);
    });
  });

  describe('unicode and whitespace normalization', () => {
    it('matches across non-breaking hyphen (U+2011)', () => {
      const result = scanForAntiLLMPolicy('Policy: no AI\u2011generated code accepted.');
      expect(result.matched).toBe(true);
    });

    it('matches across non-breaking space', () => {
      const result = scanForAntiLLMPolicy('Policy: no\u00a0Copilot allowed.');
      expect(result.matched).toBe(true);
    });
  });

  describe('input validation', () => {
    it('throws on non-string input rather than silently returning matched=false', () => {
      // @ts-expect-error — runtime contract check
      expect(() => scanForAntiLLMPolicy(null)).toThrow(TypeError);
      // @ts-expect-error — runtime contract check
      expect(() => scanForAntiLLMPolicy(undefined)).toThrow(TypeError);
      // @ts-expect-error — runtime contract check
      expect(() => scanForAntiLLMPolicy(Buffer.from('hello'))).toThrow(TypeError);
    });
  });
});

describe('scanAIDisclosureRequirement (#1269)', () => {
  it('returns matched=false for empty text', () => {
    const result = scanAIDisclosureRequirement('');
    expect(result.matched).toBe(false);
    expect(result.matches).toEqual([]);
  });

  it('returns matched=false for ordinary contributing prose', () => {
    const result = scanAIDisclosureRequirement(
      'Welcome! Please read the contributing guide. Open a PR with tests and a clear description.',
    );
    expect(result.matched).toBe(false);
  });

  describe('mandatory disclosure signals', () => {
    it('matches "must disclose AI use"', () => {
      const result = scanAIDisclosureRequirement('Contributors must disclose AI use in the PR description.');
      expect(result.matched).toBe(true);
      expect(result.matches.some((m) => m.category === 'mandatory')).toBe(true);
    });

    it('matches "required to indicate AI assistance"', () => {
      const result = scanAIDisclosureRequirement('You are required to indicate AI assistance when submitting a PR.');
      expect(result.matched).toBe(true);
      expect(result.matches.some((m) => m.category === 'mandatory')).toBe(true);
    });

    it('matches "PRs using AI must be labeled"', () => {
      const result = scanAIDisclosureRequirement('PRs using AI tools must be labeled with [ai].');
      expect(result.matched).toBe(true);
      expect(result.matches.some((m) => m.category === 'mandatory')).toBe(true);
    });

    it('matches passive form "disclosure of AI is required"', () => {
      const result = scanAIDisclosureRequirement('Disclosure of AI use is required in commit messages.');
      expect(result.matched).toBe(true);
      expect(result.matches.some((m) => m.category === 'mandatory')).toBe(true);
    });

    it('matches "must credit Copilot" (named tool)', () => {
      const result = scanAIDisclosureRequirement('All contributors must credit Copilot when used.');
      expect(result.matched).toBe(true);
      expect(result.matches.some((m) => m.category === 'mandatory')).toBe(true);
    });
  });

  describe('recommended disclosure signals', () => {
    it('matches "should disclose AI"', () => {
      const result = scanAIDisclosureRequirement('You should disclose AI use in your PR.');
      expect(result.matched).toBe(true);
      expect(result.matches.some((m) => m.category === 'recommended')).toBe(true);
    });

    it('matches "we ask you to indicate AI"', () => {
      const result = scanAIDisclosureRequirement('We ask you to indicate AI assistance for transparency.');
      expect(result.matched).toBe(true);
      expect(result.matches.some((m) => m.category === 'recommended')).toBe(true);
    });

    it('matches "we strongly encourage acknowledging AI"', () => {
      const result = scanAIDisclosureRequirement('We strongly encourage acknowledging AI tools.');
      expect(result.matched).toBe(true);
      expect(result.matches.some((m) => m.category === 'recommended')).toBe(true);
    });

    it('matches imperative "credit AI tools you used"', () => {
      const result = scanAIDisclosureRequirement('Credit AI tools you used.');
      expect(result.matched).toBe(true);
      expect(result.matches.some((m) => m.category === 'recommended')).toBe(true);
    });
  });

  describe('invited disclosure signals', () => {
    it('matches "feel free to mention AI"', () => {
      const result = scanAIDisclosureRequirement('Feel free to mention AI tools you used in the PR description.');
      expect(result.matched).toBe(true);
      expect(result.matches.some((m) => m.category === 'invited')).toBe(true);
    });

    it('matches "you are welcome to disclose AI"', () => {
      const result = scanAIDisclosureRequirement(
        'You are welcome to disclose AI assistance, though it is not required.',
      );
      expect(result.matched).toBe(true);
      expect(result.matches.some((m) => m.category === 'invited')).toBe(true);
    });
  });

  describe('false-positive resistance', () => {
    it('does not match anti-AI policy as disclosure', () => {
      // The text bans AI; it should not also register as inviting AI disclosure.
      const result = scanAIDisclosureRequirement('We do not accept AI-generated code.');
      expect(result.matched).toBe(false);
    });

    it('does not match incidental "AI" mentions without a disclosure verb', () => {
      const result = scanAIDisclosureRequirement(
        'Our team uses AI tools internally. The release process is documented in RELEASING.md.',
      );
      expect(result.matched).toBe(false);
    });

    it('does not match a feature description with "credit" in unrelated context', () => {
      // "credit" appears, but not paired with an AI-tool noun.
      const result = scanAIDisclosureRequirement('See the CREDITS file for our list of contributors.');
      expect(result.matched).toBe(false);
    });

    it('does not match "we use AI to label issues" (workflow description, not policy)', () => {
      const result = scanAIDisclosureRequirement('Our triage bot uses AI to label issues automatically.');
      expect(result.matched).toBe(false);
    });
  });

  describe('input validation', () => {
    it('throws on non-string input rather than silently returning matched=false', () => {
      // @ts-expect-error — runtime contract check
      expect(() => scanAIDisclosureRequirement(null)).toThrow(TypeError);
      // @ts-expect-error — runtime contract check
      expect(() => scanAIDisclosureRequirement(undefined)).toThrow(TypeError);
    });
  });

  describe('excerpt extraction', () => {
    it('returns the matched phrase and a windowed excerpt', () => {
      const text =
        'Lots of preamble here describing the project. Contributors must disclose AI use in the PR. Then more text follows.';
      const result = scanAIDisclosureRequirement(text);
      expect(result.matched).toBe(true);
      const match = result.matches[0];
      expect(match.excerpt).toContain('disclose');
      expect(match.excerpt.length).toBeLessThan(text.length);
    });
  });
});
