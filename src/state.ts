/**
 * State management for the OSS Contribution Agent
 * Persists state to a JSON file for simplicity and version control
 */

import * as fs from 'fs';
import * as path from 'path';
import { AgentState, INITIAL_STATE, TrackedPR, TrackedIssue } from './types.js';

const STATE_FILE = path.join(process.cwd(), 'data', 'state.json');
const BACKUP_DIR = path.join(process.cwd(), 'data', 'backups');

export class StateManager {
  private state: AgentState;
  private readonly inMemoryOnly: boolean;

  constructor(inMemoryOnly = false) {
    this.inMemoryOnly = inMemoryOnly;
    this.state = inMemoryOnly ? this.createFreshState() : this.load();
  }

  /**
   * Create a fresh state with new array instances (deep copy)
   */
  private createFreshState(): AgentState {
    return {
      version: INITIAL_STATE.version,
      activePRs: [],
      activeIssues: [],
      dormantPRs: [],
      mergedPRs: [],
      closedPRs: [],
      config: {
        ...INITIAL_STATE.config,
        setupComplete: false,
        languages: [...INITIAL_STATE.config.languages],
        labels: [...INITIAL_STATE.config.labels],
        excludeRepos: [],
        trustedProjects: [],
      },
      lastRunAt: new Date().toISOString(),
    };
  }

  /**
   * Check if initial setup has been completed
   */
  isSetupComplete(): boolean {
    return this.state.config.setupComplete === true;
  }

  /**
   * Mark setup as complete
   */
  markSetupComplete(): void {
    this.state.config.setupComplete = true;
    this.state.config.setupCompletedAt = new Date().toISOString();
  }

