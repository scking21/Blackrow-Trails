/* geo.js — pure geo/AR math for Trail Marker AR.
 * No DOM, no sensors, no framework. Unit-testable in Node (see geo.test.js).
 * Works as a plain browser script (attaches window.Geo) and as a CommonJS
 * module (module.exports) so Jest can require it. */
(function (root) {
  'use strict';

  var R_EARTH = 6371000; // meters
  var toRad = function (d) { return d * Math.PI / 180; };
  var toDeg = function (r) { return r * 180 / Math.PI; };

  // Normalize any angle to [0, 360).
  function norm360(deg) { return ((deg % 360) + 360) % 360; }

  // Smallest signed angular difference (to - from), in (-180, 180].
  // Positive => `to` is clockwise (to the right) of `from`.
  function angularDelta(from, to) {
    var d = norm360(to - from);
    return d > 180 ? d - 360 : d;
  }

  // Initial great-circle bearing from a -> b, degrees clockwise from true north.
  // a, b: { latitude, longitude }
  function bearing(a, b) {
    var phi1 = toRad(a.latitude), phi2 = toRad(b.latitude);
    var dLon = toRad(b.longitude - a.longitude);
    var y = Math.sin(dLon) * Math.cos(phi2);
    var x = Math.cos(phi1) * Math.sin(phi2) -
            Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
    return norm360(toDeg(Math.atan2(y, x)));
  }

  // Haversine distance in meters between a and b.
  function distance(a, b) {
    var phi1 = toRad(a.latitude), phi2 = toRad(b.latitude);
    var dPhi = toRad(b.latitude - a.latitude);
    var dLon = toRad(b.longitude - a.longitude);
    var s = Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
            Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R_EARTH * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  // Circular exponential smoothing of a heading (handles the 359->0 wrap).
  // prev/next in degrees; alpha is the weight of the NEW sample (0..1).
  // Lower alpha = calmer/slower. Returns smoothed heading in [0,360).
  // If prev is null/undefined/NaN, returns next unchanged (first sample).
  function smoothHeading(prev, next, alpha) {
    if (prev == null || isNaN(prev)) return norm360(next);
    var pr = toRad(prev), nx = toRad(next);
    var x = (1 - alpha) * Math.cos(pr) + alpha * Math.cos(nx);
    var y = (1 - alpha) * Math.sin(pr) + alpha * Math.sin(nx);
    return norm360(toDeg(Math.atan2(y, x)));
  }

  // Pick the live heading source. While moving fast enough, GPS course-over-ground
  // is far steadier than the magnetometer; standing still, use the compass.
  //   course: GPS heading deg or null/NaN; speed: m/s or null;
  //   compass: compass heading deg or null; courseSpeedThreshold: m/s
  // Returns { heading, source: 'gps'|'compass'|'none' }.
  function chooseHeading(opts) {
    var course = opts.course, speed = opts.speed, compass = opts.compass;
    var thr = opts.courseSpeedThreshold;
    var courseOk = course != null && !isNaN(course) && course >= 0;
    if (courseOk && speed != null && speed >= thr) {
      return { heading: norm360(course), source: 'gps' };
    }
    if (compass != null && !isNaN(compass)) {
      return { heading: norm360(compass), source: 'compass' };
    }
    if (courseOk) return { heading: norm360(course), source: 'gps' };
    return { heading: 0, source: 'none' };
  }

  // Project a target onto the screen given where the phone is pointing.
  //   bearingToTarget: absolute bearing to target (deg)
  //   heading: where the phone faces (deg)
  //   fovDeg: horizontal field of view (deg) — MUST be calibrated per device
  //   width: screen width in px
  // Returns:
  //   { onScreen, x, fraction, relative, side }
  //   relative: signed angle target-vs-heading (+ = right). fraction: -1..1 across
  //   the FOV. x: pixel position (only meaningful when onScreen). side: 'left'|'right'
  //   when off-screen (which way to turn).
  function projectToScreen(opts) {
    var relative = angularDelta(opts.heading, opts.bearingToTarget);
    var half = opts.fovDeg / 2;
    var fraction = relative / half;          // -1 at left edge, +1 at right edge
    var onScreen = Math.abs(fraction) <= 1;
    var x = (0.5 + 0.5 * fraction) * opts.width;
    return {
      onScreen: onScreen,
      x: x,
      fraction: fraction,
      relative: relative,
      side: relative >= 0 ? 'right' : 'left'
    };
  }

  // Human-friendly distance string.
  function formatDistance(m) {
    if (m == null || isNaN(m)) return '—';
    if (m < 1000) return Math.round(m) + ' m';
    return (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km';
  }

  var Geo = {
    R_EARTH: R_EARTH,
    toRad: toRad, toDeg: toDeg,
    norm360: norm360,
    angularDelta: angularDelta,
    bearing: bearing,
    distance: distance,
    smoothHeading: smoothHeading,
    chooseHeading: chooseHeading,
    projectToScreen: projectToScreen,
    formatDistance: formatDistance
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Geo;
  if (root) root.Geo = Geo;
})(typeof window !== 'undefined' ? window : null);
