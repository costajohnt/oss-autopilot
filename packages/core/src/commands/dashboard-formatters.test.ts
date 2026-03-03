/**
 * Tests for dashboard-formatters.ts — HTML escaping and XSS prevention.
 */

import { describe, it, expect } from 'vitest';
import { escapeHtml } from './dashboard-formatters.js';

describe('escapeHtml', () => {
  it('should escape ampersand', () => {
    expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
  });

  it('should escape less-than', () => {
    expect(escapeHtml('a < b')).toBe('a &lt; b');
  });

  it('should escape greater-than', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b');
  });

  it('should escape double quotes', () => {
    expect(escapeHtml('say "hello"')).toBe('say &quot;hello&quot;');
  });

  it('should escape single quotes', () => {
    expect(escapeHtml("it's fine")).toBe('it&#39;s fine');
  });

  it('should escape all special characters at once', () => {
    expect(escapeHtml('<div class="x" data-val=\'y\'>&</div>')).toBe(
      '&lt;div class=&quot;x&quot; data-val=&#39;y&#39;&gt;&amp;&lt;/div&gt;',
    );
  });

  it('should return empty string unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('should return plain text unchanged', () => {
    expect(escapeHtml('Hello World 123')).toBe('Hello World 123');
  });

  // XSS-focused regression tests
  it('should neutralize script injection', () => {
    const result = escapeHtml('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
    expect(result).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('should neutralize event handler injection', () => {
    const result = escapeHtml('<img src=x onerror="alert(1)">');
    expect(result).not.toContain('<img');
    expect(result).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('should neutralize nested HTML tags', () => {
    const result = escapeHtml('<a href="javascript:void(0)">click</a>');
    expect(result).not.toContain('<a ');
    expect(result).toBe('&lt;a href=&quot;javascript:void(0)&quot;&gt;click&lt;/a&gt;');
  });

  it('should handle double-escaping correctly (already escaped input)', () => {
    // If input already contains &amp; it should be escaped again
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  it('should escape PR titles with special characters', () => {
    // Realistic PR title from GitHub
    expect(escapeHtml('fix: handle <T> generic in parse() & format()')).toBe(
      'fix: handle &lt;T&gt; generic in parse() &amp; format()',
    );
  });

  it('should escape multi-line content', () => {
    const input = 'line1 <b>\nline2 "quoted"\nline3 & more';
    expect(escapeHtml(input)).toBe('line1 &lt;b&gt;\nline2 &quot;quoted&quot;\nline3 &amp; more');
  });
});
