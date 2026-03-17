# FGCU OCF Product Design Guide

Source-of-truth visual rules for the FGCU Office of Competitive Fellowships Data Platform.

## 1. Product Direction

The application is an internal operations dashboard, not a public university marketing site. The UI should feel like a refined SaaS admin product with FGCU brand cues used selectively.

### Core Position

- Neutral, light content surfaces
- Deep-neutral sidebar and shell chrome
- FGCU green for primary actions and active states
- FGCU blue as a secondary accent for supportive information
- FGCU gold reserved for awards, highlights, and limited emphasis states
- Strong editorial hierarchy with restrained motion and generous spacing

### What To Avoid

- Green-dominant layouts that make the shell visually heavier than the content
- Mixing institutional brochure patterns into data-heavy dashboard screens
- Using gold as a general-purpose accent
- Rebuilding common page structures from scratch instead of using shared primitives

## 2. Color System

### Brand Anchors

| Token | Hex | Purpose |
| ---- | ---- | ---- |
| FGCU Green | `#006747` | Primary CTAs, active nav state, success emphasis |
| FGCU Green Dark | `#00563b` | Primary hover and pressed states |
| FGCU Blue | `#003B5C` | Secondary accents and informational highlights |
| FGCU Gold | `#C99700` | Awards, premium highlights, notable achievements |

### Product Neutrals

| Token | Usage |
| ---- | ---- |
| Background | Warm, very light app canvas |
| Surface Subtle | Secondary panels, KPI wells, low-emphasis sections |
| Card | Primary content surfaces |
| Border | Soft panel separation |
| Foreground | High-contrast text |
| Muted Foreground | Descriptions, meta, and table helper text |

### Usage Rules

- Use FGCU green for primary buttons, active nav states, selection accents, focus rings, and high-confidence positive signals.
- Use FGCU blue for secondary actions, supportive chart accents, and contextual information where green would imply action.
- Use gold only for awards, honors, or premium emphasis states.
- Prefer neutral backgrounds over tinted backgrounds for most layouts.

## 3. Typography

### Families

- Headings: Merriweather, Georgia, serif fallback
- Body: Open Sans, Roboto, sans-serif fallback

### Hierarchy

- Page title: `text-3xl` on desktop and `text-2xl` on smaller screens
- Section title: `text-lg` to `text-xl`, `font-semibold`
- Body text: `text-sm` to `text-base`
- Meta text: `text-xs` to `text-sm`, muted foreground
- Kicker text: uppercase, high tracking, small size, FGCU green

## 4. Layout Rules

### Dashboard Shell

- Sidebar: deep-neutral, visually quiet, accent only on active states
- Top bar: light surface, subtle border, optional contextual metadata
- Main content: centered, generous breathing room, maximum width around `max-w-7xl`

### Page Rhythm

Use this order whenever the route supports it:

1. Page header
2. KPI strip or summary row
3. Toolbar or supporting controls
4. Primary content surface
5. Secondary or supporting sections

### Detail Page Rhythm

1. Entity header with actions and badges
2. Summary metrics when relevant
3. Structured detail sections
4. Related records
5. Recent activity or timeline

## 5. Shared Components

All new dashboard work should prefer shared wrappers over raw ad hoc `Card` usage.

- `AppCard`: default content surface
- `StatCard`: KPI and executive metrics
- `PageSection`: section heading plus actions and content grouping
- `EmptyState`: reusable empty-state treatment
- `MetricBadge`: semantic chip for low-friction status and count labels
- `EntityHeader`: detail-page summary block
- `DetailSection`: standard detail-page content block
- `DataToolbar`: list-page search, filters, and actions container
- `ListPageLoading`: shared skeleton baseline for CRUD and roster pages with KPI strips and toolbars

## 6. Tables And Data Views

- Use spacious row padding and strong left alignment.
- Reserve color for status and emphasis, not for every value.
- Prefer subtle row hover states and clear action affordances.
- Keep table headers compact and highly scannable.
- Default table actions should visually align across routes.

## 7. Charts And Analytics

- Analytics should feel calm and executive, not flashy.
- Use bar, area, and line charts before donut charts.
- Prefer 2 to 4 chart colors in a single view.
- Chart legends and helper text must explain the metric narrative.
- Every chart should degrade to a sensible empty state.

## 8. Motion And Interaction

- Use motion only to reinforce hierarchy and responsiveness.
- Prioritize hover refinement, loading polish, and dialog or drawer transitions.
- Prefer `motion-safe:` transition utilities on shell controls, cards, and table rows so reduced-motion preferences are respected by default.
- Avoid decorative animation loops.
- Focus states must remain visible and consistent.

## 9. Accessibility And Responsiveness

- Every color treatment must preserve legibility.
- Desktop density should not collapse into cramped mobile layouts.
- Toolbars must stack cleanly on small screens.
- Tables must preserve critical information at narrower breakpoints.
- When tables become too dense for smaller screens, replace them with stacked summary cards instead of relying on horizontal scroll alone.

## 10. Implementation Notes

- Global visual tokens live in `app/globals.css`.
- Shared shell components live in `components/layout`.
- Shared primitives live in `components/ui`.
- Shared route-level loading states live alongside their routes under `app/(dashboard)/**/loading.tsx` and should mirror the final layout shape.
- When design rules change, update this guide and `docs/UI_UX_REFACTOR.md` in the same pull request.
