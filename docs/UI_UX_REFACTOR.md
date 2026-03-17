# UI/UX System Reference

Implementation rules for the current FGCU OCF dashboard UI. This document defines the active standard that new UI work must follow.

**Last Updated:** March 17, 2026
**Status:** Active

## 1. Visual Baseline

- Neutral SaaS dashboard surfaces are the default.
- FGCU green is the primary accent.
- FGCU blue is supportive, not dominant.
- FGCU gold is reserved for awards, honors, or other premium states.
- Typography must maintain a strong headline-to-meta hierarchy without becoming decorative.

## 2. Shared Layout Standards

### Shell

- Sidebar is deep-neutral with restrained branding.
- Top bar is a lighter supporting surface with minimal chrome.
- Main content should stay within a centered width and breathe vertically.

### Page Order

1. Page header
2. KPI strip if relevant
3. Toolbar, filters, or contextual controls
4. Primary content surface
5. Supporting sections or related content

### Detail Page Order

1. Entity header with status and actions
2. Summary metrics when relevant
3. Structured detail sections
4. Related records
5. Recent activity timeline

## 3. Shared UI Layer

These abstractions are the preferred way to build new dashboard UI:

- `AppCard`
- `StatCard`
- `PageSection`
- `DataToolbar`
- `EmptyState`
- `MetricBadge`
- `EntityHeader`
- `DetailSection`

If a page needs a new visual pattern, evaluate whether it belongs in one of these wrappers before creating page-local markup.

## 4. KPI And Summary Cards

- KPIs should foreground one number, one label, and at most one supporting line.
- Icons belong in compact colored wells, not oversized illustrations.
- Primary KPIs should be linkable when they represent drill-down destinations.
- Supporting metrics should feel quieter than top-line executive metrics.

## 5. Tables And Toolbars

- Search and filters should live together in a shared toolbar surface.
- Table row density should stay comfortable, never compressed by default.
- Hover states should be visible but subtle.
- Actions must remain consistently placed and accessible.
- Empty states must explain the absence of data and offer a next step where possible.

## 6. Analytics And Reports

- Dashboard and reports should explain what matters, not just expose raw counts.
- Group metrics into narratives such as pipeline, student profile, advising activity, and exceptions.
- Highlight follow-up opportunities explicitly.
- Charts should use restrained color and clear labels.

## 7. Motion And Loading

- Use motion to reinforce hierarchy and responsiveness.
- Prefer subtle CSS transitions for cards, rows, controls, and drawers.
- Skeleton states should resemble the final layout rather than generic blocks.

## 8. Documentation Rules

- Update this file and `docs/DESIGN_GUIDE.md` when the visual system changes.
- Update `README.md` when route descriptions or feature maturity change.
- Keep page-specific upgrade notes, such as `docs/STUDENTS_DASHBOARD_UPGRADE.md`, aligned with the current component system.
