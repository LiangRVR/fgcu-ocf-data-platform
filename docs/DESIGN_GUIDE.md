# FGCU Design Style Guide

Official design system and style guide for the FGCU OCF Data Platform.

## 1. FGCU Core Color Palette

FGCU uses a green + blue + gold brand identity. The dominant color is the university green.

### Primary Colors

| Color | Hex | Usage |
|-------|-----|-------|
| FGCU Green | `#006747` | Main brand color, headers, navbars |
| FGCU Blue | `#003B5C` | Secondary accent |
| FGCU Gold | `#C99700` | Highlights, call-to-action elements |

### Supporting Neutral Colors

| Color | Hex | Usage |
|-------|-----|-------|
| Dark Gray | `#333333` | Body text |
| Medium Gray | `#6B7280` | Secondary text |
| Light Gray | `#F3F4F6` | Background sections |
| White | `#FFFFFF` | Cards, page background |

### Tailwind Configuration

```typescript
colors: {
  fgcu: {
    green: {
      DEFAULT: "#006747",
      dark: "#00563b"
    },
    blue: "#003B5C",
    gold: "#C99700"
  }
}
```

### Color Usage Guidelines

#### Green
- Header
- Navigation bars
- Section headers
- Primary buttons
- Sidebar background

#### Blue
- Sub navigation
- Footer accents
- Link hover states
- Active navigation items

#### Gold
- Highlights
- Important CTAs
- Icons / badges
- Accent elements

## 2. Typography Style

FGCU uses clean academic typography with a combination of serif headings and sans-serif body text.

### Headings

**Font Family:**
- Merriweather (preferred)
- Georgia (fallback)

**Style:**
- `font-weight: 700`
- Slight letter-spacing
- Clear hierarchy (H1 → H6)

### Body Text

**Font Family:**
- Open Sans (preferred)
- Roboto
- Source Sans Pro

**Style:**
- `font-weight: 400` (regular)
- Comfortable line-height (1.6-1.8)
- Readable font size (16px base)

### Tailwind Configuration

```typescript
fontFamily: {
  heading: ["Merriweather", "Georgia", "serif"],
  body: ["Open Sans", "Roboto", "sans-serif"]
}
```

## 3. Layout & Design System

FGCU sites follow a structured university layout with emphasis on clarity and professionalism.

### Structure Pattern

```
┌─ Header ────────────────────────────┐
├─ Navigation Bar ────────────────────┤
├─ Hero Banner (optional) ────────────┤
├─ Content Sections ──────────────────┤
│  └─ Cards / Content Blocks          │
└─ Footer ────────────────────────────┘
```

### Content Grid

Most pages use:
- `max-width: 1200px`
- Centered container
- Large white margins
- Responsive padding

```css
.container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px;
}
```

## 4. UI Components

### Navigation

**Style:**
- Large horizontal nav (or vertical sidebar for dashboards)
- Dropdown menus
- Sticky header
- `background: FGCU green`
- `text: white`

### Buttons

#### Primary Button
```css
background: #006747 (FGCU green)
color: white
border-radius: 6px
padding: 12px 24px
```

#### Secondary Button
```css
border: 1px solid #006747 (FGCU green)
color: #006747
background: white
border-radius: 6px
padding: 12px 24px
```

#### Accent Button
```css
background: #C99700 (FGCU gold)
color: black
border-radius: 6px
padding: 12px 24px
```

### Cards

Used everywhere for departments, programs, events, and data display.

**Style:**
```css
background: white
border: 1px solid #E5E7EB (light gray)
border-radius: 8px
box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1)
padding: 24px
```

### Hero Sections

**Style:**
- Large photo background
- Dark overlay (rgba(0, 0, 0, 0.5))
- White title text
- `height: 400–600px`
- Centered text

## 5. Iconography

**Style Guidelines:**
- Simple line icons
- Academic / institutional style
- Minimal color
- Consistent stroke width

**Recommended Libraries:**
- `lucide-react` (preferred)
- `heroicons`

## 6. Spacing & Visual Density

FGCU sites emphasize spaciousness and readability.

### Typical Spacing

- **Section padding:** `64px` (vertical)
- **Card padding:** `24px`
- **Grid gap:** `32px`
- **Element spacing:** `16px` (standard), `24px` (comfortable)

### Tailwind Spacing Scale

```typescript
spacing: {
  'xs': '8px',
  'sm': '16px',
  'md': '24px',
  'lg': '32px',
  'xl': '48px',
  '2xl': '64px'
}
```

## 7. OCF Dashboard Design Direction

Since the OCF Data Platform is an internal dashboard, the design should be:

### Layout Structure

```
┌─ Sidebar (FGCU green) ─┬─ Topbar (white) ──────────────┐
│                         ├─ Content Area ─────────────────┤
│  Navigation Items       │                                │
│  (white text)           │  Cards (white background)      │
│                         │  Light gray page background    │
│  Active: FGCU blue bg   │                                │
└─────────────────────────┴────────────────────────────────┘
```

### Component Styling

#### Sidebar
- `background: FGCU green (#006747)`
- `text: white`
- Active item: `background: FGCU blue (#003B5C)`

#### Topbar
- `background: white`
- `border-bottom: 1px solid light gray`

#### Content Area
- `background: light gray (#F3F4F6)`
- Cards on white background

#### Primary Actions
- FGCU green button (`#006747`)

#### Highlights & Badges
- FGCU gold (`#C99700`)

## 8. Design Philosophy

**FGCU design is:** Academic + Professional + Clean

### Key Characteristics

✓ Strong institutional colors
✓ Minimalistic UI
✓ Spacious layout
✓ Large readable typography
✓ Card-based sections
✓ Clear information hierarchy
✓ Accessible and inclusive

## 9. Implementation Stack

**Recommended Technologies:**
- Next.js (framework)
- Tailwind CSS (styling)
- shadcn/ui (component library)
- lucide-react (icons)
- FGCU custom theme

## 10. Accessibility Standards

FGCU is committed to accessibility (WCAG 2.1 AA compliance):

- Sufficient color contrast ratios
- Keyboard navigation support
- Screen reader compatibility
- Focus indicators on interactive elements
- Semantic HTML structure
- Alt text for images
- ARIA labels where appropriate

## References

- [FGCU Official Website](https://www.fgcu.edu)
- [FGCU Brand Guidelines](https://www.fgcu.edu/brand)
- [Web Content Accessibility Guidelines (WCAG)](https://www.w3.org/WAI/WCAG21/quickref/)

---

**Last Updated:** March 5, 2026
**Version:** 1.0.0
