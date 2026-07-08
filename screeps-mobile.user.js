// ==UserScript==
// @name         Screeps Mobile UX
// @namespace    harabi.screeps.mobile
// @version      0.6.3
// @description  Mobile UX fixes for screeps.com: touch resize for the script/console/Memory panel, same-tile object picker bottom sheet, navbar de-overlap, larger UI.
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
    // The "alpha" world map (#!/map2) is a modern app2 canvas component,
    // but (confirmed in 0.6.2) it does NOT pan/zoom via touch/pointer --
    // only mouse drag + wheel, like the old world map. So map2 is handled
    // by the same touch->mouse pan bridge (worldMapPan) and pinch->wheel
    // zoom bridge (pinchZoomMap); their selectors include app-world-map-map.
    // touch-action:none here just hands those bridges the touch stream
    // (side effect: pull-to-refresh over the map is disabled -- panning and
    // pull-to-refresh cannot coexist on the same downward drag).
    map2TouchAction: true,
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
    ' content: ""; position: absolute; top: 5px; right: 110px;' +
    " width: 64px; height: 6px; border-radius: 3px;" +
    " background: rgba(255,255,255,0.28); pointer-events: none; }\n" +
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
    /* map2 (#!/map2, the "alpha" world map): a modern app2 canvas
     * component (app-world-map-map > canvas) whose pan/zoom is mouse+wheel
     * only. touch-action:none stops the browser from claiming the touch
     * gesture so the pan/pinch bridges (5b/5c) get the raw touch stream. */
    (CONFIG.map2TouchAction
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

  if (CONFIG.viewportWidth) {
    var meta = document.querySelector('meta[name="viewport"]');
    if (meta) {
      var content = "width=" + CONFIG.viewportWidth;
      // Lock page zoom with user-scalable=no ONLY. Do NOT set
      // initial-scale/minimum-scale/maximum-scale: pinning the scale to 1
      // fights the width-based magnification and renders the UI at native
      // (tiny) size on some Android browsers, and the clamp then traps it
      // small (user can't pinch to recover). width=<n> alone provides the
      // enlargement. (Firefox Android may still allow accessibility zoom
      // regardless of user-scalable=no; that is a browser policy, not a bug.)
      if (CONFIG.lockZoom) {
        content += ",user-scalable=no";
      }
      meta.setAttribute("content", content);
    }
  }

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
    "section.room .game-field-container, section.world-map .map-container," +
    " app-world-map-map"; // last: the alpha map2 canvas host
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

  var WORLD_MAP_SEL =
    "section.world-map .map-container, app-world-map-map"; // + alpha map2
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
      // Drag handlers usually live on document; dispatch on the map target
      // so the event bubbles to both the map element and document.
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
  /* 6. Diagnostics: window.__smDump() or triple-tap the navbar logo     */
  /* ------------------------------------------------------------------ */

  function dump() {
    var lines = [];
    lines.push("screeps-mobile-ux 0.6.3");
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

    var ctrl = panelCtrl();
    lines.push(
      "resize panel ctrl: " +
        (ctrl ? "ok, height=" + ctrl.ctrl.getHeight() : "none"),
    );
    return lines.join("\n");
  }

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
    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;";
    var btnCopy = document.createElement("button");
    btnCopy.textContent = "Copy";
    var btnClose = document.createElement("button");
    btnClose.textContent = "Close";
    [btnCopy, btnClose].forEach(function (b) {
      b.style.cssText =
        "flex:1;padding:12px;font-size:16px;background:#444;color:#eee;" +
        "border:1px solid #666;border-radius:4px;";
    });
    btnCopy.addEventListener("click", function () {
      ta.select();
      if (navigator.clipboard) navigator.clipboard.writeText(ta.value);
      else document.execCommand("copy");
      btnCopy.textContent = "Copied";
    });
    btnClose.addEventListener("click", function () {
      wrap.remove();
    });
    row.appendChild(btnCopy);
    row.appendChild(btnClose);
    wrap.appendChild(ta);
    wrap.appendChild(row);
    document.body.appendChild(wrap);
  }
})();
