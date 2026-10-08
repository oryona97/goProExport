# GoPro Export design system

## Direction

A calm, practical desktop workspace for moving footage from a GoPro to a
computer. Media and the next action take priority over explanatory copy.

Applied UI/UX Pro Max guidance from the local skill's verified
`productivity dashboard minimal` search: flat surfaces, clean typography,
simple hover states, consistent spacing, and lightweight rendering. Its
marketing-page pattern is not applicable to this local utility. The blue
palette below is a project-specific choice rather than the generated teal
and orange recommendation.

Keep the existing HTML, CSS, and JavaScript stack. Use local system fonts,
native controls, and inline vector artwork so the app works without a CDN
or additional build dependencies.

## Tokens

The implementation source of truth is `public/styles.css`.

| Role | Value |
| --- | --- |
| Text | `#172438` |
| Secondary text | `#56657a` |
| Page background | `#f5f7fa` |
| Surface | `#ffffff` |
| Primary action | `#2563eb` with white text |
| Primary hover / link | `#1d4ed8` |
| Selected surface | `#eff5ff` |
| Divider | `#dce3ed` |
| Control boundary | `#8190a6` |
| Success text | `#14704e` |
| Error text | `#b42332` |

Use Segoe UI Variable Text, Segoe UI, then the system sans-serif stack.
Use 4px increments for spacing, 8px control corners, 12px nested panels,
and 16px section corners. Use 44px primary control targets and 48px for the
connection action. Use tabular figures for transfer statistics.

## Pages and interactions

- Connection: camera discovery, manual details, local destination, then one
  primary connection action. Setup guidance sits beside the form on desktop
  and after it on small screens. Technical reference content uses a separate
  tab; activity is initially collapsed.
- Workspace: compact connection status and an editable destination, then
  footage and preview, followed by the download center and activity.
- Search matches file names and folders; type filtering supports videos,
  photos, and other files. Selections survive filtering and preview changes.
  “Select visible” applies only to the current results; “Queue all” applies
  to all loaded footage.
- Keep the existing preview, queue ordering, download progress, and desktop
  floating collapsed transfer panel behavior.

## Accessibility and responsive behavior

Use visible focus indicators, semantic labels, a skip link, labelled media
selection and preview actions, and keyboard tab navigation. Connection
validation retains inline errors and focuses an error summary with links
to invalid fields, following the skill's `error summary validation` search.
Disable and label scanning, connection, and refresh actions while pending.
Errors are announced; selection counts use a contextual status region.

Respect reduced motion. Adapt at 520px, 800px, and 1100px. At narrow widths,
stack the preview below media and reduce table columns; complete metadata
remains available through the preview. Do not lock zoom or page scrolling.
Use text as well as color for connection and transfer states.
