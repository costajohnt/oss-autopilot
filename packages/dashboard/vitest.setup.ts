/**
 * Vitest setup for dashboard tests.
 * Provides canvas mock and matchMedia stub needed in jsdom environment.
 */
import { afterAll, vi } from 'vitest';

// Preact schedules effect flushes with a 35 ms timer whose callback calls
// cancelAnimationFrame. If a test file finishes inside that window, the timer
// fires after vitest has removed the jsdom globals and the run fails with
// "ReferenceError: cancelAnimationFrame is not defined" although every test
// passed (seen on slow CI runners). Wait out the window before teardown: the
// pending timer was scheduled first, so it always fires before this one.
afterAll(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

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
