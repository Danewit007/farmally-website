// netlify/functions/create-payment.js
//
// Called by the FarmAlly app (wallet deposit + shop checkout) to start a
// Paystack payment. This runs server-side so the Paystack SECRET key never
// touches the browser.
//
// Required environment variable (set in Netlify → Site settings →
// Environment variables):
//   PAYSTACK_SECRET_KEY = sk_test_xxxxxxxxxxxxxxxxxxxxxxxxxx

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  if (!PAYSTACK_SECRET_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server is missing PAYSTACK_SECRET_KEY. Add it in Netlify environment variables.' }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { amount, email, reference, purpose, callback_url } = payload;

  if (!amount || !email || !reference) {
    return { statusCode: 400, body: JSON.stringify({ error: 'amount, email, and reference are required' }) };
  }

  try {
    const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        amount: Math.round(Number(amount) * 100), // Naira → kobo
        reference,
        callback_url,
        metadata: { purpose: purpose || 'unspecified' },
      }),
    });

    const data = await paystackRes.json();

    // Pass Paystack's response straight through — the client already
    // expects this exact shape: { status, message, data: { authorization_url, reference } }
    return {
      statusCode: paystackRes.ok ? 200 : paystackRes.status,
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Could not reach Paystack: ' + err.message }),
    };
  }
};
