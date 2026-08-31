# Screeps Mobile UX

A userscript that makes the [Screeps](https://screeps.com/) web client easier to use on a phone.

## Features

- Larger, adjustable mobile UI
- Touch-friendly same-tile object picker
- Room-edge navigation
- Touch pan and pinch zoom for world maps
- Touch resize for Script / Console / Memory
- Mobile navbar and room-control layout fixes
- Optional default map: classic or alpha

## Install

Install this userscript:

**[screeps-mobile.user.js](https://raw.githubusercontent.com/sy-harabi/screeps-mobile-tools/main/screeps-mobile.user.js)**

### Android

Use Firefox with **Violentmonkey** or **Tampermonkey**, open the link above, install, then reload Screeps.

### iPhone / iPad

Use Safari with the **Userscripts** extension:

1. Install Userscripts and enable its Safari extension.
2. Allow it to run on `screeps.com`.
3. Open the userscript link above in Safari and install it.
4. Reload Screeps.

**iOS/iPadOS 15.4+ recommended.** iPad Safari has been tested, including alpha-map (`#!/map2`) pan and pinch zoom. iPhone has not yet been physically verified.

## Usage

Tap the floating **⚙** button to change UI size or choose the default world map.

Most behavior can also be changed in the `CONFIG` block near the top of `screeps-mobile.user.js`.

## Updates

The repo includes:

- `screeps-mobile.user.js` — full userscript
- `screeps-mobile.meta.js` — update metadata

When releasing a new version, keep `@version` synchronized in both files.

## Diagnostics

If something breaks, **triple-tap the burger/logo** to open the diagnostic dump. On desktop, run:

```js
__smDump()
```

The script is built against the live Screeps web client, so client updates may occasionally break selectors or internal APIs.

## License

MIT — see [LICENSE](LICENSE).
