#!/usr/bin/env node
/**
 * OSS Contribution Agent CLI
 * Human-in-the-loop system for managing open source contributions
 */

import 'dotenv/config';
import { getStateManager } from './state.js';
import { PRMonitor, PRUpdate } from './pr-monitor.js';
import { IssueDiscovery } from './issue-discovery.js';
import { parseGitHubUrl } from './utils.js';
import { DailyDigest, TrackedPR } from './types.js';

const VERSION = '0.1.0';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Commands that don't require GitHub API access
const LOCAL_ONLY_COMMANDS = ['help', 'status', 'config', 'read', 'untrack', 'version', '-v', '--version', 'setup', 'checkSetup'];

const command = process.argv[2] || 'help';
if (!GITHUB_TOKEN && !LOCAL_ONLY_COMMANDS.includes(command)) {
  console.error('Error: GITHUB_TOKEN environment variable is required');
  console.error('Set it in .env file or export GITHUB_TOKEN=your_token');
  process.exit(1);
}

// Lazy initialization - only create when needed
let _stateManager: ReturnType<typeof getStateManager> | null = null;
let _prMonitor: PRMonitor | null = null;
let _issueDiscovery: IssueDiscovery | null = null;

function getState() {
  if (!_stateManager) _stateManager = getStateManager();
  return _stateManager;
}

function getPRMonitor() {
  if (!_prMonitor) _prMonitor = new PRMonitor(GITHUB_TOKEN!);
  return _prMonitor;
}

function getIssueDiscovery() {
  if (!_issueDiscovery) _issueDiscovery = new IssueDiscovery(GITHUB_TOKEN!);
  return _issueDiscovery;
}

