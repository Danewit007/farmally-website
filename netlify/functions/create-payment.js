// netlify/functions/create-payment.js
//
// Called by the browser (shop checkout AND wallet deposit) to start
// a Vendy payment. Whatever Vendy sends back gets passed straight
// through to the browser — the client-side code already checks
// several possible field names for a transaction id / checkout
// link, so this doesn't need to reshape the response, just forward
// it honestly.
//
// ⚠️ ONE THING IS STILL A BLOCKING UNKNOWN: the real request URL
// for Vendy's "Request to Pay" endpoint. This file is fully wired
// and ready — search for "CONFIRM:" for the couple of guesses
// still in here (the URL, and the exact field/header names).

const VENDY_API_URL = 'https://api.myvendy.com/v1/request-payment';
// ☝️ CONFIRM: replace with the real URL shown at the top of the
// "Request to Pay (PUSH)" page in Vendy's docs (usually a colored
// "POST" badge right next to the page title).

const VENDY_API_KEY = process.env.VENDY_API_KEY; // your business's real "apikey"
const VENDY_SECRET  = process.env.VENDY_SECRET;  // your business's real "secret"
// ☝️ Get these from YOUR actual Vendy business account, not the
// "Test Business A/B/C" sample values from the docs — those are
// just documentation examples, not real credentials.

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bad JSON' }) };
  }

  const { amount, phone, email, client_ref, purpose } = body;

  if (!amount || amount <= 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid amount' }) };
  }
  if (!phone) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Phone number required' }) };
  }
  if (!VENDY_API_KEY || !VENDY_SECRET) {
    console.error('create-payment: Vendy credentials not configured');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured — missing Vendy credentials' }) };
  }

  try {
    const vendyRes = await fetch(VENDY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // CONFIRM: exact auth style — some APIs want apikey/secret
        // as separate headers, others want one bearer token. This
        // sends both common patterns at once as a first attempt.
        'apikey': VENDY_API_KEY,
        'Authorization': `Bearer ${VENDY_SECRET}`,
      },
      body: JSON.stringify({
        // CONFIRM: field names — guessed from what showed up in
        // the webhook payloads (msisdn, amount, currency).
        msisdn:    phone,
        amount:    amount,
        currency:  'ngn',
        reference: client_ref || undefined,
        email:     email || undefined,
        narration: purpose === 'wallet_deposit' ? 'FarmAlly wallet deposit' : 'FarmAlly order payment',
      }),
    });

    const vendyData = await vendyRes.json().catch(() => null);

    // TEMP — leave until confirmed, then remove. Check Netlify's
    // function logs after a test to see exactly what Vendy said.
    console.log('[create-payment] Vendy status:', vendyRes.status);
    console.log('[create-payment] Vendy body:', JSON.stringify(vendyData));

    if (!vendyRes.ok) {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Vendy rejected the request', details: vendyData }),
      };
    }

    return { statusCode: 200, body: JSON.stringify(vendyData) };

  } catch (err) {
    console.error('create-payment: request to Vendy failed', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not reach Vendy', details: err.message }) };
  }
};
  
