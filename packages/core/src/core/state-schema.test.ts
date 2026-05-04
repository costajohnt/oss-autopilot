/**
 * Tests for Zod schema validation in state-schema.ts
 */

import { describe, it, expect } from 'vitest';
import {
  AgentStateSchema,
  AgentConfigSchema,
  ShelvedPRRefSchema,
  RepoScoreSchema,
  TrackedIssueSchema,
} from './state-schema.js';

describe('AgentStateSchema', () => {
  describe('missing optional fields get defaults', () => {
    it('should populate all fields with defaults from minimal { version: 4 } input', () => {
      const result = AgentStateSchema.parse({ version: 4 });

      // Top-level defaults
      expect(result.version).toBe(4);
      expect(result.repoScores).toEqual({});
      expect(result.activeIssues).toEqual([]);

      // lastRunAt should be a valid ISO string
      expect(typeof result.lastRunAt).toBe('string');
      expect(new Date(result.lastRunAt).toISOString()).toBe(result.lastRunAt);

      // Config defaults
      expect(result.config.setupComplete).toBe(false);
      expect(result.config.githubUsername).toBe('');
      expect(result.config.maxActivePRs).toBe(10);
      expect(result.config.dormantThresholdDays).toBe(30);
      expect(result.config.approachingDormantDays).toBe(25);
      expect(result.config.maxIssueAgeDays).toBe(90);
      expect(result.config.languages).toEqual(['typescript', 'javascript']);
      expect(result.config.labels).toEqual(['good first issue', 'help wanted']);
      expect(result.config.excludeRepos).toEqual([]);
      expect(result.config.trustedProjects).toEqual([]);
      expect(result.config.minRepoScoreThreshold).toBe(4);
      expect(result.config.starredRepos).toEqual([]);
      expect(result.config.squashByDefault).toBe(true);
      expect(result.config.minStars).toBe(50);
      expect(result.config.includeDocIssues).toBe(true);
      expect(result.config.aiPolicyBlocklist).toEqual(['matplotlib/matplotlib']);
      expect(result.config.shelvedPRUrls).toEqual([]);
      expect(result.config.dismissedIssues).toEqual({});
      expect(result.config.projectCategories).toEqual([]);
      expect(result.config.preferredOrgs).toEqual([]);
    });

    it('should preserve custom config values while defaulting the rest', () => {
      const result = AgentStateSchema.parse({
        version: 4,
        config: { githubUsername: 'testuser' },
      });

      expect(result.config.githubUsername).toBe('testuser');
      // Other config fields should still get defaults
      expect(result.config.maxActivePRs).toBe(10);
      expect(result.config.languages).toEqual(['typescript', 'javascript']);
      expect(result.config.setupComplete).toBe(false);
    });
  });

  describe('unknown keys stripped', () => {
    it('should strip unknown top-level keys', () => {
      const result = AgentStateSchema.parse({
        version: 4,
        snoozedPRs: { foo: 'bar' },
        extraField: true,
      });

      expect(result).not.toHaveProperty('snoozedPRs');
      expect(result).not.toHaveProperty('extraField');
      expect(result.version).toBe(4);
    });

    it('should strip unknown keys from nested config', () => {
      const result = AgentStateSchema.parse({
        version: 4,
        config: { githubUsername: '', legacyField: 42 },
      });

      expect(result.config).not.toHaveProperty('legacyField');
      expect(result.config.githubUsername).toBe('');
    });
  });

  describe('invalid critical fields fail', () => {
    it('should fail for version: 1 (wrong literal)', () => {
      const result = AgentStateSchema.safeParse({ version: 1 });
      expect(result.success).toBe(false);
    });

    it('should fail for version: 2 (old version literal)', () => {
      const result = AgentStateSchema.safeParse({ version: 2 });
      expect(result.success).toBe(false);
    });

    it('should fail for version: "two" (wrong type)', () => {
      const result = AgentStateSchema.safeParse({ version: 'two' });
      expect(result.success).toBe(false);
    });

    it('should fail for config as a string', () => {
      const result = AgentStateSchema.safeParse({ version: 4, config: 'not-an-object' });
      expect(result.success).toBe(false);
    });

    it('should fail for empty object (missing version)', () => {
      const result = AgentStateSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should fail for null', () => {
      const result = AgentStateSchema.safeParse(null);
      expect(result.success).toBe(false);
    });

    it('should fail for a string', () => {
      const result = AgentStateSchema.safeParse('string');
      expect(result.success).toBe(false);
    });
  });

  describe('new v4 fields', () => {
    it('should accept StoredMergedPR with learningsExtractedAt', () => {
      const result = AgentStateSchema.parse({
        version: 4,
        mergedPRs: [
          {
            url: 'https://github.com/o/r/pull/1',
            title: 'Fix bug',
            mergedAt: '2025-01-01',
            learningsExtractedAt: '2025-02-01T00:00:00Z',
          },
        ],
      });
      expect(result.mergedPRs![0].learningsExtractedAt).toBe('2025-02-01T00:00:00Z');
    });

    it('should accept StoredClosedPR with learningsExtractedAt', () => {
      const result = AgentStateSchema.parse({
        version: 4,
        closedPRs: [
          {
            url: 'https://github.com/o/r/pull/2',
            title: 'Try fix',
            closedAt: '2025-01-01',
            learningsExtractedAt: '2025-02-01T00:00:00Z',
          },
        ],
      });
      expect(result.closedPRs![0].learningsExtractedAt).toBe('2025-02-01T00:00:00Z');
    });

    it('should accept analyzedIssueConversations', () => {
      const result = AgentStateSchema.parse({
        version: 4,
        analyzedIssueConversations: [{ url: 'https://github.com/o/r/issues/1', repo: 'o/r', analyzedAt: '2025-03-01' }],
      });
      expect(result.analyzedIssueConversations).toHaveLength(1);
    });

    it('should accept gistId field', () => {
      const result = AgentStateSchema.parse({ version: 4, gistId: 'abc123' });
      expect(result.gistId).toBe('abc123');
    });

    it('should default gistId to undefined', () => {
      const result = AgentStateSchema.parse({ version: 4 });
      expect(result.gistId).toBeUndefined();
    });
  });
});

