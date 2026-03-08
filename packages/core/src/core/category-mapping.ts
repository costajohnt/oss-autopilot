/**
 * Category Mapping — static mappings from project categories to GitHub topics and organizations.
 *
 * Used by issue discovery to prioritize repos matching user's category preferences.
 */

import type { ProjectCategory } from './types.js';

/** GitHub topics associated with each project category, used for `topic:` search queries. */
export const CATEGORY_TOPICS: Record<ProjectCategory, string[]> = {
  nonprofit: ['nonprofit', 'social-good', 'humanitarian', 'charity', 'social-impact', 'civic-tech'],
  devtools: ['developer-tools', 'devtools', 'cli', 'sdk', 'linter', 'formatter', 'build-tool'],
  infrastructure: ['infrastructure', 'cloud', 'kubernetes', 'docker', 'devops', 'monitoring', 'observability'],
  'web-frameworks': ['web-framework', 'frontend', 'backend', 'fullstack', 'nextjs', 'react', 'vue'],
  'data-ml': ['machine-learning', 'data-science', 'deep-learning', 'nlp', 'data-pipeline', 'analytics'],
  education: ['education', 'learning', 'tutorial', 'courseware', 'edtech', 'teaching'],
};

/** Well-known GitHub organizations associated with each project category. */
export const CATEGORY_ORGS: Record<ProjectCategory, string[]> = {
  nonprofit: ['code-for-america', 'opengovfoundation', 'ushahidi', 'hotosm', 'openfn', 'democracyearth'],
  devtools: ['eslint', 'prettier', 'vitejs', 'biomejs', 'oxc-project', 'ast-grep', 'turbot'],
  infrastructure: ['kubernetes', 'hashicorp', 'grafana', 'prometheus', 'open-telemetry', 'envoyproxy', 'cncf'],
  'web-frameworks': ['vercel', 'remix-run', 'sveltejs', 'nuxt', 'astro', 'redwoodjs', 'blitz-js'],
  'data-ml': ['huggingface', 'mlflow', 'apache', 'dbt-labs', 'dagster-io', 'prefecthq', 'langchain-ai'],
  education: ['freeCodeCamp', 'TheOdinProject', 'exercism', 'codecademy', 'oppia', 'Khan'],
};

/**
 * Check if a repo belongs to any of the given categories based on its owner matching a category org.
 * Comparison is case-insensitive.
 */
export function repoBelongsToCategory(repoFullName: string, categories: ProjectCategory[]): boolean {
  if (categories.length === 0) return false;
  const owner = repoFullName.split('/')[0]?.toLowerCase();
  if (!owner) return false;

  for (const category of categories) {
    const orgs = CATEGORY_ORGS[category];
    if (!orgs) continue; // Guard against invalid categories from hand-edited state.json
    if (orgs.some((org) => org.toLowerCase() === owner)) {
      return true;
    }
  }
  return false;
}

/**
 * Get deduplicated GitHub topics for the given categories, for use in `topic:` search queries.
 */
export function getTopicsForCategories(categories: ProjectCategory[]): string[] {
  const topics = new Set<string>();
  for (const category of categories) {
    const categoryTopics = CATEGORY_TOPICS[category];
    if (!categoryTopics) continue; // Guard against invalid categories from hand-edited state.json
    for (const topic of categoryTopics) {
      topics.add(topic);
    }
  }
  return [...topics];
}
