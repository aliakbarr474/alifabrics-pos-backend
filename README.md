# Ali Fabrics POS — Backend

The REST API behind the Ali Fabrics point-of-sale and accounting system. It is used day to day by a family-owned textile business. It handles sales, purchasing, inventory, returns, customer and vendor ledgers, cash and bank balances, and business reporting.

The React frontend is in [alifabrics-pos-frontend](https://github.com/aliakbarr474/alifabrics-pos-frontend).

## Highlights

- **37 REST endpoints** in Express, all protected with JWT except register and login.
- **17-table MySQL schema** covering sales, purchases, inventory, returns, customers, vendors, payments and bank accounts.
- **Safe money and stock updates:** checkout, stock purchases, vendor payments and returns run inside SQL transactions with row-level locking (`SELECT ... FOR UPDATE`). If any step fails, the whole operation rolls back, so stock levels and balances never end up half-updated.
- **WhatsApp notifications:** when a vendor payment is recorded, the vendor automatically gets a WhatsApp confirmation (whatsapp-web.js).
- **Excel backups:** any table can be downloaded as an `.xlsx` file (ExcelJS).
- **Reporting:** queries for daily revenue, profit and loss, top-selling items, low stock, customer dues, vendor balances, and cash and bank totals.
- **Passwords** are hashed with bcrypt.

## Tech stack

| Area | Tools |
|---|---|
| Runtime and framework | Node.js, Express 5 |
| Database | MySQL (`mysql2/promise` connection pool) |
| Auth | jsonwebtoken, bcrypt |
| Integrations | whatsapp-web.js, ExcelJS |
| Config | dotenv |

## Database tables

`users` · `brand_info` · `items` · `brands` · `inventory` · `vendors` · `vendor_company_names` · `purchases` · `purchase_items` · `payments` · `customers` · `customer_payments` · `sales` · `sale_items` · `returns` · `return_items` · `business_bank_accounts`

## API overview

| Area | Endpoints |
|---|---|
| Auth | `POST /register`, `POST /login` |
| Sales | `POST /checkout`, `GET /invoices`, `GET /invoices/:id/items`, `POST /return` |
| Inventory | `GET /inventory`, `POST /add-product`, `POST /add-single-product`, `PUT /inventory/:id`, `DELETE /inventory/:id`, `GET /inventory/:id/history` |
| Vendors | `GET /vendors`, `GET /get-vendors`, `POST /add-vendors`, `GET /vendors/:id/details`, `GET /vendors/:id/ledger`, `GET /vendors/:vendorName/brands`, `DELETE /vendors/:id` |
| Vendor payments | `POST /add-payment`, `GET /get-payments` |
| Customers | `GET /customers`, `POST /customers`, `GET /customers/:id/history`, `POST /add-customer-payment`, `DELETE /customers/:id` |
| Bank accounts | `GET /bank-accounts`, `POST /bank-accounts`, `PATCH /bank-accounts/:id/toggle`, `GET /api/bank-accounts/active` |
| Dashboard | `GET /api/dashboard/summary`, `GET /api/dashboard/pnl` |
| Settings | `POST /api/settings/brand`, `GET /api/users`, `DELETE /api/users/:id`, `GET /api/backup` |

Protected endpoints expect an `Authorization: Bearer <token>` header.

## Getting started

Requirements: Node.js 18 or newer, and MySQL 8.

```bash
git clone https://github.com/aliakbarr474/alifabrics-pos-backend.git
cd alifabrics-pos-backend
npm install
```

Create a `.env` file in the project root:

```env
PORT=5000
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=alifabrics_pos
JWT_SECRET=a_long_random_secret
```

Then start the server:

```bash
node server.js
```

The API runs at `http://localhost:5000`.

**WhatsApp setup:** on first run, a QR code is printed in the terminal. Scan it with WhatsApp (Linked devices) to connect. The session is then saved locally in `.wwebjs_auth/`, which is git-ignored. The `apt.toml` file lists the system libraries the headless browser needs when deployed.

## Author

**Ali Akbar** — Full-stack developer
[GitHub](https://github.com/aliakbarr474) · [LinkedIn](https://linkedin.com/in/ali-akbar-8592b1241) · aliakbarr474@gmail.com