  /**
   * Load state from file, or create initial state if none exists
   */
  private load(): AgentState {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = fs.readFileSync(STATE_FILE, 'utf-8');
        const state = JSON.parse(data) as AgentState;

        // Validate required fields exist
        if (!this.isValidState(state)) {
          console.error('Invalid state file structure, starting fresh');
          return this.createFreshState();
        }

        console.log(`Loaded state: ${state.activePRs.length} active PRs, ${state.mergedPRs.length} merged`);
        return state;
      }
    } catch (error) {
      console.error('Error loading state, starting fresh:', error);
    }

    console.log('No existing state found, initializing...');
    return this.createFreshState();
  }

  /**
   * Validate that a loaded state has the required structure
   */
  private isValidState(state: unknown): state is AgentState {
    if (!state || typeof state !== 'object') return false;
    const s = state as Record<string, unknown>;

    return (
      typeof s.version === 'number' &&
      Array.isArray(s.activePRs) &&
      Array.isArray(s.activeIssues) &&
      Array.isArray(s.dormantPRs) &&
      Array.isArray(s.mergedPRs) &&
      Array.isArray(s.closedPRs) &&
      typeof s.config === 'object' &&
      s.config !== null
    );
  }

  /**
   * Save current state to file with backup
   */
  save(): void {
    // Update lastRunAt
    this.state.lastRunAt = new Date().toISOString();

    // Skip file operations in in-memory mode
    if (this.inMemoryOnly) {
      return;
    }

    // Ensure directories exist
    const dataDir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    // Create backup of existing state
    if (fs.existsSync(STATE_FILE)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFile = path.join(BACKUP_DIR, `state-${timestamp}.json`);
      fs.copyFileSync(STATE_FILE, backupFile);

      // Keep only last 10 backups
      this.cleanupBackups();
    }

    // Save state
    fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    console.log('State saved successfully');
  }

  private cleanupBackups(): void {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('state-'))
      .sort()
      .reverse();

    // Keep only the 10 most recent backups
    files.slice(10).forEach(file => {
      fs.unlinkSync(path.join(BACKUP_DIR, file));
    });
  }

  /**
   * Get the current state (read-only)
   */
  getState(): Readonly<AgentState> {
    return this.state;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<AgentState['config']>): void {
    this.state.config = { ...this.state.config, ...config };
  }

  // === PR Management ===

  addActivePR(pr: TrackedPR): void {
    // Check if already exists
    const existing = this.state.activePRs.find(p => p.url === pr.url);
    if (existing) {
      console.log(`PR ${pr.url} already tracked`);
      return;
    }

    this.state.activePRs.push(pr);
    console.log(`Added active PR: ${pr.repo}#${pr.number}`);
  }

  updatePR(url: string, updates: Partial<TrackedPR>): void {
    const index = this.state.activePRs.findIndex(p => p.url === url);
    if (index !== -1) {
      this.state.activePRs[index] = { ...this.state.activePRs[index], ...updates };
    }
  }

  movePRToMerged(url: string): void {
    const index = this.state.activePRs.findIndex(p => p.url === url);
    if (index !== -1) {
      const pr = this.state.activePRs.splice(index, 1)[0];
      pr.status = 'merged';
      pr.mergedAt = new Date().toISOString();
      this.state.mergedPRs.push(pr);
      console.log(`PR merged: ${pr.repo}#${pr.number}`);
    }
  }

  movePRToClosed(url: string): void {
    const index = this.state.activePRs.findIndex(p => p.url === url);
    if (index !== -1) {
      const pr = this.state.activePRs.splice(index, 1)[0];
      pr.status = 'closed';
      pr.closedAt = new Date().toISOString();
      this.state.closedPRs.push(pr);
      console.log(`PR closed: ${pr.repo}#${pr.number}`);
    }
  }

  movePRToDormant(url: string): void {
    const index = this.state.activePRs.findIndex(p => p.url === url);
    if (index !== -1) {
      const pr = this.state.activePRs.splice(index, 1)[0];
      pr.activityStatus = 'dormant';
      this.state.dormantPRs.push(pr);
      console.log(`PR marked dormant: ${pr.repo}#${pr.number}`);
    }
  }

  reactivatePR(url: string): void {
    const index = this.state.dormantPRs.findIndex(p => p.url === url);
    if (index !== -1) {
      const pr = this.state.dormantPRs.splice(index, 1)[0];
      pr.activityStatus = 'active';
      this.state.activePRs.push(pr);
      console.log(`PR reactivated: ${pr.repo}#${pr.number}`);
    }
  }

  moveDormantPRToMerged(url: string): void {
    const index = this.state.dormantPRs.findIndex(p => p.url === url);
    if (index !== -1) {
      const pr = this.state.dormantPRs.splice(index, 1)[0];
      pr.status = 'merged';
      pr.mergedAt = new Date().toISOString();
      this.state.mergedPRs.push(pr);
      console.log(`Dormant PR merged: ${pr.repo}#${pr.number}`);
    }
  }

  moveDormantPRToClosed(url: string): void {
    const index = this.state.dormantPRs.findIndex(p => p.url === url);
    if (index !== -1) {
      const pr = this.state.dormantPRs.splice(index, 1)[0];
      pr.status = 'closed';
      pr.closedAt = new Date().toISOString();
      this.state.closedPRs.push(pr);
      console.log(`Dormant PR closed: ${pr.repo}#${pr.number}`);
    }
  }

  // === Issue Management ===

  addIssue(issue: TrackedIssue): void {
    const existing = this.state.activeIssues.find(i => i.url === issue.url);
    if (existing) {
      console.log(`Issue ${issue.url} already tracked`);
      return;
    }

    this.state.activeIssues.push(issue);
    console.log(`Added issue: ${issue.repo}#${issue.number}`);
  }

  updateIssue(url: string, updates: Partial<TrackedIssue>): void {
    const index = this.state.activeIssues.findIndex(i => i.url === url);
    if (index !== -1) {
      this.state.activeIssues[index] = { ...this.state.activeIssues[index], ...updates };
    }
  }

  removeIssue(url: string): void {
    const index = this.state.activeIssues.findIndex(i => i.url === url);
    if (index !== -1) {
      this.state.activeIssues.splice(index, 1);
    }
  }

  linkIssueToPR(issueUrl: string, prNumber: number): void {
    const issue = this.state.activeIssues.find(i => i.url === issueUrl);
    if (issue) {
      issue.linkedPRNumber = prNumber;
      issue.status = 'pr_submitted';
    }
  }

  // === Trusted Projects ===

  addTrustedProject(repo: string): void {
    if (!this.state.config.trustedProjects.includes(repo)) {
      this.state.config.trustedProjects.push(repo);
      console.log(`Added trusted project: ${repo}`);
    }
  }

  // === PR Utilities ===

  untrackPR(url: string): boolean {
    // Check active PRs
    let index = this.state.activePRs.findIndex(p => p.url === url);
    if (index !== -1) {
      const pr = this.state.activePRs.splice(index, 1)[0];
      console.log(`Untracked PR: ${pr.repo}#${pr.number}`);
      return true;
    }

    // Check dormant PRs
    index = this.state.dormantPRs.findIndex(p => p.url === url);
    if (index !== -1) {
      const pr = this.state.dormantPRs.splice(index, 1)[0];
      console.log(`Untracked dormant PR: ${pr.repo}#${pr.number}`);
      return true;
    }

    console.log(`PR not found: ${url}`);
    return false;
  }

  markPRAsRead(url: string): boolean {
    const pr = this.state.activePRs.find(p => p.url === url);
    if (pr) {
      pr.hasUnreadComments = false;
      pr.activityStatus = 'active';
      console.log(`Marked as read: ${pr.repo}#${pr.number}`);
      return true;
    }
    return false;
  }

  markAllPRsAsRead(): number {
    let count = 0;
    for (const pr of this.state.activePRs) {
      if (pr.hasUnreadComments) {
        pr.hasUnreadComments = false;
        pr.activityStatus = 'active';
        count++;
      }
    }
    console.log(`Marked ${count} PRs as read`);
    return count;
  }

  // === Statistics ===

  getStats() {
    // Merge rate = merged / (merged + closed + dormant)
    // Dormant PRs are effectively "pending" outcomes, but we include them
    // to show a conservative rate
    const completed = this.state.mergedPRs.length + this.state.closedPRs.length;
    const mergeRate = completed > 0
      ? (this.state.mergedPRs.length / completed) * 100
      : 0;

    return {
      activePRs: this.state.activePRs.length,
      dormantPRs: this.state.dormantPRs.length,
      mergedPRs: this.state.mergedPRs.length,
      closedPRs: this.state.closedPRs.length,
      activeIssues: this.state.activeIssues.length,
      trustedProjects: this.state.config.trustedProjects.length,
      mergeRate: mergeRate.toFixed(1) + '%',
      // Additional stats
      totalTracked: this.state.activePRs.length + this.state.dormantPRs.length +
                    this.state.mergedPRs.length + this.state.closedPRs.length,
      needsResponse: this.state.activePRs.filter(p => p.hasUnreadComments).length,
    };
  }
}

// Singleton instance
let stateManager: StateManager | null = null;

export function getStateManager(): StateManager {
  if (!stateManager) {
    stateManager = new StateManager();
  }
  return stateManager;
}

/**
 * Reset the singleton state manager (for testing)
 */
export function resetStateManager(): void {
  stateManager = null;
}
