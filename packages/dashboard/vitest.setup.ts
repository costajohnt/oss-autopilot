/**
 * Vitest setup for dashboard tests.
 * Provides canvas mock and matchMedia stub needed in jsdom environment.
 */
import { vi } from 'vitest';

HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

// canvas-confetti schedules its own requestAnimationFrame loop; in jsdom those
// frames keep firing after the test tears down the DOM, and the library then
// throws `Cannot read properties of null (reading 'clearRect')` as an
// unhandled error. The animation is decorative, so stub it out entirely.
vi.mock('canvas-confetti', () => ({ default: vi.fn() }));

// matchMedia is not implemented in jsdom — provide a minimal stub
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