describe('AgentConfigSchema', () => {
  describe('partial config with defaults', () => {
    it('should produce full config with all defaults from empty object', () => {
      const result = AgentConfigSchema.parse({});

      expect(result.setupComplete).toBe(false);
      expect(result.maxActivePRs).toBe(10);
      expect(result.dormantThresholdDays).toBe(30);
      expect(result.approachingDormantDays).toBe(25);
      expect(result.maxIssueAgeDays).toBe(90);
      expect(result.languages).toEqual(['typescript', 'javascript']);
      expect(result.labels).toEqual(['good first issue', 'help wanted']);
      expect(result.excludeRepos).toEqual([]);
      expect(result.trustedProjects).toEqual([]);
      expect(result.githubUsername).toBe('');
      expect(result.minRepoScoreThreshold).toBe(4);
      expect(result.starredRepos).toEqual([]);
      expect(result.squashByDefault).toBe(true);
      expect(result.minStars).toBe(50);
      expect(result.includeDocIssues).toBe(true);
      expect(result.aiPolicyBlocklist).toEqual(['matplotlib/matplotlib']);
      expect(result.shelvedPRUrls).toEqual([]);
      expect(result.dismissedIssues).toEqual({});
      expect(result.projectCategories).toEqual([]);
      expect(result.preferredOrgs).toEqual([]);
    });

    it('should preserve overridden values while defaulting the rest', () => {
      const result = AgentConfigSchema.parse({ maxActivePRs: 20 });

      expect(result.maxActivePRs).toBe(20);
      // Rest should still be defaults
      expect(result.githubUsername).toBe('');
      expect(result.languages).toEqual(['typescript', 'javascript']);
      expect(result.setupComplete).toBe(false);
    });
  });

  describe('squashByDefault union type', () => {
    it('should accept boolean true', () => {
      const result = AgentConfigSchema.parse({ squashByDefault: true });
      expect(result.squashByDefault).toBe(true);
    });

    it('should accept boolean false', () => {
      const result = AgentConfigSchema.parse({ squashByDefault: false });
      expect(result.squashByDefault).toBe(false);
    });

    it('should accept string "ask"', () => {
      const result = AgentConfigSchema.parse({ squashByDefault: 'ask' });
      expect(result.squashByDefault).toBe('ask');
    });

    it('should reject invalid string "never"', () => {
      const result = AgentConfigSchema.safeParse({ squashByDefault: 'never' });
      expect(result.success).toBe(false);
    });

    it('should reject number 42', () => {
      const result = AgentConfigSchema.safeParse({ squashByDefault: 42 });
      expect(result.success).toBe(false);
    });
  });
});

