/**
 * Tests for formatter-detection module (#703)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectFormatters,
  diagnoseCIFormatterFailure,
  getPreferredFormatter,
  type FormatterDetectionResult,
} from './formatter-detection.js';
import * as fs from 'fs';

vi.mock('fs');

const mockedFs = vi.mocked(fs);

/** Helper: set up which files "exist" in the mock filesystem */
function mockFileSystem(files: Record<string, string | true>): void {
  mockedFs.existsSync.mockImplementation((filePath) => {
    const p = typeof filePath === 'string' ? filePath : filePath.toString();
    // The repo root directory always exists
    if (p === '/repo') return true;
    // Check if any mocked file matches this path
    for (const key of Object.keys(files)) {
      if (p.endsWith(key) || p === key) return true;
    }
    return false;
  });

  mockedFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

  mockedFs.readFileSync.mockImplementation((filePath, _encoding) => {
    const p = typeof filePath === 'string' ? filePath : filePath.toString();
    for (const [key, value] of Object.entries(files)) {
      if ((p.endsWith(key) || p === key) && typeof value === 'string') {
        return value;
      }
    }
    throw new Error(`ENOENT: no such file: ${p}`);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('detectFormatters', () => {
  it('should throw for nonexistent repoPath', () => {
    mockedFs.existsSync.mockReturnValue(false);

    expect(() => detectFormatters('/nonexistent')).toThrow('does not exist or is not a directory');
  });

  it('should return empty result for empty directory', () => {
    // First call (repoPath validation) returns true, rest return false
    mockedFs.existsSync.mockImplementation((p) => {
      return typeof p === 'string' && p === '/repo';
    });
    mockedFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
    mockedFs.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = detectFormatters('/repo');
    expect(result.formatters).toEqual([]);
    expect(result.packageJsonScripts).toEqual([]);
    expect(result.repoPath).toBe('/repo');
  });

  it('should detect biome from biome.json', () => {
    mockFileSystem({ 'biome.json': '{}' });

    const result = detectFormatters('/repo');
    expect(result.formatters).toHaveLength(1);
    expect(result.formatters[0]).toMatchObject({
      name: 'biome',
      configPath: 'biome.json',
      supportsFileArgs: true,
    });
  });

  it('should detect biome from biome.jsonc', () => {
    mockFileSystem({ 'biome.jsonc': '{}' });

    const result = detectFormatters('/repo');
    expect(result.formatters).toHaveLength(1);
    expect(result.formatters[0].name).toBe('biome');
    expect(result.formatters[0].configPath).toBe('biome.jsonc');
  });

  it('should detect prettier from .prettierrc', () => {
    mockFileSystem({ '.prettierrc': '{}' });

    const result = detectFormatters('/repo');
    expect(result.formatters).toHaveLength(1);
    expect(result.formatters[0]).toMatchObject({
      name: 'prettier',
      configPath: '.prettierrc',
      supportsFileArgs: true,
    });
  });

  it('should detect prettier from .prettierrc.yml', () => {
    mockFileSystem({ '.prettierrc.yml': 'semi: false' });

    const result = detectFormatters('/repo');
    expect(result.formatters).toHaveLength(1);
    expect(result.formatters[0].name).toBe('prettier');
    expect(result.formatters[0].configPath).toBe('.prettierrc.yml');
  });

  it('should detect prettier via devDependencies when no config file exists', () => {
    mockFileSystem({
      'package.json': JSON.stringify({
        devDependencies: { prettier: '^3.0.0' },
      }),
    });

    const result = detectFormatters('/repo');
    const prettier = result.formatters.find((f) => f.name === 'prettier');
    expect(prettier).toBeDefined();
    expect(prettier!.configPath).toBe('package.json');
  });

  it('should detect eslint from eslint.config.js', () => {
    mockFileSystem({ 'eslint.config.js': 'export default {}' });

    const result = detectFormatters('/repo');
    expect(result.formatters).toHaveLength(1);
    expect(result.formatters[0]).toMatchObject({
      name: 'eslint',
      configPath: 'eslint.config.js',
    });
  });

  it('should detect eslint from .eslintrc.json', () => {
    mockFileSystem({ '.eslintrc.json': '{}' });

    const result = detectFormatters('/repo');
    expect(result.formatters).toHaveLength(1);
    expect(result.formatters[0].name).toBe('eslint');
  });

  it('should detect rustfmt from Cargo.toml', () => {
    mockFileSystem({ 'Cargo.toml': '[package]\nname = "my-crate"' });

    const result = detectFormatters('/repo');
    expect(result.formatters).toHaveLength(1);
    expect(result.formatters[0]).toMatchObject({
      name: 'rustfmt',
      configPath: 'Cargo.toml',
      supportsFileArgs: false,
    });
  });

  it('should detect ruff from pyproject.toml with [tool.ruff]', () => {
    mockFileSystem({ 'pyproject.toml': '[tool.ruff]\nline-length = 88' });

    const result = detectFormatters('/repo');
    expect(result.formatters).toHaveLength(1);
    expect(result.formatters[0]).toMatchObject({
      name: 'ruff',
      configPath: 'pyproject.toml',
    });
  });

  it('should detect black from pyproject.toml with [tool.black]', () => {
    mockFileSystem({ 'pyproject.toml': '[tool.black]\nline-length = 88' });

    const result = detectFormatters('/repo');
    expect(result.formatters).toHaveLength(1);
    expect(result.formatters[0]).toMatchObject({
      name: 'black',
      configPath: 'pyproject.toml',
    });
  });

  it('should prefer ruff over black when both sections exist', () => {
    mockFileSystem({
      'pyproject.toml': '[tool.ruff]\nline-length = 88\n\n[tool.black]\nline-length = 88',
    });

    const result = detectFormatters('/repo');
    const pythonFormatters = result.formatters.filter((f) => f.name === 'ruff' || f.name === 'black');
    expect(pythonFormatters).toHaveLength(1);
    expect(pythonFormatters[0].name).toBe('ruff');
  });

  it('should detect ruff from ruff.toml', () => {
    mockFileSystem({ 'ruff.toml': 'line-length = 88' });

    const result = detectFormatters('/repo');
    expect(result.formatters).toHaveLength(1);
    expect(result.formatters[0]).toMatchObject({
      name: 'ruff',
      configPath: 'ruff.toml',
    });
  });

  it('should detect gofmt from go.mod', () => {
    mockFileSystem({ 'go.mod': 'module example.com/foo' });

    const result = detectFormatters('/repo');
    expect(result.formatters).toHaveLength(1);
    expect(result.formatters[0]).toMatchObject({
      name: 'gofmt',
      configPath: 'go.mod',
    });
  });

  it('should detect clang-format from .clang-format', () => {
    mockFileSystem({ '.clang-format': 'BasedOnStyle: Google' });

    const result = detectFormatters('/repo');
    expect(result.formatters).toHaveLength(1);
    expect(result.formatters[0]).toMatchObject({
      name: 'clang-format',
      configPath: '.clang-format',
    });
  });

  it('should detect rubocop from .rubocop.yml', () => {
    mockFileSystem({ '.rubocop.yml': 'AllCops:\n  TargetRubyVersion: 3.0' });

    const result = detectFormatters('/repo');
    expect(result.formatters).toHaveLength(1);
    expect(result.formatters[0]).toMatchObject({
      name: 'rubocop',
      configPath: '.rubocop.yml',
    });
  });

  it('should detect multiple formatters in priority order', () => {
    mockFileSystem({
      'biome.json': '{}',
      '.prettierrc': '{}',
      'eslint.config.js': 'export default {}',
    });

    const result = detectFormatters('/repo');
    expect(result.formatters).toHaveLength(3);
    expect(result.formatters[0].name).toBe('biome');
    expect(result.formatters[1].name).toBe('prettier');
    expect(result.formatters[2].name).toBe('eslint');
  });

  it('should extract package.json formatting scripts', () => {
    mockFileSystem({
      'package.json': JSON.stringify({
        scripts: {
          format: 'prettier --write .',
          lint: 'eslint .',
          'lint:fix': 'eslint --fix .',
          build: 'tsc',
          test: 'vitest',
        },
      }),
    });

    const result = detectFormatters('/repo');
    expect(result.packageJsonScripts).toContainEqual({ name: 'format', command: 'prettier --write .' });
    expect(result.packageJsonScripts).toContainEqual({ name: 'lint', command: 'eslint .' });
    expect(result.packageJsonScripts).toContainEqual({ name: 'lint:fix', command: 'eslint --fix .' });
    // build and test should NOT be included
    expect(result.packageJsonScripts.find((s) => s.name === 'build')).toBeUndefined();
    expect(result.packageJsonScripts.find((s) => s.name === 'test')).toBeUndefined();
  });

  it('should handle malformed package.json gracefully', () => {
    mockFileSystem({
      'package.json': '{ invalid json',
    });

    const result = detectFormatters('/repo');
    expect(result.packageJsonScripts).toEqual([]);
    // Should not throw
  });
});

describe('diagnoseCIFormatterFailure', () => {
  it('should return false for empty log', () => {
    const result = diagnoseCIFormatterFailure('');
    expect(result.isFormattingFailure).toBe(false);
    expect(result.evidence).toEqual([]);
  });

  it('should return false for non-formatting failure', () => {
    const result = diagnoseCIFormatterFailure('Error: Cannot find module "express"\nnpm ERR! test failed');
    expect(result.isFormattingFailure).toBe(false);
  });

  it('should detect prettier failure', () => {
    const result = diagnoseCIFormatterFailure('Code style issues found in the above file(s). Forgot to run Prettier?');
    expect(result.isFormattingFailure).toBe(true);
    expect(result.formatter).toBe('prettier');
    expect(result.fixCommand).toBe('npx prettier --write .');
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it('should detect black failure', () => {
    const result = diagnoseCIFormatterFailure('Oh no! 3 files would be reformatted');
    expect(result.isFormattingFailure).toBe(true);
    expect(result.formatter).toBe('black');
    expect(result.fixCommand).toBe('black .');
  });

  it('should detect ruff failure', () => {
    const result = diagnoseCIFormatterFailure('ruff format --check failed: would reformat 5 files');
    expect(result.isFormattingFailure).toBe(true);
    expect(result.formatter).toBe('ruff');
  });

  it('should detect rustfmt failure', () => {
    const result = diagnoseCIFormatterFailure('Diff in /src/main.rs\ncargo fmt --check failed');
    expect(result.isFormattingFailure).toBe(true);
    expect(result.formatter).toBe('rustfmt');
  });

  it('should detect biome failure', () => {
    const result = diagnoseCIFormatterFailure('biome ci failed\nFound 3 fixable diagnostics');
    expect(result.isFormattingFailure).toBe(true);
    expect(result.formatter).toBe('biome');
  });

  it('should detect eslint failure', () => {
    const result = diagnoseCIFormatterFailure('eslint: 12 problems (5 errors, 7 warnings)');
    expect(result.isFormattingFailure).toBe(true);
    expect(result.formatter).toBe('eslint');
  });

  it('should cross-reference with local detection when repoPath provided', () => {
    // Set up a repo with biome
    mockFileSystem({ 'biome.json': '{}' });

    const result = diagnoseCIFormatterFailure('biome ci failed', '/repo');
    expect(result.isFormattingFailure).toBe(true);
    expect(result.formatter).toBe('biome');
    expect(result.fixCommand).toBe('npx @biomejs/biome check --write');
  });

  it('should provide fallback fix command when no local detection', () => {
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = diagnoseCIFormatterFailure('Forgot to run Prettier?');
    expect(result.isFormattingFailure).toBe(true);
    expect(result.fixCommand).toBe('npx prettier --write .');
  });
});

describe('getPreferredFormatter', () => {
  it('should return first formatter when multiple exist', () => {
    const result: FormatterDetectionResult = {
      formatters: [
        {
          name: 'biome',
          configPath: 'biome.json',
          fixCommand: 'npx biome check --write',
          checkCommand: 'npx biome check',
          supportsFileArgs: true,
        },
        {
          name: 'prettier',
          configPath: '.prettierrc',
          fixCommand: 'npx prettier --write .',
          checkCommand: 'npx prettier --check .',
          supportsFileArgs: true,
        },
      ],
      packageJsonScripts: [],
      repoPath: '/repo',
    };
    const preferred = getPreferredFormatter(result);
    expect(preferred).toBeDefined();
    expect(preferred!.name).toBe('biome');
  });

  it('should return undefined for empty result', () => {
    const result: FormatterDetectionResult = {
      formatters: [],
      packageJsonScripts: [],
      repoPath: '/repo',
    };
    expect(getPreferredFormatter(result)).toBeUndefined();
  });
});
