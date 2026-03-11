import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { MergedPRList } from './merged-pr-list';
import { makeMergedPR } from '../test-helpers';

describe('MergedPRList', () => {
  const prs = [
    makeMergedPR({
      url: 'https://github.com/a/b/pull/1',
      repo: 'a/b',
      number: 1,
      title: 'First PR',
      mergedAt: '2025-06-10T00:00:00Z',
    }),
    makeMergedPR({
      url: 'https://github.com/c/d/pull/2',
      repo: 'c/d',
      number: 2,
      title: 'Second PR',
      mergedAt: '2025-06-09T00:00:00Z',
    }),
  ];

  const repoMetadata = {
    'a/b': { stars: 5000, language: 'TypeScript' },
    'c/d': { stars: 200, language: 'Python' },
  };

  it('renders back button that calls onBack', () => {
    const onBack = vi.fn();
    const { container } = render(<MergedPRList mergedPRs={prs} onBack={onBack} />);
    const backBtn = container.querySelector('.merged-view-back') as HTMLButtonElement;
    expect(backBtn).toBeTruthy();
    fireEvent.click(backBtn);
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('renders all PRs with titles and GitHub links', () => {
    const { container } = render(<MergedPRList mergedPRs={prs} onBack={() => {}} />);
    const links = container.querySelectorAll('.merged-table-pr-link');
    expect(links).toHaveLength(2);
    expect((links[0] as HTMLAnchorElement).href).toBe('https://github.com/a/b/pull/1');
    expect((links[0] as HTMLAnchorElement).target).toBe('_blank');
    expect((links[0] as HTMLAnchorElement).rel).toBe('noopener noreferrer');
    expect(links[0].textContent).toBe('a/b#1');
    expect(links[1].textContent).toBe('c/d#2');
  });

  it('shows formatted merge dates', () => {
    const { container } = render(<MergedPRList mergedPRs={prs} onBack={() => {}} />);
    const dates = container.querySelectorAll('.merged-table-date');
    expect(dates).toHaveLength(2);
    // Just check they render (formatting depends on locale)
    expect(dates[0].textContent).toBeTruthy();
  });

  it('shows count in subtitle', () => {
    const { container } = render(<MergedPRList mergedPRs={prs} onBack={() => {}} />);
    const subtitle = container.querySelector('.merged-view-subtitle');
    expect(subtitle?.textContent).toBe('2 total');
  });

  it('shows empty state when no PRs', () => {
    const { container } = render(<MergedPRList mergedPRs={[]} onBack={() => {}} />);
    const empty = container.querySelector('.merged-view-empty');
    expect(empty).toBeTruthy();
    expect(empty?.textContent).toContain('No merged PRs found');
  });

  it('renders star counts and language when repoMetadata is provided', () => {
    const { container } = render(<MergedPRList mergedPRs={prs} repoMetadata={repoMetadata} onBack={() => {}} />);
    const stars = container.querySelectorAll('.merged-table-stars');
    expect(stars).toHaveLength(2);
    expect(stars[0].textContent).toContain('5.0k');
    expect(stars[1].textContent).toContain('200');

    const languages = container.querySelectorAll('.merged-table-language');
    expect(languages).toHaveLength(2);
    expect(languages[0].textContent).toContain('TypeScript');
    expect(languages[1].textContent).toContain('Python');
  });

  it('renders gracefully without repoMetadata', () => {
    const { container } = render(<MergedPRList mergedPRs={prs} onBack={() => {}} />);
    // Table cells still exist, but show dashes
    const stars = container.querySelectorAll('.merged-table-stars');
    expect(stars).toHaveLength(2);
    expect(stars[0].textContent).toBe('—');
    expect(stars[1].textContent).toBe('—');

    const languages = container.querySelectorAll('.merged-table-language');
    expect(languages).toHaveLength(2);
    expect(languages[0].textContent).toBe('—');
    expect(languages[1].textContent).toBe('—');
  });

  it('handles missing repo in metadata map', () => {
    const partialMetadata = { 'a/b': { stars: 1000, language: 'Go' } };
    const { container } = render(<MergedPRList mergedPRs={prs} repoMetadata={partialMetadata} onBack={() => {}} />);
    const stars = container.querySelectorAll('.merged-table-stars');
    expect(stars).toHaveLength(2);
    expect(stars[0].textContent).toContain('1.0k');
    expect(stars[1].textContent).toBe('—');

    const languages = container.querySelectorAll('.merged-table-language');
    expect(languages).toHaveLength(2);
    expect(languages[0].textContent).toContain('Go');
    expect(languages[1].textContent).toBe('—');
  });

  it('handles repo with stars but no language', () => {
    const metaNoLang = { 'a/b': { stars: 500, language: null } };
    const { container } = render(<MergedPRList mergedPRs={[prs[0]]} repoMetadata={metaNoLang} onBack={() => {}} />);
    const stars = container.querySelectorAll('.merged-table-stars');
    expect(stars).toHaveLength(1);
    expect(stars[0].textContent).toContain('500');

    // Language cell exists but shows dash
    const languages = container.querySelectorAll('.merged-table-language');
    expect(languages).toHaveLength(1);
    expect(languages[0].textContent).toBe('—');
  });

  it('renders table with correct column headers', () => {
    const { container } = render(<MergedPRList mergedPRs={prs} onBack={() => {}} />);
    const headers = container.querySelectorAll('.merged-table th');
    expect(headers).toHaveLength(4);
    expect(headers[0].textContent).toBe('PR');
    expect(headers[1].textContent).toBe('Stars');
    expect(headers[2].textContent).toBe('Language');
    expect(headers[3].textContent).toBe('Date Merged');
  });

  it('renders correct number of table rows', () => {
    const { container } = render(<MergedPRList mergedPRs={prs} onBack={() => {}} />);
    const rows = container.querySelectorAll('.merged-table tbody tr');
    expect(rows).toHaveLength(2);
  });
});
