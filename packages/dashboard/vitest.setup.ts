/**
 * Vitest setup for dashboard tests.
 * Provides canvas mock needed by Chart.js in jsdom environment.
 */

HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
