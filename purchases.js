const recordedRefs = new Set();

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function stripColumnFromPayload(fields, errorMessage) {
  const msg = String(errorMessage || '');
  const match = msg.match(/Could not find the '(\w+)' column/i)
    || msg.match(/column ["']?(\w+)["']? of relation/i)
    || msg.match(/column ["']?(\w+)["']? does not exist/i);
  if (!match || !(match[1] in fields)) return null;
  const next = { ...fields };
  delete next[match[1]];
  console.warn(`purchases column '${match[1]}' missing — retrying without it`);
  return next;
}

function cleanText(value, max = 200) {
  const s = String(value == null ? '' : value).trim();
  return s ? s.slice(0, max) : '';
}

function paypalPayer(order) {
  const payer = order?.payer || {};
  const given = payer.name?.given_name || '';
  const surname = payer.name?.surname || '';
  const shippingName = order?.purchase_units?.[0]?.shipping?.name?.full_name || '';
  return {
    buyer_email: cleanText(payer.email_address || payer.email),
    buyer_name: cleanText([given, surname].filter(Boolean).join(' ') || shippingName),
  };
}

function payjsrPayer(session) {
  const customer = session?.customer && typeof session.customer === 'object' ? session.customer : {};
  return {
    buyer_email: cleanText(
      session?.customer_email || customer.email || session?.email || session?.payer_email || ''
    ),
    buyer_name: cleanText(
      session?.customer_name || customer.name || session?.name || customer.full_name || ''
    ),
  };
}

export function createPurchaseRecorder(getSupabase) {
  async function findExisting(supabase, ref) {
    if (!ref) return null;
    const keys = ['provider_ref', 'paypal_order_id', 'order_id', 'reference'];
    for (const key of keys) {
      const { data, error } = await supabase.from('purchases').select('id').eq(key, ref).maybeSingle();
      if (error) continue;
      if (data?.id) return data;
    }
    return null;
  }

  async function insertPurchase(payload) {
    const supabase = typeof getSupabase === 'function' ? getSupabase() : null;
    if (!supabase) {
      console.warn('purchase not saved: Supabase is not configured');
      return { ok: false, error: 'Supabase not configured' };
    }

    const ref = cleanText(payload.provider_ref || payload.paypal_order_id || payload.reference || payload.order_id, 120);
    if (ref && recordedRefs.has(ref)) return { ok: true, duplicate: true };

    try {
      const existing = await findExisting(supabase, ref);
      if (existing) {
        if (ref) recordedRefs.add(ref);
        return { ok: true, duplicate: true, id: existing.id };
      }
    } catch (err) {
      console.warn('purchase lookup failed:', err?.message || err);
    }

    let fields = { ...payload };
    if (!isUuid(fields.video_id)) fields.video_id = null;
    Object.keys(fields).forEach((key) => {
      if (fields[key] === undefined) delete fields[key];
    });

    for (let attempt = 0; attempt < 12; attempt++) {
      const { data, error } = await supabase.from('purchases').insert(fields).select('id').maybeSingle();
      if (!error) {
        if (ref) recordedRefs.add(ref);
        return { ok: true, id: data?.id };
      }
      const code = String(error.code || '');
      if (code === '23505' || /duplicate|unique/i.test(error.message || '')) {
        if (ref) recordedRefs.add(ref);
        return { ok: true, duplicate: true };
      }
      const stripped = stripColumnFromPayload(fields, error.message);
      if (!stripped) {
        console.error('purchase insert failed:', error.message);
        return { ok: false, error: error.message };
      }
      fields = stripped;
    }
    return { ok: false, error: 'Could not save purchase' };
  }

  async function recordPaypalPurchase(order, extras = {}) {
    const customId = String(
      extras.custom_id
      || order?.purchase_units?.[0]?.custom_id
      || ''
    );
    const videoId = customId.startsWith('video:') ? customId.slice('video:'.length) : null;
    const unit = order?.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    const amount = extras.amount
      ?? capture?.amount?.value
      ?? unit?.amount?.value;
    const currency = extras.currency
      || capture?.amount?.currency_code
      || unit?.amount?.currency_code
      || 'USD';
    const payer = paypalPayer(order);
    const orderId = String(order?.id || extras.order_id || '').trim();
    const title = extras.title
      || (customId === 'full-content-v1' ? 'Full Content' : unit?.description)
      || '';

    return insertPurchase({
      video_id: videoId,
      buyer_email: payer.buyer_email || extras.buyer_email || null,
      buyer_name: payer.buyer_name || extras.buyer_name || null,
      amount: amount != null && amount !== '' ? Number(amount) : null,
      price: amount != null && amount !== '' ? Number(amount) : null,
      currency: cleanText(currency, 8) || 'USD',
      provider: 'paypal',
      status: 'paid',
      provider_ref: orderId,
      paypal_order_id: orderId,
      order_id: orderId,
      reference: orderId,
      product_title: cleanText(title, 240) || null,
      title: cleanText(title, 240) || null,
    });
  }

  async function recordPayjsrPurchase(session, extras = {}) {
    const meta = session?.metadata && typeof session.metadata === 'object' ? session.metadata : {};
    const isBundle = String(meta.bundle || extras.bundle || '').toLowerCase() === 'all';
    const videoId = isBundle ? null : String(meta.video_id || extras.video_id || '').trim();
    const payer = payjsrPayer(session);
    const reference = String(session?.reference || extras.reference || '').trim();
    const amount = extras.amount ?? session?.amount;
    const title = extras.title || meta.display_title || (isBundle ? 'All videos and folders' : '');

    return insertPurchase({
      video_id: videoId || null,
      buyer_email: payer.buyer_email || extras.buyer_email || null,
      buyer_name: payer.buyer_name || extras.buyer_name || null,
      amount: amount != null && amount !== '' ? Number(amount) : null,
      price: amount != null && amount !== '' ? Number(amount) : null,
      currency: cleanText(extras.currency || session?.currency, 8) || 'USD',
      provider: 'payjsr',
      status: 'paid',
      provider_ref: reference,
      reference,
      order_id: reference,
      product_title: cleanText(title, 240) || null,
      title: cleanText(title, 240) || null,
    });
  }

  async function listPurchases() {
    const supabase = typeof getSupabase === 'function' ? getSupabase() : null;
    if (!supabase) return [];

    const queries = [
      () => supabase.from('purchases').select('*, videos(id, title)').order('created_at', { ascending: false }).limit(300),
      () => supabase.from('purchases').select('*').order('created_at', { ascending: false }).limit(300),
      () => supabase.from('purchases').select('*').order('id', { ascending: false }).limit(300),
    ];

    let lastError = null;
    for (const query of queries) {
      const { data, error } = await query();
      if (!error) return data || [];
      lastError = error;
    }
    throw new Error(lastError?.message || 'Could not load purchases');
  }

  return {
    recordPaypalPurchase,
    recordPayjsrPurchase,
    listPurchases,
  };
}
