const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const Stripe = require('stripe');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

if (!fs.existsSync(path.join(ROOT, 'uploads'))) {
  fs.mkdirSync(path.join(ROOT, 'uploads'), { recursive: true });
}

const db = new Database(path.join(ROOT, 'fastlife.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 slug TEXT UNIQUE NOT NULL,
 name TEXT NOT NULL,
 category TEXT NOT NULL,
 price_cents INTEGER NOT NULL,
 description TEXT DEFAULT '',
 image TEXT DEFAULT '',
 active INTEGER DEFAULT 1,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 stripe_session_id TEXT UNIQUE,
 email TEXT,
 amount_cents INTEGER,
 status TEXT,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

const defaults = [
 ['tshirt','FAST LIFE T-Shirt','T-Shirt',1999,'Heavyweight Streetwear Tee',''],
 ['hoodie','FAST LIFE Hoodie','Hoodie',3999,'Premium fleece hoodie',''],
 ['cap','FAST LIFE Cap','Cap',1399,'6-panel FAST LIFE cap','']
];

const insert = db.prepare(`
 INSERT OR IGNORE INTO products
 (slug,name,category,price_cents,description,image)
 VALUES (?,?,?,?,?,?)
`);
for (const p of defaults) insert.run(...p);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
 secret: process.env.SESSION_SECRET || 'CHANGE_THIS_IN_PRODUCTION',
 resave: false,
 saveUninitialized: false,
 cookie: {
   httpOnly: true,
   sameSite: 'lax',
   secure: process.env.NODE_ENV === 'production'
 }
}));

app.use('/uploads', express.static(path.join(ROOT, 'uploads')));
app.use(express.static(path.join(ROOT, 'public')));

function admin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(401).json({ error: 'Nicht eingeloggt.' });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(ROOT, 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype));
  }
});

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};

  if (
    username === process.env.ADMIN_USER &&
    password === process.env.ADMIN_PASSWORD
  ) {
    req.session.admin = true;
    return res.json({ ok: true });
  }

  res.status(401).json({ error: 'Benutzername oder Passwort falsch.' });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/me', (req, res) => {
  res.json({ admin: !!req.session.admin });
});

app.get('/api/products', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM products WHERE active=1 ORDER BY id')
    .all();

  res.json(rows);
});

app.get('/api/admin/products', admin, (req, res) => {
  res.json(db.prepare('SELECT * FROM products ORDER BY id DESC').all());
});

app.post('/api/admin/products', admin, (req, res) => {
  const { slug, name, category, price, description, image } = req.body;

  if (!slug || !name || !category || price === undefined) {
    return res.status(400).json({ error: 'Pflichtfelder fehlen.' });
  }

  try {
    const info = db.prepare(`
      INSERT INTO products
      (slug,name,category,price_cents,description,image)
      VALUES (?,?,?,?,?,?)
    `).run(
      slug,
      name,
      category,
      Math.round(Number(price) * 100),
      description || '',
      image || ''
    );

    res.json(
      db.prepare('SELECT * FROM products WHERE id=?').get(info.lastInsertRowid)
    );
  } catch (e) {
    res.status(400).json({
      error: 'Slug existiert bereits oder Daten sind ungültig.'
    });
  }
});

app.put('/api/admin/products/:id', admin, (req, res) => {
  const id = Number(req.params.id);
  const { slug, name, category, price, description, image, active } = req.body;

  db.prepare(`
    UPDATE products
    SET slug=?, name=?, category=?, price_cents=?,
        description=?, image=?, active=?
    WHERE id=?
  `).run(
    slug,
    name,
    category,
    Math.round(Number(price) * 100),
    description || '',
    image || '',
    active ? 1 : 0,
    id
  );

  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(id));
});

app.delete('/api/admin/products/:id', admin, (req, res) => {
  db.prepare('DELETE FROM products WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/upload', admin, upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Bitte ein Bild hochladen.' });
  }

  res.json({ url: '/uploads/' + req.file.filename });
});

app.get('/api/admin/orders', admin, (req, res) => {
  res.json(db.prepare('SELECT * FROM orders ORDER BY id DESC').all());
});

const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        error: 'Stripe ist noch nicht konfiguriert.'
      });
    }

    const ids = Array.isArray(req.body.items) ? req.body.items : [];

    if (!ids.length) {
      return res.status(400).json({ error: 'Warenkorb leer.' });
    }

    const counts = {};

    for (const id of ids) {
      if (!Number.isInteger(Number(id))) {
        return res.status(400).json({ error: 'Ungültiger Warenkorb.' });
      }

      counts[id] = (counts[id] || 0) + 1;
    }

    const rows = Object.keys(counts).map(id =>
      db.prepare(
        'SELECT * FROM products WHERE id=? AND active=1'
      ).get(Number(id))
    );

    if (rows.some(x => !x)) {
      return res.status(400).json({
        error: 'Produkt nicht verfügbar.'
      });
    }

    const line_items = rows.map(p => ({
      price_data: {
        currency: 'eur',
        product_data: { name: p.name },
        unit_amount: p.price_cents
      },
      quantity: counts[p.id]
    }));

    const base =
      process.env.PUBLIC_URL || `http://localhost:${PORT}`;

    const checkout = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      billing_address_collection: 'auto',
      shipping_address_collection: {
        allowed_countries: [
          'DE', 'AT', 'CH', 'NL',
          'BE', 'FR', 'IT', 'ES'
        ]
      },
      success_url:
        `${base}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/?checkout=cancelled`,
      locale: 'auto'
    });

    res.json({ url: checkout.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: 'Checkout konnte nicht erstellt werden.'
    });
  }
});

app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(400).send('Webhook nicht konfiguriert.');
    }

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (e) {
      return res.status(400).send('Invalid signature');
    }

    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;

      db.prepare(`
        INSERT OR IGNORE INTO orders
        (stripe_session_id,email,amount_cents,status)
        VALUES (?,?,?,?)
      `).run(
        s.id,
        s.customer_details?.email || '',
        s.amount_total || 0,
        'paid'
      );
    }

    res.json({ received: true });
  }
);

app.get('/success.html', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'success.html'));
});

app.listen(PORT, () => {
  console.log(`FAST LIFE läuft auf Port ${PORT}`);
});
