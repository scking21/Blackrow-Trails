// ============================================================================
//  billing.js — In-App Purchase / subscription bridge (StoreKit + Play Billing)
//  ----------------------------------------------------------------------------
//  Blackrow Trails is a Capacitor app, so real subscriptions go through the native
//  stores. This file is a thin, defensive wrapper around cordova-plugin-purchase
//  (CdvPurchase v13), an open-source (MIT) library that talks DIRECTLY to Apple
//  StoreKit and Google Play Billing — entirely on-device, with no third-party
//  backend, no account, and no analytics. That keeps the app's "no servers / no
//  trackers / no data collected" posture intact.
//
//  On the web (or any build where the plugin isn't installed) every method
//  degrades gracefully: `isAvailable()` returns false and the app falls back to
//  the built-in simulated Entitlement flow, so development never breaks.
//
//  Validation is on-device (no server-side receipt check). For a single Pro
//  unlock with no user accounts that's standard; add a validator URL later if
//  you ever want server-side verification.
//
//  ---- One-time store setup (do this before shipping) ----
//  1. npm i cordova-plugin-purchase && npx cap sync
//  2. App Store Connect: create an auto-renewable subscription group with products
//     `trailpro_monthly` and `trailpro_yearly`. Add a 14-day free trial as an
//     *introductory offer* on each (StoreKit serves the trial).
//  3. Google Play Console: create a subscription with base plans `monthly` /
//     `yearly`, each with a 14-day free-trial offer.
//  No API keys, dashboards, or accounts to configure — the product IDs below are
//  all the library needs.
// ============================================================================
window.Billing = (function () {
  const ENTITLEMENT_ID = 'pro';            // logical entitlement name (app-internal)
  const PRODUCTS = { monthly: 'trailpro_monthly', yearly: 'trailpro_yearly' };

  const Cap = window.Capacitor;
  const platform = (Cap && Cap.getPlatform && Cap.getPlatform()) || 'web';
  const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());

  // The plugin attaches itself to window.CdvPurchase when installed + synced.
  function api() { return window.CdvPurchase || null; }
  function isAvailable() { return isNative && !!api(); }

  // Owned = an active subscription to either plan, per the on-device receipt.
  function isPro() {
    const C = api(); if (!C) return false;
    try { return !!(C.store.owned(PRODUCTS.monthly) || C.store.owned(PRODUCTS.yearly)); }
    catch (e) { return false; }
  }

  // Reflect the live store entitlement into the app's Entitlement model.
  function applyOwned() {
    const active = isPro();
    if (window.Entitlement && window.Entitlement.setFromStore) window.Entitlement.setFromStore(active);
    return active;
  }

  // Initialize the store exactly once (register products + wire callbacks).
  let initPromise = null;
  function ready() {
    if (!isAvailable()) return Promise.resolve(false);
    if (!initPromise) {
      initPromise = (async () => {
        const { store, ProductType, Platform } = api();
        const stores = [Platform.APPLE_APPSTORE, Platform.GOOGLE_PLAY];
        store.register(stores.flatMap(p => [
          { id: PRODUCTS.monthly, type: ProductType.PAID_SUBSCRIPTION, platform: p },
          { id: PRODUCTS.yearly,  type: ProductType.PAID_SUBSCRIPTION, platform: p }
        ]));
        store.when()
          .approved(t => t.finish())          // on-device: accept and close out the transaction
          .receiptUpdated(() => applyOwned())  // ownership changed -> sync entitlement
          .productUpdated(() => applyOwned());
        store.error(e => console.warn('[Billing] store error', e && e.message ? e.message : e));
        await store.initialize(stores);
        return true;
      })().catch(e => { console.warn('[Billing] init failed', e); return false; });
    }
    return initPromise;
  }
  // Back-compat alias (the old API exposed configure()).
  const configure = ready;

  // Pull current subscription status from the store (call on app start).
  async function refresh() {
    if (!(await ready())) return false;
    return applyOwned();
  }

  // The localized offer for a product, plus its display price string.
  function offerFor(productId) {
    const C = api(); if (!C) return null;
    const p = C.store.get(productId);
    if (!p) return null;
    const offer = (p.getOffer && p.getOffer()) || (p.offers && p.offers[0]) || null;
    const phase = offer && offer.pricingPhases && offer.pricingPhases[0];
    const priceString = (phase && phase.price) || (p.pricing && p.pricing.price) || null;
    return { product: p, offer, priceString };
  }

  // Shape-compatible with the old RevenueCat getOfferings(): the paywall reads
  // `.availablePackages[].product.{identifier,priceString}` for live pricing.
  async function getOfferings() {
    if (!(await ready())) return null;
    const availablePackages = [];
    for (const term of ['monthly', 'yearly']) {
      const id = PRODUCTS[term];
      const o = offerFor(id);
      if (o) availablePackages.push({ identifier: term, product: { identifier: id, priceString: o.priceString }, _offer: o.offer });
    }
    return { availablePackages };
  }

  async function orderPlan(term) {
    if (!(await ready())) return 'unavailable';
    const productId = PRODUCTS[term];
    if (!productId) { console.warn('[Billing] unknown term', term); return 'unavailable'; }
    const o = offerFor(productId);
    if (!o || !o.offer) { console.warn('[Billing] no offer for', productId); return 'unavailable'; }
    try {
      const C = api();
      const res = await C.store.order(o.offer);
      if (res && res.isError) {
        if (res.code === C.ErrorCode.PAYMENT_CANCELLED) return 'cancelled';
        console.warn('[Billing] order failed', res.message);
        return 'unavailable';
      }
    } catch (e) { console.warn('[Billing] purchase failed', e); return 'unavailable'; }
    // Ownership flips asynchronously via receiptUpdated; give it a moment.
    for (let i = 0; i < 20 && !isPro(); i++) await new Promise(r => setTimeout(r, 150));
    return applyOwned() ? 'redeemed' : 'opened';
  }

  // Purchase a plan. term = 'monthly' | 'yearly'. Resolves true on success.
  async function purchase(term) {
    return (await orderPlan(term)) === 'redeemed';
  }

  // Restore purchases (App Store / Play require a visible "Restore" path).
  async function restore() {
    if (!(await ready())) return false;
    try { await api().store.restorePurchases(); }
    catch (e) { console.warn('[Billing] restore failed', e); }
    return applyOwned();
  }

  // Open the platform-owned promotional-code flow. Apple provides a native
  // offer-code redemption sheet; Google Play accepts subscription promo codes
  // inside the normal purchase sheet under Payment method > Redeem code.
  // Entitlement still comes only from the store receipt — this never accepts
  // or validates developer-defined codes inside the app.
  async function redeemOfferCode() {
    if (!(await ready())) return 'unavailable';
    const C = api();
    if (platform === 'ios') {
      const adapter = C.store.adapters && C.store.adapters.findReady
        ? C.store.adapters.findReady(C.Platform.APPLE_APPSTORE)
        : null;
      if (!adapter || typeof adapter.presentCodeRedemptionSheet !== 'function') return 'unavailable';
      try {
        await adapter.presentCodeRedemptionSheet();
        // The native callback means the sheet was presented, not that the user
        // finished redeeming. receiptUpdated will apply ownership afterward.
        return 'opened';
      } catch (e) {
        console.warn('[Billing] offer code redemption failed', e);
        return 'unavailable';
      }
    }
    if (platform === 'android') {
      return orderPlan('monthly');
    }
    return 'unavailable';
  }

  return { isAvailable, configure, refresh, getOfferings, purchase, restore, redeemOfferCode, PRODUCTS, ENTITLEMENT_ID, platform };
})();