// CLI Commands
const commands: Record<string, () => Promise<void>> = {
  /**
   * Run daily check - monitors PRs and generates digest
   */
  async daily() {
    console.log('\n📊 Running daily check...\n');

    // Check all PRs
    const updates = await getPRMonitor().checkAllPRs();

    // Generate digest
    const digest = generateDigest(updates);

    // Print digest
    printDigest(digest);

    // Save state
    getState().save();
  },

  /**
   * Search for new issues to work on
   */
  async search() {
    const args = process.argv.slice(3);
    const maxResults = parseInt(args[0]) || 5;

    console.log(`\n🔍 Searching for issues (max ${maxResults})...\n`);

    const discovery = getIssueDiscovery();
    const candidates = await discovery.searchIssues({ maxResults });

    if (candidates.length === 0) {
      console.log('No matching issues found.');
      return;
    }

    console.log(`Found ${candidates.length} candidates:\n`);

    for (const candidate of candidates) {
      console.log(discovery.formatCandidate(candidate));
      console.log('---');
    }
  },

  /**
   * Vet a specific issue
   */
  async vet() {
    const issueUrl = process.argv[3];
    if (!issueUrl) {
      console.error('Usage: oss-autopilot vet <issue-url>');
      process.exit(1);
    }

    console.log(`\n🔍 Vetting issue: ${issueUrl}\n`);

    const discovery = getIssueDiscovery();
    const candidate = await discovery.vetIssue(issueUrl);
    console.log(discovery.formatCandidate(candidate));
  },

  /**
   * Track a PR
   */
  async track() {
    const prUrl = process.argv[3];
    if (!prUrl) {
      console.error('Usage: oss-autopilot track <pr-url>');
      process.exit(1);
    }

    console.log(`\n📌 Tracking PR: ${prUrl}\n`);

    const pr = await getPRMonitor().trackPR(prUrl);
    console.log(`Added PR: ${pr.repo}#${pr.number} - ${pr.title}`);

    getState().save();
  },

  /**
   * Untrack a PR (stop monitoring)
   */
  async untrack() {
    const prUrl = process.argv[3];
    if (!prUrl) {
      console.error('Usage: oss-autopilot untrack <pr-url>');
      process.exit(1);
    }

    console.log(`\n🗑️ Untracking PR: ${prUrl}\n`);

    const sm = getState();
    const removed = sm.untrackPR(prUrl);

    if (removed) {
      sm.save();
      console.log('PR removed from tracking.');
    } else {
      console.log('PR was not being tracked.');
    }
  },

  /**
   * Mark PR comments as read
   */
  async read() {
    const prUrl = process.argv[3];
    const sm = getState();

    if (prUrl === '--all') {
      console.log('\n✓ Marking all PRs as read...\n');
      const count = sm.markAllPRsAsRead();
      sm.save();
      console.log(`Marked ${count} PRs as read.`);
      return;
    }

    if (!prUrl) {
      console.error('Usage: oss-autopilot read <pr-url> or oss-autopilot read --all');
      process.exit(1);
    }

    console.log(`\n✓ Marking PR as read: ${prUrl}\n`);

    const marked = sm.markPRAsRead(prUrl);
    if (marked) {
      sm.save();
      console.log('PR marked as read.');
    } else {
      console.log('PR not found or already read.');
    }
  },

  /**
   * Show current status
   */
  async status() {
    console.log('\n📊 Current Status\n');

    const sm = getState();
    const stats = sm.getStats();
    const state = sm.getState();

    console.log(`Active PRs: ${stats.activePRs}`);
    console.log(`Dormant PRs: ${stats.dormantPRs}`);
    console.log(`Merged PRs: ${stats.mergedPRs}`);
    console.log(`Closed PRs: ${stats.closedPRs}`);
    console.log(`Active Issues: ${stats.activeIssues}`);
    console.log(`Trusted Projects: ${stats.trustedProjects}`);
    console.log(`Merge Rate: ${stats.mergeRate}`);
    console.log(`\nLast Run: ${state.lastRunAt}`);

    if (state.activePRs.length > 0) {
      console.log('\n📋 Active PRs:');
      for (const pr of state.activePRs) {
        const status = pr.hasUnreadComments ? '💬' : '✓';
        console.log(`  ${status} ${pr.repo}#${pr.number} - ${pr.title}`);
      }
    }

    if (state.dormantPRs.length > 0) {
      console.log('\n⏰ Dormant PRs:');
      for (const pr of state.dormantPRs) {
        console.log(`  ${pr.repo}#${pr.number} - ${pr.daysSinceActivity} days inactive`);
      }
    }
  },

  /**
   * Configure the agent
   */
  async config() {
    const key = process.argv[3];
    const value = process.argv[4];
    const sm = getState();

    if (!key) {
      // Show current config
      const config = sm.getState().config;
      console.log('\n⚙️ Current Configuration:\n');
      console.log(JSON.stringify(config, null, 2));
      return;
    }

    if (!value) {
      console.error('Usage: oss-autopilot config <key> <value>');
      process.exit(1);
    }

    // Handle specific config keys
    const currentConfig = sm.getState().config;
    switch (key) {
      case 'username':
        sm.updateConfig({ githubUsername: value });
        console.log(`Set GitHub username to: ${value}`);
        break;
      case 'add-language':
        if (!currentConfig.languages.includes(value)) {
          sm.updateConfig({ languages: [...currentConfig.languages, value] });
          console.log(`Added language: ${value}`);
        }
        break;
      case 'add-label':
        if (!currentConfig.labels.includes(value)) {
          sm.updateConfig({ labels: [...currentConfig.labels, value] });
          console.log(`Added label: ${value}`);
        }
        break;
      case 'exclude-repo':
        if (!currentConfig.excludeRepos.includes(value)) {
          sm.updateConfig({ excludeRepos: [...currentConfig.excludeRepos, value] });
          console.log(`Excluded repo: ${value}`);
        }
        break;
      default:
        console.error(`Unknown config key: ${key}`);
        process.exit(1);
    }

    sm.save();
  },

  /**
   * Initialize with existing PRs
   */
  async init() {
    const username = process.argv[3];
    if (!username) {
      console.error('Usage: oss-autopilot init <github-username>');
      process.exit(1);
    }

    console.log(`\n🚀 Initializing with PRs from @${username}...\n`);

    const sm = getState();

    // Set username
    sm.updateConfig({ githubUsername: username });

    // Import existing open PRs
    await importUserPRs(username);

    sm.save();
    console.log('\nInitialization complete! Run `oss-agent status` to see your PRs.');
  },

  /**
   * Fetch and display comments for a PR
   */
  async comments() {
    const prUrl = process.argv[3];
    if (!prUrl) {
      console.error('Usage: oss-autopilot comments <pr-url>');
      process.exit(1);
    }

    console.log(`\n💬 Fetching comments for: ${prUrl}\n`);

    const { getOctokit } = await import('./github.js');
    const octokit = getOctokit(GITHUB_TOKEN!);

    // Parse PR URL
    const parsed = parseGitHubUrl(prUrl);
    if (!parsed || parsed.type !== 'pull') {
      console.error('Invalid PR URL format');
      process.exit(1);
    }

    const { owner, repo, number: pull_number } = parsed;

    // Get PR details
    const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number });
    console.log(`## ${pr.title}\n`);
    console.log(`**Status:** ${pr.state} | **Mergeable:** ${pr.mergeable ?? 'checking...'}`);
    console.log(`**Branch:** ${pr.head.ref} → ${pr.base.ref}`);
    console.log(`**URL:** ${pr.html_url}\n`);

    // Get review comments (inline code comments)
    const { data: reviewComments } = await octokit.pulls.listReviewComments({
      owner,
      repo,
      pull_number,
      per_page: 100,
    });

    // Get issue comments (general PR discussion)
    const { data: issueComments } = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: pull_number,
      per_page: 100,
    });

    // Get reviews
    const { data: reviews } = await octokit.pulls.listReviews({
      owner,
      repo,
      pull_number,
      per_page: 100,
    });

    // Filter out own comments, optionally show bots
    const sm = getState();
    const username = sm.getState().config.githubUsername;
    const showBots = process.argv.includes('--bots');

    const filterComment = (c: { user?: { login?: string; type?: string } | null }) => {
      if (!c.user) return false;
      if (c.user.login === username) return false;
      // Allow review bots like CodeRabbit, Copilot if --bots flag
      if (c.user.type === 'Bot' && !showBots) return false;
      return true;
    };

    // Filter and sort by date (newest first)
    const relevantReviewComments = reviewComments
      .filter(filterComment)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const relevantIssueComments = issueComments
      .filter(filterComment)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const relevantReviews = reviews
      .filter(r => filterComment(r) && r.body && r.body.trim())
      .sort((a, b) => new Date(b.submitted_at || 0).getTime() - new Date(a.submitted_at || 0).getTime());

    // Helper to format relative time
    const formatRelativeTime = (dateStr: string) => {
      const date = new Date(dateStr);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (diffDays < 30) return `${diffDays}d ago`;
      return date.toLocaleDateString();
    };

    // Print reviews (newest first)
    if (relevantReviews.length > 0) {
      console.log('### Reviews (newest first)\n');
      for (const review of relevantReviews) {
        const state = review.state === 'APPROVED' ? '✅' :
                      review.state === 'CHANGES_REQUESTED' ? '❌' : '💬';
        const time = review.submitted_at ? formatRelativeTime(review.submitted_at) : '';
        console.log(`${state} **@${review.user?.login}** (${review.state}) - ${time}`);
        if (review.body) {
          console.log(`> ${review.body.split('\n').join('\n> ')}\n`);
        }
      }
    }

    // Print review comments (inline, newest first)
    if (relevantReviewComments.length > 0) {
      console.log('### Inline Comments (newest first)\n');
      for (const comment of relevantReviewComments) {
        const time = formatRelativeTime(comment.created_at);
        console.log(`**@${comment.user?.login}** on \`${comment.path}\` - ${time}`);
        console.log(`> ${comment.body.split('\n').join('\n> ')}`);
        if (comment.diff_hunk) {
          console.log(`\`\`\`diff\n${comment.diff_hunk.slice(-500)}\n\`\`\``);
        }
        console.log('');
      }
    }

    // Print issue comments (general discussion, newest first)
    if (relevantIssueComments.length > 0) {
      console.log('### Discussion (newest first)\n');
      for (const comment of relevantIssueComments) {
        const time = formatRelativeTime(comment.created_at);
        console.log(`**@${comment.user?.login}** - ${time}`);
        console.log(`> ${comment.body?.split('\n').join('\n> ')}\n`);
      }
    }

    if (relevantReviewComments.length === 0 &&
        relevantIssueComments.length === 0 &&
        relevantReviews.length === 0) {
      console.log('No comments from other users.\n');
    }

    // Summary
    console.log('---');
    console.log(`**Summary:** ${relevantReviews.length} reviews, ${relevantReviewComments.length} inline comments, ${relevantIssueComments.length} discussion comments`);
  },

  /**
   * Show version
   */
  async version() {
    console.log(`oss-autopilot v${VERSION}`);
  },

  /**
   * Interactive setup / configuration
   * Usage:
   *   setup              - Show current setup status and prompts
   *   setup --reset      - Re-run setup even if already complete
   *   setup --set key=value key2=value2  - Set specific values
   */
  async setup() {
    const args = process.argv.slice(3);
    const sm = getState();
    const config = sm.getState().config;
    const isReset = args.includes('--reset');
    const setIndex = args.indexOf('--set');

    // Handle --set mode: apply settings directly
    if (setIndex !== -1) {
      const settings = args.slice(setIndex + 1);
      for (const setting of settings) {
        const [key, ...valueParts] = setting.split('=');
        const value = valueParts.join('='); // Handle values with = in them

        switch (key) {
          case 'username':
            sm.updateConfig({ githubUsername: value });
            console.log(`✓ GitHub username: ${value}`);
            break;
          case 'maxActivePRs':
            sm.updateConfig({ maxActivePRs: parseInt(value) || 10 });
            console.log(`✓ Max active PRs: ${value}`);
            break;
          case 'dormantDays':
            sm.updateConfig({ dormantThresholdDays: parseInt(value) || 30 });
            console.log(`✓ Dormant threshold: ${value} days`);
            break;
          case 'approachingDays':
            sm.updateConfig({ approachingDormantDays: parseInt(value) || 25 });
            console.log(`✓ Approaching dormant: ${value} days`);
            break;
          case 'languages':
            sm.updateConfig({ languages: value.split(',').map(l => l.trim()) });
            console.log(`✓ Languages: ${value}`);
            break;
          case 'labels':
            sm.updateConfig({ labels: value.split(',').map(l => l.trim()) });
            console.log(`✓ Labels: ${value}`);
            break;
          case 'complete':
            if (value === 'true') {
              sm.markSetupComplete();
              console.log(`✓ Setup marked complete`);
            }
            break;
          default:
            console.warn(`Unknown setting: ${key}`);
        }
      }
      sm.save();
      return;
    }

    // Show setup status
    console.log('\n⚙️  OSS Autopilot Setup\n');

    if (config.setupComplete && !isReset) {
      console.log('✓ Setup already complete!\n');
      console.log('Current settings:');
      console.log(`  GitHub username:    ${config.githubUsername || '(not set)'}`);
      console.log(`  Max active PRs:     ${config.maxActivePRs}`);
      console.log(`  Dormant threshold:  ${config.dormantThresholdDays} days`);
      console.log(`  Approaching dormant: ${config.approachingDormantDays} days`);
      console.log(`  Languages:          ${config.languages.join(', ')}`);
      console.log(`  Labels:             ${config.labels.join(', ')}`);
      console.log(`\nRun 'setup --reset' to reconfigure.`);
      return;
    }

    // Output setup prompts in structured format for Claude Code
    console.log('SETUP_REQUIRED');
    console.log('---');
    console.log('Please configure the following settings:\n');

    console.log('SETTING: username');
    console.log('PROMPT: What is your GitHub username?');
    console.log(`CURRENT: ${config.githubUsername || '(not set)'}`);
    console.log('REQUIRED: true');
    console.log('');

    console.log('SETTING: maxActivePRs');
    console.log('PROMPT: How many PRs do you want to work on at once?');
    console.log(`CURRENT: ${config.maxActivePRs}`);
    console.log('DEFAULT: 10');
    console.log('TYPE: number');
    console.log('');

    console.log('SETTING: dormantDays');
    console.log('PROMPT: After how many days of inactivity should a PR be considered dormant?');
    console.log(`CURRENT: ${config.dormantThresholdDays}`);
    console.log('DEFAULT: 30');
    console.log('TYPE: number');
    console.log('');

    console.log('SETTING: approachingDays');
    console.log('PROMPT: At how many days should we warn about approaching dormancy?');
    console.log(`CURRENT: ${config.approachingDormantDays}`);
    console.log('DEFAULT: 25');
    console.log('TYPE: number');
    console.log('');

    console.log('SETTING: languages');
    console.log('PROMPT: What programming languages do you want to contribute to? (comma-separated)');
    console.log(`CURRENT: ${config.languages.join(', ')}`);
    console.log('DEFAULT: typescript, javascript');
    console.log('TYPE: list');
    console.log('');

    console.log('SETTING: labels');
    console.log('PROMPT: What issue labels should we search for? (comma-separated)');
    console.log(`CURRENT: ${config.labels.join(', ')}`);
    console.log('DEFAULT: good first issue, help wanted');
    console.log('TYPE: list');
    console.log('');

    console.log('---');
    console.log('END_SETUP_PROMPTS');
  },

  /**
   * Check if setup is complete (for Claude Code integration)
   */
  async checkSetup() {
    const sm = getState();
    if (sm.isSetupComplete()) {
      console.log('SETUP_COMPLETE');
      console.log(`username=${sm.getState().config.githubUsername}`);
    } else {
      console.log('SETUP_INCOMPLETE');
    }
  },

  /**
   * Show help
   */
  async help() {
    console.log(`
oss-autopilot v${VERSION} - AI-powered autopilot for managing open source contributions

Commands:
  setup               Interactive setup (configure preferences)
  setup --reset       Re-run setup to change settings
  init <username>     Initialize with your GitHub username and import open PRs
  daily               Run daily check on all tracked PRs
  comments <pr-url>   Show all comments on a PR (for drafting responses)
  search [count]      Search for new issues to work on (default: 5)
  vet <issue-url>     Vet a specific issue before working on it
  track <pr-url>      Add a PR to track
  untrack <pr-url>    Stop tracking a PR
  read <pr-url>       Mark PR comments as read
  read --all          Mark all PR comments as read
  status              Show current status and stats
  config              Show or update configuration
  help                Show this help message

Examples:
  oss-autopilot init costajohnt
  oss-autopilot daily
  oss-autopilot comments https://github.com/owner/repo/pull/123
  oss-autopilot search 10
  oss-autopilot vet https://github.com/owner/repo/issues/123
  oss-autopilot track https://github.com/owner/repo/pull/456
  oss-autopilot untrack https://github.com/owner/repo/pull/456
  oss-autopilot read https://github.com/owner/repo/pull/456
  oss-autopilot config username costajohnt
  oss-autopilot config add-language ruby
`);
  },
};

