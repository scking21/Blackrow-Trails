/* ar.js — Trail Marker AR (sensor overlay, no ARKit/ARCore).
 * Camera background + GPS + heading + trig. Tolerates GPS slop: a marker a few
 * meters off still reads correctly. Depends on window.Geo (geo.js).
 *
 * window.openTrailMarkerAR({ latitude, longitude, label, onArrive })
 *
 * TWO THINGS YOU MUST DO (the scaffold can't):
 *  1. Calibrate FOV: open the debug HUD (ⓘ), aim a known-direction landmark to
 *     screen center, nudge FOV +/- until the marker lines up as you pan.
 *  2. Field-test on foot: tune HEADING_ALPHA (lower = calmer) until the marker
 *     feels locked-on while walking.
 */
(function () {
  'use strict';

  // ---- Tunables -------------------------------------------------------------
  var DEFAULT_FOV_DEG = 55;          // GUESS. Calibrate per device/lens/orientation.
  var HEADING_ALPHA = 0.15;          // compass smoothing (new-sample weight); lower = calmer
  var ARRIVE_RADIUS_M = 15;         // proximity radius, including reported GPS accuracy
  var MARKER_VERTICAL = 0.42;        // fixed vertical placement (0=top,1=bottom) for v1
  var FOV_KEY = 'trailapp.ar.fov';

  function getFov() {
    // Reads can throw where writes can (Safari private mode, storage-blocked
    // WebViews) — fall back to the default instead of killing the AR launch.
    try {
      var v = parseFloat(localStorage.getItem(FOV_KEY));
      return (v && v > 20 && v < 120) ? v : DEFAULT_FOV_DEG;
    } catch (e) { return DEFAULT_FOV_DEG; }
  }
  function setFov(v) { try { localStorage.setItem(FOV_KEY, String(v)); } catch (e) {} }

  injectStyles();

  window.openTrailMarkerAR = function (opts) {
    var target = { latitude: opts.latitude, longitude: opts.longitude };
    var label = opts.label || 'Waypoint';
    var onArrive = opts.onArrive;

    var Geo = window.Geo;
    if (!Geo) { alert('AR math module (geo.js) not loaded.'); return; }

    var lines = Geo.trailLines ? Geo.trailLines(opts.geometry) : [];
    var routeMode = lines.length > 0;
    var closed = false, beta = null, gamma = null, positionAt = 0, orientationAt = 0;
    var compassAccuracy = null, declination = null;
    var NO_DECLINATION = 'Compass correction unavailable. Update the app or use the map.';

    // ---- State --------------------------------------------------------------
    var fovDeg = getFov();
    var pos = null, gpsAcc = null;
    var rawCompass = null, smoothCompass = null;
    var arrived = false, debug = false, raf = 0;
    var stream = null, watchId = null;
    var cameraError = null, gpsError = null, compassError = null;

    // ---- DOM ----------------------------------------------------------------
    var ov = el('div', 'ar-overlay');
    var video = el('video', 'ar-video'); video.setAttribute('playsinline', ''); video.setAttribute('muted', ''); video.muted = true; video.autoplay = true;
    var routeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    routeSvg.setAttribute('class', 'ar-route'); routeSvg.setAttribute('aria-label', 'Approximate mapped trail');
    var routePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    routeSvg.appendChild(routePath);
    var marker = el('div', 'ar-marker');
    marker.innerHTML = '<div class="ar-pin"><img src="assets/icons/phosphor/map-pin.svg" alt=""></div><div class="ar-card"><div class="ar-label"></div><div class="ar-dist"></div></div>';
    var chevron = el('div', 'ar-chevron'); chevron.innerHTML = '<div class="ar-chev-arrow"></div><div class="ar-chev-text"></div>';
    var hud = el('div', 'ar-hud');
    var banner = el('div', 'ar-banner'); banner.textContent = 'Starting camera…';
    var confidence = el('div', 'ar-confidence');
    var accuracy = el('div', 'ar-accuracy'); accuracy.textContent = 'GPS accuracy unavailable';
    var proximity = el('div', 'ar-proximity'); proximity.hidden = true;
    proximity.setAttribute('role', 'status');
    var qualifier = el('div', 'ar-qualifier'); qualifier.textContent = routeMode ? 'Approximate mapped trail · flat-ground estimate. Follow trail signs and check the map.' : 'Direction to a point, not a trail route.';
    confidence.appendChild(proximity);
    confidence.appendChild(accuracy);
    confidence.appendChild(qualifier);

    var btnClose = el('button', 'ar-btn ar-close'); btnClose.type = 'button'; btnClose.textContent = '✕'; btnClose.title = 'Close AR'; btnClose.setAttribute('aria-label', 'Close AR');
    var btnDebug = el('button', 'ar-btn ar-debug'); btnDebug.type = 'button'; btnDebug.textContent = 'ⓘ'; btnDebug.title = 'Calibrate compass'; btnDebug.setAttribute('aria-label', 'Calibrate compass');
    var btnMap = el('button', 'ar-btn ar-map-fallback'); btnMap.type = 'button'; btnMap.textContent = 'Use map instead'; btnMap.setAttribute('aria-label', 'Close camera and use map instead');

    var compass = el('div', 'ar-compass');
    compass.setAttribute('role', 'img');
    compass.innerHTML = '<div class="ar-compass-dial" aria-hidden="true"><span class="ar-compass-north">N</span><span class="ar-compass-needle">▲</span></div><strong class="ar-compass-reading">—</strong>';
    compass.setAttribute('aria-label', 'Compass unavailable');
    ov.appendChild(compass);
    ov.appendChild(video);
    ov.appendChild(routeSvg);
    ov.appendChild(chevron);
    ov.appendChild(marker);
    ov.appendChild(banner);
    ov.appendChild(hud);
    ov.appendChild(confidence);
    ov.appendChild(btnClose);
    ov.appendChild(btnDebug);
    ov.appendChild(btnMap);
    document.body.appendChild(ov);

    marker.querySelector('.ar-label').textContent = label;

    btnDebug.setAttribute('aria-expanded', 'false');
    btnClose.addEventListener('click', close);
    btnMap.addEventListener('click', close);
    btnDebug.addEventListener('click', function () { debug = !debug; hud.style.display = debug ? 'block' : 'none'; confidence.hidden = debug; btnDebug.setAttribute('aria-expanded', String(debug)); schedule(); });

    // ---- Sensors ------------------------------------------------------------
    start();
    var freshnessTimer = setInterval(schedule, 1000);
    window.addEventListener('resize', schedule);
    document.addEventListener('visibilitychange', onVisibility);
    function onVisibility() { if (document.hidden) close(); }


    async function start() {
      // Request orientation during the launch gesture, before awaiting camera.
      var orientationPermission = Promise.resolve('granted');
      try {
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
          orientationPermission = DeviceOrientationEvent.requestPermission().catch(function () { return 'denied'; });
        }
      } catch (e) { orientationPermission = Promise.resolve('denied'); }
      // Camera
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } }, audio: false
        });
        if (closed) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        video.srcObject = stream;
        banner.textContent = 'Waiting for GPS & compass…';
      } catch (e) {
        cameraError = 'Camera unavailable — ' + (e && e.message ? e.message : 'permission denied');
        banner.textContent = cameraError;
      }

      var permission = await orientationPermission;
      if (closed) return;
      // Kept apart from gpsError, which each successful fix clears.
      if (permission !== 'granted') compassError = 'Compass permission denied. Close and reopen camera to retry.';

      window.addEventListener('deviceorientationabsolute', onOrient, true);
      window.addEventListener('deviceorientation', onOrient, true);

      // GPS
      if (navigator.geolocation) {
        watchId = navigator.geolocation.watchPosition(onPos, function (e) {
          gpsError = 'GPS error — ' + (e && e.message ? e.message : 'denied');
          banner.textContent = gpsError;
          banner.style.display = 'block';
          pos = null; gpsAcc = null;
          marker.style.display = 'none'; chevron.style.display = 'none';
          schedule();
        }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
      } else {
        banner.textContent = 'Geolocation not available on this device.';
      }

      schedule();
    }

    function onPos(p) {
      if (closed) return;
      positionAt = p.timestamp || Date.now();
      gpsError = null;
      pos = { latitude: p.coords.latitude, longitude: p.coords.longitude };
      declination = Geo.declination(pos.latitude, pos.longitude, new Date(positionAt));
      gpsAcc = p.coords.accuracy;
      schedule();
    }

    function onOrient(e) {
      if (closed) return;
      beta = Number.isFinite(e.beta) ? e.beta : null;
      gamma = Number.isFinite(e.gamma) ? e.gamma : null;
      compassAccuracy = Number.isFinite(e.webkitCompassAccuracy) ? e.webkitCompassAccuracy : null;
      schedule();
      var h = headingFromEvent(e);
      if (h == null) return;
      orientationAt = Date.now();
      rawCompass = h;
      smoothCompass = Geo.smoothHeading(smoothCompass, h, HEADING_ALPHA);
      schedule();
    }

    // Magnetic heading of the camera. Both platforms are magnetic: WebKit forwards
    // CLHeading.magneticHeading, and Android's absolute frame is magnetic north.
    function headingFromEvent(e) {
      if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
        return e.webkitCompassHeading;
      }
      return e.absolute ? Geo.backCameraHeading(e.alpha, e.beta, e.gamma) : null;
    }

    // Trail and target bearings are true north, so the compass needs declination,
    // which needs a position. Until then there is no camera heading to project with.
    function trueCompass() {
      return smoothCompass == null || declination == null ? null : Geo.norm360(smoothCompass + declination);
    }

    function gpsFresh() { return !!pos && Date.now() - positionAt <= 15000; }
    function compassReliable() {
      return Number.isFinite(smoothCompass) && Date.now() - orientationAt <= 5000 &&
        (compassAccuracy == null || (compassAccuracy >= 0 && compassAccuracy <= 25));
    }
    // Shared by point and route guidance: the first reason position or camera heading
    // can't be trusted, or '' when both can.
    function sensorProblem() {
      if (!gpsFresh()) return 'Waiting for a fresh GPS fix…';
      if (!compassReliable()) return 'Waiting for a reliable compass. Move phone in a figure eight.';
      return declination == null ? NO_DECLINATION : '';
    }

    // ---- Render -------------------------------------------------------------
    function schedule() { if (!closed && !raf) raf = requestAnimationFrame(render); }

    function render() {
      raf = 0;
      if (closed) return;
      renderCompass();
      if (routeMode) { renderRoute(); return; }
      accuracy.textContent = Number.isFinite(gpsAcc) && gpsAcc > 0
        ? 'GPS accuracy ±' + Math.ceil(gpsAcc) + ' m'
        : 'GPS accuracy unavailable';
      if (!pos) { proximity.hidden = true; proximity.textContent = ''; setHud(); return; }

      var bearingToTarget = Geo.bearing(pos, target);
      var dist = Geo.distance(pos, target);
      // The marker shows where the camera points, so it uses the compass and never
      // walking course: hikers look sideways while moving.
      // Like the route, no camera means no AR marker and no activation report.
      var problem = cameraError || compassError || gpsError || sensorProblem();
      banner.style.display = problem ? 'block' : 'none';
      if (problem) banner.textContent = problem;

      var camera = problem ? null : trueCompass();
      var proj = camera == null ? null : Geo.projectToScreen({
        bearingToTarget: bearingToTarget, heading: camera,
        fovDeg: fovDeg, width: ov.clientWidth
      });

      var distStr = Geo.formatDistance(dist);
      if (proj && proj.onScreen && Number.isFinite(proj.x) && Number.isFinite(dist)) {
        marker.style.display = 'block';
        marker.style.left = proj.x + 'px';
        marker.style.top = (ov.clientHeight * MARKER_VERTICAL) + 'px';
        marker.querySelector('.ar-dist').textContent = distStr;
        chevron.style.display = 'none';
        // The bridge enforces once per app session and a zero-property payload.
        // Repeated animation frames therefore cannot inflate activation.
        reportSuccess();
      } else {
        marker.style.display = 'none';
        if (proj) {
          chevron.style.display = 'flex';
          chevron.className = 'ar-chevron ' + proj.side;
          chevron.querySelector('.ar-chev-arrow').textContent = proj.side === 'right' ? '▶' : '◀';
          chevron.querySelector('.ar-chev-text').textContent =
            'Turn ' + proj.side + ' · ' + distStr;
        } else {
          chevron.style.display = 'none';
        }
      }

      // Reported accuracy is an estimate, so describe proximity rather than arrival.
      var near = gpsFresh() && Number.isFinite(dist) && dist >= 0 &&
        Number.isFinite(gpsAcc) && gpsAcc > 0 && dist + gpsAcc <= ARRIVE_RADIUS_M;
      proximity.hidden = !near;
      proximity.textContent = near ? 'Near ' + label : '';
      if (near && !arrived) {
        arrived = true;
        if (typeof onArrive === 'function') { try { onArrive(); } catch (e) {} }
      }

      setHud(bearingToTarget, dist, camera, proj);
    }

    function reportSuccess() {
      if (window.AnalyticsBridge && typeof window.AnalyticsBridge.arSessionSucceeded === 'function') {
        window.AnalyticsBridge.arSessionSucceeded();
      }
    }

    function renderCompass() {
      var reliable = compassReliable();
      var reading = compass.querySelector('.ar-compass-reading');
      var dial = compass.querySelector('.ar-compass-dial');
      dial.style.visibility = reliable ? 'visible' : 'hidden';
      if (!reliable) {
        reading.textContent = '—';
        compass.setAttribute('aria-label', 'Compass unavailable');
        return;
      }
      var trueHeading = trueCompass(), magnetic = trueHeading == null;
      var shown = magnetic ? smoothCompass : trueHeading;
      var heading = Math.round(shown) % 360;
      var direction = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(heading / 45) % 8];
      dial.style.transform = 'rotate(' + (-shown) + 'deg)';
      reading.textContent = direction + ' ' + heading + '°' + (magnetic ? ' mag' : '');
      compass.setAttribute('aria-label', 'Compass heading ' + direction + ', ' + heading + ' degrees' + (magnetic ? ' magnetic' : ''));
    }

    function renderRoute() {
      marker.style.display = 'none'; chevron.style.display = 'none';
      proximity.hidden = true;
      accuracy.textContent = Number.isFinite(gpsAcc) && gpsAcc > 0
        ? 'GPS accuracy ±' + Math.ceil(gpsAcc) + ' m' : 'GPS accuracy unavailable';
      routePath.setAttribute('d', '');
      var angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
      var problem = cameraError || compassError || gpsError || sensorProblem();
      if (!problem && (!Number.isFinite(gpsAcc) || gpsAcc <= 0 || gpsAcc > 25)) problem = 'GPS too uncertain for trail overlay. Move to an open area.';
      if (!problem && (angle !== 0 || beta == null || gamma == null || beta < 25 || beta > 110 || Math.abs(gamma) > 15))
        problem = 'Hold phone upright in portrait, level left to right, and aim along the trail.';
      if (!problem) {
        // Camera direction must use the compass, never walking course: hikers can
        // look sideways while moving. Pitch moves the ground relative to the camera.
        var d = Geo.projectTrail(lines, pos, trueCompass(), beta - 90, ov.clientWidth, ov.clientHeight, fovDeg);
        routePath.setAttribute('d', d);
        problem = d ? '' : 'No mapped trail within 100 m in this direction. Turn toward the trail or check the map.';
        if (d) reportSuccess();
      }
      banner.textContent = problem || label;
      banner.style.display = 'block';
      setHud(null, null, trueCompass());
    }

    function setHud(bearingToTarget, dist, heading, proj) {
      if (!debug) return;
      hud.innerHTML =
        row('Heading (true)', heading == null ? '—' : heading.toFixed(0) + '°') +
        row('Compass(mag)', rawCompass == null ? '—' : rawCompass.toFixed(0) + '°') +
        row('Declination', declination == null ? '—' : declination.toFixed(1) + '°') +
        row('Bearing→tgt', bearingToTarget == null ? '—' : bearingToTarget.toFixed(0) + '°') +
        row('Relative', proj ? proj.relative.toFixed(0) + '°' : '—') +
        row('Distance', dist == null ? '—' : Geo.formatDistance(dist)) +
        row('GPS acc', gpsAcc == null ? '—' : '±' + gpsAcc.toFixed(0) + ' m') +
        '<div class="ar-fov"><span>FOV ' + fovDeg.toFixed(0) + '°</span>' +
        '<button data-fov="-1">−</button><button data-fov="1">+</button>' +
        '<span class="ar-fov-hint">calibrate so marker matches reality</span></div>';
      hud.querySelectorAll('[data-fov]').forEach(function (b) {
        b.addEventListener('click', function () {
          fovDeg = Math.max(21, Math.min(119, fovDeg + parseFloat(b.dataset.fov)));
          setFov(fovDeg); schedule();
        });
      });
    }

    function close() {
      if (closed) return;
      closed = true;
      clearInterval(freshnessTimer);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('visibilitychange', onVisibility);
      cancelAnimationFrame(raf);
      window.removeEventListener('deviceorientationabsolute', onOrient, true);
      window.removeEventListener('deviceorientation', onOrient, true);
      if (watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      if (ov.parentNode) ov.parentNode.removeChild(ov);
    }
  };

  // ---- helpers --------------------------------------------------------------
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function row(k, v) { return '<div class="ar-row"><span>' + k + '</span><b>' + v + '</b></div>'; }

  function injectStyles() {
    if (document.getElementById('ar-styles')) return;
    var s = document.createElement('style'); s.id = 'ar-styles';
    s.textContent =
      '.ar-overlay{position:fixed;inset:0;z-index:3000;background:#000;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}' +
      '.ar-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}' +
      '.ar-route{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:hidden}.ar-route path{fill:none;stroke:#58f4b3;stroke-width:9;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 2px 3px #000)}' +
      '.ar-marker{position:absolute;transform:translate(-50%,-100%);text-align:center;pointer-events:none;transition:left .08s linear}' +
      '.ar-pin{line-height:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,.6))}.ar-pin img{width:38px;height:38px;filter:invert(1)}' +
      '.ar-card{display:inline-block;margin-top:2px;background:rgba(20,40,25,.85);color:#fff;border-radius:10px;padding:6px 10px;backdrop-filter:blur(4px)}' +
      '.ar-label{font-size:22px;font-weight:600}' +
      '.ar-dist{font-size:20px;opacity:1;margin-top:1px}' +
      '.ar-chevron{position:absolute;top:42%;transform:translateY(-50%);display:none;flex-direction:column;align-items:center;color:#fff;gap:6px;pointer-events:none}' +
      '.ar-chevron.left{left:18px}.ar-chevron.right{right:18px}' +
      '.ar-chev-arrow{font-size:46px;line-height:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,.7));animation:arpulse 1.1s ease-in-out infinite}' +
      '.ar-chev-text{background:rgba(20,40,25,.85);border-radius:8px;padding:10px 14px;font-size:20px;font-weight:700;max-width:75vw}' +
      '@keyframes arpulse{0%,100%{transform:translateX(0);opacity:.85}50%{transform:translateX(4px);opacity:1}}' +
      '.ar-chevron.left .ar-chev-arrow{animation-name:arpulseL}@keyframes arpulseL{0%,100%{transform:translateX(0);opacity:.85}50%{transform:translateX(-4px);opacity:1}}' +
      '.ar-banner{position:absolute;left:16px;right:110px;top:calc(env(safe-area-inset-top,0px) + 14px);background:rgba(0,0,0,.88);color:#fff;padding:12px 14px;border-radius:14px;font-size:20px;font-weight:600;line-height:1.4;overflow-wrap:anywhere}' +
      '.ar-confidence{position:absolute;left:16px;right:16px;bottom:calc(env(safe-area-inset-bottom,0px) + 98px);padding:14px 16px;background:rgba(0,0,0,.88);color:#fff;border-radius:14px;font-size:22px;font-weight:600;pointer-events:none}' +
      '.ar-proximity{font-weight:700;margin-bottom:6px}.ar-qualifier{font-size:18px;font-weight:500;margin-top:8px;line-height:1.45}' +
      '.ar-btn{position:absolute;z-index:2;width:64px;height:64px;display:grid;place-items:center;padding:0;border-radius:50%;border:2px solid rgba(255,255,255,.7);background:rgba(0,0,0,.88);color:#fff;font-size:34px;font-weight:700;line-height:1;cursor:pointer;touch-action:manipulation;backdrop-filter:blur(4px)}' +
      '.ar-close{top:calc(env(safe-area-inset-top,0px) + 14px);right:18px}' +
      '.ar-debug{bottom:calc(env(safe-area-inset-bottom,0px) + 18px);left:18px}' +
      '.ar-map-fallback{right:18px;bottom:calc(env(safe-area-inset-bottom,0px) + 18px);width:auto;min-width:158px;padding:0 18px;border-radius:32px;font-size:18px;line-height:1.2}' +
      '.ar-compass{position:absolute;z-index:1;top:calc(env(safe-area-inset-top,0px) + 94px);right:12px;width:80px;padding:10px 4px;border-radius:18px;background:rgba(0,0,0,.88);color:#fff;text-align:center;pointer-events:none;box-sizing:border-box}' +
      '.ar-compass-dial{position:relative;width:60px;height:60px;margin:0 auto 8px;border:2px solid #fff;border-radius:50%;box-sizing:border-box}.ar-compass-north{position:absolute;top:0;left:0;right:0;font-size:18px;font-weight:800;line-height:22px}.ar-compass-needle{position:absolute;top:22px;left:0;right:0;color:#ff8585;font-size:26px;line-height:28px}.ar-compass-reading{display:block;font-size:18px;line-height:1.4;font-variant-numeric:tabular-nums}' +
      '.ar-hud{position:absolute;left:16px;right:16px;top:calc(env(safe-area-inset-top,0px) + 260px);bottom:calc(env(safe-area-inset-bottom,0px) + 98px);overflow:auto;display:none;background:rgba(0,0,0,.94);color:#cfe;border-radius:14px;padding:16px;font-size:18px;line-height:1.5;font-variant-numeric:tabular-nums}' +
      '.ar-row{display:flex;justify-content:space-between;gap:14px;padding:3px 0}.ar-row b{color:#fff}' +
      '.ar-fov{margin-top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +
      '.ar-fov button{width:56px;height:56px;border-radius:10px;border:2px solid #8db;background:#143;color:#fff;font-size:30px;cursor:pointer}' +
      '.ar-fov-hint{flex-basis:100%;font-size:18px;line-height:1.4}';
    document.head.appendChild(s);
  }
})();
