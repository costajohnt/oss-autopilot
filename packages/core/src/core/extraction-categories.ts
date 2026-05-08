/**
 * Per-repo extraction category configuration (#1284).
 *
 * The `extract-learnings` MCP prompt produces a structured markdown
 * document organized into category sections. The default category
 * set is sensible for typical web/library OSS work; specialized
 * repos (security-focused, performance-critical, accessibility-
 * forward) benefit from a tailored taxonomy.
 *
 * This module is the single source of truth for:
 *   - The default category list.
 *   - Validation of custom category lists (non-empty, no duplicates,
 *     reasonable string lengths).
 *   - Resolution: given a repo's optional override, produce the list
 *     of categories the prompt and the storage layer should use.
 *
 * Pure typed helper — no I/O. Same architectural shape as the recent
 * #1252 / #1264 / #1286 / #1279 / #1277 extractions.
 *
 * Out of scope (deferred per #1284):
 *  - Wiring `categories` into the `guidelines store` / `guidelines view`
 *    shape so the override persists alongside the markdown.
 *  - Updating the `extract-learnings` MCP prompt to consume the
 *    resolved category list at run time.
 *  - Detecting repo type from signals (SECURITY.md presence, repo
 *    topics, etc.) to suggest categories.
 */

/**
 * The default category list used by `extract-learnings` when no
 * per-repo override is configured. Order matters: the prompt
 * renders sections in this order, so `Code Style` first /
 * `Other` last is the established convention.
 */
export const DEFAULT_EXTRACTION_CATEGORIES: readonly string[] = [
  'Code Style',
  'Process',
  'Architecture',
  'Testing',
  'Other',
];

/**
 * Reasonable bounds on an override list. The prompt produces output
 * organized into one heading per category; very long lists become
 * unreadable, very long category names blow out heading width.
 */
const CATEGORY_NAME_MAX_LENGTH = 40;
const MAX_CATEGORIES = 12;

export interface CategoryValidationResult {
  ok: boolean;
  /** Non-empty when ok === false. One issue per detected problem. */
  errors: string[];
  /** The list as a caller should persist it, with `Other` appended
   * if the user forgot it (the prompt always needs an "everything
   * else" bucket). Only populated when ok === true. */
  normalized?: readonly string[];
}

/**
 * Validate a user-supplied category list. Returns a structured
 * result rather than throwing — the CLI / slash-command callers
 * surface error strings inline.
 */
export function validateCategories(input: readonly string[]): CategoryValidationResult {
  const errors: string[] = [];
  if (input.length === 0) {
    errors.push('At least one category is required.');
    return { ok: false, errors };
  }
  if (input.length > MAX_CATEGORIES) {
    errors.push(`At most ${MAX_CATEGORIES} categories are supported (received ${input.length}).`);
  }
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of input) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      errors.push('Category names cannot be empty or whitespace-only.');
      continue;
    }
    if (trimmed.length > CATEGORY_NAME_MAX_LENGTH) {
      errors.push(`Category "${trimmed.slice(0, 30)}…" is longer than ${CATEGORY_NAME_MAX_LENGTH} characters.`);
      continue;
    }
    const lowerKey = trimmed.toLowerCase();
    if (seen.has(lowerKey)) {
      errors.push(`Duplicate category "${trimmed}" (case-insensitive).`);
      continue;
    }
    seen.add(lowerKey);
    cleaned.push(trimmed);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  // Always ensure an "Other" bucket exists at the end so the prompt
  // has a place to put feedback that doesn't fit the user's chosen
  // categories. Append silently if missing rather than treating the
  // omission as an error — most users won't think to add it.
  if (!seen.has('other')) {
    cleaned.push('Other');
  }
  return { ok: true, errors: [], normalized: cleaned };
}

/**
 * Resolve the categories the prompt + storage layer should use for a
 * specific extraction. Falls back to the default list when no
 * override is supplied or when the override fails validation.
 */
export function resolveCategories(override: readonly string[] | undefined | null): readonly string[] {
  if (!override || override.length === 0) {
    return DEFAULT_EXTRACTION_CATEGORIES;
  }
  const result = validateCategories(override);
  if (!result.ok || !result.normalized) {
    return DEFAULT_EXTRACTION_CATEGORIES;
  }
  return result.normalized;
}
