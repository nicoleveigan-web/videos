(function (global) {
  var MASKED_PRODUCT_NAME = 'Digital Ebook';

  function normalizeOrigin(u) {
    try { return new URL(u).origin; } catch (e) { return ''; }
  }

  function pickMaskedName(custom) {
    if (custom && String(custom).trim()) return String(custom).trim();
    return MASKED_PRODUCT_NAME;
  }

  function ebooksSuccessUrl(ebooksOrigin, price, maskedName, displayTitle, videoId) {
    var origin = normalizeOrigin(String(ebooksOrigin || '').replace(/\/+$/, ''));
    if (!origin) return null;
    var p = new URLSearchParams();
    p.set('status', 'success');
    p.set('product_name', pickMaskedName(maskedName));
    if (displayTitle) p.set('display_title', String(displayTitle));
    p.set('amount', String(price));
    if (videoId) p.set('video_id', String(videoId));
    return origin + '/?' + p.toString();
  }

  function checkoutMethodForOrigin(ebooksOrigin, localCheckout) {
    if (localCheckout) return 'payjsr';
    var origin = normalizeOrigin(String(ebooksOrigin || '').trim().replace(/\/+$/, ''));
    return origin ? 'whop' : 'payjsr';
  }

  function checkoutApiPath(ebooksOrigin, localCheckout) {
    if (localCheckout) return '/api/payjsr-checkout';
    var origin = normalizeOrigin(String(ebooksOrigin || '').trim().replace(/\/+$/, ''));
    return origin ? '/api/paypal-checkout' : '/api/payjsr-checkout';
  }

  function checkoutQuery(ebooksOrigin, price, maskedName, displayTitle, videoId, method, extra, localCheckout) {
    var origin = normalizeOrigin(String(ebooksOrigin || '').trim().replace(/\/+$/, ''));
    if (localCheckout) origin = typeof window !== 'undefined' ? window.location.origin : origin;
    if (!origin) return null;
    var vid = videoId || '';
    var title = displayTitle || 'Digital purchase';
    var masked = pickMaskedName(maskedName);
    var successUrl = ebooksSuccessUrl(origin, price, masked, title, vid);
    if (!successUrl) return null;
    var p = new URLSearchParams();
    p.set('amount', String(price));
    p.set('currency', 'USD');
    p.set('success_url', successUrl);
    p.set('product_name', masked);
    p.set('display_title', title);
    p.set('method', method || checkoutMethodForOrigin(origin, localCheckout));
    if (vid) p.set('video_id', vid);
    if (extra) {
      Object.keys(extra).forEach(function (k) {
        if (extra[k] != null && extra[k] !== '') p.set(k, String(extra[k]));
      });
    }
    return p;
  }

  function checkoutCancelUrl(origin, checkoutParams, apiPath) {
    var cancelP = new URLSearchParams(checkoutParams.toString());
    cancelP.set('payment_canceled', 'true');
    return origin + (apiPath || '/api/payjsr-checkout') + '?' + cancelP.toString();
  }

  function checkoutUrl(ebooksOrigin, price, maskedName, displayTitle, videoId, method, localCheckout) {
    var origin = normalizeOrigin(String(ebooksOrigin || '').trim().replace(/\/+$/, ''));
    if (localCheckout && typeof window !== 'undefined') origin = window.location.origin;
    var apiPath = checkoutApiPath(ebooksOrigin, localCheckout);
    var p = checkoutQuery(ebooksOrigin, price, maskedName, displayTitle, videoId, method, null, localCheckout);
    if (!p || !origin) return null;
    p.set('cancel_url', checkoutCancelUrl(origin, p, apiPath));
    return origin + apiPath + '?' + p.toString();
  }

  function watchUrl(videoId, preview) {
    var u = '/watch?id=' + encodeURIComponent(videoId || '');
    if (preview) u += '&preview=1';
    return u;
  }

  function formatDuration(d) {
    if (d == null || d === '') return '';
    if (typeof d === 'number' && !isNaN(d)) {
      var sec = Math.max(0, Math.round(Number(d)));
      var m = Math.floor(sec / 60), s = sec % 60;
      return m + 'min ' + s + 's';
    }
    var parts = String(d).split(':');
    if (parts.length === 2) {
      var mm = parseInt(parts[0], 10) || 0, ss = Math.round(parseFloat(parts[1]) || 0);
      return mm + 'min ' + ss + 's';
    }
    if (parts.length === 3) {
      var h = parseInt(parts[0], 10) || 0, mm2 = parseInt(parts[1], 10) || 0, ss2 = Math.round(parseFloat(parts[2]) || 0);
      return h + 'h ' + mm2 + 'm ' + ss2 + 's';
    }
    return String(d);
  }

  function formatViews(v) {
    v = Number(v) || 0;
    if (v < 1000) return v + ' views';
    if (v < 1e6) return (v / 1000).toFixed(1) + 'K views';
    return (v / 1e6).toFixed(1) + 'M views';
  }

  function formatDateRel(iso) {
    if (!iso) return '';
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    var ms = Date.now() - date.getTime();
    if (ms < 0) ms = 0;
    var sec = Math.floor(ms / 1000);
    var min = Math.floor(sec / 60);
    var hr = Math.floor(min / 60);
    var days = Math.floor(hr / 24);
    if (sec < 60) return 'Just now';
    if (min < 60) return min === 1 ? '1 minute ago' : min + ' minutes ago';
    if (hr < 24) return hr === 1 ? '1 hour ago' : hr + ' hours ago';
    if (days === 1) return 'Yesterday';
    if (days < 7) return days + ' days ago';
    if (days < 30) {
      var weeks = Math.floor(days / 7);
      return weeks === 1 ? '1 week ago' : weeks + ' weeks ago';
    }
    if (days < 365) {
      var months = Math.floor(days / 30);
      return months === 1 ? '1 month ago' : months + ' months ago';
    }
    var years = Math.floor(days / 365);
    return years === 1 ? '1 year ago' : years + ' years ago';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;'); }

  var DEFAULT_POSTER_AT = 1;

  async function fetchSigned(fileKey) {
    if (!fileKey) return null;
    var r = await fetch('/api/signed-url?key=' + encodeURIComponent(String(fileKey).trim()));
    if (!r.ok) return null;
    var j = await r.json();
    return j.success && j.url ? j.url : null;
  }

  function posterAtSeconds(v) {
    var n = Number(v && v.poster_at);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_POSTER_AT;
  }

  function applyVideoPoster(container, url, atSec) {
    return new Promise(function (resolve, reject) {
      if (!container || !url) {
        reject(new Error('missing'));
        return;
      }
      var video = container.querySelector('video');
      if (!video) {
        video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('muted', '');
        video.preload = 'metadata';
        video.setAttribute('aria-hidden', 'true');
        container.appendChild(video);
      }
      var settled = false;
      function finish(ok) {
        if (settled) return;
        settled = true;
        if (ok) {
          video.style.display = 'block';
          resolve(video);
        } else {
          reject(new Error('poster'));
        }
      }
      video.onerror = function () { finish(false); };
      video.onseeked = function () {
        try { video.pause(); } catch (e) { /* ignore */ }
        finish(true);
      };
      video.onloadedmetadata = function () {
        var dur = video.duration;
        var t = Number(atSec);
        if (!Number.isFinite(t) || t < 0) t = DEFAULT_POSTER_AT;
        if (Number.isFinite(dur) && dur > 0) {
          t = Math.min(t, Math.max(0, dur - 0.05));
        }
        try {
          video.currentTime = t;
        } catch (e) {
          finish(false);
        }
      };
      video.src = url;
      video.load();
    });
  }

  async function hydrateVideoPoster(v, container, opts) {
    opts = opts || {};
    var url = opts.url || (await resolvePlaybackUrl(v));
    if (!url || !container) return null;
    var at = opts.at != null ? opts.at : posterAtSeconds(v);
    try {
      var el = await applyVideoPoster(container, url, at);
      if (opts.onReady) opts.onReady(el);
      return el;
    } catch (e) {
      if (opts.onError) opts.onError(e);
      return null;
    }
  }

  function tgUrlForVideo(v, tgUser) {
    var price = Number(v.price) || 0;
    var priceLabel = Number.isInteger(price) ? String(price) : price.toFixed(2);
    var msg =
      'Hi 👋\n' +
      'I want to purchase:\n' +
      '📦 Content: ' + String(v.title || 'ALL CONTENT') + '\n' +
      '💰 Price: $' + priceLabel + '\n' +
      'Please send me the payment details.';
    var enc = encodeURIComponent(msg);
    if (tgUser) return 'https://t.me/' + tgUser + '?text=' + enc;
    return 'https://t.me/share/url?url=&text=' + enc;
  }

  function tgUrlCryptoProof(v, tgUser, wallets) {
    var lines = (wallets || []).map(function (w) {
      return '• ' + String(w.label || w.symbol || 'Wallet').toUpperCase() + ': ' + String(w.address || '');
    }).join('\n');
    var msg =
      'Crypto $' + Number(v.price).toFixed(2) + ' — ' + v.title + '\n' +
      lines + '\n' +
      'TX hash:';
    var enc = encodeURIComponent(msg);
    if (tgUser) return 'https://t.me/' + tgUser + '?text=' + enc;
    return 'https://t.me/share/url?url=&text=' + enc;
  }

  function tgUrlPaymentSuccess(info, tgUser) {
    var lines = [
      '🎉 Payment successful!',
      '',
      '🎬 **Video:** ' + (info.displayTitle || info.product || 'Digital purchase'),
      info.amount ? '💰 **Amount:** $' + info.amount + ' USD' : '',
      info.orderId ? '🧾 **Order:** ' + info.orderId : '',
      info.videoId ? '🆔 **Reference:** ' + info.videoId : '',
      '',
      'Please send me access to the content. Thank you!'
    ].filter(Boolean).join('\n');
    var enc = encodeURIComponent(lines);
    if (tgUser) return 'https://t.me/' + tgUser + '?text=' + enc;
    return 'https://t.me/share/url?url=&text=' + enc;
  }

  function copyToClipboard(text, btn) {
    text = String(text || '');
    if (btn && !btn.getAttribute('data-label')) {
      btn.setAttribute('data-label', (btn.textContent || 'Copy').trim());
    }
    function done(ok) {
      if (!btn) return;
      btn.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(function () {
        btn.textContent = btn.getAttribute('data-label') || 'Copy';
      }, 1600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }).catch(function () { done(false); });
      return;
    }
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done(true);
    } catch (e) {
      done(false);
    }
  }

  function resolvePlaybackUrl(v) {
    if (v.public_video_url && /^https?:\/\//i.test(String(v.public_video_url).trim())) {
      return Promise.resolve(String(v.public_video_url).trim());
    }
    if (v.playback_url && /^https?:\/\//i.test(v.playback_url)) {
      return Promise.resolve(v.playback_url);
    }
    if (v.wasabi_video_key) return fetchSigned(v.wasabi_video_key);
    return Promise.resolve(null);
  }

  global.Storefront = {
    MASKED_PRODUCT_NAME: MASKED_PRODUCT_NAME,
    normalizeOrigin: normalizeOrigin,
    pickMaskedName: pickMaskedName,
    ebooksSuccessUrl: ebooksSuccessUrl,
    checkoutUrl: checkoutUrl,
    watchUrl: watchUrl,
    formatDuration: formatDuration,
    formatViews: formatViews,
    formatDateRel: formatDateRel,
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    fetchSigned: fetchSigned,
    tgUrlForVideo: tgUrlForVideo,
    tgUrlCryptoProof: tgUrlCryptoProof,
    tgUrlPaymentSuccess: tgUrlPaymentSuccess,
    copyToClipboard: copyToClipboard,
    resolvePlaybackUrl: resolvePlaybackUrl,
    DEFAULT_POSTER_AT: DEFAULT_POSTER_AT,
    posterAtSeconds: posterAtSeconds,
    applyVideoPoster: applyVideoPoster,
    hydrateVideoPoster: hydrateVideoPoster
  };
})(typeof window !== 'undefined' ? window : this);
