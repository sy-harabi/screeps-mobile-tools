// ==UserScript==
// @name         Screeps Mobile UX
// @namespace    harabi.screeps.mobile
// @version      0.8.6
// @description  Mobile UX fixes for screeps.com: alpha-map (map2) finger pan & pinch zoom, touch resize for the script/console/Memory panel, same-tile object picker bottom sheet, navbar de-overlap, larger UI.
// @author       sy-harabi
// @license      MIT
// @match        https://screeps.com/*
// @run-at       document-idle
// @grant        none
// @homepageURL  https://github.com/sy-harabi/screeps-mobile-tools
// @supportURL   https://github.com/sy-harabi/screeps-mobile-tools/issues
// @downloadURL  https://raw.githubusercontent.com/sy-harabi/screeps-mobile-tools/main/screeps-mobile.user.js
// @updateURL    https://raw.githubusercontent.com/sy-harabi/screeps-mobile-tools/main/screeps-mobile.user.js
// ==/UserScript==

/*
 * Built against the live screeps.com old client (build.min.js, 2026-07).
 * Facts this script relies on (verified in the served bundle/templates):
 *  - Same-tile picker: `.view-popup` (ViewPopup controller) already lists all
 *    objects on a clicked tile when there is more than one; it is just too
 *    small on phones and can open off-screen. We restyle and clamp it.
 *  - Panel resize: `.editor-panel .resize-handle` + appResizePanelHandle
 *    directive, which listens to mousedown/mousemove/mouseup only. We bridge
 *    touch events to synthetic mouse events. Height persists to localStorage
 *    ("game.editor.height") via the client's own code.
 *  - Panel presets: the appResizePanel controller (on `.game-switch-container`)
 *    exposes setHeight()/toggle(); double-tapping the handle cycles presets.
 *  - Navbar: `header.navbar` is a 42px strip; `.page-content` starts at 42px.
 *    When the right-side resources/CPU indicators wrap, the navbar grows and
 *    collides with `section.room .left-controls`. We prevent the wrap.
 */

