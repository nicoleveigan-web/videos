import crypto from 'node:crypto';

const PAYPAL_API = {
  live: 'https://api-m.paypal.com',
  sandbox: 'https://api-m.sandbox.paypal.com',
};
const BUNDLE_PRICE = '150.00';

function paypalConfig() {
  const clientId = String(process.env.PAYPAL_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.PAYPAL_CLIENT_SECRET || '').trim();
  const mode = String(process.env.PAYPAL_ENVIRONMENT || 'live').trim().toLowerCase();
  return {
    clientId,
    clientSecret,
    baseUrl: mode === 'sandbox' ? PAYPAL_API.sandbox : PAYPAL_API.live,
    configured: Boolean(clientId && clientSecret),
  };
}

async function paypalRequest(path, options = {}) {
  const config = paypalConfig();
  if (!config.configured) throw new Error('PayPal is not configured. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.');

  const tokenResponse = await fetch(`${config.baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(12000),
  });
  const tokenPayload = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenPayload.access_token) {
    throw new Error('Could not authenticate with PayPal. Check the PayPal app credentials and environment.');
  }

  const response = await fetch(`${config.baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${tokenPayload.access_token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || 'PayPal could not process the request.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

function isFullContentOrder(order) {
  if (order?.status !== 'COMPLETED') return false;
  const purchaseUnit = Array.isArray(order.purchase_units)
    ? order.purchase_units.find((unit) => unit.custom_id === 'full-content-v1')
    : null;
  const amount = purchaseUnit?.payments?.captures?.find((capture) => capture.status === 'COMPLETED')?.amount;
  return Boolean(
    amount &&
    amount.currency_code === 'USD' &&
    Number(amount.value).toFixed(2) === BUNDLE_PRICE
  );
}

function hasFullContentPurchaseUnit(order) {
  const purchaseUnit = Array.isArray(order?.purchase_units)
    ? order.purchase_units.find((unit) => unit.custom_id === 'full-content-v1')
    : null;
  return Boolean(
    purchaseUnit &&
    purchaseUnit.amount?.currency_code === 'USD' &&
    Number(purchaseUnit.amount.value).toFixed(2) === BUNDLE_PRICE
  );
}

export function registerPaypalRoutes(app, { getAllVideosForBundle, getTelegramUsername }) {
  app.post('/api/paypal/orders', async (req, res) => {
    try {
      if (!paypalConfig().configured) {
        return res.status(503).json({ ok: false, error: 'PayPal is not configured. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.' });
      }
      if (typeof getAllVideosForBundle !== 'function') {
        return res.status(503).json({ ok: false, error: 'The full-content offer is not configured.' });
      }
      const videos = await getAllVideosForBundle();
      if (!videos.some((video) => !video.is_free && Number(video.price) > 0)) {
        return res.status(404).json({ ok: false, error: 'The full-content offer is not available.' });
      }

      const order = await paypalRequest('/v2/checkout/orders', {
        method: 'POST',
        headers: { 'PayPal-Request-Id': crypto.randomUUID() },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{
            custom_id: 'full-content-v1',
            description: 'Full Content — all content available on this site',
            amount: { currency_code: 'USD', value: BUNDLE_PRICE },
          }],
        }),
      });
      if (!order.id || order.status !== 'CREATED') {
        return res.status(502).json({ ok: false, error: 'PayPal did not create the payment order.' });
      }
      res.json({ ok: true, id: order.id });
    } catch (error) {
      console.error('PayPal order creation failed:', error.message);
      res.status(error.status === 422 ? 422 : 502).json({ ok: false, error: error.message || 'Could not start PayPal checkout.' });
    }
  });

  app.post('/api/paypal/orders/:orderId/capture', async (req, res) => {
    try {
      const orderId = String(req.params.orderId || '').trim();
      if (!/^[A-Z0-9-]{8,80}$/i.test(orderId)) {
        return res.status(400).json({ ok: false, error: 'Invalid PayPal order ID.' });
      }
      const orderBeforeCapture = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { method: 'GET' });
      if (orderBeforeCapture.status !== 'APPROVED' || !hasFullContentPurchaseUnit(orderBeforeCapture)) {
        return res.status(400).json({ ok: false, error: 'This PayPal order is not an approved Full Content purchase.' });
      }
      const capture = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
        method: 'POST',
        headers: { 'PayPal-Request-Id': `capture-${orderId}` },
        body: '{}',
      });
      if (capture.status !== 'COMPLETED') {
        return res.status(402).json({ ok: false, error: 'PayPal has not completed this payment.' });
      }
      res.json({ ok: true });
    } catch (error) {
      console.error('PayPal capture failed:', error.message);
      res.status(error.status === 422 ? 422 : 502).json({ ok: false, error: error.message || 'Could not capture PayPal payment.' });
    }
  });

  app.get('/api/paypal/success', async (req, res) => {
    try {
      const orderId = String(req.query.order_id || '').trim();
      if (!/^[A-Z0-9-]{8,80}$/i.test(orderId)) {
        return res.status(400).json({ ok: false, error: 'Invalid PayPal order ID.' });
      }
      const order = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { method: 'GET' });
      if (!isFullContentOrder(order)) {
        return res.status(402).json({ ok: false, pending: true, error: 'PayPal payment is not confirmed yet.' });
      }
      const capture = order.purchase_units
        .find((unit) => unit.custom_id === 'full-content-v1')
        .payments.captures.find((item) => item.status === 'COMPLETED');
      res.json({
        ok: true,
        title: 'Full Content',
        amount: capture.amount.value,
        currency: capture.amount.currency_code,
        delivery_via_telegram: true,
        telegram_username: typeof getTelegramUsername === 'function' ? await getTelegramUsername() : '',
      });
    } catch (error) {
      console.error('PayPal payment verification failed:', error.message);
      res.status(502).json({ ok: false, error: error.message || 'Could not verify PayPal payment.' });
    }
  });
}
