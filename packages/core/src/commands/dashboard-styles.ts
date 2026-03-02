/**
 * Dashboard CSS styles: theme variables, layout, component styles.
 * Extracted from dashboard-templates.ts for maintainability.
 */

export const DASHBOARD_CSS = `
    :root, [data-theme="dark"] {
      --bg-base: #080b10;
      --bg-surface: rgba(22, 27, 34, 0.65);
      --bg-elevated: rgba(28, 33, 40, 0.8);
      --border: rgba(48, 54, 61, 0.6);
      --border-muted: rgba(33, 38, 45, 0.5);
      --text-primary: #e6edf3;
      --text-secondary: #8b949e;
      --text-muted: #6e7681;
      --accent-merged: #a855f7;
      --accent-merged-dim: rgba(168, 85, 247, 0.12);
      --accent-open: #3fb950;
      --accent-open-dim: rgba(63, 185, 80, 0.12);
      --accent-warning: #d29922;
      --accent-warning-dim: rgba(210, 153, 34, 0.12);
      --accent-error: #f85149;
      --accent-error-dim: rgba(248, 81, 73, 0.10);
      --accent-conflict: #da3633;
      --accent-info: #58a6ff;
      --accent-info-dim: rgba(88, 166, 255, 0.08);
      --chart-border: rgba(8, 11, 16, 0.8);
      --chart-grid: rgba(48, 54, 61, 0.3);
      --scrollbar-track: rgba(28, 33, 40, 0.8);
      --scrollbar-thumb: rgba(48, 54, 61, 0.6);
    }

    [data-theme="light"] {
      --bg-base: #f6f8fa;
      --bg-surface: rgba(255, 255, 255, 0.85);
      --bg-elevated: rgba(246, 248, 250, 0.95);
      --border: rgba(208, 215, 222, 0.6);
      --border-muted: rgba(216, 222, 228, 0.5);
      --text-primary: #1f2328;
      --text-secondary: #656d76;
      --text-muted: #8b949e;
      --accent-merged: #8250df;
      --accent-merged-dim: rgba(130, 80, 223, 0.1);
      --accent-open: #1a7f37;
      --accent-open-dim: rgba(26, 127, 55, 0.1);
      --accent-warning: #9a6700;
      --accent-warning-dim: rgba(154, 103, 0, 0.1);
      --accent-error: #cf222e;
      --accent-error-dim: rgba(207, 34, 46, 0.08);
      --accent-conflict: #cf222e;
      --accent-info: #0969da;
      --accent-info-dim: rgba(9, 105, 218, 0.08);
      --chart-border: rgba(255, 255, 255, 0.8);
      --chart-grid: rgba(208, 215, 222, 0.4);
      --scrollbar-track: rgba(246, 248, 250, 0.95);
      --scrollbar-thumb: rgba(208, 215, 222, 0.6);
    }

    @media (prefers-color-scheme: light) {
      :root:not([data-theme="dark"]) {
        --bg-base: #f6f8fa;
        --bg-surface: rgba(255, 255, 255, 0.85);
        --bg-elevated: rgba(246, 248, 250, 0.95);
        --border: rgba(208, 215, 222, 0.6);
        --border-muted: rgba(216, 222, 228, 0.5);
        --text-primary: #1f2328;
        --text-secondary: #656d76;
        --text-muted: #8b949e;
        --accent-merged: #8250df;
        --accent-merged-dim: rgba(130, 80, 223, 0.1);
        --accent-open: #1a7f37;
        --accent-open-dim: rgba(26, 127, 55, 0.1);
        --accent-warning: #9a6700;
        --accent-warning-dim: rgba(154, 103, 0, 0.1);
        --accent-error: #cf222e;
        --accent-error-dim: rgba(207, 34, 46, 0.08);
        --accent-conflict: #cf222e;
        --accent-info: #0969da;
        --accent-info-dim: rgba(9, 105, 218, 0.08);
        --chart-border: rgba(255, 255, 255, 0.8);
        --chart-grid: rgba(208, 215, 222, 0.4);
        --scrollbar-track: rgba(246, 248, 250, 0.95);
        --scrollbar-thumb: rgba(208, 215, 222, 0.6);
      }
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Geist', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg-base);
      color: var(--text-primary);
      min-height: 100vh;
      line-height: 1.5;
      overflow-x: hidden;
    }

    body::before {
      content: '';
      position: fixed;
      top: -20%; left: -10%;
      width: 60%; height: 60%;
      background: radial-gradient(ellipse, rgba(88, 166, 255, 0.06) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }

    body::after {
      content: '';
      position: fixed;
      bottom: -20%; right: -10%;
      width: 50%; height: 50%;
      background: radial-gradient(ellipse, rgba(168, 85, 247, 0.05) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }

    [data-theme="light"] body::before,
    [data-theme="light"] body::after {
      display: none;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 2rem;
      position: relative;
      z-index: 1;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1.5rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border-muted);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .logo {
      width: 44px;
      height: 44px;
      background: linear-gradient(135deg, var(--accent-info) 0%, var(--accent-merged) 50%, #f778ba 100%);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5rem;
      box-shadow: 0 0 24px rgba(168, 85, 247, 0.3), 0 0 48px rgba(88, 166, 255, 0.15);
    }

    .header h1 {
      font-size: 1.75rem;
      font-weight: 600;
      letter-spacing: -0.02em;
      background: linear-gradient(135deg, var(--text-primary) 0%, var(--text-secondary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .header-subtitle {
      font-family: 'Geist Mono', monospace;
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    .timestamp {
      font-family: 'Geist Mono', monospace;
      font-size: 0.8rem;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .timestamp::before {
      content: '';
      width: 8px;
      height: 8px;
      background: var(--accent-open);
      border-radius: 50%;
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(35, 134, 54, 0.4); }
      50% { opacity: 0.8; box-shadow: 0 0 0 8px rgba(35, 134, 54, 0); }
    }

    .stats-grid {
      display: flex;
      background: var(--bg-surface);
      border: 1px solid var(--border-muted);
      border-radius: 12px;
      margin-bottom: 1.5rem;
      overflow: hidden;
    }

    @media (max-width: 768px) {
      .stats-grid { flex-wrap: wrap; }
      .stat-card { flex: 1 1 33%; }
    }

    .stat-card {
      flex: 1;
      padding: 1rem 1.25rem;
      position: relative;
      transition: background 0.2s ease;
    }

    .stat-card + .stat-card {
      border-left: 1px solid var(--border-muted);
    }

    .stat-card:hover {
      background: rgba(255, 255, 255, 0.02);
    }

    .stat-card::after {
      content: '';
      position: absolute;
      bottom: 0; left: 0.75rem; right: 0.75rem;
      height: 2px;
      background: var(--accent-color, var(--border));
      border-radius: 2px;
      opacity: 0.7;
    }

    .stat-card.active { --accent-color: var(--accent-open); }
    .stat-card.merged { --accent-color: var(--accent-merged); }
    .stat-card.closed { --accent-color: var(--text-muted); }
    .stat-card.rate { --accent-color: var(--accent-info); }

    .stat-value {
      font-family: 'Geist Mono', monospace;
      font-size: 1.75rem;
      font-weight: 600;
      line-height: 1;
      margin-bottom: 0.25rem;
    }

    .stat-card.active .stat-value { color: var(--accent-open); }
    .stat-card.merged .stat-value { color: var(--accent-merged); }
    .stat-card.closed .stat-value { color: var(--text-muted); }
    .stat-card.rate .stat-value { color: var(--accent-info); }

    .stat-label {
      font-size: 0.7rem;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .health-section {
      background: var(--bg-surface);
      border: 1px solid var(--border-muted);
      border-radius: 10px;
      padding: 1.25rem;
      margin-bottom: 1.25rem;
    }

    .health-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1rem;
    }

    .health-header h2 {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .health-badge {
      font-family: 'Geist Mono', monospace;
      font-size: 0.7rem;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      background: var(--accent-error-dim);
      color: var(--accent-error);
    }

    .health-items {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 0.75rem;
    }

    .health-item {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      background: var(--bg-elevated);
      border-radius: 8px;
      border-left: 3px solid;
      transition: transform 0.15s ease;
    }

    .health-item:hover { transform: translateX(4px); }

    .health-item.ci-failing {
      border-left-color: var(--accent-error);
      background: var(--accent-error-dim);
    }

    .health-item.conflict {
      border-left-color: var(--accent-conflict);
      background: rgba(218, 54, 51, 0.1);
    }

    .health-item.incomplete-checklist {
      border-left-color: var(--accent-info);
    }
    .health-item.needs-response,
    .health-item.needs-changes {
      border-left-color: var(--accent-warning);
      background: var(--accent-warning-dim);
    }

    .health-item.changes-addressed,
    .health-item.waiting-maintainer {
      border-left-color: var(--accent-info);
      background: var(--accent-info-dim);
    }

    .health-item.ci-not-running {
      border-left-color: var(--text-muted);
      background: rgba(110, 118, 129, 0.1);
    }

    .health-item.missing-files {
      border-left-color: var(--accent-warning);
      background: var(--accent-warning-dim);
    }

    .health-item.ci-blocked {
      border-left-color: var(--text-muted);
      background: rgba(110, 118, 129, 0.1);
    }

    .health-item.needs-rebase {
      border-left-color: var(--accent-warning);
      background: var(--accent-warning-dim);
    }

    .health-item.shelved {
      border-left-color: var(--text-muted);
      background: rgba(110, 118, 129, 0.06);
      opacity: 0.6;
    }

    .health-item.shelved .health-icon { background: rgba(110, 118, 129, 0.12); color: var(--text-muted); }

    .health-item.auto-unshelved {
      border-left-color: var(--accent-info);
      background: var(--accent-info-dim);
    }

    .health-item.auto-unshelved .health-icon { background: var(--accent-info-dim); color: var(--accent-info); }

    .stat-card.shelved { --accent-color: var(--text-muted); }
    .stat-card.shelved .stat-value { color: var(--text-muted); }

    .waiting-section {
      border-color: rgba(88, 166, 255, 0.2);
    }

    .health-icon {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1rem;
      flex-shrink: 0;
    }

    .health-item.ci-failing .health-icon { background: var(--accent-error-dim); color: var(--accent-error); }
    .health-item.conflict .health-icon { background: rgba(218, 54, 51, 0.15); color: var(--accent-conflict); }
    .health-item.incomplete-checklist .health-icon { background: var(--accent-info-dim); color: var(--accent-info); }
    .health-item.needs-response .health-icon,
    .health-item.needs-changes .health-icon { background: var(--accent-warning-dim); color: var(--accent-warning); }
    .health-item.changes-addressed .health-icon,
    .health-item.waiting-maintainer .health-icon { background: var(--accent-info-dim); color: var(--accent-info); }
    .health-item.ci-not-running .health-icon { background: rgba(110, 118, 129, 0.15); color: var(--text-muted); }
    .health-item.missing-files .health-icon { background: var(--accent-warning-dim); color: var(--accent-warning); }
    .health-item.ci-blocked .health-icon { background: rgba(110, 118, 129, 0.15); color: var(--text-muted); }
    .health-item.needs-rebase .health-icon { background: var(--accent-warning-dim); color: var(--accent-warning); }

    .health-content { flex: 1; min-width: 0; }

    .health-title {
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .health-title a { color: inherit; text-decoration: none; }
    .health-title a:hover { color: var(--accent-info); }

    .health-meta {
      font-family: 'Geist Mono', monospace;
      font-size: 0.7rem;
      color: var(--text-muted);
    }

    .health-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
      color: var(--text-muted);
      font-size: 0.9rem;
    }

    .health-empty::before {
      content: '\\2713';
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      background: var(--accent-open-dim);
      color: var(--accent-open);
      border-radius: 50%;
      margin-right: 0.75rem;
      font-weight: bold;
    }

    .main-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.25rem;
      margin-bottom: 1.25rem;
    }

    @media (max-width: 1024px) { .main-grid { grid-template-columns: 1fr; } }

    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border-muted);
      border-radius: 10px;
      overflow: hidden;
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1.125rem;
      border-bottom: 1px solid var(--border-muted);
    }

    .card-title {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .card-body { padding: 1rem 1.125rem; }

    .chart-container {
      position: relative;
      height: 260px;
    }

    .pr-list-section {
      background: var(--bg-surface);
      border: 1px solid var(--border-muted);
      border-radius: 10px;
      overflow: hidden;
    }

    .pr-list-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1.125rem;
      border-bottom: 1px solid var(--border-muted);
    }

    .pr-list-title {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .pr-count {
      font-family: 'Geist Mono', monospace;
      font-size: 0.75rem;
      padding: 0.25rem 0.5rem;
      background: var(--accent-open-dim);
      color: var(--accent-open);
      border-radius: 4px;
    }

    .pr-list {
      max-height: 600px;
      overflow-y: auto;
    }

    .pr-list::-webkit-scrollbar { width: 6px; }
    .pr-list::-webkit-scrollbar-track { background: var(--scrollbar-track, var(--bg-elevated)); }
    .pr-list::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb, var(--border)); border-radius: 3px; }

    .pr-item {
      display: flex;
      align-items: flex-start;
      gap: 1rem;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--border-muted);
      transition: background 0.15s ease;
    }

    .pr-item:last-child { border-bottom: none; }
    .pr-item:hover { background: var(--bg-elevated); }

    .pr-status-indicator {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 1.1rem;
      background: var(--accent-open-dim);
      color: var(--accent-open);
    }

    .pr-item.has-issues .pr-status-indicator {
      background: var(--accent-error-dim);
      color: var(--accent-error);
      animation: attention-pulse 2s ease-in-out infinite;
    }

    .pr-item.stale .pr-status-indicator {
      background: var(--accent-warning-dim);
      color: var(--accent-warning);
    }

    @keyframes attention-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(248, 81, 73, 0.4); }
      50% { box-shadow: 0 0 0 6px rgba(248, 81, 73, 0); }
    }

    .pr-content { flex: 1; min-width: 0; }

    .pr-title-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.25rem;
    }

    .pr-title {
      font-size: 0.9rem;
      font-weight: 500;
      color: var(--text-primary);
      text-decoration: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .pr-title:hover { color: var(--accent-info); }

    .pr-repo {
      font-family: 'Geist Mono', monospace;
      font-size: 0.75rem;
      color: var(--text-muted);
      flex-shrink: 0;
    }

    .pr-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .badge {
      font-family: 'Geist Mono', monospace;
      font-size: 0.65rem;
      font-weight: 500;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .badge-ci-failing { background: var(--accent-error-dim); color: var(--accent-error); }
    .badge-conflict { background: rgba(218, 54, 51, 0.15); color: var(--accent-conflict); }
    .badge-needs-response { background: var(--accent-warning-dim); color: var(--accent-warning); }
    .badge-stale { background: var(--accent-warning-dim); color: var(--accent-warning); }
    .badge-passing { background: var(--accent-open-dim); color: var(--accent-open); }
    .badge-pending { background: var(--accent-info-dim); color: var(--accent-info); }
    .badge-days { background: var(--bg-elevated); color: var(--text-muted); }
    .badge-changes-requested { background: var(--accent-warning-dim); color: var(--accent-warning); }
    .badge-changes-addressed { background: var(--accent-info-dim); color: var(--accent-info); }

    .pr-activity {
      font-family: 'Geist Mono', monospace;
      font-size: 0.7rem;
      color: var(--text-muted);
      margin-left: auto;
      text-align: right;
      flex-shrink: 0;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 3rem;
      color: var(--text-muted);
    }

    .empty-state-icon {
      font-size: 2.5rem;
      margin-bottom: 1rem;
      opacity: 0.5;
    }

    .footer {
      text-align: center;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border-muted);
      margin-top: 1.5rem;
    }

    .footer p {
      font-family: 'Geist Mono', monospace;
      font-size: 0.7rem;
      color: var(--text-muted);
    }

    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .stats-grid, .health-section, .pr-list-section {
      animation: fadeInUp 0.35s ease;
    }

    .theme-toggle {
      background: var(--bg-elevated);
      border: 1px solid var(--border-muted);
      border-radius: 8px;
      padding: 0.4rem 0.6rem;
      cursor: pointer;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      gap: 0.4rem;
      font-family: 'Geist Mono', monospace;
      font-size: 0.7rem;
      transition: background 0.2s ease, color 0.2s ease;
    }

    .theme-toggle:hover {
      background: var(--bg-surface);
      color: var(--text-primary);
    }

    .theme-toggle svg { flex-shrink: 0; }

    .header-controls {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .filter-toolbar {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      background: var(--bg-surface);
      border: 1px solid var(--border-muted);
      border-radius: 10px;
      margin-bottom: 1.25rem;
      flex-wrap: wrap;
    }

    .filter-toolbar label {
      font-family: 'Geist Mono', monospace;
      font-size: 0.7rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      flex-shrink: 0;
    }

    .filter-search {
      flex: 1;
      min-width: 180px;
      padding: 0.4rem 0.75rem;
      background: var(--bg-elevated);
      border: 1px solid var(--border-muted);
      border-radius: 6px;
      color: var(--text-primary);
      font-family: 'Geist', sans-serif;
      font-size: 0.8rem;
      outline: none;
      transition: border-color 0.2s ease;
    }

    .filter-search:focus {
      border-color: var(--accent-info);
    }

    .filter-search::placeholder {
      color: var(--text-muted);
    }

    .filter-select {
      padding: 0.4rem 0.75rem;
      background: var(--bg-elevated);
      border: 1px solid var(--border-muted);
      border-radius: 6px;
      color: var(--text-primary);
      font-family: 'Geist', sans-serif;
      font-size: 0.8rem;
      outline: none;
      cursor: pointer;
      transition: border-color 0.2s ease;
    }

    .filter-select:focus {
      border-color: var(--accent-info);
    }

    .filter-count {
      font-family: 'Geist Mono', monospace;
      font-size: 0.7rem;
      color: var(--text-muted);
      margin-left: auto;
      flex-shrink: 0;
    }

    .pr-item[data-hidden="true"],
    .health-item[data-hidden="true"] {
      display: none;
    }
`;
