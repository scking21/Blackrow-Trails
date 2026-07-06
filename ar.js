/* ar.js — Trail Marker AR (sensor overlay, no ARKit/ARCore).
 * Camera background + GPS + heading + trig. Tolerates GPS slop: a marker a few
 * meters off still reads correctly. Depends on window.Geo (geo.js).
 *
 * window.openTrailMarkerAR({ latitude, longitude, label, onArrive })
 *
 * TWO THINGS YOU MUST DO (the scaffold can't):
 *  1. Calibrate FOV: open the debug HUD (ⓘ), aim a known-direction landmark to
 *     screen center, nudge FOV +/- until the marker lines up as you pan.
 *  2. Field-test on foot: tune HEADING_ALPHA (lower = calmer) and
 *     COURSE_SPEED_THRESHOLD until it feels locked-on while walking.
 */
(function () {
  'use strict';

  // ---- Tunables -------------------------------------------------------------
  var DEFAULT_FOV_DEG = 55;          // GUESS. Calibrate per device/lens/orientation.
  var HEADING_ALPHA = 0.15;          // compass smoothing (new-sample weight); lower = calmer
  var COURSE_SPEED_THRESHOLD = 1.0;  // m/s (~3.6 km/h) — above this, trust GPS course
  var ARRIVE_RADIUS_M = 15;          // "you're here" radius
  var MARKER_VERTICAL = 0.42;        // fixed vertical placement (0=top,1=bottom) for v1
  var FOV_KEY = 'trailapp.ar.fov';

  function getFov() {
    var v = parseFloat(localStorage.getItem(FOV_KEY));
    return (v && v > 20 && v < 120) ? v : DEFAULT_FOV_DEG;
  }
  function setFov(v) { try { localStorage.setItem(FOV_KEY, String(v)); } catch (e) {} }

  injectStyles();

  window.openTrailMarkerAR = function (opts) {
    var target = { latitude: opts.latitude, longitude: opts.longitude };
    var label = opts.label || 'Waypoint';
    var onArrive = opts.onArrive;

    var Geo = window.Geo;
    if (!Geo) { alert('AR math module (geo.js) not loaded.'); return; }

    // ---- State --------------------------------------------------------------
    var fovDeg = getFov();
    var pos = null, gpsAcc = null, gpsCourse = null, gpsSpeed = null;
    var rawCompass = null, smoothCompass = null;
    var arrived = false, debug = false, raf = 0;
    var stream = null, watchId = null;

    // ---- DOM ----------------------------------------------------------------
    var ov = el('div', 'ar-overlay');
    var video = el('video', 'ar-video'); video.setAttribute('playsinline', ''); video.setAttribute('muted', ''); video.muted = true; video.autoplay = true;
    var marker = el('div', 'ar-marker');
    marker.innerHTML = '<div class="ar-pin">📍</div><div class="ar-card"><div class="ar-label"></div><div class="ar-dist"></div></div>';
    var chevron = el('div', 'ar-chevron'); chevron.innerHTML = '<div class="ar-chev-arrow"></div><div class="ar-chev-text"></div>';
    var hud = el('div', 'ar-hud');
    var banner = el('div', 'ar-banner'); banner.textContent = 'Starting camera…';

    var btnClose = el('button', 'ar-btn ar-close'); btnClose.textContent = '✕'; btnClose.title = 'Close AR';
    var btnDebug = el('button', 'ar-btn ar-debug'); btnDebug.textContent = 'ⓘ'; btnDebug.title = 'Debug / calibrate';

    ov.appendChild(video);
    ov.appendChild(chevron);
    ov.appendChild(marker);
    ov.appendChild(banner);
    ov.appendChild(hud);
    ov.appendChild(btnClose);
    ov.appendChild(btnDebug);
    document.body.appendChild(ov);

    marker.querySelector('.ar-label').textContent = label;

    btnClose.addEventListener('click', close);
    btnDebug.addEventListener('click', function () { debug = !debug; hud.style.display = debug ? 'block' : 'none'; schedule(); });

    // ---- Sensors ------------------------------------------------------------
    start();

    async function start() {
      // Camera
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } }, audio: false
        });
        video.srcObject = stream;
        banner.textContent = 'Waiting for GPS & compass…';
      } catch (e) {
        banner.textContent = 'Camera unavailable — ' + (e && e.message ? e.message : 'permission denied');
      }

      // Orientation permission (iOS 13+ needs an explicit request from a gesture)
      try {
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
          await DeviceOrientationEvent.requestPermission();
        }
      } catch (e) { /* user declined; GPS course can still drive it while walking */ }

      window.addEventListener('deviceorientationabsolute', onOrient, true);
      window.addEventListener('deviceorientation', onOrient, true);

      // GPS
      if (navigator.geolocation) {
        watchId = navigator.geolocation.watchPosition(onPos, function (e) {
          banner.textContent = 'GPS error — ' + (e && e.message ? e.message : 'denied');
        }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
      } else {
        banner.textContent = 'Geolocation not available on this device.';
      }

      schedule();
    }

    function onPos(p) {
      pos = { latitude: p.coords.latitude, longitude: p.coords.longitude };
      gpsAcc = p.coords.accuracy;
      gpsSpeed = (p.coords.speed != null && !isNaN(p.coords.speed)) ? p.coords.speed : null;
      gpsCourse = (p.coords.heading != null && !isNaN(p.coords.heading)) ? p.coords.heading : null;
      schedule();
    }

    function onOrient(e) {
      var h = headingFromEvent(e);
      if (h == null) return;
      rawCompass = h;
      smoothCompass = Geo.smoothHeading(smoothCompass, h, HEADING_ALPHA);
      schedule();
    }

    function headingFromEvent(e) {
      // iOS: true heading, clockwise from north, declination handled by the OS.
      if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
        return e.webkitCompassHeading;
      }
      // Android 'deviceorientationabsolute': alpha is CCW from north.
      if (e.absolute && e.alpha != null) {
        var so = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
        return Geo.norm360(360 - e.alpha + so);
      }
      return null;
    }

    // ---- Render -------------------------------------------------------------
    function schedule() { if (!raf) raf = requestAnimationFrame(render); }

    function render() {
      raf = 0;
      if (!pos) { setHud(); return; }

      var bearingToTarget = Geo.bearing(pos, target);
      var dist = Geo.distance(pos, target);
      var chosen = Geo.chooseHeading({
        course: gpsCourse, speed: gpsSpeed, compass: smoothCompass,
        courseSpeedThreshold: COURSE_SPEED_THRESHOLD
      });

      if (chosen.source === 'none') {
        banner.style.display = 'block';
        banner.textContent = 'Point the phone around to get a compass fix…';
      } else {
        banner.style.display = 'none';
      }

      var proj = Geo.projectToScreen({
        bearingToTarget: bearingToTarget, heading: chosen.heading,
        fovDeg: fovDeg, width: ov.clientWidth
      });

      var distStr = Geo.formatDistance(dist);
      if (proj.onScreen && chosen.source !== 'none') {
        marker.style.display = 'block';
        marker.style.left = proj.x + 'px';
        marker.style.top = (ov.clientHeight * MARKER_VERTICAL) + 'px';
        marker.querySelector('.ar-dist').textContent = distStr;
        chevron.style.display = 'none';
      } else {
        marker.style.display = 'none';
        if (chosen.source !== 'none') {
          chevron.style.display = 'flex';
          chevron.className = 'ar-chevron ' + proj.side;
          chevron.querySelector('.ar-chev-arrow').textContent = proj.side === 'right' ? '▶' : '◀';
          chevron.querySelector('.ar-chev-text').textContent =
            'Turn ' + proj.side + ' · ' + distStr;
        } else {
          chevron.style.display = 'none';
        }
      }

      // Arrival
      if (!arrived && dist <= ARRIVE_RADIUS_M) {
        arrived = true;
        banner.style.display = 'block';
        banner.textContent = '✓ You\'ve arrived at ' + label;
        banner.classList.add('arrived');
        if (typeof onArrive === 'function') { try { onArrive(); } catch (e) {} }
      }

      setHud(bearingToTarget, dist, chosen, proj);
    }

    function setHud(bearingToTarget, dist, chosen, proj) {
      if (!debug) return;
      hud.innerHTML =
        row('Heading', chosen ? chosen.heading.toFixed(0) + '°' : '—') +
        row('Source', chosen ? chosen.source : '—') +
        row('Compass(raw)', rawCompass == null ? '—' : rawCompass.toFixed(0) + '°') +
        row('GPS course', gpsCourse == null ? '—' : gpsCourse.toFixed(0) + '°') +
        row('Speed', gpsSpeed == null ? '—' : gpsSpeed.toFixed(1) + ' m/s') +
        row('Bearing→tgt', bearingToTarget == null ? '—' : bearingToTarget.toFixed(0) + '°') +
        row('Relative', proj ? proj.relative.toFixed(0) + '°' : '—') +
        row('Distance', dist == null ? '—' : Geo.formatDistance(dist)) +
        row('GPS acc', gpsAcc == null ? '—' : '±' + gpsAcc.toFixed(0) + ' m') +
        '<div class="ar-fov"><span>FOV ' + fovDeg.toFixed(0) + '°</span>' +
        '<button data-fov="-1">−</button><button data-fov="1">+</button>' +
        '<span class="ar-fov-hint">calibrate so marker matches reality</span></div>';
      hud.querySelectorAll('[data-fov]').forEach(function (b) {
        b.addEventListener('click', function () {
          fovDeg = Math.max(20, Math.min(120, fovDeg + parseFloat(b.dataset.fov)));
          setFov(fovDeg); schedule();
        });
      });
    }

    function close() {
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
      '.ar-marker{position:absolute;transform:translate(-50%,-100%);text-align:center;pointer-events:none;transition:left .08s linear}' +
      '.ar-pin{font-size:38px;line-height:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,.6))}' +
      '.ar-card{display:inline-block;margin-top:2px;background:rgba(20,40,25,.85);color:#fff;border-radius:10px;padding:6px 10px;backdrop-filter:blur(4px)}' +
      '.ar-label{font-size:14px;font-weight:600}' +
      '.ar-dist{font-size:12px;opacity:.85;margin-top:1px}' +
      '.ar-chevron{position:absolute;top:42%;transform:translateY(-50%);display:none;flex-direction:column;align-items:center;color:#fff;gap:6px;pointer-events:none}' +
      '.ar-chevron.left{left:18px}.ar-chevron.right{right:18px}' +
      '.ar-chev-arrow{font-size:46px;line-height:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,.7));animation:arpulse 1.1s ease-in-out infinite}' +
      '.ar-chev-text{background:rgba(20,40,25,.85);border-radius:8px;padding:4px 9px;font-size:12px;font-weight:600;white-space:nowrap}' +
      '@keyframes arpulse{0%,100%{transform:translateX(0);opacity:.85}50%{transform:translateX(4px);opacity:1}}' +
      '.ar-chevron.left .ar-chev-arrow{animation-name:arpulseL}@keyframes arpulseL{0%,100%{transform:translateX(0);opacity:.85}50%{transform:translateX(-4px);opacity:1}}' +
      '.ar-banner{position:absolute;left:50%;top:env(safe-area-inset-top,12px);transform:translateX(-50%);margin-top:12px;background:rgba(0,0,0,.62);color:#fff;padding:8px 14px;border-radius:20px;font-size:13px;max-width:80%;text-align:center}' +
      '.ar-banner.arrived{background:rgba(46,107,52,.95);font-weight:600}' +
      '.ar-btn{position:absolute;width:44px;height:44px;border-radius:50%;border:none;background:rgba(0,0,0,.5);color:#fff;font-size:18px;cursor:pointer;backdrop-filter:blur(4px)}' +
      '.ar-close{top:calc(env(safe-area-inset-top,12px) + 10px);right:14px}' +
      '.ar-debug{bottom:calc(env(safe-area-inset-bottom,12px) + 14px);right:14px;font-size:20px}' +
      '.ar-hud{position:absolute;left:14px;bottom:calc(env(safe-area-inset-bottom,12px) + 14px);display:none;background:rgba(0,0,0,.7);color:#cfe;border-radius:10px;padding:10px 12px;font-size:12px;min-width:190px;font-variant-numeric:tabular-nums}' +
      '.ar-row{display:flex;justify-content:space-between;gap:14px;padding:1px 0}.ar-row b{color:#fff}' +
      '.ar-fov{margin-top:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}' +
      '.ar-fov button{width:26px;height:26px;border-radius:6px;border:1px solid #4a6;background:#143;color:#fff;font-size:15px;cursor:pointer}' +
      '.ar-fov-hint{flex-basis:100%;font-size:10px;opacity:.6}';
    document.head.appendChild(s);
  }
})();
