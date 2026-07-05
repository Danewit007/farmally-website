// netlify/functions/paystack-webhook.js
//
// Paystack calls this URL automatically the moment a payment succeeds
// (or fails). This is the ONLY fully-trustworthy way to know a payment
// really went through — never trust the browser redirect alone, since a
// user can close the tab or the network can drop right after paying.
//
// Set this exact URL in Paystack Dashboard → Settings → API Keys & Webhooks
// → Webhook URL:
//   https://farmally.online/.netlify/functions/paystack-webhook
//
// Required environment variables (Netlify → Site settings → Environment
// variables) — same Paystack key as create-payment.js, plus Supabase
// service-role access so this function can update the database directly,
// bypassing RLS (safe here because it never touches user input directly —
// only Paystack's verified webhook payload):
//   PAYSTACK_SECRET_KEY
//   SUPABASE_URL                (e.g. https://gtjabetlqhirdwgzpvql.supabase.co)
//   SUPABASE_SERVICE_ROLE_KEY   (Supabase → Project Settings → API → service_role key)

const crypto = require('crypto');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!PAYSTACK_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing required environment variables for paystack-webhook.');
    return { statusCode: 500, body: 'Server misconfigured' };
  }

  // ── 1. Verify this request genuinely came from Paystack ──────────────
  // Paystack signs the raw body with your secret key (HMAC SHA512).
  // If this doesn't match, someone is spoofing the webhook — reject it.
  const signature = event.headers['x-paystack-signature'];
  const expectedSignature = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(event.body)
    .digest('hex');

  if (signature !== expectedSignature) {
    console.warn('Paystack webhook signature mismatch — rejecting.');
    return { statusCode: 401, body: 'Invalid signature' };
  }

  const payload = JSON.parse(event.body);

  // Always acknowledge quickly — Paystack retries if it doesn't get a
  // fast 200, so we do the real work first, then return 200 regardless
  // (as long as verification passed), to avoid endless retries on our
  // own bugs. Log failures instead of blocking the ack.
  if (payload.event === 'charge.success') {
    const tx = payload.data;
    const reference = tx.reference;
    const purpose = tx.metadata && tx.metadata.purpose;
    const amountKobo = tx.amount; // Paystack sends amount already in kobo

    try {
      if (purpose === 'wallet_deposit') {
        await handleWalletDeposit(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, reference, amountKobo);
      } else if (purpose === 'shop_order') {
        await handleShopOrder(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, reference);
      } else {
        console.warn('Unrecognized payment purpose:', purpose);
      }
    } catch (err) {
      console.error('Error processing Paystack webhook:', err);
      // Still return 200 — see comment above. The deposit/order stays
      // 'pending' and can be reconciled manually via Paystack's dashboard
      // if this ever happens.
    }
  }

  return { statusCode: 200, body: 'ok' };
};

// ── Wallet deposit: mark the intent paid + credit the wallet ───────────
async function handleWalletDeposit(SUPABASE_URL, SERVICE_KEY, clientRef, amountKobo) {
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };

  // Look up the deposit_intents row to get the user_id and guard against
  // double-processing (Paystack can send the same webhook more than once).
  const lookupRes = await fetch(
    `${SUPABASE_URL}/rest/v1/deposit_intents?client_ref=eq.${encodeURIComponent(clientRef)}&select=user_id,status`,
    { headers }
  );
  const rows = await lookupRes.json();
  const intent = rows && rows[0];

  if (!intent) {
    console.warn('No deposit_intents row found for reference:', clientRef);
    return;
  }
  if (intent.status === 'paid') {
    return; // already processed — avoid double-crediting on webhook retries
  }

  // Mark the intent paid
  await fetch(`${SUPABASE_URL}/rest/v1/deposit_intents?client_ref=eq.${encodeURIComponent(clientRef)}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'paid' }),
  });

  // Credit the wallet via the existing credit_wallet RPC (same one the
  // client calls for other deposit paths, kept consistent here).
  await fetch(`${SUPABASE_URL}/rest/v1/rpc/credit_wallet`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      target_user_id: intent.user_id,
      amount_kobo: amountKobo,
      reference: clientRef,
      description: 'Wallet deposit via Paystack',
    }),
  });
}

// ── Shop order: mark the order paid ─────────────────────────────────────
async function handleShopOrder(SUPABASE_URL, SERVICE_KEY, orderId) {
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  };

  await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'paid' }),
  });
