// netlify/functions/vendy-webhook.js
//
// Vendy calls this server-to-server when a transaction's status
// changes. On a confirmed wallet-deposit payment, it credits the
// user's FarmAlly wallet via the credit_wallet RPC, using the
// SERVICE ROLE key — this is the one place in the app allowed to
// actually move money.
//
// Confirmed from Vendy's docs/samples:
//   - Event key is literally "event.type" (with a dot in the key
//     name — must use bracket notation, payload['event.type'],
//     NOT payload.event.type).
//   - Values seen: transaction_success, transaction_updated,
//     transaction_failed, transaction_cancelled.
//   - Vendy assigns its own transaction id at data.refid (also
//     mirrored as data.vendref / data.debitref in some samples).
//   - data.amount is plain currency units (e.g. 100 = ₦100), not
//     kobo/cents.
//   - Signature: header "x-signature", HMAC-SHA256 over the raw
//     JSON body, base64-encoded, keyed with the business's
//     webhook secretHash.
//
// Still worth double-checking once this is live: whether Vendy
// computes the signature over the exact bytes they sent, or over
// a re-serialized version — this implementation hashes the raw
// body text directly, which is the safer of the two to match
// against (see comment at signature check below).
//
// Required environment variables (set in Netlify, never in client code):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   <- service role, NEVER the anon key
//   VENDY_WEBHOOK_SECRET        <- the business's webhook secretHash

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const rawBody = event.body || '';

  // ── 1. Verify this actually came from Vendy ─────────────────
  const signature = event.headers['x-signature'] || event.headers['X-Signature'];

  if (!process.env.VENDY_WEBHOOK_SECRET) {
    console.error('Vendy webhook: VENDY_WEBHOOK_SECRET is not set');
    return { statusCode: 500, body: 'server misconfigured' };
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.VENDY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');

  if (!signature || !timingSafeEqual(signature, expectedSignature)) {
    console.warn('Vendy webhook: signature mismatch');
    return { statusCode: 401, body: 'Invalid signature' };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, body: 'Bad JSON' };
  }

  const eventType = payload['event.type'] || null;
  const data = payload.data || {};
  const refid = data.refid || data.vendref || data.debitref || null;
  const reportedAmount = data.amount != null ? Number(data.amount) : null;

  if (!refid) {
    console.warn('Vendy webhook: no refid found in payload', payload);
    return { statusCode: 200, body: 'ignored (no refid)' };
  }

  // ── 2. Find out who this refid belongs to ───────────────────
  // We never trust the gateway to tell us *who* to credit — we
  // recorded the user_id ourselves when the deposit was started,
  // and attached this refid to that row right after creation.
  let intent = await findIntentByRefid(refid);

  // Small grace window: if the client's "attach refid" update
  // hasn't landed yet (race with a very fast webhook), retry once.
  if (!intent) {
    await new Promise((r) => setTimeout(r, 1500));
    intent = await findIntentByRefid(refid);
  }

  if (!intent) {
    console.warn('Vendy webhook: no deposit_intent found for refid', refid);
    return { statusCode: 200, body: 'ignored (no matching intent)' };
  }

  // ── 3. Idempotency — gateways retry webhooks, sometimes a lot ─
  if (intent.status === 'paid' || intent.status === 'failed') {
    return { statusCode: 200, body: 'already processed' };
  }

  if (eventType === 'transaction_failed' || eventType === 'transaction_cancelled') {
    await supabase.from('deposit_intents').update({ status: 'failed' }).eq('client_ref', intent.client_ref);
    return { statusCode: 200, body: 'noted as failed' };
  }

  if (eventType !== 'transaction_success') {
    // transaction_updated or anything else — not a final state yet.
    return { statusCode: 200, body: 'noted, not final' };
  }

  // Sanity check only — log a mismatch, but still credit the
  // amount WE recorded at intent time, not whatever the payload
  // claims, so a replayed/edited webhook can't request more than
  // what the user actually agreed to pay.
  if (reportedAmount != null) {
    const reportedKobo = Math.round(reportedAmount * 100);
    if (Math.abs(reportedKobo - intent.amount_kobo) > 1) {
      console.warn(
        'Vendy webhook: amount mismatch for', refid,
        '— intent(kobo):', intent.amount_kobo, 'reported(kobo):', reportedKobo
      );
    }
  }

  // ── 4. Credit the wallet ─────────────────────────────────────
  const { error: creditErr } = await supabase.rpc('credit_wallet', {
    target_user_id: intent.user_id,
    amount_kobo:    intent.amount_kobo,
    reference:      refid,
    description:    'Wallet deposit via Vendy',
  });

  if (creditErr) {
    console.error('Vendy webhook: credit_wallet failed', creditErr);
    return { statusCode: 500, body: 'credit failed' }; // let Vendy retry
  }

  await supabase.from('deposit_intents').update({ status: 'paid' }).eq('client_ref', intent.client_ref);

  return { statusCode: 200, body: 'ok' };
};

async function findIntentByRefid(refid) {
  const { data, error } = await supabase
    .from('deposit_intents')
    .select('*')
    .eq('vendy_refid', refid)
    .maybeSingle();
  if (error) {
    console.error('Vendy webhook: deposit_intents lookup failed', error);
    return null;
  }
  return data;
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
      }
  
