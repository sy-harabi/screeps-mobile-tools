// ==UserScript==
// @name         Screeps Mobile UX
// @namespace    harabi.screeps.mobile
// @version      0.4.1
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
    // why everything is tiny on phones. 850 renders the whole UI ~1.5x
    // larger (1280/850); null = leave the site default untouched.
    // Raise back toward 980 if the layout breaks at 850.
    viewportWidth: 850,
    // Extra zoom for the console/Memory panes and the room aside panel
    // (game field and script editor are left untouched). 1 = off.
    // With viewportWidth already ~1.5x, keep this at 1 so every pane
    // scales uniformly (otherwise those panes would double-scale).
    uiScale: 1,
    // Lock the browser's page zoom (user-scalable=no) so the UI can never
    // be pinch-zoomed. The map is still zoomable via the client's own
    // +/- zoom controls. Requires viewportWidth to be set.
    lockZoom: true,
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
    /* Note: we deliberately do NOT override touch-action over the map.
     * The client's native inline touch-action:none is left intact so the
     * client handles map pan/gestures itself; map zoom is via its own
     * +/- controls. Browser page zoom is locked off (see lockZoom). */
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

  new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var added = mutations[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var node = added[j];
        if (node.nodeType !== 1) continue;
        var pop =
          node.matches && node.matches(".view-popup")
            ? node
            : node.querySelector && node.querySelector(".view-popup");
        if (pop) clampIntoView(pop);
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
  /* 6. Diagnostics: window.__smDump() or triple-tap the navbar logo     */
  /* ------------------------------------------------------------------ */

  function dump() {
    var lines = [];
    lines.push("screeps-mobile-ux 0.4.1");
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