async function importUserPRs(username: string): Promise<void> {
  const { getOctokit } = await import('./github.js');
  const octokit = getOctokit(GITHUB_TOKEN!);

  // Search for open PRs by this user
  const { data } = await octokit.search.issuesAndPullRequests({
    q: `is:pr is:open author:${username}`,
    sort: 'updated',
    order: 'desc',
    per_page: 50,
  });

  console.log(`Found ${data.total_count} open PRs`);

  const monitor = getPRMonitor();
  for (const item of data.items) {
    if (item.pull_request) {
      try {
        const pr = await monitor.trackPR(item.html_url);
        console.log(`  Added: ${pr.repo}#${pr.number} - ${pr.title}`);
      } catch (error) {
        console.error(`  Error adding ${item.html_url}:`, error);
      }
    }
  }
}

function generateDigest(updates: PRUpdate[]): DailyDigest {
  const sm = getState();
  const state = sm.getState();
  const now = new Date().toISOString();

  const mergedPRs = updates.filter(u => u.type === 'merged').map(u => u.pr);
  const prsNeedingResponse = state.activePRs.filter(pr => pr.hasUnreadComments);
  const dormantPRs = updates.filter(u => u.type === 'dormant').map(u => u.pr);
  const approachingDormant = updates.filter(u => u.type === 'approaching_dormant').map(u => u.pr);

  const stats = sm.getStats();

  return {
    generatedAt: now,
    mergedPRs,
    prsNeedingResponse,
    dormantPRs,
    approachingDormant,
    newIssueCandidates: [],
    summary: {
      totalActivePRs: stats.activePRs,
      totalDormantPRs: stats.dormantPRs,
      totalMergedAllTime: stats.mergedPRs,
      mergeRate: parseFloat(stats.mergeRate),
    },
  };
}

