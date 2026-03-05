# Dashboard Templates File Structure Analysis

## File Overview
- **Path**: `/Users/johncosta/dev/oss-autopilot/packages/core/src/commands/dashboard-templates.ts`
- **Total Lines**: 1,729
- **Exports**: 3 public exports (1 interface, 2 functions)
- **Current Consumers**:
  - `dashboard.ts` — imports `buildDashboardStats`, `generateDashboardHtml`
  - `dashboard-server.ts` — imports `buildDashboardStats`, `DashboardStats`
  - `dashboard-templates.test.ts` — imports all 3 exports

## Identified Natural Groupings

### GROUP 1: Types & Interfaces (Lines 1-23)
**Location**: Lines 9-23
**Exports**: 
- `DashboardStats` interface

**Contains**:
- DashboardStats type definition with fields: activePRs, shelvedPRs, mergedPRs, closedPRs, mergeRate

**Suggested Module**: `dashboard-stats.ts`

---

### GROUP 2: Utility Functions - Text Escaping (Lines 24-31)
**Location**: Lines 24-31
**Exports**:
- `escapeHtml()` function

**Contains**:
- XSS-prevention function that escapes HTML entities (&, <, >, ", ')

**Suggested Module**: `html-escape.ts`

---

### GROUP 3: Data Aggregation Functions (Lines 33-47)
**Location**: Lines 33-47
**Exports**:
- `buildDashboardStats()` function

**Contains**:
- Aggregates digest + state → DashboardStats object
- Computes: activePRs (from summary), shelvedPRs (array length), mergedPRs (from summary), closedPRs (from repoScores), mergeRate (formatted percentage)

**Suggested Module**: `dashboard-stats-builder.ts`

---

### GROUP 4: HTML Component Helpers (Lines 49-146)
**Location**: Lines 49-146 (inside generateDashboardHtml function)
**Internal Functions** (not exported):
- `truncateTitle()` — truncates strings to max length + ellipsis, escapes HTML
- `renderHealthItems()` — generic helper that renders PR status cards with icons/labels/metadata
- **SVG Constants** — SVG icon path definitions (comment, edit, xCircle, conflict, checklist, file, etc.) — 12 icon definitions
- `titleMeta()` — default metadata function (just calls truncateTitle)

**Contains**:
- All reusable HTML generation primitives
- Icon library (SVG paths)
- Data-driven template logic

**Suggested Module**: `dashboard-components.ts`

---

### GROUP 5: CSS & Theme Styling (Lines 158-918)
**Location**: Lines 158-918 (inside template literal)
**Contains**:
- Root CSS variables (light/dark theme definitions)
  - Color palette: `--bg-base`, `--bg-surface`, `--border`, `--text-primary`, `--accent-merged`, `--accent-open`, etc.
  - ~50+ CSS variable definitions
  - Light theme overrides (lines ~200-250)
- CSS class definitions for:
  - `.container`, `.header`, `.logo`, `.header-left`, `.header-right`
  - `.stat-card`, `.stat-value`, `.stat-label`
  - `.section`, `.section-title`, `.pr-item`, `.health-item`, `.health-icon`, `.health-content`, `.health-title`, `.health-meta`
  - `.chart-container`, `.timeline-container`
  - `.footer`, `.filter-group`, `.filter-select`
  - Status-specific classes (`.needs-response`, `.ci-failing`, `.conflict`, `.waiting-maintainer`, etc.)
  - Responsive/utility classes

**Suggested Module**: `dashboard-styles.ts` (export CSS string constant)

---

### GROUP 6: Main HTML Template Assembly (Lines 148-1448)
**Location**: Lines 148-1448 (the main return statement, ~1,300 lines)
**Contains**:
- DOCTYPE, html, head, title declarations
- Script src for Chart.js
- Style tag (references GROUP 5)
- Body structure:
  - Header with logo, title, theme toggle, filters
  - Stats cards section (using stats parameter)
  - "Action Required" PRs section (20 lines)
    - Calls renderHealthItems for: prsNeedingResponse, needsChangesPRs, ciFailingPRs, mergeConflictPRs, incompleteChecklistPRs, missingRequiredFilesPRs, needsRebasePRs
  - "Waiting on Others" section
    - Calls renderHealthItems for: changesAddressedPRs, waitingOnMaintainerPRs, ciBlockedPRs, ciNotRunningPRs
  - Recently merged/closed sections
  - Auto-unshelved PRs section
  - Shelved PRs section
  - Issue responses section
  - Repository stats section (uses repoScores aggregation)
  - Chart containers for: Repo stats, Monthly timeline

**Dependencies on earlier groups**:
- Uses `stats` (GROUP 3 output)
- Uses `renderHealthItems()`, `SVG`, `titleMeta()` (GROUP 4)
- Uses `CSS` (GROUP 5)
- Uses `escapeHtml()` (GROUP 2)

**Suggested Module**: Keep in current file or extract to `dashboard-template.ts` (the core render function)

---

### GROUP 7: JavaScript Runtime Code (Lines 1448-1729)
**Location**: Lines 1448-1729 (inside `<script>` tag)
**Contains**:
- Theme toggle logic (getEffectiveTheme, applyTheme)
- Filter logic (applyFilters, shouldExcludeRepo)
- Repository stats chart generation
- Monthly timeline chart generation
- Responsive behavior
- localStorage persistence (theme preference)

**Suggested Module**: `dashboard-client.ts` or `dashboard-script.ts` (export JS string constant)

---

## Recommended Modularization Strategy

### Phase 1: Extract Utilities
1. **`dashboard-html-escape.ts`** — escapeHtml function (can be used elsewhere)
2. **`dashboard-stats.ts`** — DashboardStats interface
3. **`dashboard-stats-builder.ts`** — buildDashboardStats function

### Phase 2: Extract Styling & Components
4. **`dashboard-components.ts`** — renderHealthItems, SVG icons, component helpers
5. **`dashboard-styles.ts`** — CSS string constant

### Phase 3: Extract Scripts
6. **`dashboard-client-script.ts`** — JavaScript runtime code (theme, filters, charts)

### Phase 4: Keep as Main Template
7. **`dashboard-templates.ts`** (refactored) — Main generateDashboardHtml function + composition logic

## Import Dependencies
- Only imports from `'../core/types.js'` (no circular dependency risk)
- Currently a pure module (no side effects, all data passed as arguments)

## Test Coverage
- `dashboard-templates.test.ts` has comprehensive tests:
  - escapeHtml: 9 test cases (XSS prevention, edge cases)
  - buildDashboardStats: 9 test cases (stat aggregation)
  - generateDashboardHtml: 28 test cases (rendering, escaping, completeness)
