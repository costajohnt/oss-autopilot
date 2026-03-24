/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { VettedIssueList } from './vetted-issue-list';
import type { ParseIssueListOutput, ParsedIssueItem, RepoMetadataEntry } from '../types';

function makeItem(overrides: Partial<ParsedIssueItem> = {}): ParsedIssueItem {
  return {
    repo: 'owner/repo',
    number: 42,
    title: 'Fix broken widget',
    tier: 'Pursue',
    url: 'https://github.com/owner/repo/issues/42',
    score: 8,
    ...overrides,
  };
}

function makeOutput(available: ParsedIssueItem[] = [], completed: ParsedIssueItem[] = []): ParseIssueListOutput {
  return {
    available,
    completed,
    availableCount: available.length,
    completedCount: completed.length,
  };
}

const testMeta: Record<string, RepoMetadataEntry> = {
  'facebook/react': { stars: 230000, language: 'JavaScript' },
  'vercel/next.js': { stars: 128000, language: 'TypeScript' },
};

describe('VettedIssueList', () => {
  it('renders back button that calls onBack', () => {
    const onBack = vi.fn();
    render(<VettedIssueList vettedIssues={makeOutput()} onBack={onBack} />);
    const backBtn = screen.getByRole('button', { name: /back/i });
    fireEvent.click(backBtn);
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('renders empty state when no items', () => {
    render(<VettedIssueList vettedIssues={makeOutput()} onBack={() => {}} />);
    expect(screen.getByText('No vetted issues found.')).toBeTruthy();
  });

  it('renders available items with GitHub links', () => {
    const items = [
      makeItem({
        repo: 'facebook/react',
        number: 100,
        title: 'Fix hooks',
        url: 'https://github.com/facebook/react/issues/100',
      }),
      makeItem({
        repo: 'vercel/next.js',
        number: 200,
        title: 'Improve ISR',
        url: 'https://github.com/vercel/next.js/issues/200',
      }),
    ];
    render(<VettedIssueList vettedIssues={makeOutput(items)} onBack={() => {}} />);

    const link1 = screen.getByText('facebook/react#100');
    expect(link1.getAttribute('href')).toContain('facebook/react/issues/100');

    const link2 = screen.getByText('vercel/next.js#200');
    expect(link2.getAttribute('href')).toContain('vercel/next.js/issues/200');
  });

  it('shows stars and language from repoMetadata', () => {
    const items = [
      makeItem({ repo: 'facebook/react', number: 100, url: 'https://github.com/facebook/react/issues/100' }),
    ];
    render(<VettedIssueList vettedIssues={makeOutput(items)} repoMetadata={testMeta} onBack={() => {}} />);
    expect(screen.getByText(/230\.0k/)).toBeTruthy();
    expect(screen.getByText('JavaScript')).toBeTruthy();
  });

  it('shows score with correct color classes', () => {
    const items = [
      makeItem({ number: 1, score: 9, url: 'https://github.com/owner/repo/issues/1' }),
      makeItem({ number: 2, score: 7, url: 'https://github.com/owner/repo/issues/2' }),
    ];
    const { container } = render(<VettedIssueList vettedIssues={makeOutput(items)} onBack={() => {}} />);
    expect(container.querySelector('.vetted-score--high')).toBeTruthy();
    expect(container.querySelector('.vetted-score--mid')).toBeTruthy();
  });

  it('sorts by score descending', () => {
    const items = [
      makeItem({ number: 1, score: 6, title: 'Low score', url: 'https://github.com/owner/repo/issues/1' }),
      makeItem({ number: 2, score: 9, title: 'High score', url: 'https://github.com/owner/repo/issues/2' }),
      makeItem({ number: 3, score: 7.5, title: 'Mid score', url: 'https://github.com/owner/repo/issues/3' }),
    ];
    const { container } = render(<VettedIssueList vettedIssues={makeOutput(items)} onBack={() => {}} />);
    const links = container.querySelectorAll('.merged-table-pr-link');
    expect(links[0].textContent).toBe('owner/repo#2');
    expect(links[1].textContent).toBe('owner/repo#3');
    expect(links[2].textContent).toBe('owner/repo#1');
  });

  it('filters out items with score below 6', () => {
    const items = [
      makeItem({ number: 1, score: 8 }),
      makeItem({ number: 2, score: 3 }),
      makeItem({ number: 3, score: 5.5 }),
    ];
    render(<VettedIssueList vettedIssues={makeOutput(items)} onBack={() => {}} />);
    expect(screen.getByText('owner/repo#1')).toBeTruthy();
    expect(screen.queryByText('owner/repo#2')).toBeNull();
    expect(screen.queryByText('owner/repo#3')).toBeNull();
  });

  it('search filters by title and repo', () => {
    const items = [
      makeItem({
        repo: 'facebook/react',
        number: 1,
        title: 'Fix hooks',
        url: 'https://github.com/facebook/react/issues/1',
      }),
      makeItem({
        repo: 'vercel/next.js',
        number: 2,
        title: 'Improve ISR',
        url: 'https://github.com/vercel/next.js/issues/2',
      }),
    ];
    render(<VettedIssueList vettedIssues={makeOutput(items)} onBack={() => {}} />);

    const input = screen.getByPlaceholderText('Search issues...');
    fireEvent.input(input, { target: { value: 'next' } });

    expect(screen.queryByText('facebook/react#1')).toBeNull();
    expect(screen.getByText('vercel/next.js#2')).toBeTruthy();
  });

  it('shows no-match message when search has no results', () => {
    const items = [makeItem()];
    render(<VettedIssueList vettedIssues={makeOutput(items)} onBack={() => {}} />);

    const input = screen.getByPlaceholderText('Search issues...');
    fireEvent.input(input, { target: { value: 'zzzznotfound' } });

    expect(screen.getByText('No issues match your search.')).toBeTruthy();
  });
});
