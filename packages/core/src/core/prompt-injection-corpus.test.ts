/**
 * Regression corpus for prompt-injection fencing (#1192).
 *
 * For every known-shape attack payload, asserts that `wrapUntrustedContent`
 * produces a fence with the structural properties described in the helper:
 * exactly one open and one close tag, lossless round-trip, payload contained.
 *
 * Asserting "the LLM ignores this" requires running the model and is
 * inherently flaky / expensive — that's not what this corpus is for. This
 * corpus exists so any future change to the fencing helper that breaks the
 * structural contract (e.g. removing the close-tag escape, or letting the
 * helper interpolate text inside an attribute without escaping) trips a
 * deterministic CI failure.
 */

import { describe, it, expect } from 'vitest';
import { wrapUntrustedContent, extractFromFence, UNTRUSTED_OPEN_TAG_NAME } from './untrusted-content.js';
import { PROMPT_INJECTION_PAYLOADS } from './__fixtures__/prompt-injection-payloads.js';

describe('prompt-injection corpus (#1192)', () => {
  it('corpus has the categories the threat model references', () => {
    const categories = new Set(PROMPT_INJECTION_PAYLOADS.map((p) => p.category));
    expect(categories).toEqual(
      new Set(['classic', 'fake-system-tag', 'markdown', 'delimiter-collision', 'unicode', 'long']),
    );
    // Pin a minimum so a regression that drops corpus entries gets caught.
    expect(PROMPT_INJECTION_PAYLOADS.length).toBeGreaterThanOrEqual(15);
  });

  describe.each(PROMPT_INJECTION_PAYLOADS)('payload "$name" ($category)', ({ payload }) => {
    const wrapped = wrapUntrustedContent(payload, 'pr-body', { author: 'attacker' });

    it('produces exactly one open tag and one close tag', () => {
      const openCount = wrapped.match(new RegExp(`<${UNTRUSTED_OPEN_TAG_NAME}\\b`, 'g'))?.length ?? 0;
      const closeCount = wrapped.match(new RegExp(`</${UNTRUSTED_OPEN_TAG_NAME}>`, 'g'))?.length ?? 0;
      expect(openCount).toBe(1);
      expect(closeCount).toBe(1);
    });

    it('round-trips through extractFromFence losslessly', () => {
      expect(extractFromFence(wrapped)).toBe(payload);
    });

    it('does not allow the payload to escape the fence boundaries', () => {
      // Find the indices of the open-tag end and close-tag start. Anything
      // between them is "inside the fence". Any substring that looks like an
      // instruction should fall inside that range.
      const openEnd = wrapped.indexOf('>') + 1;
      const closeStart = wrapped.lastIndexOf(`</${UNTRUSTED_OPEN_TAG_NAME}>`);
      expect(openEnd).toBeGreaterThan(0);
      // openEnd === closeStart is legitimate (empty body); only assert the
      // close tag isn't *before* the open tag.
      expect(closeStart).toBeGreaterThanOrEqual(openEnd);

      // For payloads that contain known instruction markers, assert every
      // occurrence in the wrapped output is within the fence interior.
      const markers = ['Ignore previous', 'SYSTEM:', '<system>', '<|im_start|>', '<tool_use>', '<!-- INSTRUCTION'];
      for (const marker of markers) {
        if (!payload.includes(marker)) continue;
        let idx = wrapped.indexOf(marker);
        while (idx !== -1) {
          expect(idx).toBeGreaterThanOrEqual(openEnd);
          expect(idx).toBeLessThan(closeStart);
          idx = wrapped.indexOf(marker, idx + 1);
        }
      }
    });
  });
});
