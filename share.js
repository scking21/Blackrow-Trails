// ============================================================================
//  share.js — native OS share-sheet bridge (Apple + Android)
//  ----------------------------------------------------------------------------
//  Wraps the Capacitor Share plugin (@capacitor/share), which opens the real
//  system share sheet — iOS UIActivityViewController, Android ACTION_SEND — so
//  the user can hand their trip plan to Messages, Mail, WhatsApp, AirDrop, etc.
//
//  Graceful three-tier fallback so it works everywhere:
//    1. Capacitor Share  — native iOS/Android share sheet (packaged app)
//    2. Web Share API     — navigator.share() (mobile browsers, some desktops)
//    3. Clipboard         — copies the text so the user can paste it anywhere
//
//  Install for native builds:  npm i @capacitor/share && npx cap sync
//  (On web / when the plugin is absent, tiers 2–3 cover it — dev never breaks.)
// ============================================================================
window.TripShare = (function () {
  const Cap = window.Capacitor;
  const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  function sharePlugin() { return (Cap && Cap.Plugins && Cap.Plugins.Share) || null; }
  function canNative() { return isNative && !!sharePlugin(); }
  function isCancel(e) {
    const m = (e && (e.message || e.name) || '').toLowerCase();
    return e && (e.name === 'AbortError' || m.includes('cancel') || m.includes('abort'));
  }

  // share({ title, text, url, dialogTitle }) -> { method, ok, cancelled? }
  async function share(opts) {
    const o = opts || {};
    // 1. Native share sheet (Capacitor)
    if (canNative()) {
      try {
        await sharePlugin().share({
          title: o.title, text: o.text, url: o.url,
          dialogTitle: o.dialogTitle || o.title || 'Share'
        });
        return { method: 'native', ok: true };
      } catch (e) {
        if (isCancel(e)) return { method: 'native', ok: false, cancelled: true };
        console.warn('[TripShare] native share failed, falling back', e);
      }
    }
    // 2. Web Share API
    if (navigator.share) {
      try {
        await navigator.share({ title: o.title, text: o.text, url: o.url });
        return { method: 'web', ok: true };
      } catch (e) {
        if (isCancel(e)) return { method: 'web', ok: false, cancelled: true };
        console.warn('[TripShare] web share failed, falling back', e);
      }
    }
    // 3. Clipboard fallback
    const blob = [o.title, o.text, o.url].filter(Boolean).join('\n\n');
    try {
      await navigator.clipboard.writeText(blob);
      return { method: 'clipboard', ok: true, text: blob };
    } catch (e) {
      return { method: 'none', ok: false, text: blob };
    }
  }

  return { share, canNative, available: () => canNative() || !!navigator.share };
})();
