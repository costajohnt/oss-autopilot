import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { ThemeToggle } from './theme-toggle';

describe('ThemeToggle', () => {
  it('renders sun icon when theme is dark', () => {
    const { container } = render(<ThemeToggle theme="dark" onToggle={() => {}} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    // Sun icon has a circle element
    expect(svg!.querySelector('circle')).toBeTruthy();
  });

  it('renders moon icon when theme is light', () => {
    const { container } = render(<ThemeToggle theme="light" onToggle={() => {}} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    // Moon icon has a path but no circle
    expect(svg!.querySelector('path')).toBeTruthy();
    expect(svg!.querySelector('circle')).toBeNull();
  });

  it('has correct aria-label for dark mode', () => {
    const { container } = render(<ThemeToggle theme="dark" onToggle={() => {}} />);
    const button = container.querySelector('button');
    expect(button!.getAttribute('aria-label')).toBe('Switch to light mode');
  });

  it('has correct aria-label for light mode', () => {
    const { container } = render(<ThemeToggle theme="light" onToggle={() => {}} />);
    const button = container.querySelector('button');
    expect(button!.getAttribute('aria-label')).toBe('Switch to dark mode');
  });

  it('calls onToggle when clicked', () => {
    const onToggle = vi.fn();
    const { container } = render(<ThemeToggle theme="dark" onToggle={onToggle} />);
    const button = container.querySelector('button')!;
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('has the theme-toggle class', () => {
    const { container } = render(<ThemeToggle theme="dark" onToggle={() => {}} />);
    expect(container.querySelector('.theme-toggle')).toBeTruthy();
  });
});