function printDigest(digest: DailyDigest): void {
  console.log('═'.repeat(60));
  console.log('📋 DAILY STATUS REPORT');
  console.log(`Generated: ${new Date(digest.generatedAt).toLocaleString()}`);
  console.log('═'.repeat(60));

  if (digest.mergedPRs.length > 0) {
    console.log('\n🎉 MERGED PRs:');
    for (const pr of digest.mergedPRs) {
      console.log(`   ${pr.repo}#${pr.number} - ${pr.title}`);
    }
  }

  if (digest.prsNeedingResponse.length > 0) {
    console.log('\n💬 PRs NEEDING RESPONSE:');
    for (const pr of digest.prsNeedingResponse) {
      console.log(`   ${pr.repo}#${pr.number} - ${pr.title}`);
      console.log(`   └─ ${pr.url}`);
    }
  }

  if (digest.approachingDormant.length > 0) {
    console.log('\n⚠️ APPROACHING DORMANT (25+ days):');
    for (const pr of digest.approachingDormant) {
      console.log(`   ${pr.repo}#${pr.number} - ${pr.daysSinceActivity} days`);
    }
  }

  if (digest.dormantPRs.length > 0) {
    console.log('\n⏰ NEWLY DORMANT (30+ days):');
    for (const pr of digest.dormantPRs) {
      console.log(`   ${pr.repo}#${pr.number} - ${pr.title}`);
    }
  }

  console.log('\n📊 SUMMARY:');
  console.log(`   Active PRs: ${digest.summary.totalActivePRs}`);
  console.log(`   Dormant PRs: ${digest.summary.totalDormantPRs}`);
  console.log(`   Merged (all time): ${digest.summary.totalMergedAllTime}`);
  console.log(`   Merge Rate: ${digest.summary.mergeRate}%`);
  console.log('═'.repeat(60));
}

// Main entry point
async function main() {
  let command = process.argv[2] || 'help';

  // Handle version flags
  if (command === '-v' || command === '--version') {
    command = 'version';
  }

  if (command in commands) {
    try {
      await commands[command]();
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  } else {
    console.error(`Unknown command: ${command}`);
    await commands.help();
    process.exit(1);
  }
}

main();