(function () {
  "use strict";

  // Keep in sync with the @version header above; the dump prints this so the
  // on-screen header never lies about which build is loaded.
  var SM_VERSION = "0.8.6";

  var CONFIG = {
    // Apply the CSS only on coarse-pointer (touch) devices.
    // Set false to force it on desktop for testing.
    touchOnly: true,
    // Editor panel height presets as fractions of the layout viewport
    // height. Double-tapping the resize handle cycles through them.
    heightPresets: [0.35, 0.6, 0.85],
    doubleTapMs: 400,
    // The site ships <meta name="viewport" content="width=1280">, which is
    // why everything is tiny on phones. Smaller width = larger UI
    // (1280/width). 570 renders the whole UI ~2.25x the site default
    // (~1.5x larger than the previous 850). null = site default.
    // Raise this if the layout breaks (values well below 980 are
    // aggressive: 570 -> 720 -> 850 -> 980 progressively tames it).
    viewportWidth: 570,
    // Extra zoom for the console/Memory panes and the room aside panel
    // (game field and script editor are left untouched). 1 = off.
    // With viewportWidth already enlarging everything, keep this at 1 so
    // every pane scales uniformly (otherwise those panes double-scale).
    uiScale: 1,
    // Lock the browser's page zoom (user-scalable=no) so the UI can never
    // be pinch-zoomed. The map stays zoomable via pinchZoomMap below and
    // the client's own +/- controls. Requires viewportWidth to be set.
    lockZoom: true,
    // Pinch-to-zoom the map (room game field / world map) with two fingers.
    // Because page zoom is locked, we translate the pinch into the client's
    // own zoom by dispatching synthetic wheel events at the pinch centroid,
    // so only the map zooms and the UI stays fixed.
    pinchZoomMap: true,
    // Pinch travel (px) per emitted wheel tick; smaller = more sensitive.
    pinchStepPx: 28,
    // Magnitude of each synthetic wheel tick's deltaY (client zoom step).
    wheelDelta: 100,
    // Set true if pinch-out zooms OUT instead of in (client wheel sign
    // differs); flips the zoom direction.
    invertPinch: false,
    // Same-tile object picker. When 2+ objects share a tapped tile the
    // client shows a tiny .view-popup list that is hard to tap (and, on
    // some devices, whose items don't select at all). popupPicker mirrors
    // that list into a large bottom-sheet of buttons; tapping a button
    // forwards a click to the client's own list item, so selection reuses
    // the client's handler and needs no tile coordinates (zoom-safe).
    popupPicker: true,
    // The older independent picker that recomputes the tile from tap
    // coordinates. It breaks when the map is zoomed (wrong tile), so it is
    // off by default; popupPicker supersedes it.
    coordPicker: false,
    // The client's world map pans on mouse drag but ignores touch, so a
    // finger drag does nothing. Bridge single-finger touch to synthetic
    // mouse events (mousedown/move/up) so dragging pans it; a finger tap
    // (no drag) is forwarded as a click so room navigation still works.
    worldMapPan: true,
    // Movement (px) beyond which a world-map touch counts as a drag, not
    // a tap.
    worldMapPanThreshold: 5,
    // The "alpha" world map (#!/map2) is an app2/Angular + PIXI component.
    // Synthetic events never drove its drag-pan (0.6.2-0.6.4: misread as a
    // room click). Instead we call the component's OWN pan/zoom model API
    // directly (v0.7.7), so no synthetic events are involved and a room
    // click can never be spoofed. Single finger = pan, two fingers = zoom.
    map2Pan: true,
    map2Zoom: true,
    // Flip pan direction per axis if a finger drag moves the map the wrong
    // way on your device/orientation.
    map2InvertX: false,
    map2InvertY: false,
    // touch-action:none on the map2 canvas so the browser can't steal the
    // drag as a scroll / pull-to-refresh before our handler owns it. Tapping
    // a room still navigates (touch-action doesn't affect taps).
    map2TouchAction: true,
    // Show the floating gear (⚙) settings panel (bottom-right). Its "Size"
    // row changes the whole UI size live (A- / A+); the chosen size persists
    // in localStorage (survives reloads and auto-updates), independent of
    // viewportWidth above. Set false to hide the Size row.
    sizeControl: true,
    // Distance (px) of the gear panel from the bottom-right corner. Nudge
    // sizeControlRight up if it collides with a client button (e.g. the
    // history view's right-panel toggle sits in the bottom-right corner).
    sizeControlRight: 52,
    sizeControlBottom: 8,
    // Default world-map preference, set from the gear panel's "Map" row.
    // Screeps has two world maps: the classic #!/map and the newer "alpha"
    // #!/map2. Pick auto / classic / alpha; once set (not "auto"), any
    // navigation to the other map is steered to your choice. The choice
    // persists in localStorage["sm.defaultMap"] (survives reloads/updates).
    // "auto" enforces nothing, so the client's own behavior is untouched.
    // Set false to hide the Map row and disable the feature.
    mapDefaultToggle: true,
  };

  /* ------------------------------------------------------------------ */
  /* 1. CSS: navbar de-overlap, touch-sized picker, resize grip visual   */
  /* ------------------------------------------------------------------ */

  var mq = CONFIG.touchOnly ? "@media (pointer: coarse)" : "@media all";
  var css =
    mq +
    " {\n" +
    /* Navbar: keep it a single 42px row so it cannot wrap and spill
     * over the room view's top-left controls (World/overview/zoom). */
    "header.navbar .navbar-resources { display: none !important; }\n" +
    "header.navbar .navbar-sysbar { display: none !important; }\n" +
    "header.navbar .navbar-profile .username {" +
    " display: inline-block; max-width: 8em; overflow: hidden;" +
    " text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }\n" +
    /* Built-in same-tile object picker: touch-sized targets. */
    ".view-popup { min-width: 230px; z-index: 100 !important; }\n" +
    ".view-popup ul li {" +
    " padding: 14px 20px !important; font-size: 20px !important;" +
    " line-height: 1.25; color: #ddd; }\n" +
    /* Resize handle: visible grip so it is discoverable by touch.
     * (Kept to the right side: the left part of the strip is the tab row.) */
    ".editor-panel .resize-handle::after {" +
    ' content: "\\21D5";' + // up-down double arrow: reads as a drag-to-resize control
    " position: absolute; top: 1px; right: 122px;" +
    " width: 40px; height: 20px; line-height: 20px; text-align: center;" +
    " font-size: 16px; color: rgba(255,255,255,0.62);" +
    " background: rgba(255,255,255,0.13);" +
    " border: 1px solid rgba(255,255,255,0.22); border-radius: 11px;" +
    " pointer-events: none; }\n" +
    /* Slightly larger zoom buttons in the room view. */
    "section.room .left-controls .zoom-controls .md-button {" +
    " width: 40px; height: 40px; line-height: 40px; }\n" +
    /* Enlarge console/Memory panes and the aside panel. The script pane
     * (first tab) is excluded so the code editor's metrics stay intact. */
    (CONFIG.uiScale !== 1
      ? ".editor-panel .tab-content .tab-pane:not(:first-child)," +
        " section.room aside .aside-content { zoom: " +
        CONFIG.uiScale +
        "; }\n"
      : "") +
    /* map2 (#!/map2, the "alpha" world map): touch-action:none so our own
     * pan/zoom bridge (section 5c-2) owns the gesture instead of the browser
     * scrolling / pull-to-refresh. Enabled whenever map2 pan or zoom is on. */
    (CONFIG.map2TouchAction || CONFIG.map2Pan || CONFIG.map2Zoom
      ? "app-world-map-map, app-world-map-map canvas," +
        " app-world-map-base, app-world-map-base canvas {" +
        " touch-action: none !important; }\n"
      : "") +
    /* Note: for the OLD room/world map we deliberately do NOT override
     * touch-action. The client's native inline touch-action:none is left
     * intact; room zoom is via its +/- controls and (v0.5+) the pinch
     * bridge. Browser page zoom is locked off (see lockZoom). */
    "}";

  var style = document.createElement("style");
  style.id = "screeps-mobile-ux-css";
  style.textContent = css;
  document.head.appendChild(style);

  /* Layout-viewport width controls the whole-UI size (1280/width = scale).
   * A runtime override lives in localStorage so the floating A-/A+ control
   * (below) persists across reloads AND across script auto-updates (which
   * overwrite this file, wiping any CONFIG edit). Helpers are declarations
   * so they hoist for this early call.
   *
   * Lock page zoom with user-scalable=no ONLY. Do NOT set initial-/minimum-/
   * maximum-scale: pinning the scale to 1 fights the width-based
   * magnification and renders the UI tiny on some Android browsers. */
  var SIZE_LS_KEY = "sm.viewportWidth";

  function smClampWidth(w) {
    return Math.max(427, Math.min(1280, Math.round(w))); // scale 3.0x .. 1.0x
  }
  function smSavedWidth() {
    try {
      var v = parseInt(localStorage.getItem(SIZE_LS_KEY), 10);
      if (v >= 427 && v <= 1280) return v;
    } catch (e) {}
    return null;
  }
  function smCurrentWidth() {
    return smSavedWidth() || CONFIG.viewportWidth || 1280;
  }
  function smApplyViewport(width, persist) {
    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    var content = "width=" + width + (CONFIG.lockZoom ? ",user-scalable=no" : "");
    meta.setAttribute("content", content);
    if (persist) {
      try {
        localStorage.setItem(SIZE_LS_KEY, String(width));
      } catch (e) {}
    }
  }

  if (CONFIG.viewportWidth) smApplyViewport(smCurrentWidth(), false);

  /* ------------------------------------------------------------------ */
  /* 2. Touch -> mouse bridge for the editor panel resize handle         */
  /* ------------------------------------------------------------------ */

  var drag = null;
  var lastTapTime = 0;
  var presetIdx = -1;

  function fireMouse(type, target, touch) {
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        clientX: touch ? touch.clientX : 0,
        clientY: touch ? touch.clientY : 0,
      }),
    );
  }


  document.addEventListener(
    "touchstart",
    function (e) {
      var handle =
        e.target.closest && e.target.closest(".editor-panel .resize-handle");
      if (!handle || e.touches.length !== 1) return;
      // preventDefault suppresses the browser's compatibility mouse events;
      // we synthesize the full sequence ourselves.
      e.preventDefault();
      drag = { moved: false };
      fireMouse("mousedown", handle, e.touches[0]);
    },
    { passive: false, capture: true },
  );

  document.addEventListener(
    "touchmove",
    function (e) {
      if (!drag) return;
      e.preventDefault(); // no page scroll while resizing
      drag.moved = true;
      fireMouse("mousemove", document.documentElement, e.touches[0]);
    },
    { passive: false, capture: true },
  );

  function endDrag(e) {
    if (!drag) return;
    fireMouse("mouseup", document.documentElement, e.changedTouches[0]);
    var wasTap = !drag.moved;
    drag = null;
    if (wasTap) {
      var now = e.timeStamp;
      if (now - lastTapTime < CONFIG.doubleTapMs) {
        lastTapTime = 0;
        cyclePreset();
      } else {
        lastTapTime = now;
      }
    }
  }
  document.addEventListener("touchend", endDrag, {
    passive: false,
    capture: true,
  });
  document.addEventListener("touchcancel", endDrag, {
    passive: false,
    capture: true,
  });

  function panelCtrl() {
    if (!window.angular) return null;
    var containers = document.querySelectorAll(".game-switch-container");
    for (var i = 0; i < containers.length; i++) {
      var ctrl = window.angular
        .element(containers[i])
        .controller("appResizePanel");
      if (ctrl) return { ctrl: ctrl, el: containers[i] };
    }
    return null;
  }

  function cyclePreset() {
    var found = panelCtrl();
    if (!found) return;
    presetIdx = (presetIdx + 1) % CONFIG.heightPresets.length;
    var h = Math.round(window.innerHeight * CONFIG.heightPresets[presetIdx]);
    var scope = window.angular.element(found.el).scope();
    var apply = function () {
      found.ctrl.toggle(false); // ensure the panel is open
      found.ctrl.setHeight(h);
    };
    if (scope && scope.$applyAsync) scope.$applyAsync(apply);
    else apply();
  }

  /* ------------------------------------------------------------------ */
  /* 3. Keep the same-tile picker (.view-popup) inside the viewport      */
  /* ------------------------------------------------------------------ */

  function clampIntoView(el) {
    requestAnimationFrame(function () {
      var r = el.getBoundingClientRect();
      if (!r.width) return;
      // The popup lives inside the (possibly transform-scaled) room
      // stage, so convert the on-screen correction back to local px.
      var scaleX = el.offsetWidth ? r.width / el.offsetWidth : 1;
      var scaleY = el.offsetHeight ? r.height / el.offsetHeight : 1;
      var vv = window.visualViewport;
      var b = vv
        ? {
            left: vv.offsetLeft,
            top: vv.offsetTop,
            right: vv.offsetLeft + vv.width,
            bottom: vv.offsetTop + vv.height,
          }
        : {
            left: 0,
            top: 0,
            right: window.innerWidth,
            bottom: window.innerHeight,
          };
      var dx = 0,
        dy = 0;
      if (r.right > b.right) dx = b.right - r.right;
      if (r.left + dx < b.left) dx = b.left - r.left;
      if (r.bottom > b.bottom) dy = b.bottom - r.bottom;
      if (r.top + dy < b.top) dy = b.top - r.top;
      if (dx) el.style.marginLeft = dx / scaleX + "px";
      if (dy) el.style.marginTop = dy / scaleY + "px";
    });
  }

  function findPopup(node) {
    if (node.nodeType !== 1) return null;
    if (node.matches && node.matches(".view-popup")) return node;
    return node.querySelector && node.querySelector(".view-popup");
  }

  new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      for (var j = 0; j < m.addedNodes.length; j++) {
        var pop = findPopup(m.addedNodes[j]);
        if (pop) {
          clampIntoView(pop);
          if (CONFIG.popupPicker) mirrorPopupToSheet(pop);
        }
      }
      // When the client removes its popup (selection made or tapped away),
      // tear down the mirrored sheet so the two stay in sync.
      for (var k = 0; k < m.removedNodes.length; k++) {
        if (findPopup(m.removedNodes[k])) onPopupGone();
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  /* ------------------------------------------------------------------ */
  /* 4. Independent same-tile object picker (bottom sheet)               */
  /*                                                                     */
  /* Does not depend on the client's .view-popup. A tap on the room's    */
  /* .cursor-layer is converted to tile coordinates from the layer's     */
  /* bounding rect; the objects on that tile are read from the Angular   */
  /* room scope (Room.objects/Room.flags, same exclusions the client's   */
  /* own picker applies). Two or more objects -> bottom sheet with       */
  /* touch-sized buttons; tapping one injects the selection.             */
  /* ------------------------------------------------------------------ */

  var pickerInfo = { lastTile: "-", lastStack: -1 }; // diagnostics
  var roomTap = null;

  function getRoomScope() {
    var el = document.querySelector("section.room");
    var s = el && window.angular && window.angular.element(el).scope();
    return s && s.Room ? s : null;
  }

  function objectsAt(scope, x, y) {
    var Room = scope.Room;
    var list = [].concat(Room.objects || [], Room.flags || []);
    return list.filter(function (o) {
      return (
        o &&
        !o.temp &&
        o.x === x &&
        o.y === y &&
        !(o.type === "creep" && o.spawning) &&
        o.type !== "wall" &&
        o.type !== "swamp" &&
        o.type !== "exit"
      );
    });
  }

  document.addEventListener(
    "touchstart",
    function (e) {
      if (e.touches.length !== 1) {
        roomTap = null; // pinch etc.
        return;
      }
      if (!(e.target.closest && e.target.closest(".cursor-layer"))) return;
      roomTap = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        moved: false,
      };
    },
    { passive: true, capture: true },
  );

  document.addEventListener(
    "touchmove",
    function (e) {
      if (!roomTap || e.touches.length !== 1) return;
      if (
        Math.abs(e.touches[0].clientX - roomTap.x) > 12 ||
        Math.abs(e.touches[0].clientY - roomTap.y) > 12
      ) {
        roomTap.moved = true; // pan, not a tap
      }
    },
    { passive: true, capture: true },
  );

  document.addEventListener(
    "touchend",
    function (e) {
      if (!roomTap) return;
      var wasTap = !roomTap.moved;
      roomTap = null;
      if (!CONFIG.coordPicker) return; // popupPicker supersedes this path
      if (!wasTap || e.changedTouches.length !== 1) return;
      var layer = e.target.closest && e.target.closest(".cursor-layer");
      if (!layer) return;
      var scope = getRoomScope();
      if (!scope) return;
      var action =
        scope.Room.selectedAction && scope.Room.selectedAction.action;
      if (action && action !== "view") return; // don't interfere with flag/construct placement
      var r = layer.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var t = e.changedTouches[0];
      var tx = Math.floor(((t.clientX - r.left) / r.width) * 50);
      var ty = Math.floor(((t.clientY - r.top) / r.height) * 50);
      if (tx < 0 || tx > 49 || ty < 0 || ty > 49) return;
      // Let the client's own click handling finish first.
      setTimeout(function () {
        maybeShowSheet(tx, ty);
      }, 150);
    },
    { passive: true, capture: true },
  );

  function maybeShowSheet(x, y) {
    var scope = getRoomScope();
    pickerInfo.lastTile = x + "," + y;
    if (!scope) {
      pickerInfo.lastStack = -1;
      hideSheet();
      return;
    }
    var objs = objectsAt(scope, x, y);
    pickerInfo.lastStack = objs.length;
    if (objs.length < 2) {
      hideSheet();
      return;
    }
    renderSheet(scope, objs, x, y);
  }

  function objLabel(o) {
    var label = o.type === "energy" ? "resource" : o.type;
    if (o.name && o.type !== "controller") {
      var name = String(o.name);
      if (name.length > 14) name = name.slice(0, 13) + "…";
      label += " " + name;
    }
    return label;
  }

  function hideSheet() {
    var el = document.getElementById("sm-tile-picker");
    if (el) el.remove();
  }

  function renderSheet(scope, objs, x, y) {
    hideSheet();
    // Dynamic font size based on the VISIBLE viewport width so the sheet
    // has a constant physical size at any pinch-zoom level.
    var vw = window.visualViewport
      ? window.visualViewport.width
      : window.innerWidth;
    var fs = Math.max(14, Math.round(vw / 34));
    var wrap = document.createElement("div");
    wrap.id = "sm-tile-picker";
    wrap.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;z-index:9998;" +
      "display:flex;align-items:stretch;gap:8px;padding:10px;" +
      "background:rgba(22,22,22,0.96);border-top:1px solid #555;" +
      "overflow-x:auto;-webkit-overflow-scrolling:touch;" +
      "font-size:" +
      fs +
      "px;";
    var title = document.createElement("div");
    title.textContent = x + "," + y;
    title.style.cssText =
      "flex:0 0 auto;align-self:center;color:#888;padding:0 4px;" +
      "font-size:0.75em;";
    wrap.appendChild(title);
    var selectedId = scope.Room.selectedObject && scope.Room.selectedObject._id;
    objs.forEach(function (o) {
      var btn = document.createElement("button");
      btn.textContent = objLabel(o);
      var active = o._id && o._id === selectedId;
      btn.style.cssText =
        "flex:0 0 auto;padding:0.55em 0.9em;font-size:1em;" +
        "color:#eee;border-radius:6px;white-space:nowrap;" +
        (active
          ? "background:#2e3550;border:1px solid #6374d0;"
          : "background:#3a3a3a;border:1px solid #666;");
      btn.addEventListener("click", function () {
        scope.$applyAsync(function () {
          scope.Room.selectedObject = o;
          if (scope.$root) scope.$root.$broadcast("roomObjectSelected", o);
        });
        renderSheet(scope, objs, x, y); // refresh highlight
      });
      wrap.appendChild(btn);
    });
    var close = document.createElement("button");
    close.textContent = "✕";
    close.style.cssText =
      "flex:0 0 auto;padding:0.55em 0.9em;font-size:1em;color:#aaa;" +
      "background:transparent;border:1px solid #555;border-radius:6px;" +
      "margin-left:auto;";
    close.addEventListener("click", hideSheet);
    wrap.appendChild(close);
    document.body.appendChild(wrap);
    pinToVisualBottom(wrap);
  }

  /* ------------------------------------------------------------------ */
  /* 4b. Popup-driven picker (default): mirror the client's .view-popup  */
  /*                                                                     */
  /* The client already lists the tile's objects in .view-popup and      */
  /* already knows which tile was tapped (no coordinate math, zoom-safe).*/
  /* We hide that tiny list and show a large bottom sheet of buttons;    */
  /* each button forwards a synthetic click to the matching client <li>, */
  /* so selection runs through the client's OWN handler. A programmatic  */
  /* click also bypasses the touch layer that was swallowing item taps.  */
  /* ------------------------------------------------------------------ */

  var activePopup = null; // the client .view-popup currently mirrored

  function popupLis(pop) {
    return Array.prototype.slice.call(pop.querySelectorAll("ul li"));
  }

  function clickLi(li) {
    // Cover click-based (Angular ng-click) and mousedown/up-based handlers.
    ["mousedown", "mouseup", "click"].forEach(function (type) {
      li.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
        }),
      );
    });
  }

  function onPopupGone() {
    hideSheet();
    activePopup = null;
  }

  function dismissPopup() {
    hideSheet();
    if (activePopup && activePopup.parentNode) activePopup.remove();
    activePopup = null;
  }

  function mirrorPopupToSheet(pop) {
    // The <li> items may render a frame after the popup node is inserted.
    var tries = 0;
    (function attempt() {
      var items = popupLis(pop);
      pickerInfo.lastStack = items.length;
      if (items.length >= 2) {
        activePopup = pop;
        pop.style.visibility = "hidden"; // keep in DOM (handlers stay live)
        renderSheetFromLis(items);
      } else if (items.length === 0 && tries++ < 3 && pop.parentNode) {
        requestAnimationFrame(attempt); // wait for Angular to fill the list
      }
      // items === 1: client selects directly; nothing to mirror.
    })();
  }

  function renderSheetFromLis(items) {
    hideSheet();
    var vw = window.visualViewport
      ? window.visualViewport.width
      : window.innerWidth;
    var fs = Math.max(14, Math.round(vw / 34));
    var wrap = document.createElement("div");
    wrap.id = "sm-tile-picker";
    wrap.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;z-index:9998;" +
      "display:flex;align-items:stretch;gap:8px;padding:10px;" +
      "background:rgba(22,22,22,0.96);border-top:1px solid #555;" +
      "overflow-x:auto;-webkit-overflow-scrolling:touch;" +
      "font-size:" +
      fs +
      "px;";
    items.forEach(function (li) {
      var label = (li.textContent || "").replace(/\s+/g, " ").trim() || "object";
      var btn = document.createElement("button");
      btn.textContent = label;
      btn.style.cssText =
        "flex:0 0 auto;padding:0.55em 0.9em;font-size:1em;" +
        "color:#eee;border-radius:6px;white-space:nowrap;" +
        "background:#3a3a3a;border:1px solid #666;";
      btn.addEventListener("click", function () {
        clickLi(li); // let the client select via its own handler
        dismissPopup();
      });
      wrap.appendChild(btn);
    });
    var close = document.createElement("button");
    close.textContent = "✕";
    close.style.cssText =
      "flex:0 0 auto;padding:0.55em 0.9em;font-size:1em;color:#aaa;" +
      "background:transparent;border:1px solid #555;border-radius:6px;" +
      "margin-left:auto;";
    close.addEventListener("click", dismissPopup);
    wrap.appendChild(close);
    document.body.appendChild(wrap);
    pinToVisualBottom(wrap);
  }

  /* ------------------------------------------------------------------ */
  /* 5. Viewport helpers                                                 */
  /*                                                                     */
  /* Browser page zoom is locked off (CONFIG.lockZoom -> viewport meta   */
  /* user-scalable=no), so the UI can never be pinch-zoomed and the map  */
  /* is zoomed only via the client's own +/- controls. The pinch-escape  */
  /* button that earlier versions needed is therefore gone. We keep only */
  /* zoomFactor (for diagnostics) and pinToVisualBottom (to keep the     */
  /* tile-picker sheet on screen if the visual viewport ever shifts,     */
  /* e.g. an on-screen keyboard).                                        */
  /* ------------------------------------------------------------------ */

  // 1 = fully zoomed out (page fits the screen), >1 = zoomed in.
  // With zoom locked this reports ~1.0; retained for the dump.
  function zoomFactor() {
    var vv = window.visualViewport;
    return vv ? window.innerWidth / vv.width : 1;
  }

  // Keep a fixed, bottom-pinned element aligned to the VISUAL viewport.
  function pinToVisualBottom(el) {
    var vv = window.visualViewport;
    if (!vv) return; // default fixed bottom:0 styles are fine then
    el.style.left = vv.offsetLeft + "px";
    el.style.right = "auto";
    el.style.width = vv.width + "px";
    el.style.bottom = "auto";
    el.style.top = vv.offsetTop + vv.height - el.offsetHeight + "px";
  }

  if (window.visualViewport) {
    var onVvChange = function () {
      var sheet = document.getElementById("sm-tile-picker");
      if (sheet) pinToVisualBottom(sheet);
    };
    window.visualViewport.addEventListener("scroll", onVvChange);
    window.visualViewport.addEventListener("resize", onVvChange);
  }

  /* ------------------------------------------------------------------ */
  /* 5b. Pinch-to-zoom the map (room game field / world map)             */
  /*                                                                     */
  /* Page zoom is locked (user-scalable=no), so a two-finger pinch over  */
  /* the map is translated into the client's OWN zoom by dispatching     */
  /* synthetic wheel events at the pinch centroid. Result: only the map  */
  /* zooms; the surrounding UI stays fixed. The client zooms the room on */
  /* wheel (deltaY<0 = zoom in on the standard client build); flip via   */
  /* CONFIG.invertPinch if a build inverts the sign.                     */
  /* ------------------------------------------------------------------ */

  var MAP_ZOOM_SEL =
    "section.room .game-field-container, section.world-map .map-container";
  // (map2 / app-world-map-map is intentionally excluded -- see WORLD_MAP_SEL.)
  var pinch = null; // { d, accum } while a two-finger pinch is active
  pickerInfo.lastPinch = "-"; // diagnostics

  function touchDist(a, b) {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function fireWheel(x, y, deltaY) {
    var target =
      document.elementFromPoint(x, y) || document.querySelector(MAP_ZOOM_SEL);
    if (!target) return;
    target.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        deltaX: 0,
        deltaY: deltaY,
        deltaMode: 0,
      }),
    );
  }

  document.addEventListener(
    "touchstart",
    function (e) {
      if (!CONFIG.pinchZoomMap) return;
      if (e.touches.length !== 2) {
        pinch = null;
        return;
      }
      if (!(e.target.closest && e.target.closest(MAP_ZOOM_SEL))) return;
      pinch = { d: touchDist(e.touches[0], e.touches[1]), accum: 0 };
      // Own the gesture: no client pan, no browser default.
      e.preventDefault();
      e.stopPropagation();
    },
    { capture: true, passive: false },
  );

  document.addEventListener(
    "touchmove",
    function (e) {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      e.stopPropagation();
      var a = e.touches[0],
        b = e.touches[1];
      var nd = touchDist(a, b);
      var cx = (a.clientX + b.clientX) / 2;
      var cy = (a.clientY + b.clientY) / 2;
      pinch.accum += nd - pinch.d; // fingers apart (+) = zoom in
      pinch.d = nd;
      pickerInfo.lastPinch = Math.round(nd) + "px acc=" + Math.round(pinch.accum);
      var step = CONFIG.pinchStepPx;
      while (Math.abs(pinch.accum) >= step) {
        var zoomIn = pinch.accum > 0;
        pinch.accum += zoomIn ? -step : step;
        var dir = zoomIn ? -1 : 1;
        if (CONFIG.invertPinch) dir = -dir;
        fireWheel(cx, cy, dir * CONFIG.wheelDelta);
      }
    },
    { capture: true, passive: false },
  );

  function endPinch(e) {
    if (!pinch) return;
    if (!e.touches || e.touches.length < 2) pinch = null;
  }
  document.addEventListener("touchend", endPinch, {
    capture: true,
    passive: true,
  });
  document.addEventListener("touchcancel", endPinch, {
    capture: true,
    passive: true,
  });

  /* ------------------------------------------------------------------ */
  /* 5c. World-map touch pan bridge                                      */
  /*                                                                     */
  /* The client's world map pans on MOUSE drag (mousedown on the map ->  */
  /* mousemove/mouseup on document) but has no touch handling, so a      */
  /* finger drag does nothing. We bridge a single-finger touch to that   */
  /* mouse sequence (same technique as the resize handle). A tap with no */
  /* drag is forwarded as a click so tapping a room still navigates.     */
  /* Two-finger gestures are left to the pinch-zoom bridge (5b).         */
  /* ------------------------------------------------------------------ */

  // Old world map only. map2 (#!/map2) is intentionally NOT bridged: it is
  // an app2 WebGL component whose drag-pan relies on real pointer-capture
  // semantics that synthetic mouse/pointer events do not satisfy -- injected
  // events were misread as a room click (accidental navigation) instead of a
  // pan (verified across 0.6.2-0.6.4). Use #!/map on mobile for a pannable
  // map, or see the deeper Angular-component route noted in the README.
  var WORLD_MAP_SEL = "section.world-map .map-container";
  var wmPan = null;

  document.addEventListener(
    "touchstart",
    function (e) {
      if (!CONFIG.worldMapPan) return;
      if (e.touches.length !== 1) {
        // A second finger (pinch) ends any active pan cleanly.
        if (wmPan) {
          fireMouse("mouseup", wmPan.target, e.touches[0] || wmPan.last);
          wmPan = null;
        }
        return;
      }
      if (!(e.target.closest && e.target.closest(WORLD_MAP_SEL))) return;
      var t = e.touches[0];
      wmPan = { target: e.target, x: t.clientX, y: t.clientY, moved: false, last: t };
      e.preventDefault(); // own the gesture; we synthesize the mouse events
      fireMouse("mousedown", e.target, t);
    },
    { capture: true, passive: false },
  );

  document.addEventListener(
    "touchmove",
    function (e) {
      if (!wmPan || e.touches.length !== 1) return;
      var t = e.touches[0];
      wmPan.last = t;
      if (
        Math.abs(t.clientX - wmPan.x) > CONFIG.worldMapPanThreshold ||
        Math.abs(t.clientY - wmPan.y) > CONFIG.worldMapPanThreshold
      ) {
        wmPan.moved = true;
      }
      e.preventDefault(); // no page scroll while panning
      fireMouse("mousemove", wmPan.target, t);
    },
    { capture: true, passive: false },
  );

  function endWmPan(e) {
    if (!wmPan) return;
    var t = e.changedTouches && e.changedTouches[0];
    fireMouse("mouseup", wmPan.target, t || wmPan.last);
    if (!wmPan.moved) fireMouse("click", wmPan.target, t || wmPan.last);
    pickerInfo.lastWmPan = wmPan.moved ? "drag" : "tap";
    wmPan = null;
  }
  document.addEventListener("touchend", endWmPan, {
    capture: true,
    passive: true,
  });
  document.addEventListener("touchcancel", endWmPan, {
    capture: true,
    passive: true,
  });

  /* ------------------------------------------------------------------ */
  /* 5c-2. map2 (alpha world map) touch pan + pinch zoom                 */
  /*                                                                     */
  /* map2 is an app2/Angular + PIXI component. Synthetic pointer/mouse/  */
  /* touch events never drove its drag-pan -- they were misread as a     */
  /* room click, causing accidental navigation (0.6.2-0.6.4). Instead we */
  /* call the component's OWN model API directly, so NO synthetic events */
  /* exist and a room click can never be spoofed:                        */
  /*   BaseComponent.onChangeCenter([x,y]) -> pan (updates URL + model)  */
  /*   BaseComponent.onChangeScale(scale)  -> zoom                        */
  /*   MapContainer.setCenter([x,y]) / setScale(s) -> immediate render    */
  /* The instances are read live via the legacy ng.probe() debug API.    */
  /* Pixels<->rooms is derived from MapContainer.getBound() at gesture    */
  /* start, so it is correct at any zoom. A single-finger tap under the   */
  /* drag threshold is left untouched, so tapping a room still navigates  */
  /* through the client's native handler.                                */
  /* ------------------------------------------------------------------ */

  var MAP2_MIN_SCALE = 0.4,
    MAP2_MAX_SCALE = 5;
  pickerInfo.lastMap2 = "-"; // diagnostics

  function onMap2() {
    return (location.hash || "").indexOf("#!/map2") === 0;
  }

  // Resolve the live map2 component instances via the legacy ng.probe API.
  function map2Ctx() {
    if (!window.ng || typeof window.ng.probe !== "function") return null;
    var base = null,
      mc = null;
    try {
      var baseEl = document.querySelector("app-world-map-base");
      var d = baseEl && window.ng.probe(baseEl);
      base = (d && d.componentInstance) || null;
    } catch (e) {}
    try {
      if (base && base.mapRef && base.mapRef.screepsMap)
        mc = base.mapRef.screepsMap._mapContainer || null;
      if (!mc) {
        var mapEl = document.querySelector("app-world-map-map");
        var dm = mapEl && window.ng.probe(mapEl);
        var mapComp = dm && dm.componentInstance;
        if (mapComp && mapComp.screepsMap)
          mc = mapComp.screepsMap._mapContainer || null;
      }
    } catch (e) {}
    if (!base && !mc) return null;
    return { base: base, mc: mc };
  }

  // px-per-room at the current zoom, from the live visible bound. getBound()
  // returns the room rectangle plus a +2 padding, so the visible span is
  // (width-2) rooms across _width px.
  function map2PxPerRoom(mc) {
    try {
      var b = mc && mc.getBound();
      if (!b) return null;
      var px = [];
      if (b.width > 2) px.push(mc._width / (b.width - 2));
      if (b.height > 2) px.push(mc._height / (b.height - 2));
      if (!px.length) return null;
      return (
        px.reduce(function (a, c) {
          return a + c;
        }, 0) / px.length
      );
    } catch (e) {
      return null;
    }
  }

  function map2Center(ctx) {
    try {
      var c = ctx.mc && ctx.mc.getCenter && ctx.mc.getCenter();
      if (c && c.length === 2) return [c[0], c[1]];
    } catch (e) {}
    return null;
  }
  function map2Scale(ctx) {
    try {
      if (ctx.mc && ctx.mc._scaleSbj) return ctx.mc._scaleSbj.getValue();
    } catch (e) {}
    try {
      if (ctx.base && ctx.base._scaleSbj) return ctx.base._scaleSbj.getValue();
    } catch (e) {}
    return null;
  }
  // After moving/zooming the container, re-run the room/stat/user draw
  // pipeline for the new view. Normally the map emits its bound and
  // BaseComponent.onBound() redraws; we bypass that path, so drive it
  // ourselves with the container's live bound ({x,y,width,height}).
  function map2Redraw(ctx) {
    try {
      if (ctx.base && ctx.base.onBound && ctx.mc && ctx.mc.getBound) {
        var b = ctx.mc.getBound();
        if (b) ctx.base.onBound(b);
      }
    } catch (e) {}
  }
  function map2SetCenter(ctx, xy) {
    // setCenter takes an array [x,y] (matches getCenter). We deliberately do
    // NOT call base.onChangeCenter: its source stores center as a joined
    // STRING (and its route update is commented out), which would corrupt
    // the container's numeric center if fed back.
    try {
      if (ctx.mc && ctx.mc.setCenter) ctx.mc.setCenter(xy);
    } catch (e) {}
    map2Redraw(ctx);
  }
  function map2SetScale(ctx, s) {
    try {
      if (ctx.mc && ctx.mc.setScale) ctx.mc.setScale(s);
    } catch (e) {}
    // Keep the settings panel's scale % in sync (numeric, no corruption).
    try {
      if (ctx.base && ctx.base.onChangeScale) ctx.base.onChangeScale(s);
    } catch (e) {}
    map2Redraw(ctx);
  }

  var m2 = null; // active map2 gesture state

  document.addEventListener(
    "touchstart",
    function (e) {
      if (!CONFIG.map2Pan && !CONFIG.map2Zoom) return;
      if (!onMap2()) return;
      if (!(e.target.closest && e.target.closest("app-world-map-base"))) return;
      var ctx = map2Ctx();
      if (!ctx) return;

      if (e.touches.length === 2 && CONFIG.map2Zoom) {
        var a = e.touches[0],
          b = e.touches[1];
        m2 = {
          mode: "pinch",
          ctx: ctx,
          startDist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
          startScale: map2Scale(ctx) || 1,
        };
        pickerInfo.lastMap2 = "pinch start s=" + m2.startScale;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.touches.length === 1 && CONFIG.map2Pan) {
        var t = e.touches[0];
        m2 = {
          mode: "pan",
          ctx: ctx,
          x: t.clientX,
          y: t.clientY,
          startCenter: map2Center(ctx),
          pxPerRoom: map2PxPerRoom(ctx.mc),
          moved: false,
        };
        pickerInfo.lastMap2 =
          "pan start c=" +
          JSON.stringify(m2.startCenter) +
          " ppr=" +
          (m2.pxPerRoom ? m2.pxPerRoom.toFixed(1) : "?");
        // No preventDefault yet: a tap must still reach the native room-click
        // handler. We only own the gesture once it becomes a drag.
      }
    },
    { capture: true, passive: false },
  );

  document.addEventListener(
    "touchmove",
    function (e) {
      if (!m2) return;
      var ctx = m2.ctx;

      if (m2.mode === "pinch") {
        if (e.touches.length !== 2) return;
        e.preventDefault();
        e.stopPropagation();
        var a = e.touches[0],
          b = e.touches[1];
        var d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (!(m2.startDist > 0)) return;
        var ratio = CONFIG.invertPinch ? m2.startDist / d : d / m2.startDist;
        var lo = (ctx.base && ctx.base.MIN_SCALE) || MAP2_MIN_SCALE;
        var hi = (ctx.base && ctx.base.MAX_SCALE) || MAP2_MAX_SCALE;
        var s = m2.startScale * ratio;
        s = Math.round(Math.max(lo, Math.min(hi, s)) * 100) / 100;
        map2SetScale(ctx, s);
        pickerInfo.lastMap2 = "pinch s=" + s;
        return;
      }

      // pan
      if (e.touches.length !== 1) return;
      var t = e.touches[0];
      var dx = t.clientX - m2.x;
      var dy = t.clientY - m2.y;
      if (
        !m2.moved &&
        (Math.abs(dx) > CONFIG.worldMapPanThreshold ||
          Math.abs(dy) > CONFIG.worldMapPanThreshold)
      ) {
        m2.moved = true;
      }
      if (!m2.moved) return; // still a potential tap; leave it to the client
      e.preventDefault(); // now a drag: own it (also cancels the native click)
      e.stopPropagation();
      if (!m2.startCenter || !m2.pxPerRoom) return;
      var ppr = m2.pxPerRoom;
      var sx = CONFIG.map2InvertX ? -dx : dx;
      var sy = CONFIG.map2InvertY ? -dy : dy;
      // Drag right -> reveal content to the left -> center moves left.
      var nx = m2.startCenter[0] - sx / ppr;
      var ny = m2.startCenter[1] - sy / ppr;
      map2SetCenter(ctx, [nx, ny]);
      pickerInfo.lastMap2 =
        "pan d=" +
        Math.round(dx) +
        "," +
        Math.round(dy) +
        " -> " +
        nx.toFixed(1) +
        "," +
        ny.toFixed(1);
    },
    { capture: true, passive: false },
  );

  function endMap2() {
    if (!m2) return;
    if (m2.mode === "pan") pickerInfo.lastMap2 = m2.moved ? "pan end" : "tap";
    m2 = null;
  }
  document.addEventListener("touchend", endMap2, { capture: true, passive: true });
  document.addEventListener("touchcancel", endMap2, {
    capture: true,
    passive: true,
  });

  /* ------------------------------------------------------------------ */
  /* 5d. Floating settings panel (gear): UI size + default map           */
  /*                                                                     */
  /* One bottom-right gear button opens a panel with two rows:           */
  /*   Map:  auto / classic / alpha  (see 5e for what these do)          */
  /*   Size: A- / scale / A+ / reset (rewrites the viewport meta live,   */
  /*         persisted to localStorage; scale = 1280/width, 1.0x..3.0x)  */
  /* Consolidating both here keeps a single entry point instead of       */
  /* scattered floating buttons. getMapPref/setMapPref/enforceMapPref    */
  /* live in 5e (hoisted); this is why buildSettings() is CALLED from    */
  /* the end of 5e, once those and their localStorage key exist.         */
  /* ------------------------------------------------------------------ */

  function buildSettings() {
    var showSize = CONFIG.sizeControl;
    var showMap = CONFIG.mapDefaultToggle;
    if (!showSize && !showMap) return;
    if (!document.body || document.getElementById("sm-settings")) return;

    function mkBtn(txt, big) {
      var b = document.createElement("button");
      b.textContent = txt;
      b.style.cssText =
        "min-width:34px;height:34px;padding:0 8px;color:#eee;" +
        "background:#3a3a3a;border:1px solid #666;border-radius:6px;font:" +
        (big ? "18px" : "13px") +
        "/1 sans-serif;";
      return b;
    }
    function mkRow(labelText) {
      var row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:6px;";
      var l = document.createElement("span");
      l.textContent = labelText;
      l.style.cssText = "min-width:40px;color:#9bd;font:12px/1 sans-serif;";
      row.appendChild(l);
      return row;
    }

    var wrap = document.createElement("div");
    wrap.id = "sm-settings";
    wrap.style.cssText =
      "position:fixed;right:" +
      CONFIG.sizeControlRight +
      "px;bottom:" +
      CONFIG.sizeControlBottom +
      "px;z-index:99990;display:flex;flex-direction:column;" +
      "align-items:flex-end;gap:6px;";

    var panel = document.createElement("div");
    panel.style.cssText =
      "display:none;flex-direction:column;gap:8px;padding:8px 10px;" +
      "background:rgba(22,22,22,0.96);border:1px solid #666;border-radius:10px;";

    // --- Map row: auto / classic / alpha, highlighting the active choice.
    if (showMap) {
      var mapRow = mkRow("Map");
      var mapOpts = [
        ["auto", null],
        ["classic", "map"],
        ["alpha", "map2"],
      ];
      var mapBtns = [];
      var syncMap = function () {
        var cur = getMapPref(); // null | "map" | "map2"
        mapBtns.forEach(function (b) {
          var on = (b.getAttribute("data-pref") || "") === (cur || "");
          b.style.background = on ? "#2d6cdf" : "#3a3a3a";
          b.style.borderColor = on ? "#5a8ff0" : "#666";
        });
      };
      mapOpts.forEach(function (o) {
        var b = mkBtn(o[0], false);
        b.setAttribute("data-pref", o[1] || "");
        b.addEventListener("click", function () {
          setMapPref(o[1]);
          syncMap();
          enforceMapPref();
        });
        mapBtns.push(b);
        mapRow.appendChild(b);
      });
      syncMap();
      panel.appendChild(mapRow);
    }

    // --- Size row: A- / scale / A+ / reset.
    if (showSize) {
      var sizeRow = mkRow("Size");
      var minus = mkBtn("A−", true);
      var label = document.createElement("span");
      label.style.cssText =
        "min-width:44px;text-align:center;color:#ddd;font:15px/1 sans-serif;";
      var plus = mkBtn("A＋", true);
      var reset = mkBtn("↺", true);
      var refresh = function () {
        label.textContent = (1280 / smCurrentWidth()).toFixed(1) + "×";
      };
      var step = function (deltaScale) {
        var s = 1280 / smCurrentWidth();
        s = Math.max(1.0, Math.min(3.0, Math.round((s + deltaScale) * 10) / 10));
        smApplyViewport(smClampWidth(1280 / s), true);
        refresh();
      };
      minus.addEventListener("click", function () {
        step(-0.1);
      });
      plus.addEventListener("click", function () {
        step(0.1);
      });
      reset.addEventListener("click", function () {
        smApplyViewport(smClampWidth(CONFIG.viewportWidth || 1280), true);
        refresh();
      });
      refresh();
      sizeRow.appendChild(minus);
      sizeRow.appendChild(label);
      sizeRow.appendChild(plus);
      sizeRow.appendChild(reset);
      panel.appendChild(sizeRow);
    }

    var toggle = mkBtn("⚙", true);
    toggle.style.borderRadius = "50%";
    toggle.style.opacity = "0.85";
    toggle.addEventListener("click", function () {
      var open = panel.style.display !== "none";
      panel.style.display = open ? "none" : "flex";
    });

    wrap.appendChild(panel);
    wrap.appendChild(toggle);
    document.body.appendChild(wrap);
  }

  /* ------------------------------------------------------------------ */
  /* 5e. Default world-map preference (classic #!/map <-> alpha #!/map2)  */
  /*                                                                     */
  /* Screeps has two separate world-map apps. The preference (set from   */
  /* the gear panel's Map row, 5d) is remembered in                      */
  /* localStorage["sm.defaultMap"]; once set (not "auto") every route to */
  /* the other map is steered to your choice. Two entry points are       */
  /* covered: the hamburger menu's World item and the room view's globe  */
  /* button -- both are hashbang <a> links, so a capture-phase click      */
  /* interceptor rewrites them BEFORE the wrong app loads (avoiding the   */
  /* "classic flashes, flips to alpha on touch" bug). A hashchange        */
  /* listener is the fallback for direct-URL / programmatic navigation.  */
  /* classic and alpha use different suffix formats (alpha: ?pos=x,y),    */
  /* so conversion keeps only the shard (+ pos into alpha) to never       */
  /* produce a route the target app can't parse.                         */
  /* ------------------------------------------------------------------ */

  var MAP_PREF_KEY = "sm.defaultMap";
  function getMapPref() {
    try {
      var v = localStorage.getItem(MAP_PREF_KEY);
      return v === "map" || v === "map2" ? v : null;
    } catch (e) {
      return null;
    }
  }
  function setMapPref(v) {
    try {
      if (v) localStorage.setItem(MAP_PREF_KEY, v);
      else localStorage.removeItem(MAP_PREF_KEY);
    } catch (e) {}
  }

  // Match a world-map hash. Returns { isMap2, rest } where rest is the
  // /shard?pos=... suffix (or ""), or null if the hash isn't a map route.
  // The lookahead keeps #!/market etc. from matching.
  function parseMapHash(hash) {
    var m = (hash || "").match(/^#!\/map(2)?($|[\/?].*)$/);
    return m ? { isMap2: m[1] === "2", rest: m[2] || "" } : null;
  }
  // Build a valid hash for the preferred map from an arbitrary map suffix.
  // Keeps the shard; carries a pos only into alpha (its ?pos= scheme). This
  // avoids emitting e.g. #!/map2/shard/W1N1 (a room-name path alpha can't
  // read) when swapping from the classic map's format.
  function buildMapTarget(want2, rest) {
    var shard = "";
    var sm = (rest || "").match(/^\/([^/?#]+)/);
    if (sm) shard = sm[1];
    var pos = "";
    var pm = (rest || "").match(/[?&]pos=([^&#]+)/);
    if (pm) pos = pm[1];
    var t = "#!/map" + (want2 ? "2" : "");
    if (shard) t += "/" + shard;
    if (want2 && pos) t += "?pos=" + pos;
    return t;
  }
  function enforceMapPref() {
    var pref = getMapPref();
    if (!pref) return; // "auto": leave the client's navigation alone
    var r = parseMapHash(location.hash);
    if (!r) return; // not on a world map right now
    if (r.isMap2 === (pref === "map2")) return; // already the preferred map
    // Fallback path (direct URL entry, programmatic nav).
    location.replace(buildMapTarget(pref === "map2", r.rest));
  }
  window.addEventListener("hashchange", enforceMapPref);
  enforceMapPref(); // apply on initial load too

  // Extract the shard token from the current hash (room / map route).
  function currentShard() {
    var m = (location.hash || "").match(/(shard[^/?#]+)/i);
    return m ? m[1] : "";
  }
  // Build an alpha-map hash for the room currently being viewed. The room
  // name in the hash (e.g. E7S5 / W44N22) maps to the alpha map's pos=x,y
  // using the client's own convention: E/S positive, W/N negative, room
  // centre +0.5 -- so goToMap()'s pos is reproduced exactly.
  function roomToMap2Hash() {
    var shard = currentShard();
    var t = "#!/map2" + (shard ? "/" + shard : "");
    var rm = (location.hash || "").match(/([WE])(\d+)([NS])(\d+)/i);
    if (rm) {
      var x = (rm[1].toUpperCase() === "E" ? 1 : -1) * (parseInt(rm[2], 10) + 0.5);
      var y = (rm[3].toUpperCase() === "S" ? 1 : -1) * (parseInt(rm[4], 10) + 0.5);
      t += "?pos=" + x + "," + y;
    }
    return t;
  }

  // Primary path: rewrite the navigation BEFORE the wrong map ever loads.
  // Two entry points, two shapes:
  //  (a) hashbang <a> links -- the hamburger menu's World item;
  //  (b) the room view's globe <button ng-click="Room.goToMap()"> -- not an
  //      anchor, and it always targets the CLASSIC map, which the old
  //      AngularJS client then refuses to hand off to the unknown /map2 route
  //      (so a post-hoc redirect leaves you stuck on classic).
  // Capture phase runs before the link/ng-click handler, so preventing it and
  // navigating straight to the preferred hash lands on the right app cleanly.
  document.addEventListener(
    "click",
    function (e) {
      var pref = getMapPref();
      if (!pref) return;
      var want2 = pref === "map2";

      // (a) hashbang anchor map links.
      var a = e.target.closest && e.target.closest("a[href]");
      if (a) {
        var href = a.getAttribute("href") || "";
        var hash = href.indexOf("#") >= 0 ? href.slice(href.indexOf("#")) : "";
        var r = parseMapHash(hash);
        if (r && r.isMap2 !== want2) {
          e.preventDefault();
          e.stopPropagation();
          location.hash = buildMapTarget(want2, r.rest);
          return;
        }
      }

      // (b) room globe button -> goToMap() (classic). Only redirect to alpha.
      if (want2) {
        var g = e.target.closest && e.target.closest("[ng-click]");
        var ngc = (g && g.getAttribute("ng-click")) || "";
        if (/goToMap\b/.test(ngc)) {
          e.preventDefault();
          e.stopPropagation();
          location.hash = roomToMap2Hash();
        }
      }
    },
    true,
  );

  // Build the unified gear panel (5d) now that the map-pref helpers exist.
  buildSettings();

  /* ------------------------------------------------------------------ */
  /* 6. Diagnostics: window.__smDump() or triple-tap the navbar logo     */
  /* ------------------------------------------------------------------ */

  function dump() {
    var lines = [];
    lines.push("screeps-mobile-ux " + SM_VERSION);
    lines.push(
      "uiSize: width=" +
        smCurrentWidth() +
        " scale=" +
        (1280 / smCurrentWidth()).toFixed(2) +
        "x saved=" +
        (smSavedWidth() != null ? smSavedWidth() : "no"),
    );
    lines.push("zoomFactor: " + zoomFactor().toFixed(2));
    lines.push("ua: " + navigator.userAgent);
    lines.push(
      "inner: " +
        window.innerWidth +
        "x" +
        window.innerHeight +
        (window.visualViewport
          ? " | visual: " +
            Math.round(window.visualViewport.width) +
            "x" +
            Math.round(window.visualViewport.height) +
            " scale " +
            window.visualViewport.scale.toFixed(2)
          : ""),
    );
    var vp = document.querySelector('meta[name="viewport"]');
    lines.push(
      "viewport meta: " + (vp ? vp.getAttribute("content") : "(none)"),
    );

    var sels = [
      "header.navbar",
      ".navbar-brand",
      ".navbar-profile",
      "section.room .left-controls",
      ".editor-panel",
      ".editor-panel .resize-handle",
      ".view-popup",
      ".game-switch-container",
    ];
    sels.forEach(function (s) {
      var el = document.querySelector(s);
      if (!el) {
        lines.push(s + ": (none)");
        return;
      }
      var r = el.getBoundingClientRect();
      lines.push(
        s +
          ": x=" +
          Math.round(r.x) +
          " y=" +
          Math.round(r.y) +
          " w=" +
          Math.round(r.width) +
          " h=" +
          Math.round(r.height),
      );
    });

    // Map probe: identify the current map view (map vs map2) and the
    // container/canvas under it so pan/zoom bridges can target it.
    function desc(el) {
      var cls =
        el && typeof el.className === "string" && el.className.trim()
          ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
          : "";
      return el ? el.tagName.toLowerCase() + cls : "(none)";
    }
    lines.push("hash: " + location.hash);
    var sections = Array.prototype.slice.call(
      document.querySelectorAll("section"),
    );
    lines.push(
      "sections: " +
        (sections.map(desc).join(", ") || "(none)"),
    );
    var cx = Math.round(window.innerWidth / 2);
    var cy = Math.round(window.innerHeight / 2);
    lines.push(
      "at-center(" +
        cx +
        "," +
        cy +
        "): " +
        document.elementsFromPoint(cx, cy).slice(0, 6).map(desc).join(" | "),
    );
    var canv = document.querySelector("section canvas") || document.querySelector("canvas");
    if (canv) {
      var chain = [],
        n = canv,
        guard = 0;
      while (n && n !== document.body && guard++ < 8) {
        chain.push(desc(n));
        n = n.parentElement;
      }
      lines.push("canvas chain: " + chain.join(" < "));
    } else {
      lines.push("canvas: (none)");
    }

    // What is stacked in the top-left corner (overlap diagnosis).
    [
      [30, 21],
      [120, 21],
      [30, 70],
      [30, 120],
    ].forEach(function (p) {
      var stack = document
        .elementsFromPoint(p[0], p[1])
        .slice(0, 5)
        .map(function (el) {
          var cls =
            typeof el.className === "string" && el.className.trim()
              ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
              : "";
          return el.tagName.toLowerCase() + cls;
        });
      lines.push("at(" + p[0] + "," + p[1] + "): " + stack.join(" | "));
    });

    var roomEl = document.querySelector("section.room");
    var scope =
      window.angular && roomEl && window.angular.element(roomEl).scope();
    lines.push(
      "room scope: " +
        (scope && scope.Room
          ? "ok, objects=" +
            ((scope.Room.objects && scope.Room.objects.length) || 0) +
            ", selected=" +
            (scope.Room.selectedObject
              ? scope.Room.selectedObject.type
              : "null")
          : "none"),
    );

    lines.push(
      "selectedAction: " +
        (scope && scope.Room && scope.Room.selectedAction
          ? scope.Room.selectedAction.action
          : "n/a"),
    );
    lines.push(
      "picker: lastTile=" +
        pickerInfo.lastTile +
        " stack=" +
        pickerInfo.lastStack +
        " sheet=" +
        (document.getElementById("sm-tile-picker") ? "visible" : "hidden"),
    );
    lines.push("pinch: " + pickerInfo.lastPinch);
    lines.push(
      "wmPan: " +
        (pickerInfo.lastWmPan || "-") +
        " container=" +
        (document.querySelector(WORLD_MAP_SEL) ? "yes" : "no"),
    );
    lines.push(
      "map2: " +
        (pickerInfo.lastMap2 || "-") +
        " onMap2=" +
        (onMap2() ? "yes" : "no"),
    );
    lines.push("defaultMap pref: " + (getMapPref() || "auto"));

    var ctrl = panelCtrl();
    lines.push(
      "resize panel ctrl: " +
        (ctrl ? "ok, height=" + ctrl.ctrl.getHeight() : "none"),
    );

    // map2 (alpha world map) component probe -- only meaningful on #!/map2.
    try {
      lines.push("");
      lines.push(map2Probe());
    } catch (err) {
      lines.push("map2 probe ERROR: " + (err && err.message));
    }
    return lines.join("\n");
  }

  /* ------------------------------------------------------------------ */
  /* map2 probe: health-check for the alpha-map pan/zoom bridge (5c-2).  */
  /*                                                                     */
  /* Verifies the component instances still resolve and that the exact   */
  /* methods/values the bridge depends on are present -- so if a client  */
  /* update renames or moves them, this dump shows precisely what broke. */
  /* Reuses the same map2Ctx()/map2Center()/... helpers the bridge uses. */
  /* Open #!/map2 first, then triple-tap the burger (or __smDump()).     */
  /* ------------------------------------------------------------------ */
  function map2Probe() {
    var L = ["=== map2 probe ==="];
    L.push("hash: " + location.hash + " onMap2=" + (onMap2() ? "yes" : "no"));
    L.push(
      "ng: " +
        (window.ng
          ? "keys=" + Object.keys(window.ng).slice(0, 8).join(",")
          : typeof window.ng) +
        " | PIXI: " +
        (window.PIXI ? window.PIXI.VERSION : "absent"),
    );

    var ctx = map2Ctx();
    if (!ctx) {
      L.push(
        "ctx: NOT RESOLVED (ng.probe / app-world-map-base missing) -- open #!/map2",
      );
      return L.join("\n");
    }
    var base = ctx.base,
      mc = ctx.mc;
    L.push(
      "base: " +
        (base ? base.constructor && base.constructor.name : "null") +
        " | container: " +
        (mc ? mc.constructor && mc.constructor.name : "null"),
    );

    // Live values the pan/zoom math relies on.
    var bound = null;
    try {
      bound = mc && mc.getBound && mc.getBound();
    } catch (e) {}
    var ppr = map2PxPerRoom(mc);
    L.push(
      "center=" +
        JSON.stringify(map2Center(ctx)) +
        " scale=" +
        JSON.stringify(map2Scale(ctx)),
    );
    L.push(
      "bound=" + JSON.stringify(bound) + " pxPerRoom=" + (ppr ? ppr.toFixed(2) : "?"),
    );

    // Presence of the exact methods the bridge calls (y = ok, N = missing).
    function has(o, m) {
      return o && typeof o[m] === "function" ? "y" : "N";
    }
    L.push(
      "methods base.onBound=" +
        has(base, "onBound") +
        " base.onChangeScale=" +
        has(base, "onChangeScale") +
        " | mc.setCenter=" +
        has(mc, "setCenter") +
        " mc.setScale=" +
        has(mc, "setScale") +
        " mc.getCenter=" +
        has(mc, "getCenter") +
        " mc.getBound=" +
        has(mc, "getBound"),
    );
    return L.join("\n");
  }

  /* ------------------------------------------------------------------ */
  /* room-edge navigation probe (0.8.6 diagnostic)                       */
  /*                                                                     */
  /* PC: hovering near a room game-field edge reveals a "go to neighbor  */
  /* room" affordance; clicking it navigates. Touch fires no hover, so a */
  /* tap does nothing. Before building the touch bridge we must confirm  */
  /* the exact client mechanism ON A REAL DEVICE (screeps.com is blocked */
  /* from the build env). Two probes, run from the diagnostic overlay:   */
  /*   Edge probe  -- non-destructive: for each of the 4 field edges,    */
  /*     dump the stacked elements BEFORE and AFTER a synthetic          */
  /*     mouseover+mousemove, so a hover-revealed arrow/overlay shows up  */
  /*     as a diff; also list Room-scope nav-ish keys/methods.           */
  /*   Test ->nav -- drives the full PC gesture (mouseover+mousemove ->  */
  /*     mousedown/up/click) at the right edge and reports whether        */
  /*     location.hash changed to a neighbor room (= approach A works).   */
  /* ------------------------------------------------------------------ */

  function smElDesc(el) {
    if (!el || el.nodeType !== 1) return "(none)";
    var cls =
      typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\s+/).slice(0, 4).join(".")
        : "";
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + cls;
  }
  function smStackAt(x, y) {
    return document
      .elementsFromPoint(x, y)
      .slice(0, 6)
      .map(smElDesc);
  }
  function smFireMouseAt(x, y, type) {
    var tgt = document.elementFromPoint(x, y);
    if (!tgt) return null;
    tgt.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        clientX: x,
        clientY: y,
      }),
    );
    return tgt;
  }

  // Non-destructive: hover each edge, diff the stacked elements. Async (waits
  // two frames after each hover so an Angular-rendered arrow can appear).
  function roomEdgeProbe(done) {
    var L = ["=== room-edge probe " + SM_VERSION + " ==="];
    L.push("hash: " + location.hash);
    var field = document.querySelector("section.room .game-field-container");
    var cursor = document.querySelector("section.room .cursor-layer");
    if (!field) {
      L.push("game-field-container: (none) -- open a room first");
      done(L.join("\n"));
      return;
    }
    var r = field.getBoundingClientRect();
    L.push(
      "field: " +
        smElDesc(field) +
        " rect x=" +
        Math.round(r.x) +
        " y=" +
        Math.round(r.y) +
        " w=" +
        Math.round(r.width) +
        " h=" +
        Math.round(r.height),
    );
    L.push("cursor-layer: " + smElDesc(cursor));
    L.push(
      "field children: " +
        (Array.prototype.slice.call(field.children).map(smElDesc).join(", ") ||
          "(none)"),
    );

    // Room-scope keys that could be the neighbor-room navigation hook.
    var scope = getRoomScope();
    if (scope && scope.Room) {
      var keys = [];
      for (var k in scope.Room) {
        if (/go|exit|nav|hover|arrow|edge|adjac|neighbo|goto/i.test(k)) {
          var isFn = false;
          try {
            isFn = typeof scope.Room[k] === "function";
          } catch (e) {}
          keys.push(k + (isFn ? "()" : ""));
        }
      }
      L.push("Room keys(nav-ish): " + (keys.join(", ") || "(none matched)"));
    } else {
      L.push("Room scope: none");
    }

    var inset = 5;
    var cx = r.left + r.width / 2,
      cy = r.top + r.height / 2;
    var edges = [
      ["L", r.left + inset, cy],
      ["R", r.right - inset, cy],
      ["T", cx, r.top + inset],
      ["B", cx, r.bottom - inset],
    ];
    var i = 0;
    (function step() {
      if (i >= edges.length) {
        done(L.join("\n"));
        return;
      }
      var ed = edges[i],
        name = ed[0],
        x = ed[1],
        y = ed[2];
      var before = smStackAt(x, y);
      smFireMouseAt(x, y, "mouseover");
      smFireMouseAt(x, y, "mousemove");
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          L.push(
            "[" + name + "] @" + Math.round(x) + "," + Math.round(y),
          );
          L.push("   before: " + before.join(" | "));
          L.push("   hover : " + smStackAt(x, y).join(" | "));
          i++;
          step();
        });
      });
    })();
  }

  // Destructive test: full hover+click at one edge; reports hash change.
  function testEdgeNav(dir, log) {
    var field = document.querySelector("section.room .game-field-container");
    if (!field) {
      log("navTest: no room field -- open a room first");
      return;
    }
    var r = field.getBoundingClientRect();
    var pts = {
      L: [r.left + 5, r.top + r.height / 2],
      R: [r.right - 5, r.top + r.height / 2],
      T: [r.left + r.width / 2, r.top + 5],
      B: [r.left + r.width / 2, r.bottom - 5],
    };
    var p = pts[dir] || pts.R;
    var before = location.hash;
    smFireMouseAt(p[0], p[1], "mouseover");
    smFireMouseAt(p[0], p[1], "mousemove");
    requestAnimationFrame(function () {
      smFireMouseAt(p[0], p[1], "mousedown");
      smFireMouseAt(p[0], p[1], "mouseup");
      smFireMouseAt(p[0], p[1], "click");
      setTimeout(function () {
        log(
          "navTest " +
            dir +
            ": before=" +
            before +
            " after=" +
            location.hash +
            (before !== location.hash ? "  -> NAVIGATED (approach A works)" : "  -> no change"),
        );
      }, 350);
    });
  }

  window.__smEdgeProbe = function () {
    roomEdgeProbe(function (t) {
      console.log(t);
    });
  };
  window.__smTestEdgeNav = function (dir) {
    testEdgeNav(dir || "R", function (t) {
      console.log(t);
    });
  };

  window.__smDump = function () {
    var out = dump();
    console.log(out);
    return out;
  };

  // Triple-tap the navbar burger/logo to show the dump on screen
  // (mobile browsers have no dev console without USB debugging).
  var brandTaps = [];
  document.addEventListener(
    "touchend",
    function (e) {
      if (!(e.target.closest && e.target.closest(".navbar-brand"))) return;
      var now = e.timeStamp;
      brandTaps = brandTaps.filter(function (t) {
        return now - t < 1200;
      });
      brandTaps.push(now);
      if (brandTaps.length >= 3) {
        brandTaps = [];
        e.preventDefault();
        showDumpOverlay();
      }
    },
    { passive: false, capture: true },
  );

  function showDumpOverlay() {
    var old = document.getElementById("screeps-mobile-ux-dump");
    if (old) old.remove();
    var wrap = document.createElement("div");
    wrap.id = "screeps-mobile-ux-dump";
    wrap.style.cssText =
      "position:fixed;z-index:99999;left:4%;top:6%;width:92%;height:80%;" +
      "background:#222;border:1px solid #666;border-radius:6px;padding:10px;" +
      "display:flex;flex-direction:column;gap:8px;";
    var ta = document.createElement("textarea");
    ta.style.cssText =
      "flex:1;background:#111;color:#cfc;border:none;font:14px/1.4 monospace;" +
      "white-space:pre;resize:none;";
    ta.readOnly = true;
    ta.value = dump();
    function appendLog(text) {
      ta.value += "\n" + text;
      ta.scrollTop = ta.scrollHeight;
    }
    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
    var btnCopy = document.createElement("button");
    btnCopy.textContent = "Copy";
    var btnEdge = document.createElement("button");
    btnEdge.textContent = "Edge probe";
    var btnNav = document.createElement("button");
    btnNav.textContent = "Test →nav";
    var btnClose = document.createElement("button");
    btnClose.textContent = "Close";
    [btnCopy, btnEdge, btnNav, btnClose].forEach(function (b) {
      b.style.cssText =
        "flex:1 1 auto;min-width:80px;padding:12px;font-size:16px;" +
        "background:#444;color:#eee;border:1px solid #666;border-radius:4px;";
    });
    btnCopy.addEventListener("click", function () {
      ta.select();
      if (navigator.clipboard) navigator.clipboard.writeText(ta.value);
      else document.execCommand("copy");
      btnCopy.textContent = "Copied";
    });
    btnEdge.addEventListener("click", function () {
      appendLog("\n--- running edge probe... ---");
      roomEdgeProbe(appendLog);
    });
    btnNav.addEventListener("click", function () {
      appendLog("\n--- test →nav (right edge): watch the top-left room name ---");
      testEdgeNav("R", appendLog);
    });
    btnClose.addEventListener("click", function () {
      wrap.remove();
    });
    row.appendChild(btnCopy);
    row.appendChild(btnEdge);
    row.appendChild(btnNav);
    row.appendChild(btnClose);
    wrap.appendChild(ta);
    wrap.appendChild(row);
    document.body.appendChild(wrap);
  }
})();
