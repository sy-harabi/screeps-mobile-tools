// ==UserScript==
// @name         Screeps Mobile UX
// @namespace    harabi.screeps.mobile
// @version      0.9.8
// @description  Mobile UX fixes for screeps.com: room-edge navigation, map touch controls, visible navbar status, spaced room controls, touch resize, same-tile picker, larger UI.
// @author       sy-harabi
// @license      MIT
// @match        https://screeps.com/*
// @run-at       document-idle
// @grant        none
// @homepageURL  https://github.com/sy-harabi/screeps-mobile-tools
// @supportURL   https://github.com/sy-harabi/screeps-mobile-tools/issues
// @downloadURL  https://raw.githubusercontent.com/sy-harabi/screeps-mobile-tools/main/screeps-mobile.user.js
// @updateURL    https://raw.githubusercontent.com/sy-harabi/screeps-mobile-tools/main/screeps-mobile.meta.js
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
 *  - Navbar: the resources, CPU, and profile indicators remain visible on
 *    touch devices so mobile users retain access to account status. The room
 *    view's `.left-controls` are offset by one 42px navbar row to clear it.
 */

(function () {
  "use strict";

  var SM_VERSION = "0.9.8";

  var CONFIG = {
    touchOnly: true,
    heightPresets: [0.35, 0.6, 0.85],
    doubleTapMs: 400,
    autoViewport: true,
    viewportRatio: 1.4,
    viewportWidth: 570,
    uiScale: 1,
    lockZoom: true,
    pinchZoomMap: true,
    pinchStepPx: 28,
    wheelDelta: 100,
    invertPinch: false,
    popupPicker: true,
    coordPicker: false,
    roomTapThreshold: 12,
    worldMapPan: true,
    worldMapPanThreshold: 5,
    map2Pan: true,
    map2Zoom: true,
    map2InvertX: false,
    map2InvertY: false,
    map2TouchAction: true,
    sizeControl: true,
    sizeControlRight: 52,
    sizeControlBottom: 8,
    mapDefaultToggle: true,
    roomEdgeNav: true,
    roomEdgeMargin: 4,
  };

  if (
    CONFIG.touchOnly &&
    window.matchMedia &&
    !window.matchMedia("(pointer: coarse)").matches
  ) {
    return;
  }

  var mq = CONFIG.touchOnly ? "@media (pointer: coarse)" : "@media all";
  var css =
    mq +
    " {\n" +
    "header.navbar .navbar-profile .username { display:inline-block;max-width:8em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle;}\n" +
    "section.room .left-controls, section.room .right-top-controls { margin-top:var(--sm-navbar-clearance,42px)!important;}\n" +
    "section.room .room-controls { box-sizing:border-box;padding-right:210px;margin-top:var(--sm-navbar-clearance,42px);}\n" +
    "section.room:has(> aside.collapsed) > .room-controls { padding-right:0;}\n" +
    "html.sm-room-touch-pending .view-popup, html.sm-room-touch-pending #sm-tile-picker { visibility:hidden!important;}\n" +
    ".view-popup { min-width:230px;z-index:100!important;}\n" +
    ".view-popup ul li { padding:14px 20px!important;font-size:20px!important;line-height:1.25;color:#ddd;}\n" +
    ".editor-panel .resize-handle::after { content:'⇕';position:absolute;top:1px;right:122px;width:40px;height:20px;line-height:20px;text-align:center;font-size:16px;color:rgba(255,255,255,.62);background:rgba(255,255,255,.13);border:1px solid rgba(255,255,255,.22);border-radius:11px;pointer-events:none;}\n" +
    "section.room .left-controls .zoom-controls .md-button { width:40px;height:40px;line-height:40px;}\n" +
    (CONFIG.uiScale !== 1
      ? ".editor-panel .tab-content .tab-pane:not(:first-child), section.room aside .aside-content { zoom:" + CONFIG.uiScale + ";}\n"
      : "") +
    (CONFIG.map2TouchAction || CONFIG.map2Pan || CONFIG.map2Zoom
      ? "app-world-map-map,app-world-map-map canvas,app-world-map-base,app-world-map-base canvas { touch-action:none!important;}\n"
      : "") +
    "}";

  var style = document.createElement("style");
  style.id = "screeps-mobile-ux-css";
  style.textContent = css;
  document.head.appendChild(style);

  var NAVBAR_CLEARANCE_VAR = "--sm-navbar-clearance";
  var NAVBAR_STATUS_SELECTORS = [".navbar-profile", ".navbar-resources", ".navbar-sysbar"];
  var smNavbarClearanceFrame = null;
  var smNavbarResizeObserver = null;

  function smNavbarClearanceForBottoms(roomTop, bottoms) {
    var top = Number(roomTop);
    if (!isFinite(top)) top = 42;
    var lowest = top;
    (bottoms || []).forEach(function (bottom) {
      var value = Number(bottom);
      if (isFinite(value) && value > lowest) lowest = value;
    });
    return Math.max(0, Math.ceil(lowest - top));
  }

  function smUpdateNavbarClearance() {
    smNavbarClearanceFrame = null;
    var room = document.querySelector("section.room");
    var header = document.querySelector("header.navbar");
    if (!room || !header) return;
    var bottoms = [];
    var headerRect = header.getBoundingClientRect();
    if (headerRect.width && headerRect.height) bottoms.push(headerRect.bottom);
    NAVBAR_STATUS_SELECTORS.forEach(function (selector) {
      var el = header.querySelector(selector);
      if (!el) return;
      var r = el.getBoundingClientRect();
      if (r.width && r.height) bottoms.push(r.bottom);
    });
    var roomTop = room.getBoundingClientRect().top;
    room.style.setProperty(NAVBAR_CLEARANCE_VAR, smNavbarClearanceForBottoms(roomTop, bottoms) + "px");
  }

  function smScheduleNavbarClearance() {
    if (smNavbarClearanceFrame != null) cancelAnimationFrame(smNavbarClearanceFrame);
    smNavbarClearanceFrame = requestAnimationFrame(smUpdateNavbarClearance);
  }

  function smObserveNavbarLayout() {
    if (smNavbarResizeObserver) smNavbarResizeObserver.disconnect();
    if (typeof ResizeObserver === "function") {
      smNavbarResizeObserver = new ResizeObserver(smScheduleNavbarClearance);
      var header = document.querySelector("header.navbar");
      if (header) {
        smNavbarResizeObserver.observe(header);
        NAVBAR_STATUS_SELECTORS.forEach(function (selector) {
          var el = header.querySelector(selector);
          if (el) smNavbarResizeObserver.observe(el);
        });
      }
    }
    smScheduleNavbarClearance();
  }

  window.addEventListener("resize", smScheduleNavbarClearance);
  window.addEventListener("orientationchange", smScheduleNavbarClearance);
  window.addEventListener("hashchange", smScheduleNavbarClearance);
  smObserveNavbarLayout();
  setTimeout(smObserveNavbarLayout, 500);

  var SIZE_LS_KEY = "sm.viewportWidth";
  function smClampWidth(w) { return Math.max(427, Math.min(1280, Math.round(w))); }
  function smAutoWidthForScreen(screenWidth, ratio, fallbackWidth) {
    var sw = Number(screenWidth), r = Number(ratio), fallback = Number(fallbackWidth);
    if (!isFinite(fallback) || fallback <= 0) fallback = 1280;
    if (!isFinite(sw) || sw <= 0 || !isFinite(r) || r <= 0) return smClampWidth(fallback);
    return smClampWidth(sw * r);
  }
  function smScreenWidth() {
    try {
      var w = Number(window.screen && window.screen.width);
      return isFinite(w) && w > 0 ? w : null;
    } catch (e) { return null; }
  }
  function smDefaultWidth() {
    var fallback = CONFIG.viewportWidth || 1280;
    return CONFIG.autoViewport ? smAutoWidthForScreen(smScreenWidth(), CONFIG.viewportRatio, fallback) : smClampWidth(fallback);
  }
  function smChooseWidth(savedWidth, defaultWidth) { return savedWidth != null ? savedWidth : defaultWidth; }
  function smSavedWidth() {
    try {
      var v = parseInt(localStorage.getItem(SIZE_LS_KEY), 10);
      if (v >= 427 && v <= 1280) return v;
    } catch (e) {}
    return null;
  }
  function smCurrentWidth() { return smChooseWidth(smSavedWidth(), smDefaultWidth()); }
  function smClearSavedWidth() { try { localStorage.removeItem(SIZE_LS_KEY); } catch (e) {} }
  function smResetViewport() { smClearSavedWidth(); smApplyViewport(smDefaultWidth(), false); }
  function smApplyViewport(width, persist) {
    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    meta.setAttribute("content", "width=" + width + (CONFIG.lockZoom ? ",user-scalable=no" : ""));
    if (persist) try { localStorage.setItem(SIZE_LS_KEY, String(width)); } catch (e) {}
    smRefreshSizeLabel();
    smScheduleNavbarClearance();
  }
  function smRefreshSizeLabel() {
    var label = document.getElementById("sm-size-label");
    if (label) label.textContent = (1280 / smCurrentWidth()).toFixed(1) + "×";
  }
  if (CONFIG.autoViewport || CONFIG.viewportWidth || smSavedWidth() != null) smApplyViewport(smCurrentWidth(), false);

  var smOrientationTimer = null;
  function smRefreshAutoViewport() {
    if (!CONFIG.autoViewport || smSavedWidth() != null) return;
    smApplyViewport(smDefaultWidth(), false);
  }
  function smScheduleAutoViewport() {
    if (smOrientationTimer != null) clearTimeout(smOrientationTimer);
    smOrientationTimer = setTimeout(smRefreshAutoViewport, 200);
  }
  window.addEventListener("orientationchange", smScheduleAutoViewport);
  if (window.screen && window.screen.orientation && window.screen.orientation.addEventListener) {
    window.screen.orientation.addEventListener("change", smScheduleAutoViewport);
  }

  var drag = null, lastTapTime = 0, presetIdx = -1;
  function fireMouse(type, target, touch) {
    target.dispatchEvent(new MouseEvent(type, { bubbles:true, cancelable:true, view:window, button:0, clientX:touch ? touch.clientX : 0, clientY:touch ? touch.clientY : 0 }));
  }
  document.addEventListener("touchstart", function (e) {
    var handle = e.target.closest && e.target.closest(".editor-panel .resize-handle");
    if (!handle || e.touches.length !== 1) return;
    e.preventDefault(); drag = { moved:false }; fireMouse("mousedown", handle, e.touches[0]);
  }, { passive:false, capture:true });
  document.addEventListener("touchmove", function (e) {
    if (!drag) return; e.preventDefault(); drag.moved = true; fireMouse("mousemove", document.documentElement, e.touches[0]);
  }, { passive:false, capture:true });
  function endDrag(e) {
    if (!drag) return;
    fireMouse("mouseup", document.documentElement, e.changedTouches[0]);
    var wasTap = !drag.moved; drag = null;
    if (wasTap) {
      var now = e.timeStamp;
      if (now - lastTapTime < CONFIG.doubleTapMs) { lastTapTime = 0; cyclePreset(); }
      else lastTapTime = now;
    }
  }
  document.addEventListener("touchend", endDrag, { passive:false, capture:true });
  document.addEventListener("touchcancel", endDrag, { passive:false, capture:true });

  function panelCtrl() {
    if (!window.angular) return null;
    var containers = document.querySelectorAll(".game-switch-container");
    for (var i = 0; i < containers.length; i++) {
      var ctrl = window.angular.element(containers[i]).controller("appResizePanel");
      if (ctrl) return { ctrl:ctrl, el:containers[i] };
    }
    return null;
  }
  function cyclePreset() {
    var found = panelCtrl(); if (!found) return;
    presetIdx = (presetIdx + 1) % CONFIG.heightPresets.length;
    var h = Math.round(window.innerHeight * CONFIG.heightPresets[presetIdx]);
    var scope = window.angular.element(found.el).scope();
    var apply = function () { found.ctrl.toggle(false); found.ctrl.setHeight(h); };
    if (scope && scope.$applyAsync) scope.$applyAsync(apply); else apply();
  }

  function clampIntoView(el) {
    requestAnimationFrame(function () {
      var r = el.getBoundingClientRect(); if (!r.width) return;
      var scaleX = el.offsetWidth ? r.width / el.offsetWidth : 1;
      var scaleY = el.offsetHeight ? r.height / el.offsetHeight : 1;
      var vv = window.visualViewport;
      var b = vv ? { left:vv.offsetLeft, top:vv.offsetTop, right:vv.offsetLeft + vv.width, bottom:vv.offsetTop + vv.height } : { left:0, top:0, right:window.innerWidth, bottom:window.innerHeight };
      var dx = 0, dy = 0;
      if (r.right > b.right) dx = b.right - r.right;
      if (r.left + dx < b.left) dx = b.left - r.left;
      if (r.bottom > b.bottom) dy = b.bottom - r.bottom;
      if (r.top + dy < b.top) dy = b.top - r.top;
      if (dx) el.style.marginLeft = dx / scaleX + "px";
      if (dy) el.style.marginTop = dy / scaleY + "px";
    });
  }

  var pickerInfo = { lastTile:"-", lastStack:-1 };
  var roomTap = null;
  var ROOM_TOUCH_PENDING_CLASS = "sm-room-touch-pending";
  var activePopup = null;

  function getRoomScope() {
    var el = document.querySelector("section.room");
    var s = el && window.angular && window.angular.element(el).scope();
    return s && s.Room ? s : null;
  }
  function sameSelectedObject(a, b) {
    if (a === b) return true;
    return !!(a && b && a._id && b._id && a._id === b._id);
  }
  function setRoomSelection(scope, obj) {
    if (!scope || !scope.Room) return;
    var selected = obj || null;
    scope.Room.selectedObject = selected;
    if (scope.$root && scope.$root.$broadcast) {
      if (scope.$root.$$phase) scope.$root.$broadcast("roomObjectSelected", selected);
      else if (scope.$root.$evalAsync) scope.$root.$evalAsync(function () { scope.$root.$broadcast("roomObjectSelected", selected); });
    }
  }

  function installRoomSelectionGate(tap, scope) {
    if (!tap || !scope || !scope.Room) return false;
    var room = scope.Room, descriptor = null;
    try {
      descriptor = Object.getOwnPropertyDescriptor(room, "selectedObject") || null;
      if (descriptor && descriptor.configurable === false) return false;
    } catch (e) { return false; }
    var root = scope.$root || null;
    var gate = { room:room, descriptor:descriptor, hadOwn:!!descriptor, previous:tap.previousSelected, root:root, originalBroadcast:root && typeof root.$broadcast === "function" ? root.$broadcast : null, broadcastWrapper:null };
    try {
      Object.defineProperty(room, "selectedObject", {
        configurable:true,
        enumerable:descriptor ? descriptor.enumerable : true,
        get:function () { return gate.previous; },
        set:function (value) { tap.candidateSelected = value || null; tap.hasCandidate = true; },
      });
    } catch (e) { return false; }
    if (gate.originalBroadcast) {
      gate.broadcastWrapper = function (name) {
        if (roomTap === tap && name === "roomObjectSelected") {
          if (arguments.length > 1) { tap.candidateSelected = arguments[1] || null; tap.hasCandidate = true; }
          return { name:name, targetScope:root, currentScope:null, defaultPrevented:false, preventDefault:function () { this.defaultPrevented = true; } };
        }
        return gate.originalBroadcast.apply(this, arguments);
      };
      try { root.$broadcast = gate.broadcastWrapper; } catch (e) { gate.broadcastWrapper = null; }
    }
    tap.selectionGate = gate;
    return true;
  }

  function releaseRoomSelectionGate(tap, commit) {
    var gate = tap && tap.selectionGate; if (!gate) return false;
    tap.selectionGate = null;
    if (gate.root && gate.broadcastWrapper && gate.root.$broadcast === gate.broadcastWrapper) {
      try { gate.root.$broadcast = gate.originalBroadcast; } catch (e) {}
    }
    try {
      if (gate.hadOwn) Object.defineProperty(gate.room, "selectedObject", gate.descriptor);
      else delete gate.room.selectedObject;
    } catch (e) {
      try { Object.defineProperty(gate.room, "selectedObject", { configurable:true, enumerable:true, writable:true, value:tap.previousSelected }); } catch (ignored) {}
    }
    var scope = getRoomScope();
    if (!scope || scope.Room !== gate.room) return true;
    if (commit && tap.hasCandidate) setRoomSelection(scope, tap.candidateSelected);
    else if (!sameSelectedObject(scope.Room.selectedObject, tap.previousSelected)) setRoomSelection(scope, tap.previousSelected);
    return true;
  }

  function sampleNativeRoomSelection(tap) {
    if (!tap || roomTap !== tap || tap.cancelled || tap.selectionGate) return;
    var scope = getRoomScope(); if (!scope) return;
    var current = scope.Room.selectedObject || null;
    if (sameSelectedObject(current, tap.previousSelected)) return;
    tap.candidateSelected = current; tap.hasCandidate = true;
    setRoomSelection(scope, tap.previousSelected);
  }

  function hideSheet() {
    var el = document.getElementById("sm-tile-picker");
    if (el) el.remove();
  }
  function dismissPopup() {
    hideSheet();
    if (activePopup && activePopup.parentNode) activePopup.remove();
    activePopup = null;
  }
  function popupLis(pop) { return Array.prototype.slice.call(pop.querySelectorAll("ul li")); }
  function clickLi(li) {
    ["mousedown", "mouseup", "click"].forEach(function (type) {
      li.dispatchEvent(new MouseEvent(type, { bubbles:true, cancelable:true, view:window, button:0 }));
    });
  }
  function mirrorPopupToSheet(pop) {
    var tries = 0;
    (function attempt() {
      var items = popupLis(pop);
      pickerInfo.lastStack = items.length;
      if (items.length >= 2) {
        activePopup = pop;
        pop.style.visibility = "hidden";
        renderSheetFromLis(items);
      } else if (items.length === 0 && tries++ < 3 && pop.parentNode) requestAnimationFrame(attempt);
    })();
  }

  function scheduleNativePopupCheck(tap) {
    var previousPopup = tap && tap.previousPopup;
    var tries = 0;
    function finish(pop) {
      if (pop) {
        if (previousPopup && previousPopup !== pop && previousPopup.parentNode) previousPopup.remove();
        clampIntoView(pop);
        if (CONFIG.popupPicker) mirrorPopupToSheet(pop);
        return;
      }
      var scope = getRoomScope();
      var unchanged = scope && sameSelectedObject(scope.Room.selectedObject, tap.previousSelected);
      if (previousPopup && previousPopup.parentNode && unchanged) {
        clampIntoView(previousPopup);
        if (CONFIG.popupPicker) mirrorPopupToSheet(previousPopup);
      } else {
        if (previousPopup && previousPopup.parentNode) previousPopup.remove();
        if (activePopup === previousPopup) activePopup = null;
        hideSheet();
      }
    }
    function check() {
      var pops = document.querySelectorAll(".view-popup");
      var fresh = null;
      for (var i = 0; i < pops.length; i++) {
        if (pops[i] !== previousPopup) { fresh = pops[i]; break; }
      }
      if (fresh) { finish(fresh); return; }
      if (tries++ < 3) requestAnimationFrame(check);
      else finish(null);
    }
    requestAnimationFrame(check);
  }

  function cancelRoomSelection(tap, reason) {
    if (!tap) return;
    tap.moved = true; tap.cancelled = true; pickerInfo.lastRoomTap = reason || "cancel";
    if (!tap.selectionGate) {
      var scope = getRoomScope();
      if (scope && !sameSelectedObject(scope.Room.selectedObject, tap.previousSelected)) setRoomSelection(scope, tap.previousSelected);
    }
    dismissPopup();
  }

  function scheduleRoomTouchFinalize(tap, commit) {
    if (!tap || tap.finalizeScheduled) return;
    tap.finalizeScheduled = true;
    var finish = function () {
      if (roomTap !== tap) return;
      if (!tap.selectionGate && !tap.cancelled) sampleNativeRoomSelection(tap);
      roomTap = null;
      document.documentElement.classList.remove(ROOM_TOUCH_PENDING_CLASS);
      if (tap.selectionGate) releaseRoomSelectionGate(tap, commit);
      else if (commit) {
        var scopeCommit = getRoomScope();
        if (scopeCommit && tap.hasCandidate) setRoomSelection(scopeCommit, tap.candidateSelected);
      } else {
        var scopeCancelled = getRoomScope();
        if (scopeCancelled && !sameSelectedObject(scopeCancelled.Room.selectedObject, tap.previousSelected)) setRoomSelection(scopeCancelled, tap.previousSelected);
      }
      if (commit) scheduleNativePopupCheck(tap); else dismissPopup();
    };
    if (typeof queueMicrotask === "function") queueMicrotask(finish);
    else if (typeof Promise === "function") Promise.resolve().then(finish);
    else setTimeout(finish, 0);
  }

  function objectsAt(scope, x, y) {
    var Room = scope.Room;
    return [].concat(Room.objects || [], Room.flags || []).filter(function (o) {
      return o && !o.temp && o.x === x && o.y === y && !(o.type === "creep" && o.spawning) && o.type !== "wall" && o.type !== "swamp" && o.type !== "exit";
    });
  }

  document.addEventListener("touchstart", function (e) {
    if (e.touches.length !== 1) { if (roomTap) cancelRoomSelection(roomTap, "multitouch"); return; }
    if (!(e.target.closest && e.target.closest(".cursor-layer"))) return;
    var scope = getRoomScope(); if (!scope) return;
    var action = scope.Room.selectedAction && scope.Room.selectedAction.action;
    if (action && action !== "view") return;

    var previousPopup = activePopup && activePopup.parentNode ? activePopup : document.querySelector(".view-popup");
    hideSheet();
    if (previousPopup) previousPopup.style.visibility = "hidden";

    var t = e.touches[0];
    var tap = {
      x:t.clientX, y:t.clientY, moved:false, cancelled:false,
      previousSelected:scope.Room.selectedObject || null,
      candidateSelected:null, hasCandidate:false, selectionGate:null,
      finalizeScheduled:false, previousPopup:previousPopup || null,
    };
    roomTap = tap;
    document.documentElement.classList.add(ROOM_TOUCH_PENDING_CLASS);
    if (!installRoomSelectionGate(tap, scope)) {
      var sample = function () { sampleNativeRoomSelection(tap); };
      if (typeof queueMicrotask === "function") queueMicrotask(sample);
      else if (typeof Promise === "function") Promise.resolve().then(sample);
      else setTimeout(sample, 0);
      requestAnimationFrame(sample);
    }
  }, { passive:true, capture:true });

  document.addEventListener("touchmove", function (e) {
    if (!roomTap) return;
    if (e.touches.length !== 1) { cancelRoomSelection(roomTap, "pinch"); return; }
    var t = e.touches[0];
    if (Math.abs(t.clientX - roomTap.x) > CONFIG.roomTapThreshold || Math.abs(t.clientY - roomTap.y) > CONFIG.roomTapThreshold) cancelRoomSelection(roomTap, "pan");
  }, { passive:true, capture:true });

  document.addEventListener("touchend", function (e) {
    var tap = roomTap; if (!tap) return;
    if (!tap.selectionGate && !tap.cancelled) sampleNativeRoomSelection(tap);
    if (tap.cancelled && e.touches && e.touches.length > 0) return;
    var wasTap = !tap.moved && !tap.cancelled && e.changedTouches.length === 1 && (!e.touches || e.touches.length === 0);
    pickerInfo.lastRoomTap = wasTap ? "tap" : pickerInfo.lastRoomTap || "cancel";
    scheduleRoomTouchFinalize(tap, wasTap);
    if (!wasTap || !CONFIG.coordPicker) return;
    var layer = e.target.closest && e.target.closest(".cursor-layer");
    var scope = getRoomScope(); if (!layer || !scope) return;
    var action = scope.Room.selectedAction && scope.Room.selectedAction.action;
    if (action && action !== "view") return;
    var r = layer.getBoundingClientRect(); if (!r.width || !r.height) return;
    var t = e.changedTouches[0];
    var tx = Math.floor(((t.clientX - r.left) / r.width) * 50);
    var ty = Math.floor(((t.clientY - r.top) / r.height) * 50);
    if (tx < 0 || tx > 49 || ty < 0 || ty > 49) return;
    setTimeout(function () { maybeShowSheet(tx, ty); }, 150);
  }, { passive:true, capture:true });

  document.addEventListener("touchcancel", function (e) {
    var tap = roomTap; if (!tap) return;
    cancelRoomSelection(tap, "touchcancel");
    if (e.touches && e.touches.length > 0) return;
    scheduleRoomTouchFinalize(tap, false);
  }, { passive:true, capture:true });

  function maybeShowSheet(x, y) {
    var scope = getRoomScope(); pickerInfo.lastTile = x + "," + y;
    if (!scope) { pickerInfo.lastStack = -1; hideSheet(); return; }
    var objs = objectsAt(scope, x, y); pickerInfo.lastStack = objs.length;
    if (objs.length < 2) { hideSheet(); return; }
    renderSheet(scope, objs, x, y);
  }
  function objLabel(o) {
    var label = o.type === "energy" ? "resource" : o.type;
    if (o.name && o.type !== "controller") {
      var name = String(o.name); if (name.length > 14) name = name.slice(0, 13) + "…";
      label += " " + name;
    }
    return label;
  }
  function renderSheet(scope, objs, x, y) {
    hideSheet();
    var vw = window.visualViewport ? window.visualViewport.width : window.innerWidth;
    var fs = Math.max(14, Math.round(vw / 34));
    var wrap = document.createElement("div"); wrap.id = "sm-tile-picker";
    wrap.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:9998;display:flex;align-items:stretch;gap:8px;padding:10px;background:rgba(22,22,22,.96);border-top:1px solid #555;overflow-x:auto;-webkit-overflow-scrolling:touch;font-size:" + fs + "px;";
    var title = document.createElement("div"); title.textContent = x + "," + y; title.style.cssText = "flex:0 0 auto;align-self:center;color:#888;padding:0 4px;font-size:.75em;"; wrap.appendChild(title);
    var selectedId = scope.Room.selectedObject && scope.Room.selectedObject._id;
    objs.forEach(function (o) {
      var btn = document.createElement("button"); btn.textContent = objLabel(o);
      var active = o._id && o._id === selectedId;
      btn.style.cssText = "flex:0 0 auto;padding:.55em .9em;font-size:1em;color:#eee;border-radius:6px;white-space:nowrap;" + (active ? "background:#2e3550;border:1px solid #6374d0;" : "background:#3a3a3a;border:1px solid #666;");
      btn.addEventListener("click", function () {
        scope.$applyAsync(function () { scope.Room.selectedObject = o; if (scope.$root) scope.$root.$broadcast("roomObjectSelected", o); });
        renderSheet(scope, objs, x, y);
      });
      wrap.appendChild(btn);
    });
    var close = document.createElement("button"); close.textContent = "✕"; close.style.cssText = "flex:0 0 auto;padding:.55em .9em;font-size:1em;color:#aaa;background:transparent;border:1px solid #555;border-radius:6px;margin-left:auto;"; close.addEventListener("click", hideSheet); wrap.appendChild(close);
    document.body.appendChild(wrap); pinToVisualBottom(wrap);
  }

  function renderSheetFromLis(items) {
    hideSheet();
    var vw = window.visualViewport ? window.visualViewport.width : window.innerWidth;
    var fs = Math.max(14, Math.round(vw / 34));
    var wrap = document.createElement("div"); wrap.id = "sm-tile-picker";
    wrap.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:9998;display:flex;align-items:stretch;gap:8px;padding:10px;background:rgba(22,22,22,.96);border-top:1px solid #555;overflow-x:auto;-webkit-overflow-scrolling:touch;font-size:" + fs + "px;";
    items.forEach(function (li) {
      var label = (li.textContent || "").replace(/\s+/g, " ").trim() || "object";
      var btn = document.createElement("button"); btn.textContent = label;
      btn.style.cssText = "flex:0 0 auto;padding:.55em .9em;font-size:1em;color:#eee;border-radius:6px;white-space:nowrap;background:#3a3a3a;border:1px solid #666;";
      btn.addEventListener("click", function () { clickLi(li); dismissPopup(); });
      wrap.appendChild(btn);
    });
    var close = document.createElement("button"); close.textContent = "✕"; close.style.cssText = "flex:0 0 auto;padding:.55em .9em;font-size:1em;color:#aaa;background:transparent;border:1px solid #555;border-radius:6px;margin-left:auto;"; close.addEventListener("click", dismissPopup); wrap.appendChild(close);
    document.body.appendChild(wrap); pinToVisualBottom(wrap);
  }

  function zoomFactor() { var vv = window.visualViewport; return vv ? window.innerWidth / vv.width : 1; }
  function pinToVisualBottom(el) {
    var vv = window.visualViewport; if (!vv) return;
    el.style.left = vv.offsetLeft + "px"; el.style.right = "auto"; el.style.width = vv.width + "px"; el.style.bottom = "auto"; el.style.top = vv.offsetTop + vv.height - el.offsetHeight + "px";
  }
  if (window.visualViewport) {
    var onVvChange = function () { var sheet = document.getElementById("sm-tile-picker"); if (sheet) pinToVisualBottom(sheet); };
    window.visualViewport.addEventListener("scroll", onVvChange);
    window.visualViewport.addEventListener("resize", onVvChange);
  }

  var MAP_ZOOM_SEL = "section.room .game-field-container, section.world-map .map-container";
  var pinch = null; pickerInfo.lastPinch = "-";
  function touchDist(a, b) { return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
  function fireWheel(x, y, deltaY) {
    var target = document.elementFromPoint(x, y) || document.querySelector(MAP_ZOOM_SEL); if (!target) return;
    target.dispatchEvent(new WheelEvent("wheel", { bubbles:true, cancelable:true, view:window, clientX:x, clientY:y, deltaX:0, deltaY:deltaY, deltaMode:0 }));
  }
  document.addEventListener("touchstart", function (e) {
    if (!CONFIG.pinchZoomMap) return;
    if (e.touches.length !== 2) { pinch = null; return; }
    if (!(e.target.closest && e.target.closest(MAP_ZOOM_SEL))) return;
    pinch = { d:touchDist(e.touches[0], e.touches[1]), accum:0 }; e.preventDefault(); e.stopPropagation();
  }, { capture:true, passive:false });
  document.addEventListener("touchmove", function (e) {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault(); e.stopPropagation();
    var a=e.touches[0], b=e.touches[1], nd=touchDist(a,b), cx=(a.clientX+b.clientX)/2, cy=(a.clientY+b.clientY)/2;
    pinch.accum += nd - pinch.d; pinch.d = nd; pickerInfo.lastPinch = Math.round(nd) + "px acc=" + Math.round(pinch.accum);
    var step = CONFIG.pinchStepPx;
    while (Math.abs(pinch.accum) >= step) {
      var zoomIn = pinch.accum > 0; pinch.accum += zoomIn ? -step : step;
      var dir = zoomIn ? -1 : 1; if (CONFIG.invertPinch) dir = -dir;
      fireWheel(cx, cy, dir * CONFIG.wheelDelta);
    }
  }, { capture:true, passive:false });
  function endPinch(e) { if (!pinch) return; if (!e.touches || e.touches.length < 2) pinch = null; }
  document.addEventListener("touchend", endPinch, { capture:true, passive:true });
  document.addEventListener("touchcancel", endPinch, { capture:true, passive:true });

  var WORLD_MAP_SEL = "section.world-map .map-container";
  var wmPan = null;
  document.addEventListener("touchstart", function (e) {
    if (!CONFIG.worldMapPan) return;
    if (e.touches.length !== 1) { if (wmPan) { fireMouse("mouseup", wmPan.target, e.touches[0] || wmPan.last); wmPan = null; } return; }
    if (!(e.target.closest && e.target.closest(WORLD_MAP_SEL))) return;
    var t=e.touches[0]; wmPan={target:e.target,x:t.clientX,y:t.clientY,moved:false,last:t}; e.preventDefault(); fireMouse("mousedown", e.target, t);
  }, { capture:true, passive:false });
  document.addEventListener("touchmove", function (e) {
    if (!wmPan || e.touches.length !== 1) return;
    var t=e.touches[0]; wmPan.last=t;
    if (Math.abs(t.clientX-wmPan.x)>CONFIG.worldMapPanThreshold || Math.abs(t.clientY-wmPan.y)>CONFIG.worldMapPanThreshold) wmPan.moved=true;
    e.preventDefault(); fireMouse("mousemove", wmPan.target, t);
  }, { capture:true, passive:false });
  function endWmPan(e) {
    if (!wmPan) return;
    var t=e.changedTouches&&e.changedTouches[0]; fireMouse("mouseup", wmPan.target, t||wmPan.last); if (!wmPan.moved) fireMouse("click", wmPan.target, t||wmPan.last);
    pickerInfo.lastWmPan = wmPan.moved ? "drag" : "tap"; wmPan=null;
  }
  document.addEventListener("touchend", endWmPan, {capture:true,passive:true});
  document.addEventListener("touchcancel", endWmPan, {capture:true,passive:true});

  var MAP2_MIN_SCALE=0.4, MAP2_MAX_SCALE=5; pickerInfo.lastMap2="-";
  function onMap2(){return(location.hash||"").indexOf("#!/map2")===0;}
  function map2Ctx(){
    if(!window.ng||typeof window.ng.probe!=="function")return null;
    var base=null,mc=null;
    try{var baseEl=document.querySelector("app-world-map-base"),d=baseEl&&window.ng.probe(baseEl);base=(d&&d.componentInstance)||null;}catch(e){}
    try{if(base&&base.mapRef&&base.mapRef.screepsMap)mc=base.mapRef.screepsMap._mapContainer||null;if(!mc){var mapEl=document.querySelector("app-world-map-map"),dm=mapEl&&window.ng.probe(mapEl),mapComp=dm&&dm.componentInstance;if(mapComp&&mapComp.screepsMap)mc=mapComp.screepsMap._mapContainer||null;}}catch(e){}
    if(!base&&!mc)return null;return{base:base,mc:mc};
  }
  function map2PxPerRoom(mc){try{var b=mc&&mc.getBound();if(!b)return null;var px=[];if(b.width>2)px.push(mc._width/(b.width-2));if(b.height>2)px.push(mc._height/(b.height-2));if(!px.length)return null;return px.reduce(function(a,c){return a+c;},0)/px.length;}catch(e){return null;}}
  function map2Center(ctx){try{var c=ctx.mc&&ctx.mc.getCenter&&ctx.mc.getCenter();if(c&&c.length===2)return[c[0],c[1]];}catch(e){}return null;}
  function map2Scale(ctx){try{if(ctx.mc&&ctx.mc._scaleSbj)return ctx.mc._scaleSbj.getValue();}catch(e){}try{if(ctx.base&&ctx.base._scaleSbj)return ctx.base._scaleSbj.getValue();}catch(e){}return null;}
  function map2Redraw(ctx){try{if(ctx.base&&ctx.base.onBound&&ctx.mc&&ctx.mc.getBound){var b=ctx.mc.getBound();if(b)ctx.base.onBound(b);}}catch(e){}}
  function map2SetCenter(ctx,xy){try{if(ctx.mc&&ctx.mc.setCenter)ctx.mc.setCenter(xy);}catch(e){}map2Redraw(ctx);}
  function map2SetScale(ctx,s){try{if(ctx.mc&&ctx.mc.setScale)ctx.mc.setScale(s);}catch(e){}try{if(ctx.base&&ctx.base.onChangeScale)ctx.base.onChangeScale(s);}catch(e){}map2Redraw(ctx);}
  var m2=null;
  document.addEventListener("touchstart",function(e){
    if(!CONFIG.map2Pan&&!CONFIG.map2Zoom)return;if(!onMap2())return;if(!(e.target.closest&&e.target.closest("app-world-map-base")))return;var ctx=map2Ctx();if(!ctx)return;
    if(e.touches.length===2&&CONFIG.map2Zoom){var a=e.touches[0],b=e.touches[1];m2={mode:"pinch",ctx:ctx,startDist:Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),startScale:map2Scale(ctx)||1};pickerInfo.lastMap2="pinch start s="+m2.startScale;e.preventDefault();e.stopPropagation();return;}
    if(e.touches.length===1&&CONFIG.map2Pan){var t=e.touches[0];m2={mode:"pan",ctx:ctx,x:t.clientX,y:t.clientY,startCenter:map2Center(ctx),pxPerRoom:map2PxPerRoom(ctx.mc),moved:false};pickerInfo.lastMap2="pan start c="+JSON.stringify(m2.startCenter)+" ppr="+(m2.pxPerRoom?m2.pxPerRoom.toFixed(1):"?");}
  },{capture:true,passive:false});
  document.addEventListener("touchmove",function(e){
    if(!m2)return;var ctx=m2.ctx;
    if(m2.mode==="pinch"){if(e.touches.length!==2)return;e.preventDefault();e.stopPropagation();var a=e.touches[0],b=e.touches[1],d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);if(!(m2.startDist>0))return;var ratio=CONFIG.invertPinch?m2.startDist/d:d/m2.startDist;var lo=(ctx.base&&ctx.base.MIN_SCALE)||MAP2_MIN_SCALE,hi=(ctx.base&&ctx.base.MAX_SCALE)||MAP2_MAX_SCALE,s=m2.startScale*ratio;s=Math.round(Math.max(lo,Math.min(hi,s))*100)/100;map2SetScale(ctx,s);pickerInfo.lastMap2="pinch s="+s;return;}
    if(e.touches.length!==1)return;var t=e.touches[0],dx=t.clientX-m2.x,dy=t.clientY-m2.y;if(!m2.moved&&(Math.abs(dx)>CONFIG.worldMapPanThreshold||Math.abs(dy)>CONFIG.worldMapPanThreshold))m2.moved=true;if(!m2.moved)return;e.preventDefault();e.stopPropagation();if(!m2.startCenter||!m2.pxPerRoom)return;var ppr=m2.pxPerRoom,sx=CONFIG.map2InvertX?-dx:dx,sy=CONFIG.map2InvertY?-dy:dy,nx=m2.startCenter[0]-sx/ppr,ny=m2.startCenter[1]-sy/ppr;map2SetCenter(ctx,[nx,ny]);pickerInfo.lastMap2="pan d="+Math.round(dx)+","+Math.round(dy)+" -> "+nx.toFixed(1)+","+ny.toFixed(1);
  },{capture:true,passive:false});
  function endMap2(){if(!m2)return;if(m2.mode==="pan")pickerInfo.lastMap2=m2.moved?"pan end":"tap";m2=null;}
  document.addEventListener("touchend",endMap2,{capture:true,passive:true});document.addEventListener("touchcancel",endMap2,{capture:true,passive:true});

  function buildSettings(){
    var showSize=CONFIG.sizeControl,showMap=CONFIG.mapDefaultToggle;if(!showSize&&!showMap)return;if(!document.body||document.getElementById("sm-settings"))return;
    function mkBtn(txt,big){var b=document.createElement("button");b.textContent=txt;b.style.cssText="min-width:34px;height:34px;padding:0 8px;color:#eee;background:#3a3a3a;border:1px solid #666;border-radius:6px;font:"+(big?"18px":"13px")+"/1 sans-serif;";return b;}
    function mkRow(labelText){var row=document.createElement("div");row.style.cssText="display:flex;align-items:center;gap:6px;";var l=document.createElement("span");l.textContent=labelText;l.style.cssText="min-width:40px;color:#9bd;font:12px/1 sans-serif;";row.appendChild(l);return row;}
    var wrap=document.createElement("div");wrap.id="sm-settings";wrap.style.cssText="position:fixed;right:"+CONFIG.sizeControlRight+"px;bottom:"+CONFIG.sizeControlBottom+"px;z-index:99990;display:flex;flex-direction:column;align-items:flex-end;gap:6px;";
    var panel=document.createElement("div");panel.style.cssText="display:none;flex-direction:column;gap:8px;padding:8px 10px;background:rgba(22,22,22,.96);border:1px solid #666;border-radius:10px;";
    if(showMap){var mapRow=mkRow("Map"),mapOpts=[["auto",null],["classic","map"],["alpha","map2"]],mapBtns=[];var syncMap=function(){var cur=getMapPref();mapBtns.forEach(function(b){var on=(b.getAttribute("data-pref")||"")===(cur||"");b.style.background=on?"#2d6cdf":"#3a3a3a";b.style.borderColor=on?"#5a8ff0":"#666";});};mapOpts.forEach(function(o){var b=mkBtn(o[0],false);b.setAttribute("data-pref",o[1]||"");b.addEventListener("click",function(){setMapPref(o[1]);syncMap();enforceMapPref();});mapBtns.push(b);mapRow.appendChild(b);});syncMap();panel.appendChild(mapRow);}
    if(showSize){var sizeRow=mkRow("Size"),minus=mkBtn("A−",true),label=document.createElement("span");label.id="sm-size-label";label.style.cssText="min-width:44px;text-align:center;color:#ddd;font:15px/1 sans-serif;";var plus=mkBtn("A＋",true),reset=mkBtn("↺",true),refresh=function(){smRefreshSizeLabel();},step=function(deltaScale){var s=1280/smCurrentWidth();s=Math.max(1,Math.min(3,Math.round((s+deltaScale)*10)/10));smApplyViewport(smClampWidth(1280/s),true);refresh();};minus.addEventListener("click",function(){step(-.1);});plus.addEventListener("click",function(){step(.1);});reset.addEventListener("click",function(){smResetViewport();refresh();});refresh();sizeRow.appendChild(minus);sizeRow.appendChild(label);sizeRow.appendChild(plus);sizeRow.appendChild(reset);panel.appendChild(sizeRow);}
    var toggle=mkBtn("⚙",true);toggle.style.borderRadius="50%";toggle.style.opacity=".85";toggle.addEventListener("click",function(){var open=panel.style.display!=="none";panel.style.display=open?"none":"flex";});wrap.appendChild(panel);wrap.appendChild(toggle);document.body.appendChild(wrap);
  }

  var MAP_PREF_KEY="sm.defaultMap";
  function getMapPref(){try{var v=localStorage.getItem(MAP_PREF_KEY);return v==="map"||v==="map2"?v:null;}catch(e){return null;}}
  function setMapPref(v){try{if(v)localStorage.setItem(MAP_PREF_KEY,v);else localStorage.removeItem(MAP_PREF_KEY);}catch(e){}resetMapEnforceGuard(v);}
  function parseMapHash(hash){var m=(hash||"").match(/^#!\/map(2)?($|[\/?].*)$/);return m?{isMap2:m[1]==="2",rest:m[2]||""}:null;}
  function buildMapTarget(want2,rest){var shard="",sm=(rest||"").match(/^\/([^/?#]+)/);if(sm)shard=sm[1];var pos="",pm=(rest||"").match(/[?&]pos=([^&#]+)/);if(pm)pos=pm[1];var t="#!/map"+(want2?"2":"");if(shard)t+="/"+shard;if(want2&&pos)t+="?pos="+pos;return t;}
  var MAP_HANDOFF_WINDOW_MS=2500,mapEnforceState={pref:null,pending:null,blockedSource:null},mapEnforceLastReason="idle";
  function resetMapEnforceGuard(pref){mapEnforceState={pref:pref==="map"||pref==="map2"?pref:null,pending:null,blockedSource:null};mapEnforceLastReason="preference-reset";}
  function mapEnforceTransition(state,pref,hash,now,windowMs){
    pref=pref==="map"||pref==="map2"?pref:null;hash=hash||"";var pending=state&&state.pending;var next={pref:state&&state.pref?state.pref:null,pending:pending?{source:pending.source,target:pending.target,time:pending.time,accepted:!!pending.accepted}:null,blockedSource:(state&&state.blockedSource)||null};
    if(next.pref!==pref){next.pref=pref;next.pending=null;next.blockedSource=null;}if(!pref)return{state:next,target:null,reason:"auto"};
    if(next.blockedSource){if(hash===next.blockedSource)return{state:next,target:null,reason:"source-blocked"};next.blockedSource=null;next.pending=null;}
    pending=next.pending;if(pending){var age=now-pending.time;if(age<0||age>windowMs)next.pending=null;else if(hash===pending.target){pending.accepted=true;return{state:next,target:null,reason:"target-accepted"};}else if(hash===pending.source){if(pending.accepted){next.pending=null;next.blockedSource=hash;return{state:next,target:null,reason:"source-reverted"};}return{state:next,target:null,reason:"handoff-pending"};}else{var arrivedRoute=parseMapHash(hash);if(arrivedRoute&&arrivedRoute.isMap2===(pref==="map2")){pending.accepted=true;return{state:next,target:null,reason:"target-normalized"};}next.pending=null;}}
    var route=parseMapHash(hash);if(!route)return{state:next,target:null,reason:"unrelated"};if(route.isMap2===(pref==="map2"))return{state:next,target:null,reason:"preferred"};var target=buildMapTarget(pref==="map2",route.rest);next.pending={source:hash,target:target,time:now,accepted:false};return{state:next,target:target,reason:"replace"};
  }
  function enforceMapPref(){var pref=getMapPref(),result=mapEnforceTransition(mapEnforceState,pref,location.hash,Date.now(),MAP_HANDOFF_WINDOW_MS);mapEnforceState=result.state;mapEnforceLastReason=result.reason;if(result.target)location.replace(result.target);}
  window.addEventListener("hashchange",enforceMapPref);enforceMapPref();
  function currentShard(){var m=(location.hash||"").match(/(shard[^/?#]+)/i);return m?m[1]:"";}
  function roomToMap2Hash(){var shard=currentShard(),t="#!/map2"+(shard?"/"+shard:"");var rm=(location.hash||"").match(/([WE])(\d+)([NS])(\d+)/i);if(rm){var x=(rm[1].toUpperCase()==="E"?1:-1)*(parseInt(rm[2],10)+.5),y=(rm[3].toUpperCase()==="S"?1:-1)*(parseInt(rm[4],10)+.5);t+="?pos="+x+","+y;}return t;}
  document.addEventListener("click",function(e){var pref=getMapPref();if(!pref)return;var want2=pref==="map2";var a=e.target.closest&&e.target.closest("a[href]");if(a){var href=a.getAttribute("href")||"",hash=href.indexOf("#")>=0?href.slice(href.indexOf("#")):"",r=parseMapHash(hash);if(r&&r.isMap2!==want2){e.preventDefault();e.stopPropagation();location.hash=buildMapTarget(want2,r.rest);return;}}if(want2){var g=e.target.closest&&e.target.closest("[ng-click]"),ngc=(g&&g.getAttribute("ng-click"))||"";if(/goToMap\b/.test(ngc)){e.preventDefault();e.stopPropagation();location.hash=roomToMap2Hash();}}},true);
  buildSettings();

  var ROOM_FIELD_SEL="section.room .game-field-container",edgeTap=null;pickerInfo.lastEdgeNav="-";
  function exitAtPoint(x,y,margin){var exits=document.querySelectorAll("section.room .exit"),best=null,bestD=Infinity;for(var i=0;i<exits.length;i++){var r=exits[i].getBoundingClientRect();if(!r.width||!r.height)continue;if(x>=r.left-margin&&x<=r.right+margin&&y>=r.top-margin&&y<=r.bottom+margin){var dx=x-(r.left+r.right)/2,dy=y-(r.top+r.bottom)/2,d=dx*dx+dy*dy;if(d<bestD){bestD=d;best=exits[i];}}}return best;}
  document.addEventListener("touchstart",function(e){if(!CONFIG.roomEdgeNav||e.touches.length!==1){edgeTap=null;return;}if(!(e.target.closest&&e.target.closest(ROOM_FIELD_SEL)))return;var t=e.touches[0];edgeTap={x:t.clientX,y:t.clientY,moved:false};},{capture:true,passive:true});
  document.addEventListener("touchmove",function(e){if(!edgeTap||e.touches.length!==1)return;var t=e.touches[0];if(Math.abs(t.clientX-edgeTap.x)>10||Math.abs(t.clientY-edgeTap.y)>10)edgeTap.moved=true;},{capture:true,passive:true});
  document.addEventListener("touchend",function(e){var info=edgeTap;edgeTap=null;if(!CONFIG.roomEdgeNav||!info||info.moved)return;if(e.changedTouches.length!==1)return;var t=e.changedTouches[0],ex=exitAtPoint(t.clientX,t.clientY,CONFIG.roomEdgeMargin);if(!ex)return;e.preventDefault();pickerInfo.lastEdgeNav=typeof ex.className==="string"?"."+ex.className.trim().split(/\s+/).slice(0,3).join("."):"exit";["mousedown","mouseup","click"].forEach(function(type){ex.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window,button:0}));});},{capture:true,passive:false});

  function dump(){
    var lines=[];lines.push("screeps-mobile-ux "+SM_VERSION);lines.push("uiSize: width="+smCurrentWidth()+" scale="+(1280/smCurrentWidth()).toFixed(2)+"x saved="+(smSavedWidth()!=null?smSavedWidth():"no"));lines.push("zoomFactor: "+zoomFactor().toFixed(2));lines.push("ua: "+navigator.userAgent);lines.push("inner: "+window.innerWidth+"x"+window.innerHeight+(window.visualViewport?" | visual: "+Math.round(window.visualViewport.width)+"x"+Math.round(window.visualViewport.height)+" scale "+window.visualViewport.scale.toFixed(2):""));var vp=document.querySelector('meta[name="viewport"]');lines.push("viewport meta: "+(vp?vp.getAttribute("content"):"(none)"));
    var sels=["header.navbar",".navbar-brand",".navbar-profile",".navbar-resources",".navbar-sysbar","section.room .left-controls","section.room .room-controls","section.room .right-top-controls",".editor-panel",".editor-panel .resize-handle",".view-popup",".game-switch-container"];
    sels.forEach(function(s){var el=document.querySelector(s);if(!el){lines.push(s+": (none)");return;}var r=el.getBoundingClientRect();lines.push(s+": x="+Math.round(r.x)+" y="+Math.round(r.y)+" w="+Math.round(r.width)+" h="+Math.round(r.height));});
    function desc(el){var cls=el&&typeof el.className==="string"&&el.className.trim()?"."+el.className.trim().split(/\s+/).slice(0,3).join("."):"";return el?el.tagName.toLowerCase()+cls:"(none)";}
    lines.push("hash: "+location.hash);var mapPending=mapEnforceState.pending;lines.push("map enforce: pref="+(mapEnforceState.pref||"auto")+" last="+mapEnforceLastReason+" pending="+(mapPending?mapPending.source+" -> "+mapPending.target+" accepted="+(mapPending.accepted?"yes":"no")+" age="+Math.max(0,Date.now()-mapPending.time)+"ms":"none")+" blocked="+(mapEnforceState.blockedSource||"none"));var sections=Array.prototype.slice.call(document.querySelectorAll("section"));lines.push("sections: "+(sections.map(desc).join(", ")||"(none)"));
    var cx=Math.round(window.innerWidth/2),cy=Math.round(window.innerHeight/2);lines.push("at-center("+cx+","+cy+"): "+document.elementsFromPoint(cx,cy).slice(0,6).map(desc).join(" | "));
    var canv=document.querySelector("section canvas")||document.querySelector("canvas");if(canv){var chain=[],n=canv,guard=0;while(n&&n!==document.body&&guard++<8){chain.push(desc(n));n=n.parentElement;}lines.push("canvas chain: "+chain.join(" < "));}else lines.push("canvas: (none)");
    [[30,21],[120,21],[30,70],[30,120]].forEach(function(p){var stack=document.elementsFromPoint(p[0],p[1]).slice(0,5).map(function(el){var cls=typeof el.className==="string"&&el.className.trim()?"."+el.className.trim().split(/\s+/).slice(0,3).join("."):"";return el.tagName.toLowerCase()+cls;});lines.push("at("+p[0]+","+p[1]+"): "+stack.join(" | "));});
    var roomEl=document.querySelector("section.room"),scope=window.angular&&roomEl&&window.angular.element(roomEl).scope();lines.push("room scope: "+(scope&&scope.Room?"ok, objects="+((scope.Room.objects&&scope.Room.objects.length)||0)+", selected="+(scope.Room.selectedObject?scope.Room.selectedObject.type:"null"):"none"));lines.push("selectedAction: "+(scope&&scope.Room&&scope.Room.selectedAction?scope.Room.selectedAction.action:"n/a"));lines.push("picker: lastTile="+pickerInfo.lastTile+" stack="+pickerInfo.lastStack+" sheet="+(document.getElementById("sm-tile-picker")?"visible":"hidden"));lines.push("roomTap: "+(pickerInfo.lastRoomTap||"-"));lines.push("pinch: "+pickerInfo.lastPinch);lines.push("wmPan: "+(pickerInfo.lastWmPan||"-")+" container="+(document.querySelector(WORLD_MAP_SEL)?"yes":"no"));lines.push("map2: "+(pickerInfo.lastMap2||"-")+" onMap2="+(onMap2()?"yes":"no"));lines.push("defaultMap pref: "+(getMapPref()||"auto"));lines.push("edgeNav: "+(pickerInfo.lastEdgeNav||"-")+" exits="+document.querySelectorAll("section.room .exit").length);var ctrl=panelCtrl();lines.push("resize panel ctrl: "+(ctrl?"ok, height="+ctrl.ctrl.getHeight():"none"));
    try{lines.push("");lines.push(map2Probe());}catch(err){lines.push("map2 probe ERROR: "+(err&&err.message));}
    return lines.join("\n");
  }
  function map2Probe(){var L=["=== map2 probe ==="];L.push("hash: "+location.hash+" onMap2="+(onMap2()?"yes":"no"));L.push("ng: "+(window.ng?"keys="+Object.keys(window.ng).slice(0,8).join(","):typeof window.ng)+" | PIXI: "+(window.PIXI?window.PIXI.VERSION:"absent"));var ctx=map2Ctx();if(!ctx){L.push("ctx: NOT RESOLVED (ng.probe / app-world-map-base missing) -- open #!/map2");return L.join("\n");}var base=ctx.base,mc=ctx.mc;L.push("base: "+(base?base.constructor&&base.constructor.name:"null")+" | container: "+(mc?mc.constructor&&mc.constructor.name:"null"));var bound=null;try{bound=mc&&mc.getBound&&mc.getBound();}catch(e){}var ppr=map2PxPerRoom(mc);L.push("center="+JSON.stringify(map2Center(ctx))+" scale="+JSON.stringify(map2Scale(ctx)));L.push("bound="+JSON.stringify(bound)+" pxPerRoom="+(ppr?ppr.toFixed(2):"?"));function has(o,m){return o&&typeof o[m]==="function"?"y":"N";}L.push("methods base.onBound="+has(base,"onBound")+" base.onChangeScale="+has(base,"onChangeScale")+" | mc.setCenter="+has(mc,"setCenter")+" mc.setScale="+has(mc,"setScale")+" mc.getCenter="+has(mc,"getCenter")+" mc.getBound="+has(mc,"getBound"));return L.join("\n");}
  window.__smDump=function(){var out=dump();console.log(out);return out;};
  var brandTaps=[];
  document.addEventListener("touchend",function(e){if(!(e.target.closest&&e.target.closest(".navbar-brand")))return;var now=e.timeStamp;brandTaps=brandTaps.filter(function(t){return now-t<1200;});brandTaps.push(now);if(brandTaps.length>=3){brandTaps=[];e.preventDefault();showDumpOverlay();}},{passive:false,capture:true});
  function showDumpOverlay(){var old=document.getElementById("screeps-mobile-ux-dump");if(old)old.remove();var wrap=document.createElement("div");wrap.id="screeps-mobile-ux-dump";wrap.style.cssText="position:fixed;z-index:99999;left:4%;top:6%;width:92%;height:80%;background:#222;border:1px solid #666;border-radius:6px;padding:10px;display:flex;flex-direction:column;gap:8px;";var ta=document.createElement("textarea");ta.style.cssText="flex:1;background:#111;color:#cfc;border:none;font:14px/1.4 monospace;white-space:pre;resize:none;";ta.readOnly=true;ta.value=dump();var row=document.createElement("div");row.style.cssText="display:flex;gap:8px;";var btnCopy=document.createElement("button");btnCopy.textContent="Copy";var btnClose=document.createElement("button");btnClose.textContent="Close";[btnCopy,btnClose].forEach(function(b){b.style.cssText="flex:1;padding:12px;font-size:16px;background:#444;color:#eee;border:1px solid #666;border-radius:4px;";});btnCopy.addEventListener("click",function(){ta.select();if(navigator.clipboard)navigator.clipboard.writeText(ta.value);else document.execCommand("copy");btnCopy.textContent="Copied";});btnClose.addEventListener("click",function(){wrap.remove();});row.appendChild(btnCopy);row.appendChild(btnClose);wrap.appendChild(ta);wrap.appendChild(row);document.body.appendChild(wrap);}
})();
