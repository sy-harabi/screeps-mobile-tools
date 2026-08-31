# screeps-mobile-tools

Userscript that fixes the worst mobile UX problems of the screeps.com web client.

## What it fixes

| Problem | Fix |
| --- | --- |
| Can't pick an object when several share a tile | `popupPicker` replaces the tiny same-tile popup with a large touch-friendly bottom bar and forwards selection to the client's own handler. |
| Whole UI too small | `autoViewport` derives a device-sized layout width from `screen.width`, with manual A− / A＋ / ↺ controls in the floating ⚙ panel. |
| Tapping a room-view edge does nothing | `roomEdgeNav` forwards a touch on a rendered room exit strip to the client's own `Room.switchRoom(dir)` handler. |
| Pinch zooms the page instead of the map | `lockZoom` prevents accidental page zoom while `pinchZoomMap` translates a two-finger pinch into map zoom. |
| Can't pan the classic world map by finger | `worldMapPan` bridges touch drag to the classic map's mouse-drag handling. |
| Can't pan/zoom the alpha map (`#!/map2`) | `map2Pan` / `map2Zoom` drive the Screeps Angular/PIXI map component directly through its live model API. |
| Can't resize Script/Console/Memory by touch | Touch drag is bridged to the existing resize handle; double-tap cycles 35% / 60% / 85% presets. |
| Mobile navbar/control overlap | The script measures the live navbar and repositions room controls dynamically. |
| Want one map as the default | The ⚙ panel can prefer auto / classic / alpha world map and persists the choice in `localStorage`. |

## Install

### Android + Firefox

1. Install **Violentmonkey** or **Tampermonkey** in Firefox.
2. Open the raw userscript URL:

   ```text
   https://raw.githubusercontent.com/sy-harabi/screeps-mobile-tools/main/screeps-mobile.user.js
   ```

3. Accept the userscript installation prompt.
4. Reload `https://screeps.com/`.

### iPhone / iPad + Safari

Use the open-source **Userscripts** Safari extension.

Requirements:

- iOS/iPadOS **15.4+ recommended** for this script. Userscripts itself supports iOS 15.1+, but Screeps Mobile UX uses CSS `:has()`, which requires Safari 15.4+.
- Safari extension access must be enabled for `screeps.com` (or all websites).

Install:

1. Install **Userscripts** from the App Store.
2. Open the Userscripts app once and choose/confirm its scripts directory.
3. Enable **Userscripts** in Safari extensions and grant website access.
4. In Safari, open:

   ```text
   https://raw.githubusercontent.com/sy-harabi/screeps-mobile-tools/main/screeps-mobile.user.js
   ```

5. Open the Userscripts extension popup and accept the installation prompt.
6. Reload Screeps.

The `.user.js` suffix must be in the URL path; the raw GitHub URL above satisfies that requirement.

## Auto-update

The repository contains two update endpoints:

```text
screeps-mobile.meta.js   # metadata/version check
screeps-mobile.user.js   # full script download
```

For userscript managers that support the standard update flow, metadata should use:

```text
@updateURL   https://raw.githubusercontent.com/sy-harabi/screeps-mobile-tools/main/screeps-mobile.meta.js
@downloadURL https://raw.githubusercontent.com/sy-harabi/screeps-mobile-tools/main/screeps-mobile.user.js
```

When releasing a new version, keep the `@version` value in **both** files synchronized.

Userscripts for Safari periodically checks installed scripts with `@version` + `@updateURL`. Its documentation notes that its update implementation is not fully complete, so manual reinstallation from the raw `.user.js` URL remains a fallback if an automatic update is not detected.

## iPhone / Safari compatibility status

The current script is written with standard browser APIs and has no dependency on Tampermonkey/Violentmonkey `GM_*` APIs (`@grant none`). Static review found no obvious blocker for modern Safari.

Expected compatibility:

| Feature | iPhone status |
| --- | --- |
| Viewport/UI sizing | Expected to work |
| ⚙ settings | Expected to work |
| Same-tile picker | Expected to work |
| Room-edge navigation | Expected to work |
| Touch panel resize | Expected to work |
| Classic-map touch pan | Expected to work |
| Classic/room-map pinch zoom | Expected to work; device verification recommended |
| Alpha-map (`map2`) pan/zoom | Needs real-device verification |
| Auto-update | Supported by metadata layout; Userscripts itself documents limitations in its update implementation |

### Why `map2` needs extra verification

The alpha world-map bridge resolves Screeps' Angular component instances through the legacy `window.ng.probe()` debug API. The script therefore needs to execute in a page context where Screeps' `window.ng` is visible. Userscripts supports `@inject-into` with `auto`, `content`, and `page`; the script currently relies on the default/automatic behavior rather than forcing an injection context.

If everything works except alpha-map dragging or pinch zoom, open `#!/map2` and use the diagnostic dump described below. `ctx: NOT RESOLVED` indicates that `ng.probe` or the expected map component is unavailable.

This repository has been tuned primarily on Android + Firefox. The iPhone notes above are based on source/API compatibility review; they are **not a claim of physical iPhone device testing**.

## Config

Edit the `CONFIG` block near the top of `screeps-mobile.user.js`.

- `touchOnly` — apply mobile CSS only on coarse-pointer devices. Set `false` for desktop testing.
- `heightPresets` — editor-panel height fractions used by double-tap.
- `autoViewport` / `viewportRatio` — derive the initial layout width from `screen.width` (default ratio `1.4`).
- `viewportWidth` — fallback/fixed layout width; default `570`.
- `sizeControl` — show the floating ⚙ size controls and persist the selected viewport width.
- `mapDefaultToggle` — show auto / classic / alpha map preference in the ⚙ panel.
- `roomEdgeNav` — enable touch navigation through room exit strips.
- `roomEdgeMargin` — extra touch padding around exit strips; default `4` px.
- `uiScale` — optional extra zoom for console/Memory/aside panes; default `1`.
- `lockZoom` — disable browser page pinch zoom while leaving map zoom available.
- `pinchZoomMap` — translate two-finger pinch on the room/classic map into the client's own zoom.
- `pinchStepPx` / `wheelDelta` / `invertPinch` — tune classic-map pinch behavior.
- `worldMapPan` — bridge touch drag to classic world-map mouse drag.
- `worldMapPanThreshold` — movement threshold between tap and drag.
- `map2Pan` / `map2Zoom` — touch pan and pinch zoom for the alpha map.
- `map2InvertX` / `map2InvertY` — reverse alpha-map pan direction if required.
- `map2TouchAction` — keep the browser from stealing gestures on the alpha-map canvas.
- `popupPicker` — large touch picker for multiple objects on one tile.
- `coordPicker` — legacy coordinate picker; off by default because it is not zoom-safe.

## Diagnostics

If something is broken, **triple-tap the burger/logo** at the top left to open the on-screen diagnostic dump. It includes viewport data, element rectangles, element stacking, and Angular/map2 status.

Tap **Copy** and paste the result into an issue or debugging conversation.

From a desktop console, the same dump is available through:

```js
__smDump()
```

## Notes / limitations

- Built against the live Screeps old client (`build.min.js`) as served in 2026-07. Client updates can rename classes/directives or remove Angular debug APIs.
- The same-tile picker appears only when a tile contains more than one selectable object; the Screeps client directly selects a single object.
- The resize strip overlaps the tab row on its left side; use the **⇕** grip on the right side.
- Automatic viewport sizing is tuned around typical phone widths. Use the ⚙ Size control for a persistent manual override.

## License

MIT — see [LICENSE](LICENSE). Anyone may install, use, modify, and redistribute it.
