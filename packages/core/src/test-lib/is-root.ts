/**
 * True when the test process runs as uid 0. Root ignores file modes, so tests
 * that simulate EACCES/EPERM with chmod (000, 555) cannot fail as expected
 * there (Docker, devcontainers, remote sandboxes). Guard them with
 * `it.skipIf(isRoot)`.
 */
export const isRoot = process.getuid?.() === 0;