describe('ShelvedPRRefSchema', () => {
  const validShelvedPR = {
    number: 1,
    url: 'https://github.com/owner/repo/pull/1',
    title: 'Fix bug',
    repo: 'owner/repo',
    daysSinceActivity: 5,
    status: 'needs_addressing' as const,
  };

  describe('enum validation', () => {
    it('should pass for valid ShelvedPRRef with needs_addressing', () => {
      expect(ShelvedPRRefSchema.safeParse(validShelvedPR).success).toBe(true);
    });

    it('should pass for valid ShelvedPRRef with waiting_on_maintainer', () => {
      expect(ShelvedPRRefSchema.safeParse({ ...validShelvedPR, status: 'waiting_on_maintainer' }).success).toBe(true);
    });

    it('should fail for invalid status "dormant"', () => {
      expect(ShelvedPRRefSchema.safeParse({ ...validShelvedPR, status: 'dormant' }).success).toBe(false);
    });
  });
});

describe('RepoScoreSchema', () => {
  const validRepoScore = {
    repo: 'owner/repo',
    score: 8,
    mergedPRCount: 3,
    closedWithoutMergeCount: 1,
    avgResponseDays: 2.5,
    lastMergedAt: '2025-06-01T00:00:00Z',
    lastEvaluatedAt: '2025-06-15T00:00:00Z',
    signals: {
      hasActiveMaintainers: true,
      isResponsive: true,
      hasHostileComments: false,
    },
    stargazersCount: 500,
    language: 'TypeScript',
  };

  describe('validation', () => {
    it('should pass for a valid complete RepoScore', () => {
      const result = RepoScoreSchema.safeParse(validRepoScore);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.repo).toBe('owner/repo');
        expect(result.data.score).toBe(8);
        expect(result.data.signals.hasActiveMaintainers).toBe(true);
      }
    });

    it('should accept avgResponseDays as null (nullable field)', () => {
      const result = RepoScoreSchema.safeParse({
        ...validRepoScore,
        avgResponseDays: null,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.avgResponseDays).toBeNull();
      }
    });

    it('should fail when required repo field is missing', () => {
      const { repo: _repo, ...withoutRepo } = validRepoScore;
      const result = RepoScoreSchema.safeParse(withoutRepo);
      expect(result.success).toBe(false);
    });
  });
});

describe('TrackedIssueSchema', () => {
  const validTrackedIssue = {
    id: 42,
    url: 'https://github.com/owner/repo/issues/42',
    repo: 'owner/repo',
    number: 42,
    title: 'Add dark mode support',
    status: 'candidate' as const,
    labels: ['enhancement', 'good first issue'],
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-20T15:30:00Z',
    vetted: true,
    vettingResult: {
      passedAllChecks: true,
      checks: {
        noExistingPR: true,
        notClaimed: true,
        projectActive: true,
        clearRequirements: true,
        contributionGuidelinesFound: true,
      },
      notes: ['Looks good to contribute'],
    },
  };

  describe('validation', () => {
    it('should pass for a valid TrackedIssue with all fields', () => {
      const result = TrackedIssueSchema.safeParse(validTrackedIssue);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe(42);
        expect(result.data.status).toBe('candidate');
        expect(result.data.vettingResult?.passedAllChecks).toBe(true);
      }
    });

    it('should fail for invalid status "unknown"', () => {
      const result = TrackedIssueSchema.safeParse({
        ...validTrackedIssue,
        status: 'unknown',
      });
      expect(result.success).toBe(false);
    });

    it('should pass when optional vettingResult is omitted', () => {
      const { vettingResult: _vr, ...withoutVetting } = validTrackedIssue;
      const result = TrackedIssueSchema.safeParse(withoutVetting);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.vettingResult).toBeUndefined();
      }
    });
  });
});
