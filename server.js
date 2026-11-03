const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const { PORT = 3000, BASE_URL, GATEWAY_API_KEY, GATEWAY_SECRET, UPI_ID, PAYEE_NAME = 'Merchant',
  IMAP_HOST, IMAP_USER, IMAP_PASS, MAIL_FROM, CREDIT_REGEX = 'credited|received',
  ORDER_EXPIRY_MIN = 10 } = process.env;

const EXPIRY_MS = Number(ORDER_EXPIRY_MIN) * 60 * 1000;
const DB = './orders.json';
const load = () => (fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : { orders: {}, utrs: [] });
const save = (d) => fs.writeFileSync(DB, JSON.stringify(d, null, 2));
const hmac = (s, b) => crypto.createHmac('sha256', s).update(b).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const live = (o) => o.status === 'pending' && Date.now() - o.created < EXPIRY_MS;

// ---------- मर्चेंट साइट को सूचना (retry के साथ) ----------
async function notifyMerchant(o) {
  if (!o.callback_url) return;
  const body = JSON.stringify({ gateway_id: o.id, order_id: o.order_id, amount: o.amount, paid_amount: o.paise / 100, utr: o.utr, status: 'paid' });
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(o.callback_url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': hmac(GATEWAY_SECRET, body) }, body });
      if (r.ok) return;
    } catch (e) { /* फिर कोशिश */ }
    await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
  }
  console.error('Merchant notify failed:', o.id);
}

async function markPaid(id, utr) {
  const db = load(); const o = db.orders[id];
  if (!o || o.status === 'paid') return;                 // एक पेमेंट पर एक ही बार एक्सेस
  if (utr && db.utrs.includes(utr)) return;              // वही UTR दोबारा नहीं
  o.status = 'paid'; o.utr = utr || null; o.paid_at = new Date().toISOString();
  if (utr) db.utrs.push(utr);
  save(db);
  await notifyMerchant(o);
}

// ---------- ईमेल से पेमेंट पहचानना ----------
// ज़रूरी: असली ईमेल देखकर इन 2 regex को ठीक करें
const AMOUNT_RE = /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)/i;
const UTR_RE = /\b(\d{12})\b/;

async function handleMail(text) {
  if (!new RegExp(CREDIT_REGEX, 'i').test(text)) return;       // सिर्फ़ पैसा आने वाले ईमेल
  const a = text.match(AMOUNT_RE); if (!a) return;
  const paise = Math.round(parseFloat(a[1].replace(/,/g, '')) * 100);
  const utr = (text.match(UTR_RE) || [])[1];
  const db = load();
  const o = Object.values(db.orders).find((x) => live(x) && x.paise === paise);
  if (o) { console.log('Matched', o.id, paise); await markPaid(o.id, utr); }
}

let polling = false;
async function pollMail() {
  if (polling || !IMAP_USER) return; polling = true;
  const client = new ImapFlow({ host: IMAP_HOST, port: 993, secure: true, auth: { user: IMAP_USER, pass: IMAP_PASS }, logger: false });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ seen: false, from: MAIL_FROM }, { uid: true });
      for (const uid of uids) {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        const mail = await simpleParser(msg.source);
        await handleMail((mail.subject || '') + '\n' + (mail.text || ''));
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      }
    } finally { lock.release(); }
  } catch (e) { console.error('IMAP error:', e.message); }
  finally { try { await client.logout(); } catch {} polling = false; }
}
setInterval(pollMail, 10000);

