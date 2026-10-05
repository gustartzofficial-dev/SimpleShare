# SimpleShare design

A small, considered utility for sharing a screen with people you know.

## Direction

Warm editorial home; quiet, dark media canvas. Cream (#f6f3ec), ink (#252722), burnt orange (#b94323), muted olive (#727762). Geist, self-hosted, with a system fallback. A custom intersecting-window brand mark and a built-in illustrative room preview establish the identity. No stock photography, generic gradient hero, fake testimonials, subscription language, or decorative dashboards.

## Product priorities

1. A room link should be easy to create, join, copy, and recover.
2. Sharing must always be deliberate. Stop capture immediately when asked.
3. Watching on a phone is a first-class task. Do not promise mobile screen capture when the browser lacks it.

## Layout and motion

Editorial split, a wide two-line title, generous whitespace, a single strong action. No forced scroll chapters: the brief calls for a simple utility. Motion intensity 3; entry and state transitions only, always reduced-motion aware. The room dock remains in document layout and respects safe areas. Media overlays fade away until hover, tap, or keyboard focus. Audio sliders open on demand. Focus shows one large screen above compact thumbnails; additional tiles use page buttons instead of a scrolling stage. The room header uses the icon-only brand mark. Settings use a native modal with focus containment and Escape. All buttons have readable names and at least 44px touch targets. Dark and light appearance share one layout.

## Implementation

One source stylesheet, one application entry point, no runtime DOM-reparenting themes or global media API monkey patches. Phosphor icons use one family. UI values are escaped or assigned through textContent. The home preview is an explicitly labelled illustration, not a real room or a performance claim.
