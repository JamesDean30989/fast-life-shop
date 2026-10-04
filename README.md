# FAST LIFE Shop + Admin

## Shop
- `/` = öffentlicher Shop
- `/admin.html` = geschützter Admin-Bereich

## Setup
1. Node.js 18+ installieren.
2. `npm install`
3. `.env.example` nach `.env` kopieren und Werte setzen.
4. `npm start`
5. Shop: http://localhost:3000
6. Admin: http://localhost:3000/admin.html

Admin credentials:
- ADMIN_USER
- ADMIN_PASSWORD

Stripe:
- STRIPE_SECRET_KEY
- STRIPE_WEBHOOK_SECRET
- PUBLIC_URL

Der Stripe Secret Key gehört ausschließlich in die Server-Umgebung.
Produktpreise werden serverseitig aus SQLite geladen.
Der Stripe Webhook speichert erfolgreiche Checkout-Sessions als Bestellungen.
