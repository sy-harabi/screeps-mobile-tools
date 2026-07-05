# screeps-mobile-tools

Userscript that fixes the worst mobile UX problems of the screeps.com web client.

## What it fixes

| Problem | Fix |
| --- | --- |
| Can't pick an object when several share a tile | v0.2: independent bottom-sheet picker. A tap on the room grid is converted to tile coordinates directly (no dependency on the client's popup); if the tile holds 2+ objects, a bottom bar with large buttons appears — tap one to select it. The client's own `.view-popup` is also restyled/clamped as a secondary path. |
| Whole UI too small | The site forces a 1280px layout viewport; the script sets it to 980 (`viewportWidth`) and additionally zooms the console/Memory panes and the room aside panel by 1.3× (`uiScale`; the script editor pane and game field are untouched). |
| Stuck zoomed into the map, can't get back to the UI | The room/world-map pan code consumes touch events, blocking native pinch-out and page panning. v0.3 keeps multi-touch (and, while zoomed in, all touches) away from the map's handlers so native pinch/pan works, and shows a floating ⛶ button (bottom-center of the visible area, only while zoomed in) that resets the zoom in one tap. |
| Can't resize the Script/Console/Memory panel by touch | The client's resize handle only listens to mouse events. The script bridges touch drags to synthetic mouse events, so dragging the top strip of the panel resizes it (height persists via the client's own localStorage key). Double-tap the handle to cycle 35% / 60% / 85% height presets. |
| Top-left buttons (burger/logo vs World/overview) overlap | On narrow screens the navbar's right-side resource/CPU indicators wrap it to a second row, which collides with the room view's left controls. The script hides those indicators on touch devices so the navbar stays a single 42px row. |

## Install (Android + Firefox)

1. Install **Violentmonkey** (or Tampermonkey) from Firefox Add-ons.
2. Open the extension dashboard → create a new script → paste the contents of
   `screeps-mobile.user.js` → save.
   (Or serve/host the file and open its URL; the `.user.js` suffix triggers the
   install prompt.)
3. Reload screeps.com.

## Config

Edit the `CONFIG` block at the top of the script:

- `touchOnly` — CSS applies only on touch devices (`pointer: coarse`). Set
  `false` to test on desktop.
- `heightPresets` — panel height fractions cycled by double-tapping the handle.
- `viewportWidth` — layout viewport width (site default 1280). Default `980`
  (~30% larger UI). Lower values enlarge further but the layout is unverified
  below ~980. `null` restores the site default.
- `uiScale` — extra zoom for console/Memory panes and the aside panel.
  Default `1.3`. Set `1` to disable.

## Diagnostics

If something is still broken, **triple-tap the burger/logo** (top-left) to open
an on-screen diagnostic dump (viewport info, element rectangles, what elements
are stacked in the top-left corner, Angular scope status). Tap **Copy** and
paste it back for calibration. From a desktop console, `__smDump()` does the
same.

## Notes / limitations

- Built against the live old client (`build.min.js`) as served 2026-07; a
  client update can rename classes/directives. The diagnostic dump is the
  recalibration tool.
- The tile picker appears when the tapped tile holds **more than one** object
  (client behavior: exactly one object is selected directly).
- The resize handle strip doubles as the tab row on its left side; drag from
  the grip bar on the right side of the panel's top edge.
