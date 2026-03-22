import { describe, it, expect } from 'vitest';
import { crystalIcon, gradientDefs, theme, svgWrapper, escapeXml, truncate } from './svg-utils.js';

describe('crystalIcon', () => {
  it('returns valid SVG group element', () => {
    const svg = crystalIcon(24);
    expect(svg).toContain('<g');
    expect(svg).toContain('</g>');
    expect(svg).toContain('url(#a1)');
  });
  it('scales to requested size', () => {
    const svg = crystalIcon(32);
    expect(svg).toContain('scale(');
  });
});

describe('gradientDefs', () => {
  it('returns defs block with all 6 crystal gradients', () => {
    const defs = gradientDefs();
    expect(defs).toContain('<defs>');
    expect(defs).toContain('</defs>');
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) {
      expect(defs).toContain(`id="${id}"`);
    }
  });
});

describe('theme', () => {
  it('returns light theme by default', () => {
    const t = theme('light');
    expect(t.bg).toBe('#ffffff');
    expect(t.text).toBe('#1e293b');
  });
  it('returns dark theme when requested', () => {
    const t = theme('dark');
    expect(t.bg).toBe('#0d1117');
    expect(t.text).toBe('#e6edf3');
  });
});

describe('svgWrapper', () => {
  it('wraps content in valid SVG root element', () => {
    const svg = svgWrapper(400, 200, '<rect/>', 'light');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('width="400"');
    expect(svg).toContain('height="200"');
    expect(svg).toContain('<rect/>');
    expect(svg).toContain('#ffffff');
  });
});

describe('escapeXml', () => {
  it('escapes all XML special characters', () => {
    expect(escapeXml('a & b < c > d " e \' f')).toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f');
  });
  it('passes through safe strings unchanged', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });
  it('handles empty string', () => {
    expect(escapeXml('')).toBe('');
  });
});

describe('truncate', () => {
  it('passes through short strings', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });
  it('passes through strings at exactly maxLen', () => {
    expect(truncate('12345', 5)).toBe('12345');
  });
  it('truncates strings longer than maxLen with ellipsis', () => {
    const result = truncate('123456', 5);
    expect(result).toHaveLength(5);
    expect(result.endsWith('\u2026')).toBe(true);
  });
});
