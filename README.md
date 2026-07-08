# screeps-mobile-tools

Userscript that fixes the worst mobile UX problems of the screeps.com web client.

## What it fixes

| Problem | Fix |
| --- | --- |
| Can't pick an object when several share a tile | v0.5.1 (`popupPicker`): when 2+ objects share a tapped tile the client shows a tiny `.view-popup` list that is hard to tap (and on some devices whose items don't select at all). The script hides it and shows a large bottom bar of buttons mirrored from that list; tapping a button forwards a synthetic click to the client's own `<li>`, so selection runs through the client's handler — no tile-coordinate math, so it works at any map zoom. (The older coordinate-based picker is kept behind `coordPicker`, off by default, since it mis-reads the tile when the map is zoomed.) |
| Whole UI too small | The site forces a 1280px layout viewport; the script sets it to 570 (`viewportWidth`), rendering the whole UI ~2.25× larger. Smaller `viewportWidth` = larger UI; raise it if the layout breaks. `uiScale` (extra zoom for the console/Memory/aside panes) defaults to `1`, so every pane scales uniformly from the viewport width. |
| No easy way to change the UI size | v0.7 (`sizeControl`): a small **A±** button (bottom-right) opens an **A− / current scale / A＋ / ↺** row. Each tap resizes the whole UI live (1.0×–3.0×) and saves the choice to `localStorage`, so it **survives reloads and auto-updates** (editing `viewportWidth` in the file does not — auto-update overwrites the file). |
| Accidentally pinch-zooming the whole UI | v0.4 locks the browser's page zoom (`lockZoom` → `user-scalable=no`), so the UI can never be pinch-zoomed and can't get "stuck" zoomed in. The earlier floating ⛶ zoom-reset button is gone — with page zoom locked there is nothing to reset. |
| Pinching only zoomed the whole page, not the map | v0.5 (`pinchZoomMap`): a two-finger pinch over the room game field / world map is translated into the client's own zoom (synthetic wheel events at the pinch centroid), so **only the map zooms while the UI stays fixed**. The client's +/- zoom controls (enlarged for touch) still work too. |
| Can't pan the world map by finger | v0.6 (`worldMapPan`): the client's world map pans on mouse drag but ignores touch, so a finger drag did nothing. The script bridges a single-finger touch to the mouse drag sequence (`mousedown`→`mousemove`→`mouseup`); a finger tap with no drag is forwarded as a click so tapping a room still navigates. Two-finger pinch still zooms. |
| Can't pan the alpha map (`#!/map2`) by finger | **Unsolved / not attempted via events.** map2 is an app2 WebGL component (`app-world-map-map`) whose drag-pan relies on real browser pointer-capture semantics. Every synthetic-event approach (touch, mouse, pointer — 0.6.2 through 0.6.4) failed: injected events were misread as a *room click*, causing accidental navigation instead of a pan. So map2 is left untouched (`map2TouchAction` off, not in the pan/zoom bridge selectors). **On mobile, use the old world map (`#!/map`) instead — it is pannable/zoomable via the bridges above.** A proper fix would call map2's own Angular component pan/zoom API directly (would need live probing of the `app-world-map-map` component instance). |
| Can't resize the Script/Console/Memory panel by touch | The client's resize handle only listens to mouse events. The script bridges touch drags to synthetic mouse events, so dragging the top strip of the panel resizes it (height persists via the client's own localStorage key). Double-tap the handle to cycle 35% / 60% / 85% height presets. |
| Top-left buttons (burger/logo vs World/overview) overlap | On narrow screens the navbar's right-side resource/CPU indicators wrap it to a second row, which collides with the room view's left controls. The script hides those indicators on touch devices so the navbar stays a single 42px row. |

## Install (Android + Firefox)

1. Install **Violentmonkey** (or Tampermonkey) from Firefox Add-ons.
2. Open the extension dashboard → create a new script → paste the contents of
   `screeps-mobile.user.js` → save.
   (Or serve/host the file and open its URL; the `.user.js` suffix triggers the
   install prompt.)
3. Reload screeps.com.

### Auto-update

The script carries `@updateURL`/`@downloadURL` pointing at the raw file on
`main`, so Violentmonkey/Tampermonkey check for new versions automatically and
pull them once the `@version` is bumped and pushed.

To enable it the **first** time, the installed copy must already contain those
headers — install once from the raw URL so the manager records them:

```
https://raw.githubusercontent.com/sy-harabi/screeps-mobile-tools/main/screeps-mobile.user.js
```

Opening that URL triggers the install prompt. After that, every future push
that bumps `@version` is picked up automatically (managers check periodically;
"Check for updates" in the dashboard forces it immediately). GitHub's raw CDN
caches for a few minutes, so a just-pushed update may take a short while.

## Config

Edit the `CONFIG` block at the top of the script:

- `touchOnly` — CSS applies only on touch devices (`pointer: coarse`). Set
  `false` to test on desktop.
- `heightPresets` — panel height fractions cycled by double-tapping the handle.
- `viewportWidth` — layout viewport width (site default 1280). Default `570`
  (~2.25× larger UI, 1280/570). Smaller = larger UI; the layout is aggressive
  well below ~980, so raise it (570 → 720 → 850 → 980) if anything breaks.
  `null` restores the site default. This is only the **starting** size — the
  A± control (see `sizeControl`) overrides it at runtime via `localStorage`.
- `sizeControl` — when `true` (default), show the floating **A±** button that
  resizes the whole UI live (1.0×–3.0×) and remembers the choice across
  reloads/auto-updates. The saved size lives in `localStorage["sm.viewportWidth"]`;
  tap **↺** (or clear that key) to return to the `viewportWidth` default.
- `uiScale` — extra zoom for console/Memory panes and the aside panel.
  Default `1` (off). Only raise this if you want those panes larger than the
  rest of the UI; `viewportWidth` already enlarges everything uniformly.
- `lockZoom` — when `true` (default), the browser's page zoom is disabled
  (`user-scalable=no`) so the UI cannot be pinch-zoomed. The map still zooms
  via `pinchZoomMap` and the client's +/- controls. Requires `viewportWidth`.
- `pinchZoomMap` — when `true` (default), a two-finger pinch over the map is
  bridged to the client's own zoom (synthetic wheel events), so only the map
  zooms, not the UI. Tuning: `pinchStepPx` (pinch travel per wheel tick,
  smaller = more sensitive), `wheelDelta` (client zoom step per tick),
  `invertPinch` (set `true` if pinch-out zooms out instead of in).

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
  the **⇕** grip chip on the right side of the panel's top edge (double-tap it
  to cycle the height presets).
- Tuned on Android + Firefox. `viewportWidth` (default `570`, ~2.25×) is
  aggressive; on other screen sizes adjust it in the `CONFIG` block.

## License

MIT — see [LICENSE](LICENSE). Anyone may install, use, modify, and
redistribute it.
