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

  // Preserve disconnected parts and reject corrupt geometry rather than bridging gaps.
  function trailLines(geometry) {
    if (!geometry) return [];
    var lines = geometry.type === 'LineString' ? [geometry.coordinates] :
      geometry.type === 'MultiLineString' ? geometry.coordinates : [];
    if (!Array.isArray(lines)) return [];
    return lines.filter(function (line) {
      return Array.isArray(line) && line.length >= 2 && line.every(function (p) {
        return Array.isArray(p) && Number.isFinite(p[0]) && Math.abs(p[0]) <= 180 &&
          Number.isFinite(p[1]) && Math.abs(p[1]) <= 90;
      });
    });
  }

  // AWS Terrarium terrain-RGB tiles, sampled at one zoom (~16 m/px at 33 deg N).
  var TERRAIN_ZOOM = 13, TERRAIN_SIZE = 256;

  // Elevations in meters from a tile's RGBA pixels: R*256 + G + B/256 - 32768.
  function decodeTerrarium(rgba) {
    var count = rgba.length / 4, out = new Float32Array(count);
    for (var i = 0; i < count; i++) out[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
    return out;
  }

  // Global Web Mercator pixel position [x, y] at zoom z with 256 px tiles.
  function mercatorPixel(latitude, longitude, z) {
    var scale = TERRAIN_SIZE * Math.pow(2, z);
    var s = Math.sin(toRad(Math.max(-85.0511, Math.min(85.0511, latitude))));
    return [(longitude + 180) / 360 * scale, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale];
  }

  // Terrain tiles covering a lat/lon box grown by marginMeters, plus a two-pixel
  // halo so bilinear sampling at the box edge has its neighbours.
  function terrainTiles(south, west, north, east, marginMeters) {
    var z = TERRAIN_ZOOM, n = Math.pow(2, z), m = marginMeters || 0;
    var dLat = m / 111320, dLon = m / (111320 * Math.cos(toRad((south + north) / 2)));
    var a = mercatorPixel(north + dLat, west - dLon, z), b = mercatorPixel(south - dLat, east + dLon, z);
    var x0 = Math.floor((a[0] - 2) / TERRAIN_SIZE), x1 = Math.floor((b[0] + 2) / TERRAIN_SIZE);
    var y0 = Math.max(0, Math.floor((a[1] - 2) / TERRAIN_SIZE)), y1 = Math.min(n - 1, Math.floor((b[1] + 2) / TERRAIN_SIZE));
    var tiles = [];
    for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) tiles.push({ z: z, x: ((x % n) + n) % n, y: y });
    return tiles;
  }

  // Bilinear ground elevation (meters) between pixel centres, reading neighbours
  // across tile seams. gridAt(z, x, y) returns a decoded tile or null; any missing
  // or non-finite pixel makes the whole sample null rather than a guess.
  function sampleTerrain(latitude, longitude, gridAt) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    var z = TERRAIN_ZOOM, n = Math.pow(2, z), px = mercatorPixel(latitude, longitude, z);
    var u = px[0] - 0.5, v = px[1] - 0.5, i0 = Math.floor(u), j0 = Math.floor(v), fx = u - i0, fy = v - j0;
    function at(i, j) {
      var ty = Math.floor(j / TERRAIN_SIZE), tx = Math.floor(i / TERRAIN_SIZE);
      if (ty < 0 || ty >= n) return NaN;
      var grid = gridAt(z, ((tx % n) + n) % n, ty);
      return grid ? grid[(j - ty * TERRAIN_SIZE) * TERRAIN_SIZE + (i - tx * TERRAIN_SIZE)] : NaN;
    }
    var h = (at(i0, j0) * (1 - fx) + at(i0 + 1, j0) * fx) * (1 - fy) +
      (at(i0, j0 + 1) * (1 - fx) + at(i0 + 1, j0 + 1) * fx) * fy;
    return Number.isFinite(h) ? h : null;
  }

  function projectTrail(lines, position, heading, pitch, width, height, fov, elevationAt) {
    return projectTrailDetail(lines, position, heading, pitch, width, height, fov, elevationAt).d;
  }

  // Camera 1.5 m above the ground at the hiker. With elevationAt(latitude, longitude)
  // returning meters, each sample sits at its terrain height relative to the hiker;
  // if the hiker or any sample lacks elevation the whole path uses flat ground, so a
  // coverage gap cannot draw a cliff. Returns { d, terrain } (terrain: heights used).
  // Clip each source segment to a 100m neighborhood BEFORE sampling so long
  // segments crossing the hiker remain visible without unbounded subdivision.
  function projectTrailDetail(lines, position, heading, pitch, width, height, fov, elevationAt) {
    if (![position.latitude, position.longitude, heading, pitch, width, height, fov].every(Number.isFinite) ||
        width <= 0 || height <= 0 || fov <= 20 || fov >= 120) return { d: '', terrain: false };
    var h = toRad(heading), p = toRad(pitch), focal = width / (2 * Math.tan(toRad(fov) / 2));
    var cosLat = Math.cos(toRad(position.latitude));
    var runs = [], path = [];
    function local(c) {
      return [toRad(angularDelta(position.longitude, c[0])) * R_EARTH * cosLat,
        toRad(c[1] - position.latitude) * R_EARTH];
    }
    // dz: sample ground height minus camera height, in meters.
    function project(e, n, dz) {
      var side = e * Math.cos(h) - n * Math.sin(h);
      var forward = e * Math.sin(h) + n * Math.cos(h);
      var depth = forward * Math.cos(p) + dz * Math.sin(p);
      if (depth < 1) return null;
      var up = dz * Math.cos(p) - forward * Math.sin(p);
      return [width / 2 + focal * side / depth, height / 2 - focal * up / depth];
    }
    // Liang-Barsky: the parameter range [lo, hi] of (x, y) + t*(dx, dy) inside a box, or null.
    function clip(x, y, dx, dy, minX, minY, maxX, maxY) {
      var lo = 0, hi = 1, edges = [[-dx, x - minX], [dx, maxX - x], [-dy, y - minY], [dy, maxY - y]];
      for (var k = 0; k < 4; k++) {
        var edge = edges[k];
        if (edge[0] === 0) { if (edge[1] < 0) return null; continue; }
        if (edge[0] < 0) lo = Math.max(lo, edge[1] / edge[0]); else hi = Math.min(hi, edge[1] / edge[0]);
        if (lo > hi) return null;
      }
      return [lo, hi];
    }
    lines.forEach(function (line) {
      for (var i = 1; i < line.length; i++) {
        var a = local(line[i - 1]), b = local(line[i]);
        var dx = b[0] - a[0], dy = b[1] - a[1];
        var range = clip(a[0], a[1], dx, dy, -100, -100, 100, 100);
        if (!range) continue;
        var lo = range[0], hi = range[1];
        var steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) * (hi - lo) / 2));
        var run = null;
        for (var j = 0; j <= steps; j++) {
          var t = lo + (hi - lo) * j / steps, e = a[0] + dx * t, n = a[1] + dy * t;
          if (Math.hypot(e, n) > 100) { run = null; continue; }
          if (!run) runs.push(run = []);
          run.push([e, n]);
        }
      }
    });
    var ground = null, terrain = false;
    var base = typeof elevationAt === 'function' ? elevationAt(position.latitude, position.longitude) : null;
    if (Number.isFinite(base)) {
      ground = runs.map(function (run) {
        return run.map(function (s) {
          var hAt = elevationAt(position.latitude + toDeg(s[1] / R_EARTH), position.longitude + toDeg(s[0] / (R_EARTH * cosLat)));
          return Number.isFinite(hAt) ? hAt - base : NaN;
        });
      });
      terrain = ground.every(function (heights) { return heights.every(Number.isFinite); });
    }
    runs.forEach(function (run, r) {
      var current = null;
      run.forEach(function (s, k) {
        var q = project(s[0], s[1], (terrain ? ground[r][k] : 0) - 1.5);
        if (!q) { current = null; return; }
        if (!current) path.push(current = []);
        current.push(q);
      });
    });
    // Off-screen samples stay in the path for the SVG to clip, so a segment that
    // crosses the view between two off-screen samples still draws. Report nothing
    // unless some segment has a visible, non-zero-length part.
    var visible = path.some(function (points) {
      return points.some(function (q, k) {
        if (!k) return false;
        var sx = q[0] - points[k - 1][0], sy = q[1] - points[k - 1][1];
        var part = clip(points[k - 1][0], points[k - 1][1], sx, sy, 0, 0, width, height);
        return !!part && (part[1] - part[0]) * Math.hypot(sx, sy) >= 0.1;
      });
    });
    if (!visible) return { d: '', terrain: false };
    var d = path.map(function (points) {
      return points.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); });
    }).filter(function (points) {
      // A lone point or repeats of one pixel would draw a round-cap dot, not a line.
      return points.some(function (point) { return point !== points[0]; });
    }).map(function (points) { return 'M' + points.join(' L'); }).join(' ');
    return { d: d, terrain: terrain };
  }

  // Compass heading of the back camera (the vector out of the back of the screen) from
  // absolute DeviceOrientation angles, per the W3C spec's worked example. Unlike
  // 360 - alpha it stays right when the phone tilts sideways, and screen rotation
  // does not move the camera. Null when the camera points nearly straight down or up.
  function backCameraHeading(alpha, beta, gamma) {
    if (![alpha, beta, gamma].every(Number.isFinite)) return null;
    var a = toRad(alpha), b = toRad(beta), g = toRad(gamma);
    var vx = -Math.cos(a) * Math.sin(g) - Math.sin(a) * Math.sin(b) * Math.cos(g);
    var vy = -Math.sin(a) * Math.sin(g) + Math.cos(a) * Math.sin(b) * Math.cos(g);
    if (Math.hypot(vx, vy) < 0.1) return null;
    return norm360(toDeg(Math.atan2(vx, vy)));
  }

  // NOAA World Magnetic Model 2025 (public domain), valid 2025.0-2030.0.
  // Rows are [n, m, g, h, g per year, h per year] in nT.
  var WMM2025 = [
    [1,0,-29351.8,0,12,0], [1,1,-1410.8,4545.4,9.7,-21.5], [2,0,-2556.6,0,-11.6,0], [2,1,2951.1,-3133.6,-5.2,-27.7], [2,2,1649.3,-815.1,-8,-12.1],
    [3,0,1361,0,-1.3,0], [3,1,-2404.1,-56.6,-4.2,4], [3,2,1243.8,237.5,0.4,-0.3], [3,3,453.6,-549.5,-15.6,-4.1], [4,0,895,0,-1.6,0],
    [4,1,799.5,278.6,-2.4,-1.1], [4,2,55.7,-133.9,-6,4.1], [4,3,-281.1,212,5.6,1.6], [4,4,12.1,-375.6,-7,-4.4], [5,0,-233.2,0,0.6,0],
    [5,1,368.9,45.4,1.4,-0.5], [5,2,187.2,220.2,0,2.2], [5,3,-138.7,-122.9,0.6,0.4], [5,4,-142,43,2.2,1.7], [5,5,20.9,106.1,0.9,1.9],
    [6,0,64.4,0,-0.2,0], [6,1,63.8,-18.4,-0.4,0.3], [6,2,76.9,16.8,0.9,-1.6], [6,3,-115.7,48.8,1.2,-0.4], [6,4,-40.9,-59.8,-0.9,0.9],
    [6,5,14.9,10.9,0.3,0.7], [6,6,-60.7,72.7,0.9,0.9], [7,0,79.5,0,0,0], [7,1,-77,-48.9,-0.1,0.6], [7,2,-8.8,-14.4,-0.1,0.5],
    [7,3,59.3,-1,0.5,-0.8], [7,4,15.8,23.4,-0.1,0], [7,5,2.5,-7.4,-0.8,-1], [7,6,-11.1,-25.1,-0.8,0.6], [7,7,14.2,-2.3,0.8,-0.2],
    [8,0,23.2,0,-0.1,0], [8,1,10.8,7.1,0.2,-0.2], [8,2,-17.5,-12.6,0,0.5], [8,3,2,11.4,0.5,-0.4], [8,4,-21.7,-9.7,-0.1,0.4],
    [8,5,16.9,12.7,0.3,-0.5], [8,6,15,0.7,0.2,-0.6], [8,7,-16.8,-5.2,0,0.3], [8,8,0.9,3.9,0.2,0.2], [9,0,4.6,0,0,0],
    [9,1,7.8,-24.8,-0.1,-0.3], [9,2,3,12.2,0.1,0.3], [9,3,-0.2,8.3,0.3,-0.3], [9,4,-2.5,-3.3,-0.3,0.3], [9,5,-13.1,-5.2,0,0.2],
    [9,6,2.4,7.2,0.3,-0.1], [9,7,8.6,-0.6,-0.1,-0.2], [9,8,-8.7,0.8,0.1,0.4], [9,9,-12.9,10,-0.1,0.1], [10,0,-1.3,0,0.1,0],
    [10,1,-6.4,3.3,0,0], [10,2,0.2,0,0.1,0], [10,3,2,2.4,0.1,-0.2], [10,4,-1,5.3,0,0.1], [10,5,-0.6,-9.1,-0.3,-0.1],
    [10,6,-0.9,0.4,0,0.1], [10,7,1.5,-4.2,-0.1,0], [10,8,0.9,-3.8,-0.1,-0.1], [10,9,-2.7,0.9,0,0.2], [10,10,-3.9,-9.1,0,0],
    [11,0,2.9,0,0,0], [11,1,-1.5,0,0,0], [11,2,-2.5,2.9,0,0.1], [11,3,2.4,-0.6,0,0], [11,4,-0.6,0.2,0,0.1],
    [11,5,-0.1,0.5,-0.1,0], [11,6,-0.6,-0.3,0,0], [11,7,-0.1,-1.2,0,0.1], [11,8,1.1,-1.7,-0.1,0], [11,9,-1,-2.9,-0.1,0],
    [11,10,-0.2,-1.8,-0.1,0], [11,11,2.6,-2.3,-0.1,0], [12,0,-2,0,0,0], [12,1,-0.2,-1.3,0,0], [12,2,0.3,0.7,0,0],
    [12,3,1.2,1,0,-0.1], [12,4,-1.3,-1.4,0,0.1], [12,5,0.6,0,0,0], [12,6,0.6,0.6,0.1,0], [12,7,0.5,-0.1,0,0],
    [12,8,-0.1,0.8,0,0], [12,9,-0.4,0.1,0,0], [12,10,-0.2,-1,-0.1,0], [12,11,-1.3,0.1,0,0], [12,12,-0.7,0.2,-0.1,-0.1]
  ];

  // Magnetic declination in degrees, east positive: true heading = magnetic + declination.
  // Null outside the model's validity, or where the horizontal field is under NOAA's
  // 2000 nT blackout threshold and a compass is unreliable. Method: WMM2025 report.
  function declination(latitude, longitude, date, heightKm) {
    var ms = date instanceof Date ? date.getTime() : NaN, h = heightKm || 0;
    if (![latitude, longitude, ms, h].every(Number.isFinite) || Math.abs(latitude) > 90) return null;
    var year = new Date(ms).getUTCFullYear(), start = Date.UTC(year, 0, 1);
    var t = year + (ms - start) / (Date.UTC(year + 1, 0, 1) - start) - 2025;
    if (t < 0 || t >= 5) return null;
    // WGS84 geodetic -> geocentric; theta is geocentric colatitude.
    var E2 = 0.0066943799901413165, phi = toRad(latitude), sinPhi = Math.sin(phi);
    var rc = 6378.137 / Math.sqrt(1 - E2 * sinPhi * sinPhi);
    var p = (rc + h) * Math.cos(phi), z = (rc * (1 - E2) + h) * sinPhi, r = Math.hypot(p, z);
    var cosT = z / r, sinT = p / r, lambda = toRad(longitude);
    if (sinT < 1e-10) return null;
    // Gauss-normalised Legendre P(cos theta) and dP/dtheta, scaled to Schmidt by S.
    var P = [[1]], dP = [[0]], S = [[1]], north = 0, east = 0, down = 0;
    for (var n = 1; n <= 12; n++) {
      P[n] = []; dP[n] = []; S[n] = [];
      for (var m = 0; m <= n; m++) {
        if (m === n) {
          P[n][m] = sinT * P[n - 1][m - 1];
          dP[n][m] = sinT * dP[n - 1][m - 1] + cosT * P[n - 1][m - 1];
        } else {
          var k = m <= n - 2 ? ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3)) : 0;
          P[n][m] = cosT * P[n - 1][m] - (k ? k * P[n - 2][m] : 0);
          dP[n][m] = cosT * dP[n - 1][m] - sinT * P[n - 1][m] - (k ? k * dP[n - 2][m] : 0);
        }
        S[n][m] = m === 0 ? S[n - 1][0] * (2 * n - 1) / n
          : S[n][m - 1] * Math.sqrt((n - m + 1) * (m === 1 ? 2 : 1) / (n + m));
      }
    }
    WMM2025.forEach(function (c) {
      var n = c[0], m = c[1], g = c[2] + t * c[4], hh = c[3] + t * c[5];
      var scale = Math.pow(6371.2 / r, n + 2) * S[n][m];
      var cos = Math.cos(m * lambda), sin = Math.sin(m * lambda), gh = g * cos + hh * sin;
      north += scale * gh * dP[n][m];
      east += scale * m * (g * sin - hh * cos) * P[n][m];
      down -= scale * (n + 1) * gh * P[n][m];
    });
    east /= sinT;
    // Rotate from geocentric to geodetic north.
    var psi = Math.asin(cosT) - phi;
    north = north * Math.cos(psi) - down * Math.sin(psi);
    return Math.hypot(north, east) < 2000 ? null : toDeg(Math.atan2(east, north));
  }

  var Geo = {
    trailLines: trailLines, projectTrail: projectTrail,
    backCameraHeading: backCameraHeading, declination: declination,
    decodeTerrarium: decodeTerrarium, terrainTiles: terrainTiles, sampleTerrain: sampleTerrain,
    projectTrailDetail: projectTrailDetail,
    R_EARTH: R_EARTH,
    toRad: toRad, toDeg: toDeg,
    norm360: norm360,
    angularDelta: angularDelta,
    bearing: bearing,
    distance: distance,
    smoothHeading: smoothHeading,
    projectToScreen: projectToScreen,
    formatDistance: formatDistance
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Geo;
  if (root) root.Geo = Geo;
})(typeof window !== 'undefined' ? window : null);
