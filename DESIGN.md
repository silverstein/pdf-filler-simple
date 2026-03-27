# PDF Tools — Design System

This document defines the visual language for PDF Tools' MCP App UI.
All UI decisions calibrate against this file.

## Classification

**App UI** — workspace-driven, task-focused. Not a marketing site.
Calm surface hierarchy, dense but readable, utility language, minimal chrome.

## Theme

PDF Tools inherits its theme from the host (Claude Desktop) via the ext-apps SDK:
- `applyDocumentTheme()` — applies dark/light mode
- `applyHostStyleVariables()` — provides CSS custom properties

### CSS Custom Properties (from host)

| Token | Usage |
|---|---|
| `var(--background)` | Main background |
| `var(--surface)` | Card/panel background |
| `var(--surface-secondary)` | Secondary surfaces (thumbnail placeholder, skeleton) |
| `var(--text-primary)` | Primary text |
| `var(--text-secondary)` | Secondary text, labels |
| `var(--accent)` | Selection, focus ring, primary actions |
| `var(--border)` | Subtle borders, dividers |
| `var(--error)` | Error states |
| `var(--success)` | Success states |

### Fallback Colors (if host tokens unavailable)

| Token | Light | Dark |
|---|---|---|
| background | `#ffffff` | `#1a1a1a` |
| surface | `#f5f5f5` | `#2a2a2a` |
| surface-secondary | `#ebebeb` | `#333333` |
| text-primary | `#1a1a1a` | `#e5e5e5` |
| text-secondary | `#666666` | `#999999` |
| accent | `#2563eb` | `#3b82f6` |
| border | `#e0e0e0` | `#404040` |
| error | `#dc2626` | `#ef4444` |
| success | `#16a34a` | `#22c55e` |

## Typography

- **Primary font**: System font stack (inherited from host)
- **Monospace**: `ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', monospace`
- **Page numbers**: Monospace, 11px, `var(--text-secondary)`
- **Toolbar labels**: System, 13px, `var(--text-primary)`
- **Badge text**: Monospace, 10px, white on accent background
- **Status messages**: System, 12px, `var(--text-secondary)`

## Spacing

| Token | Value | Usage |
|---|---|---|
| `--space-xs` | `4px` | Badge padding, icon gaps |
| `--space-sm` | `8px` | Thumbnail inner padding, toolbar gaps |
| `--space-md` | `12px` | Grid gap between thumbnails |
| `--space-lg` | `16px` | Section padding, toolbar padding |
| `--space-xl` | `24px` | Mode section padding |

## Components

### Thumbnail

- **Width**: 120px (responsive: fills available columns, min 100px, max 180px)
- **Aspect ratio**: Matches original page (letter = 8.5:11, A4 = 1:1.414)
- **Border**: 1px `var(--border)`, subtle shadow (`0 1px 3px rgba(0,0,0,0.1)`)
- **Border radius**: 2px (subtle, not bubbly)
- **Page number**: Bottom-left, monospace 11px, `var(--text-secondary)`, 4px padding
- **Hover**: Brightness increase (`filter: brightness(1.05)`), action icons fade in top-right
- **Selected**: 2px solid `var(--accent)` border, checkbox overlay top-left
- **Deleted**: Strikethrough line across center, 50% opacity
- **Rotated**: Small badge bottom-right: "↻90°" in monospace 10px, accent background, white text
- **Drag preview**: 80% opacity, slight scale (1.02), elevated shadow
- **Placeholder** (lazy): `var(--surface-secondary)` fill, matching aspect ratio, no spinner until in viewport

### Toolbar

- **Height**: 40px
- **Background**: `var(--surface)`
- **Border**: 1px bottom `var(--border)`
- **Mode tabs**: Text tabs with underline indicator on active. "📄 View" / "▦ Manage"
- **Action buttons**: Icon-only with tooltip. Disabled state: 40% opacity
- **Primary action** ("Save as new file"): Filled background `var(--accent)`, white text, 4px radius

### Grid

- **Layout**: CSS Grid, `grid-template-columns: repeat(auto-fill, minmax(100px, 1fr))`
- **Gap**: `var(--space-md)` (12px)
- **Overflow**: Scroll vertical, padding bottom for "unsaved changes" badge
- **Drop indicator**: 2px solid `var(--accent)` line between grid items at drop position

### Status Bar

- **Position**: Bottom of grid area, sticky
- **Unsaved changes**: "⚠️ N unsaved changes" in `var(--text-secondary)`, 12px
- **Error messages**: Inline below Save button, `var(--error)`, 12px
- **Success flash**: Brief green border flash on the grid container, 300ms

### Empty State (1-page PDF)

- **Message**: "Only 1 page — nothing to rearrange."
- **Sub-message**: "Use View mode to read it."
- **Action**: "Back to View" text button
- **Layout**: Centered in grid area, `var(--text-secondary)`

## Interaction States

All interactive elements must have these states:
- **Default**: Base appearance
- **Hover**: Visual feedback (brightness, underline, opacity change)
- **Focus**: 2px focus ring `var(--accent)` (keyboard accessibility)
- **Active/Pressed**: Slight scale reduction (0.98) or darker background
- **Disabled**: 40% opacity, no cursor change, no hover effect
- **Loading**: Skeleton animation or spinner (prefer skeleton for layout stability)

## Accessibility

- **Keyboard**: Full Tab navigation through thumbnails, Space to select, Arrow keys for grid nav, Enter for primary action
- **ARIA**: Grid = `role="listbox"`, thumbnail = `role="option"` + `aria-label="Page N"` + `aria-selected`
- **Focus visible**: Always show focus ring for keyboard users
- **Touch targets**: Minimum 44px (thumbnails at 100px+ exceed this)
- **Reduced motion**: `@media (prefers-reduced-motion: reduce)` — skip drag animations, instant transitions
- **Contrast**: All text meets WCAG AA (4.5:1 for normal, 3:1 for large)

## Anti-Patterns (Do NOT)

- No colored left-borders on thumbnails
- No icons in colored circles
- No uniform bubbly border-radius (keep 2px)
- No centered-everything layout
- No decorative blobs or gradients
- No emoji as structural design elements (emoji in tab labels are acceptable — they're functional labels, not decoration)
- No thick colored borders for selection (use subtle accent border)
