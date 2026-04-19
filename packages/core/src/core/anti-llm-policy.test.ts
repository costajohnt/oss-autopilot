import { describe, it, expect } from 'vitest';
import { scanForAntiLLMPolicy } from './anti-llm-policy.js';

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