// ---------- सर्वर ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
const ALLOWED = (process.env.ALLOWED_ORIGIN || '').split(',').map((x) => x.trim()).filter(Boolean);
const MAX_AMOUNT = Number(process.env.MAX_AMOUNT || 20000);
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && ALLOWED.includes(o)) {
    res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-api-key');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
const hits = new Map();
const rateLimit = (req, res, next) => {
  const now = Date.now(), a = (hits.get(req.ip) || []).filter((t) => now - t < 60000);
  if (a.length >= 10) return res.status(429).json({ error: 'बहुत ज़्यादा रिक्वेस्ट, 1 मिनट बाद कोशिश करें' });
  a.push(now); hits.set(req.ip, a); next();
};
// ब्राउज़र (आपकी वेबसाइट) के लिए: API key के बिना, सिर्फ़ amount + ref
const publicOrder = (req, res, next) => {
  const { amount, ref } = req.body || {}, n = Number(amount);
  if (!(n >= 1 && n <= MAX_AMOUNT)) return res.status(400).json({ error: 'amount गलत है' });
  req.body = { order_id: String(ref || 'web').slice(0, 40), amount: n };
  next();
};
const auth = (req, res, next) => safeEq(req.headers['x-api-key'], GATEWAY_API_KEY) ? next() : res.status(401).json({ error: 'bad api key' });

const createOrderHandler = (req, res) => {
  const { order_id, amount, callback_url, redirect_url } = req.body || {};
  if (!order_id || !(Number(amount) > 0)) return res.status(400).json({ error: 'order_id और amount ज़रूरी हैं' });
  const db = load();
  // हर pending ऑर्डर की रकम अलग रखो (टकराव पर 1 पैसा जोड़ते जाओ) ताकि ईमेल से सही ऑर्डर पहचाना जाए
  const taken = new Set(Object.values(db.orders).filter(live).map((x) => x.paise));
  let paise = Math.round(Number(amount) * 100), tries = 0;
  while (taken.has(paise) && tries++ < 99) paise += 1;
  if (taken.has(paise)) return res.status(429).json({ error: 'अभी बहुत ऑर्डर pending हैं, थोड़ी देर बाद कोशिश करें' });
  const id = 'ord_' + crypto.randomBytes(8).toString('hex');
  db.orders[id] = { id, order_id: String(order_id), amount: Number(amount), paise, callback_url: callback_url || '', redirect_url: redirect_url || '/', status: 'pending', created: Date.now() };
  save(db);
  res.json({ gateway_id: id, pay_url: `${BASE_URL}/pay/${id}`, payable_amount: paise / 100 });
};
app.post('/api/create-order', auth, createOrderHandler);
app.post('/public/create-order', rateLimit, publicOrder, createOrderHandler);

app.get('/api/status/:id', (req, res) => {
  const o = load().orders[req.params.id];
  if (!o) return res.json({ status: 'not_found' });
  const paid = o.status === 'paid';
  res.json({ status: o.status === 'pending' && !live(o) ? 'expired' : o.status, paid_amount: paid ? o.paise / 100 : undefined, utr: paid ? o.utr : undefined });
});

// वेबसाइट पेमेंट "क्लेम" करती है: एक पेमेंट सिर्फ़ एक ऑर्डर के लिए (दोबारा इस्तेमाल नहीं)
app.post('/public/claim/:id', rateLimit, (req, res) => {
  const db = load(), o = db.orders[req.params.id], ref = String((req.body || {}).ref || '');
  if (!o || o.status !== 'paid') return res.status(402).json({ error: 'पेमेंट नहीं मिला' });
  if (o.claimed_by && o.claimed_by !== ref) return res.status(409).json({ error: 'यह पेमेंट पहले ही इस्तेमाल हो चुका है' });
  o.claimed_by = ref; save(db);
  res.json({ ok: true, paid_amount: o.paise / 100, utr: o.utr });
});

// सिर्फ़ टेस्ट के लिए: बिना असली पैसे के पेमेंट मानो
app.post('/api/simulate/:id', auth, async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(403).end();
  await markPaid(req.params.id, 'SIM' + Date.now()); res.json({ ok: true });
});

app.get('/pay/:id', (req, res) => {
  const o = load().orders[req.params.id];
  if (!o) return res.status(404).send('Order नहीं मिला');
  const upi = `upi://pay?pa=${encodeURIComponent(UPI_ID)}&pn=${encodeURIComponent(PAYEE_NAME)}&am=${(o.paise / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(o.order_id)}`;
  res.send(`<!doctype html><html lang="hi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>पेमेंट</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
:root{--bg:#f4f6f3;--card:#fff;--ink:#17201b;--mute:#5d6a62;--accent:#1f6f4a;--line:#dce2db}
@media(prefers-color-scheme:dark){:root{--bg:#121815;--card:#1a221e;--ink:#eef2ee;--mute:#9aa7a0;--accent:#5cc58f;--line:#2b352f}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif;padding:16px}
.card{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:26px;text-align:center}
.amt{font-size:40px;font-weight:700}.mute{color:var(--mute);font-size:14px}
#qr{display:grid;place-items:center;margin:18px 0;background:#fff;padding:12px;border-radius:10px}
a.btn{display:block;background:var(--accent);color:#fff;text-decoration:none;padding:14px;border-radius:10px;font-weight:600}
a.btn:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
</style></head><body><main class="card">
<div class="mute">ऑर्डर ${esc(o.order_id)}</div>
<div class="amt">₹${(o.paise / 100).toFixed(2)}</div>
<p class="mute">ठीक यही रकम भेजें, तभी पेमेंट अपने आप पहचाना जाएगा।</p>
<div id="box">
  <div id="qr"></div>
  <a class="btn" href="${esc(upi)}">UPI ऐप में खोलें</a>
  <p id="t" class="mute"></p>
</div></main>
<script>
const embed=new URLSearchParams(location.search).get('embed')==='1';
const id=${JSON.stringify(o.id)},back=${JSON.stringify(o.redirect_url)},end=${o.created + EXPIRY_MS};
new QRCode(document.getElementById('qr'),{text:${JSON.stringify(upi)},width:200,height:200});
async function tick(){
  const r=await fetch('/api/status/'+id).then(r=>r.json()).catch(()=>({}));
  if(r.status==='paid'){document.getElementById('box').innerHTML='<p>✅ पेमेंट मिल गया।</p>';if(embed){parent.postMessage({type:'gw-paid',id},'*')}else{setTimeout(()=>location.href=back,1800)}return}
  if(r.status==='expired'){document.getElementById('box').innerHTML='<p>ऑर्डर का समय ख़त्म हो गया। साइट पर लौटकर नया पेमेंट शुरू करें।</p>';return}
  const s=Math.max(0,Math.floor((end-Date.now())/1000));
  document.getElementById('t').textContent='समय बचा: '+Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
  setTimeout(tick,3000);
}
tick();
</script></body></html>`);
});

app.listen(PORT, () => console.log('UPI gateway चल रहा है, port', PORT));
