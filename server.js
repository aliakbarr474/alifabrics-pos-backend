require('dotenv').config();
const express = require("express");
const cors = require("cors");
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const excelJS = require('exceljs');

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 5000;

const db = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "1234",
  database: process.env.DB_NAME || "alifabrics_pos",
  port: process.env.DB_PORT || 3306,

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

module.exports = db;

db.getConnection()
  .then(connection => {
    console.log("Connected to MySQL database.");
    connection.release();
  })
  .catch(err => {
    console.error("Error connecting to MySQL:", err);
  });

const whatsappClient = new Client({
  authStrategy: new LocalAuth(),
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
  },
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  }
});

whatsappClient.on('qr', (qr) => {
  console.log('\n=========================================');
  console.log('📱 SCAN THIS QR CODE WITH YOUR WHATSAPP 📱');
  console.log('=========================================\n');
  qrcode.generate(qr, { small: true });
});

whatsappClient.on('ready', () => {
  console.log('✅ WhatsApp Client is ready and linked!');
});

whatsappClient.on('auth_failure', msg => {
  console.error('❌ WhatsApp Authentication failure:', msg);
});

whatsappClient.on('disconnected', (reason) => {
  console.log('❌ WhatsApp was disconnected:', reason);
  whatsappClient.initialize();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

whatsappClient.initialize();

const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ message: 'Access denied. No token provided.' });
    }

    const secretKey = process.env.JWT_SECRET || 'ali_fabrics_super_secret_key_123';
    
    jwt.verify(token, secretKey, (err, user) => {
        if (err) {
            return res.status(403).json({ message: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
};

app.post('/register', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Username or Password missing' });
  }

  try {
    const checkUserSql = 'SELECT username FROM users WHERE username = ?';
    const [existingUsers] = await db.query(checkUserSql, [email]);

    if (existingUsers.length > 0) {
      return res.status(409).json({ message: 'User already exists' });
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const insertSql = 'INSERT INTO users (username, password) VALUES (?, ?)';
    await db.query(insertSql, [email, hashedPassword]);

    return res.status(201).json({ message: 'Registration successful' });

  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Username or Password missing' });
  }

  try {
    const sql = 'SELECT username, password FROM users WHERE username = ?';
    const [result] = await db.query(sql, [email]);

    if (result.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const user = result[0];
    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const secretKey = process.env.JWT_SECRET || 'ali_fabrics_super_secret_key_123';
    const token = jwt.sign(
      { username: user.username },
      secretKey,
      { expiresIn: '12h' }
    );

    return res.status(200).json({
      message: 'Login Successful',
      username: user.username,
      token: token
    });

  } catch (error) {
    console.error('Login Error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

const { createHash } = require('crypto');

const vendorError = (message, status = 400) => Object.assign(new Error(message), { status });

const cleanVendorName = (value) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';

const vendorNameLock = (name) => `pos_vendor_${createHash('sha1').update(name.toLowerCase()).digest('hex')}`;

const acquireVendorNameLock = async (connection, name) => {
  const lockName = vendorNameLock(name);
  const [[result]] = await connection.query('SELECT GET_LOCK(?, 10) AS acquired', [lockName]);
  if (result.acquired !== 1) throw vendorError('Vendor record is busy. Please try again.', 503);
  return lockName;
};

const releaseVendorNameLock = async (connection, lockName) => {
  if (lockName) {
    try {
      await connection.query('SELECT RELEASE_LOCK(?)', [lockName]);
    } catch (error) {
      console.error('Could not release vendor lock:', error);
    }
  }
};

const resolveVendor = async (connection, { vendorId, vendorName, vendorPhone, allowCreate = false }) => {
  if (vendorId !== undefined && vendorId !== null && vendorId !== '') {
    const id = Number(vendorId);
    if (!Number.isSafeInteger(id) || id <= 0) throw vendorError('Invalid vendor ID');
    const [vendors] = await connection.query('SELECT id FROM vendors WHERE id = ? FOR UPDATE', [id]);
    if (vendors.length === 0) throw vendorError('Vendor not found', 404);
    return id;
  }

  const name = cleanVendorName(vendorName);
  if (!name) throw vendorError('Select an existing vendor or enter a vendor name');

  const [vendors] = await connection.query(
    `SELECT v.id, v.contact_person, v.phone
     FROM vendors v
     WHERE LOWER(TRIM(v.contact_person)) = LOWER(?)
        OR EXISTS (
          SELECT 1 FROM vendor_company_names vc
          WHERE vc.vendor_id = v.id AND LOWER(TRIM(vc.company_name)) = LOWER(?)
        )
     ORDER BY v.id FOR UPDATE`,
    [name, name]
  );

  if (vendors.length > 1) {
    throw vendorError(`Multiple vendor accounts match "${name}". Select the vendor by ID or merge confirmed duplicates first.`, 409);
  }

  if (vendors.length === 1) {
    const vendor = vendors[0];
    const requestedPhone = String(vendorPhone || '').replace(/\D/g, '');
    const existingPhone = String(vendor.phone || '').replace(/\D/g, '');
    if (requestedPhone && existingPhone && requestedPhone !== existingPhone) {
      throw vendorError('The vendor name matches an account with a different phone. Select its vendor ID or review the account.', 409);
    }

    const [companyRows] = await connection.query(
      'SELECT id FROM vendor_company_names WHERE vendor_id = ? LIMIT 1',
      [vendor.id]
    );
    if (companyRows.length === 0) {
      await connection.query(
        'INSERT INTO vendor_company_names (vendor_id, company_name, is_primary) VALUES (?, ?, TRUE)',
        [vendor.id, name]
      );
    }
    return vendor.id;
  }

  const requestedPhone = String(vendorPhone || '').replace(/\D/g, '');
  if (requestedPhone) {
    const [matchingPhone] = await connection.query(
      `SELECT id FROM vendors
       WHERE COALESCE(phone, '') <> ''
       AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(phone, ''), ' ', ''), '-', ''), '+', ''), '(', ''), ')', '') = ?
       ORDER BY id FOR UPDATE`,
      [requestedPhone]
    );
    if (matchingPhone.length) throw vendorError('A vendor with this phone already exists under another name. Select its existing account.', 409);
  }

  if (!allowCreate) throw vendorError('Vendor not found. Add it before recording a purchase.', 404);

  const [newVendor] = await connection.query(
    'INSERT INTO vendors (contact_person, phone, current_balance) VALUES (?, ?, 0)',
    [name, cleanVendorName(vendorPhone) || null]
  );
  await connection.query(
    'INSERT INTO vendor_company_names (vendor_id, company_name, is_primary) VALUES (?, ?, TRUE)',
    [newVendor.insertId, name]
  );
  return newVendor.insertId;
};

app.post('/add-product', verifyToken, async (req, res) => {
  const { vendorName, vendorPhone, items, vendorInvoiceNumber } = req.body;
  const vendorId = req.body.vendorId ?? req.body.vendor_id ?? (typeof vendorName === 'object' && vendorName !== null ? vendorName.id ?? vendorName.vendor_id : null);
  const parsedVendorName = typeof vendorName === 'object' && vendorName !== null
    ? vendorName.company_name || vendorName.contact_person || vendorName.name
    : vendorName;

  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: 'At least one item is required' });
  if (!vendorId && !cleanVendorName(parsedVendorName)) return res.status(400).json({ message: 'Select or enter a vendor' });

  const preparedItems = [];
  for (const item of items) {
    const quantity = Number(item.quantity);
    const unitPrice = Number(item.unitPrice);
    const sellingPrice = Number(item.sellingPrice);
    const name = typeof item.productName === 'string' ? item.productName.trim() : '';
    const unit = typeof item.unit === 'string' ? item.unit.trim() : '';
    const total = Math.round(quantity * unitPrice);

    if (!name || !unit || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(sellingPrice) || sellingPrice < 0 || !Number.isSafeInteger(total) || total < 0 || quantity > 99999999 || unitPrice > 99999999 || sellingPrice > 99999999) {
      return res.status(400).json({ message: 'Invalid product name, quantity, price, or unit' });
    }

    if (item.total !== undefined && item.total !== null && item.total !== '' && Math.abs(Number(item.total) - total) > 1) {
      return res.status(400).json({ message: `Purchase total does not match quantity and cost for ${name}` });
    }

    preparedItems.push({ ...item, productName: name, unit, quantity, unitPrice, sellingPrice, total });
  }

  const purchaseTotal = preparedItems.reduce((sum, item) => sum + item.total, 0);
  if (!Number.isSafeInteger(purchaseTotal) || purchaseTotal > 2147483647) return res.status(400).json({ message: 'Purchase total is too large' });

  const connection = await db.getConnection();
  let lockName = null;

  try {
    if (!vendorId) lockName = await acquireVendorNameLock(connection, cleanVendorName(parsedVendorName));
    await connection.beginTransaction();

    const finalVendorId = await resolveVendor(connection, {
      vendorId,
      vendorName: parsedVendorName,
      vendorPhone,
      allowCreate: true
    });

    const [purchaseResult] = await connection.query(
      'INSERT INTO purchases (vendor_id, total_amount, description, vendor_invoice_number) VALUES (?, ?, ?, ?)',
      [finalVendorId, purchaseTotal, `Purchase of ${preparedItems.length} item(s)`, cleanVendorName(vendorInvoiceNumber) || null]
    );

    for (const item of preparedItems) {
      const { productName, brand, category, unit, quantity, unitPrice, sellingPrice, total } = item;
      let brandId = null;
      const brandName = cleanVendorName(brand);

      if (brandName) {
        const [brands] = await connection.query('SELECT id FROM brands WHERE LOWER(TRIM(name)) = LOWER(?) ORDER BY id LIMIT 1', [brandName]);
        if (brands.length) {
          brandId = brands[0].id;
        } else {
          const [newBrand] = await connection.query('INSERT INTO brands (name) VALUES (?)', [brandName]);
          brandId = newBrand.insertId;
        }
      }

      let itemId = item.itemId ?? item.id;
      if (itemId !== undefined && itemId !== null && itemId !== '') {
        const [found] = await connection.query('SELECT id FROM items WHERE id = ? AND vendor_id = ? FOR UPDATE', [itemId, finalVendorId]);
        if (!found.length) throw vendorError(`Selected item ${itemId} is not assigned to this vendor`, 409);
        itemId = found[0].id;
      } else {
        const [matches] = await connection.query(
          `SELECT id FROM items
           WHERE vendor_id = ? AND LOWER(TRIM(name)) = LOWER(?)
             AND brand_id <=> ? AND LOWER(TRIM(unit)) = LOWER(?)
           ORDER BY id FOR UPDATE`,
          [finalVendorId, productName, brandId, unit]
        );
        if (matches.length > 1) throw vendorError(`Multiple inventory records match ${productName}. Choose the product by item ID.`, 409);
        itemId = matches.length ? matches[0].id : null;
      }

      if (itemId) {
        await connection.query(
          `UPDATE items
           SET stock = stock + ?, unit_price = ?, selling_price = ?, total_price = total_price + ?, category = ?, unit = ?, brand_id = ?
           WHERE id = ?`,
          [quantity, unitPrice, sellingPrice, total, category || null, unit, brandId, itemId]
        );
        const [updated] = await connection.query('UPDATE inventory SET stock = stock + ? WHERE item_id = ?', [quantity, itemId]);
        if (updated.affectedRows === 0) {
          await connection.query('INSERT INTO inventory (item_id, stock) VALUES (?, ?)', [itemId, quantity]);
        }
      } else {
        const [newItem] = await connection.query(
          `INSERT INTO items (vendor_id, brand_id, name, category, stock, unit, unit_price, selling_price, total_price)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [finalVendorId, brandId, productName, category || null, quantity, unit, unitPrice, sellingPrice, total]
        );
        itemId = newItem.insertId;
        await connection.query('INSERT INTO inventory (item_id, stock) VALUES (?, ?)', [itemId, quantity]);
      }

      await connection.query(
        'INSERT INTO purchase_items (purchase_id, item_id, quantity, unit_cost) VALUES (?, ?, ?, ?)',
        [purchaseResult.insertId, itemId, quantity, unitPrice]
      );
    }

    await connection.query('UPDATE vendors SET current_balance = current_balance + ? WHERE id = ?', [purchaseTotal, finalVendorId]);
    await connection.commit();
    return res.status(200).json({ message: 'Purchase saved successfully', vendorId: finalVendorId, purchaseId: purchaseResult.insertId });
  } catch (error) {
    await connection.rollback();
    console.error('ADD PRODUCT ERROR:', error);
    return res.status(error.status || 500).json({ message: error.status ? error.message : 'Could not save purchase' });
  } finally {
    await releaseVendorNameLock(connection, lockName);
    connection.release();
  }
});

app.post('/checkout', verifyToken, async (req, res) => {
  const { cart, subtotal, discount, customerName, customerPhone, sendWhatsApp, paymentMethod, amountPaid, bankAccountId } = req.body;

  if (!cart || cart.length === 0) {
    return res.status(400).json({ message: "Cart is empty" });
  }

  const netTotal = subtotal - (discount || 0);
  const paid = Number(amountPaid) || 0;

  if (paid < netTotal && !customerPhone) {
    return res.status(400).json({ message: "Customer phone is required for credit sales." });
  }

  const connection = await db.getConnection();
  const invoiceNumber = `INV-${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 100)}`;

  try {
    await connection.beginTransaction();
    const verifiedItems = [];

    for (const item of cart) {
      const [rows] = await connection.query(
        `SELECT stock, unit_price FROM items WHERE id = ? FOR UPDATE`,
        [item.id]
      );

      if (rows.length === 0) {
        await connection.rollback();
        return res.status(400).json({ message: `Item with ID ${item.id} not found.` });
      }

      if (item.quantity > rows[0].stock) {
        await connection.rollback();
        return res.status(400).json({
          message: `Cannot process: ${item.productName} only has ${rows[0].stock} ${item.unit || 'm'} left.`
        });
      }

      verifiedItems.push({ ...item, costPrice: rows[0].unit_price });
    }

    let customerId = null;

    if (customerPhone) {
      const balanceAddition = netTotal - paid;

      const upsertCustomerQuery = `
        INSERT INTO customers (name, phone, total_spent, total_orders, balance_due)
        VALUES (?, ?, ?, 1, ?)
        ON DUPLICATE KEY UPDATE 
          id = LAST_INSERT_ID(id),
          name = VALUES(name),
          total_spent = total_spent + VALUES(total_spent),
          total_orders = total_orders + 1,
          balance_due = balance_due + VALUES(balance_due)
      `;

      const [customerResult] = await connection.query(upsertCustomerQuery, [
        customerName || 'Walk-in Customer',
        customerPhone,
        netTotal,
        balanceAddition
      ]);

      customerId = customerResult.insertId;

      if (paid > 0) {
        await connection.query(
          `INSERT INTO customer_payments (customer_id, amount, method, bank_account_id) VALUES (?, ?, ?, ?)`,
          [customerId, paid, paymentMethod || 'Cash', bankAccountId || null]
        );
      }
    }

    const [saleResult] = await connection.query(
      `INSERT INTO sales (customer_id, total_amount, discount, payment_method, amount_paid, invoice_number, bank_account_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [customerId, subtotal, discount || 0, paymentMethod || 'Cash', paid, invoiceNumber, bankAccountId || null]
    );
    const saleId = saleResult.insertId;

    for (const item of verifiedItems) {
      await connection.query(
        `INSERT INTO sale_items (sale_id, item_id, meters_sold, unit_price, cost_price) VALUES (?, ?, ?, ?, ?)`,
        [saleId, item.id, item.quantity, item.sellingPrice, item.costPrice]
      );
      await connection.query(`UPDATE items SET stock = stock - ? WHERE id = ?`, [item.quantity, item.id]);
      await connection.query(`UPDATE inventory SET stock = stock - ? WHERE item_id = ?`, [item.quantity, item.id]);
    }

    await connection.commit();
    res.status(200).json({ message: "Checkout successful", saleId: saleId, customerId: customerId, invoiceNumber: invoiceNumber });

  } catch (error) {
    await connection.rollback();
    res.status(500).json({ message: error.sqlMessage || error.message || "Checkout failed, changes reverted." });
  } finally {
    connection.release();
  }
});

app.get('/customers', verifyToken, async (req, res) => {
  try {
    const query = `
      SELECT id, name, phone, total_spent, total_orders, balance_due, created_at 
      FROM customers 
      ORDER BY name ASC
    `;
    const [customers] = await db.query(query);
    return res.status(200).json(customers);
  } catch (error) {
    console.error('Error fetching customers:', error);
    return res.status(500).json({ message: 'Failed to fetch customers' });
  }
});

app.get('/customers/:id/history', verifyToken, async (req, res) => {
  const customerId = req.params.id;

  try {
    const query = `
      SELECT 
        s.id AS receipt_no,
        s.sale_date,
        s.net_total,
        GROUP_CONCAT(CONCAT(i.name, ' (', si.meters_sold, i.unit, ')') SEPARATOR ', ') AS items_bought
      FROM sales s
      LEFT JOIN sale_items si ON s.id = si.sale_id
      LEFT JOIN items i ON si.item_id = i.id
      WHERE s.customer_id = ?
      GROUP BY s.id
      ORDER BY s.sale_date DESC
    `;
    const [history] = await db.query(query, [customerId]);
    return res.status(200).json(history);
  } catch (error) {
    console.error('Database Error during customer history fetch:', error);
    return res.status(500).json({ message: 'Failed to fetch customer history' });
  }
});

app.get('/customers/:id/history', verifyToken, async (req, res) => {
  const customerId = req.params.id;

  try {
    const query = `
      SELECT 
        s.id AS receipt_no,
        s.sale_date,
        s.net_total,
        COUNT(si.id) AS total_items
      FROM sales s
      LEFT JOIN sale_items si ON s.id = si.sale_id
      WHERE s.customer_id = ?
      GROUP BY s.id
      ORDER BY s.sale_date DESC
    `;
    const [history] = await db.query(query, [customerId]);
    return res.status(200).json(history);
  } catch (error) {
    console.error('Database Error during customer history fetch:', error);
    return res.status(500).json({ message: 'Failed to fetch customer history' });
  }
});

app.get('/vendors', verifyToken, async (req, res) => {
  try {
    const [vendors] = await db.query(
      `SELECT v.id, v.contact_person, v.phone, v.current_balance,
         COALESCE((SELECT company_name FROM vendor_company_names
           WHERE vendor_id = v.id ORDER BY is_primary DESC, id ASC LIMIT 1), v.contact_person) AS company_name
       FROM vendors v ORDER BY v.created_at DESC, v.id DESC`
    );
    return res.status(200).json(vendors);
  } catch (error) {
    console.error('Database Error during /vendors fetch:', error);
    return res.status(500).json({ message: 'Failed to fetch vendors' });
  }
});

app.get('/inventory/:id/history', verifyToken, async (req, res) => {
  const itemId = req.params.id;

  try {
    const query = `
      SELECT 
        s.sale_date, 
        s.id AS receipt_no,
        si.meters_sold, 
        si.unit_price, 
        si.subtotal
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE si.item_id = ?
      ORDER BY s.sale_date DESC
    `;

    const [history] = await db.query(query, [itemId]);
    return res.status(200).json(history);

  } catch (error) {
    console.error('Database Error during item history fetch:', error);
    return res.status(500).json({ message: 'Failed to fetch item history' });
  }
});

app.post('/add-vendors', verifyToken, async (req, res) => {
  const { vendorName, contact, balance } = req.body;
  const name = cleanVendorName(vendorName);
  const phone = cleanVendorName(contact);
  const openingBalance = Number(balance ?? 0);

  if (!name || !phone || !Number.isSafeInteger(openingBalance) || Math.abs(openingBalance) > 2147483647) {
    return res.status(400).json({ message: 'Provide a vendor name, phone, and valid whole-rupee balance' });
  }

  const connection = await db.getConnection();
  let lockName = null;

  try {
    lockName = await acquireVendorNameLock(connection, name);
    await connection.beginTransaction();

    const [existing] = await connection.query(
      `SELECT v.id FROM vendors v
       WHERE LOWER(TRIM(v.contact_person)) = LOWER(?)
          OR EXISTS (SELECT 1 FROM vendor_company_names vc
                     WHERE vc.vendor_id = v.id AND LOWER(TRIM(vc.company_name)) = LOWER(?))
       ORDER BY v.id FOR UPDATE`,
      [name, name]
    );

    if (existing.length) throw vendorError('This vendor already exists. Select its existing account instead.', 409);

    const [matchingPhones] = await connection.query(
      `SELECT id, contact_person FROM vendors
       WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(phone, ''), ' ', ''), '-', ''), '+', ''), '(', ''), ')', '') = ?
       AND COALESCE(phone, '') <> '' ORDER BY id FOR UPDATE`,
      [phone.replace(/\D/g, '')]
    );
    if (matchingPhones.length) throw vendorError('A vendor with this phone already exists. Review the existing account before creating another.', 409);

    const [result] = await connection.query(
      'INSERT INTO vendors (contact_person, phone, current_balance) VALUES (?, ?, ?)',
      [name, phone, openingBalance]
    );
    await connection.query(
      'INSERT INTO vendor_company_names (vendor_id, company_name, is_primary) VALUES (?, ?, TRUE)',
      [result.insertId, name]
    );

    await connection.commit();
    return res.status(201).json({ message: 'Vendor added successfully', vendorId: result.insertId });
  } catch (error) {
    await connection.rollback();
    console.error('Could not add vendor:', error);
    return res.status(error.status || 500).json({ message: error.status ? error.message : 'Unable to add vendor' });
  } finally {
    await releaseVendorNameLock(connection, lockName);
    connection.release();
  }
});

app.get('/get-vendors', verifyToken, async (req, res) => {
  try {
    const [records] = await db.query(
      `SELECT v.id, v.contact_person, v.phone, v.current_balance,
         COALESCE((SELECT company_name FROM vendor_company_names
           WHERE vendor_id = v.id ORDER BY is_primary DESC, id ASC LIMIT 1), v.contact_person) AS company_name
       FROM vendors v ORDER BY v.created_at ASC, v.id ASC`
    );
    return res.status(200).json(records);
  } catch (error) {
    console.error('Error retrieving vendors:', error);
    return res.status(500).json({ message: 'Failed to fetch vendors' });
  }
});

app.get('/vendors/:vendorName/brands', verifyToken, async (req, res) => {
  const connection = await db.getConnection();
  try {
    const vendorIdValue = Number(req.params.vendorName);
    let vendorId;
    if (Number.isSafeInteger(vendorIdValue) && vendorIdValue > 0) {
      const [vendorRows] = await connection.query('SELECT id FROM vendors WHERE id = ?', [vendorIdValue]);
      vendorId = vendorRows.length ? vendorRows[0].id : null;
    } else {
      const [vendorRows] = await connection.query(
        `SELECT v.id FROM vendors v
         WHERE LOWER(TRIM(v.contact_person)) = LOWER(TRIM(?))
            OR EXISTS (SELECT 1 FROM vendor_company_names vc
              WHERE vc.vendor_id = v.id AND LOWER(TRIM(vc.company_name)) = LOWER(TRIM(?)))
         ORDER BY v.id`,
        [req.params.vendorName, req.params.vendorName]
      );
      if (vendorRows.length > 1) return res.status(409).json({ message: 'Multiple vendors have this name. Select the vendor by ID.' });
      vendorId = vendorRows.length ? vendorRows[0].id : null;
    }
    if (!vendorId) return res.status(200).json([]);
    const [brands] = await connection.query(
      `SELECT DISTINCT b.id, b.name FROM brands b
       JOIN items i ON b.id = i.brand_id WHERE i.vendor_id = ?`,
      [vendorId]
    );
    return res.status(200).json(brands);
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.status ? error.message : 'Failed to fetch vendor brands' });
  } finally {
    connection.release();
  }
});

app.get('/vendors/:id/details', verifyToken, async (req, res) => {
  const vendorId = Number(req.params.id);
  if (!Number.isSafeInteger(vendorId) || vendorId <= 0) return res.status(400).json({ message: 'Invalid vendor ID' });

  try {
    const [vendor] = await db.query('SELECT current_balance FROM vendors WHERE id = ?', [vendorId]);
    if (!vendor.length) return res.status(404).json({ message: 'Vendor not found' });

    const [brandRows] = await db.query(
      `SELECT DISTINCT b.name FROM brands b
       JOIN items i ON b.id = i.brand_id WHERE i.vendor_id = ? ORDER BY b.name`,
      [vendorId]
    );

    const [purchases] = await db.query(
      `SELECT p.id AS purchase_id, p.purchase_date,
          COALESCE(i.name, p.description) AS product_name,
          pi.quantity AS stock, COALESCE(i.unit, '') AS unit,
          COALESCE(ROUND(pi.subtotal), p.total_amount) AS total_price, p.description
       FROM purchases p
       LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
       LEFT JOIN items i ON i.id = pi.item_id
       WHERE p.vendor_id = ?
       ORDER BY p.purchase_date DESC, p.id DESC, pi.id DESC`,
      [vendorId]
    );

    return res.status(200).json({ brands: brandRows.map(row => row.name), purchases, currentBalance: vendor[0].current_balance });
  } catch (error) {
    console.error('Failed to fetch vendor details:', error);
    return res.status(500).json({ message: 'Failed to fetch vendor details' });
  }
});

app.post('/add-payment', verifyToken, async (req, res) => {
  const { amount, method, vendor_id, description, bankAccountId, bank_account_id } = req.body;
  const id = Number(vendor_id);
  const paymentAmount = Number(amount);
  const bankId = bankAccountId ?? bank_account_id ?? null;
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(paymentAmount) || paymentAmount <= 0 || paymentAmount > 2147483647 || typeof method !== 'string' || !method.trim()) {
    return res.status(400).json({ message: 'Valid vendor, payment amount, and method are required' });
  }
  if (bankId !== null && (!Number.isSafeInteger(Number(bankId)) || Number(bankId) <= 0)) {
    return res.status(400).json({ message: 'Invalid bank account' });
  }
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [existing] = await connection.query('SELECT id FROM vendors WHERE id = ? FOR UPDATE', [id]);
    if (!existing.length) throw vendorError('Vendor not found', 404);
    const insertPaymentQuery = `
    INSERT INTO payments (vendor_id, amount, method, description, bank_account_id)
    VALUES (?,?,?,?,?)`;
    await connection.query(insertPaymentQuery, [id, paymentAmount, method.trim(), description || null, bankId ? Number(bankId) : null]);

    const updateBalanceQuery = `
    UPDATE vendors SET current_balance = current_balance - ? WHERE id = ?`;
    await connection.query(updateBalanceQuery, [paymentAmount, id]);

    await connection.commit();

    try {
      const [vendorRows] = await connection.query(`SELECT contact_person, phone FROM vendors WHERE id = ?`, [id]);

      if (vendorRows.length > 0 && vendorRows[0].phone) {
        const cleanPhone = vendorRows[0].phone.replace(/\D/g, '');
        const vendorName = vendorRows[0].contact_person || 'Vendor';
        const messageText = `Hello *${vendorName}*,\n\nWe have successfully processed a payment of *${paymentAmount.toLocaleString()} PKR* via ${method}.\n\nThank you!`;

        if (whatsappClient.info) {
          const numberDetails = await whatsappClient.getNumberId(cleanPhone);
          if (numberDetails) {
            await whatsappClient.sendMessage(numberDetails._serialized, messageText);
            console.log(`WhatsApp payment notification sent to ${cleanPhone}`);
          }
        }
      }
    } catch (waError) {
      console.error("Failed to send WhatsApp message:", waError.message);
    }

    return res.status(200).json({ message: 'Payment Added Successfully' });

  } catch (error) {
    await connection.rollback();
    console.log(`Couldn't add payment: `, error);
    return res.status(error.status || 500).json({ message: error.status ? error.message : 'Internal Server Error' });
  } finally {
    connection.release();
  }
});

app.get('/get-payments', verifyToken, async (req, res) => {
  try {
    const getPayments = `
      SELECT
        COALESCE((SELECT company_name FROM vendor_company_names WHERE vendor_id = v.id ORDER BY is_primary DESC, id LIMIT 1), v.contact_person) AS vendor_name,
        p.amount,
        p.method,
        p.description,
        p.payment_date
      FROM payments p
      JOIN vendors v on p.vendor_id = v.id
      ORDER BY
        p.payment_date DESC; 
    `;

    const [rows] = await db.query(getPayments);
    res.status(200).json({
      success: true,
      data: rows
    })
  } catch (error) {
    console.log('Error occured while fetching payments: ', error);
    return res.status(500).json({ message: 'Failed to fetch payments' })
  }
});

app.get('/vendors/:id/ledger', verifyToken, async (req, res) => {
  const vendorId = Number(req.params.id);
  if (!Number.isSafeInteger(vendorId) || vendorId <= 0) return res.status(400).json({ message: 'Invalid vendor ID' });

  try {
    const [accounts] = await db.query(
      `SELECT v.current_balance, v.created_at,
          COALESCE((SELECT SUM(total_amount) FROM purchases WHERE vendor_id = v.id), 0) AS total_purchases,
          COALESCE((SELECT SUM(amount) FROM payments WHERE vendor_id = v.id), 0) AS total_payments
       FROM vendors v WHERE v.id = ?`,
      [vendorId]
    );
    if (!accounts.length) return res.status(404).json({ message: 'Vendor not found' });

    const [ledgerData] = await db.query(
      `SELECT purchase_date AS transaction_date, 'Purchase Bill' AS type,
              description, 0 AS debit_paid, total_amount AS credit_owed,
              id AS transaction_id, 0 AS sequence
       FROM purchases WHERE vendor_id = ?
       UNION ALL
       SELECT payment_date AS transaction_date, CONCAT('Payment - ', method) AS type,
              description, amount AS debit_paid, 0 AS credit_owed,
              id AS transaction_id, 1 AS sequence
       FROM payments WHERE vendor_id = ?
       ORDER BY transaction_date ASC, sequence ASC, transaction_id ASC`,
      [vendorId, vendorId]
    );

    const account = accounts[0];
    const openingBalance = Number(account.current_balance) - Number(account.total_purchases) + Number(account.total_payments);
    return res.status(200).json({ success: true, data: ledgerData, openingBalance, createdAt: account.created_at });
  } catch (error) {
    console.error('Failed to fetch ledger details:', error);
    return res.status(500).json({ message: 'Failed to fetch ledger details' });
  }
});

app.get('/api/users', verifyToken, async (req, res) => {
  try {
    const fetchUsersSql = 'SELECT id, username, password FROM users';
    const [users] = await db.query(fetchUsersSql);

    return res.status(200).json(users);
  } catch (error) {
    console.error('Fetch users error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

app.delete('/api/users/:id', verifyToken, async (req, res) => {
  const userId = req.params.id;

  try {
    const deleteSql = 'DELETE FROM users WHERE id = ?';
    const [result] = await db.query(deleteSql, [userId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    return res.status(200).json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

app.get('/api/dashboard/summary', verifyToken, async (req, res) => {
  const { filter = 'weekly' } = req.query;
  let dateCondition = 's.sale_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
  let groupBy = 'DATE(s.sale_date)';
  let dateFormat = "'%b %d'";

  if (filter === 'today') {
    dateCondition = 'DATE(s.sale_date) = CURDATE()';
    groupBy = 'HOUR(s.sale_date)';
    dateFormat = "'%h %p'";
  } else if (filter === 'monthly') {
    dateCondition = 's.sale_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)';
  } else if (filter === 'yearly') {
    dateCondition = 's.sale_date >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)';
    groupBy = 'MONTH(s.sale_date)';
    dateFormat = "'%b %Y'";
  }

  try {
    const [
      todaysRevenue,
      todaysProfit,
      monthlyPurchases,
      vendorPayables,
      lowStockAlerts,
      revenueTrend,
      topSellingItems,
      lowStockList,
      recentSalesData,
      customerReceivables,
      deadStockCount,
      deadStockList,
      categorySalesData,
      customerDuesList,
      cashData,
      bankData,
      recentExpensesData,
      bankBalancesData
    ] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(net_total), 0) AS todays_revenue FROM sales WHERE DATE(sale_date) = CURDATE()`),
      db.query(`
        SELECT 
          COALESCE(SUM(s.net_total), 0) - SUM(COALESCE(cogs.total_cogs, 0)) AS todays_profit
        FROM sales s
        LEFT JOIN (
          SELECT sale_id, SUM(meters_sold * cost_price) AS total_cogs
          FROM sale_items
          GROUP BY sale_id
        ) AS cogs ON s.id = cogs.sale_id
        WHERE DATE(s.sale_date) = CURDATE()
      `),
      db.query(`SELECT COALESCE(SUM(total_amount), 0) AS monthly_purchases FROM purchases WHERE MONTH(purchase_date) = MONTH(CURDATE()) AND YEAR(purchase_date) = YEAR(CURDATE())`),
      db.query(`SELECT COALESCE(SUM(current_balance), 0) AS total_outstanding_balance FROM vendors`),
      db.query(`SELECT COUNT(*) AS low_stock_count FROM inventory WHERE stock < 20.00`),
      db.query(`
        SELECT 
          DATE_FORMAT(MAX(s.sale_date), ${dateFormat}) AS date, 
          SUM(s.net_total) AS daily_revenue,
          SUM(s.net_total) - SUM(COALESCE(cogs.total_cogs, 0)) AS daily_profit
        FROM sales s
        LEFT JOIN (
          SELECT sale_id, SUM(meters_sold * cost_price) AS total_cogs
          FROM sale_items
          GROUP BY sale_id
        ) AS cogs ON s.id = cogs.sale_id
        WHERE ${dateCondition}
        GROUP BY ${groupBy}
        ORDER BY MAX(s.sale_date) ASC
      `),
      db.query(`SELECT i.name, SUM(si.meters_sold) AS total_meters FROM sale_items si JOIN items i ON si.item_id = i.id GROUP BY i.id, i.name ORDER BY total_meters DESC LIMIT 5`),
      db.query(`
        SELECT i.name, inv.stock, i.unit 
        FROM inventory inv 
        JOIN items i ON inv.item_id = i.id 
        WHERE inv.stock < 20.00
      `),
      db.query(`
        SELECT id, sale_date, total_amount, discount, net_total 
        FROM sales 
        ORDER BY sale_date DESC 
        LIMIT 5
      `),
      db.query(`SELECT COALESCE(SUM(balance_due), 0) AS customer_dues FROM customers`),
      db.query(`
        SELECT COUNT(*) AS dead_stock_count
        FROM items i 
        JOIN inventory inv ON i.id = inv.item_id 
        WHERE inv.stock > 0 
        AND i.id NOT IN (
          SELECT si.item_id 
          FROM sale_items si 
          JOIN sales s ON si.sale_id = s.id 
          WHERE s.sale_date >= DATE_SUB(CURDATE(), INTERVAL 2 MONTH)
        )
      `),
      db.query(`
        SELECT i.name, inv.stock, i.unit 
        FROM items i 
        JOIN inventory inv ON i.id = inv.item_id 
        WHERE inv.stock > 0 
        AND i.id NOT IN (
          SELECT si.item_id 
          FROM sale_items si 
          JOIN sales s ON si.sale_id = s.id 
          WHERE s.sale_date >= DATE_SUB(CURDATE(), INTERVAL 2 MONTH)
        )
      `),
      db.query(`
        SELECT COALESCE(i.category, 'Other') AS name, SUM(si.meters_sold * si.unit_price) AS value
        FROM sale_items si
        JOIN items i ON si.item_id = i.id
        JOIN sales s ON si.sale_id = s.id
        WHERE ${dateCondition}
        GROUP BY i.category
        ORDER BY value DESC
      `),
      db.query(`
        SELECT name, phone, balance_due 
        FROM customers 
        WHERE balance_due > 0 
        ORDER BY balance_due DESC
      `),
      db.query(`
        SELECT 
          COALESCE((SELECT SUM(amount_paid) FROM sales WHERE payment_method = 'Cash'), 0) + 
          COALESCE((SELECT SUM(amount) FROM customer_payments WHERE method = 'Cash'), 0) - 
          COALESCE((SELECT SUM(amount) FROM payments WHERE method = 'Cash'), 0) AS total_cash
      `),
      db.query(`
        SELECT 
          COALESCE((SELECT SUM(amount_paid) FROM sales WHERE payment_method = 'Bank Transfer'), 0) + 
          COALESCE((SELECT SUM(amount) FROM customer_payments WHERE method = 'Bank Transfer'), 0) - 
          COALESCE((SELECT SUM(amount) FROM payments WHERE method = 'Bank Transfer'), 0) AS total_bank
      `),
      db.query(`
        SELECT p.id, p.amount, p.method, p.payment_date, 
          COALESCE((SELECT company_name FROM vendor_company_names WHERE vendor_id = p.vendor_id ORDER BY is_primary DESC, id LIMIT 1), (SELECT contact_person FROM vendors WHERE id = p.vendor_id), 'Vendor') as vendor_name
        FROM payments p
        ORDER BY p.payment_date DESC 
        LIMIT 5
      `),
      db.query(`
        SELECT 
          b.bank_name, 
          b.account_title,
          COALESCE((SELECT SUM(amount_paid) FROM sales WHERE bank_account_id = b.id), 0) +
          COALESCE((SELECT SUM(amount) FROM customer_payments WHERE bank_account_id = b.id), 0) -
          COALESCE((SELECT SUM(amount) FROM payments WHERE bank_account_id = b.id), 0) AS balance
        FROM business_bank_accounts b
        WHERE b.is_active = TRUE
      `)
    ]);

    const cash = Number(cashData[0][0].total_cash) || 0;
    const bank = Number(bankData[0][0].total_bank) || 0;

    res.json({
      kpis: {
        revenue: todaysRevenue[0][0].todays_revenue,
        profit: todaysProfit[0][0].todays_profit,
        purchases: monthlyPurchases[0][0].monthly_purchases,
        payables: vendorPayables[0][0].total_outstanding_balance,
        lowStockCount: lowStockAlerts[0][0].low_stock_count,
        lowStockList: lowStockList[0],
        customerDues: customerReceivables[0][0].customer_dues,
        deadStockCount: deadStockCount[0][0].dead_stock_count,
        deadStockList: deadStockList[0],
        customerDuesList: customerDuesList[0],
        totalCash: cash,
        totalBank: bank,
        totalBalance: cash + bank,
        bankBalances: bankBalancesData[0]
      },
      charts: {
        revenueTrend: revenueTrend[0],
        topItems: topSellingItems[0],
        categorySales: categorySalesData[0]
      },
      recentSales: recentSalesData[0],
      recentExpenses: recentExpensesData[0]
    });
  } catch (error) {
    res.status(500).json({ error: error.sqlMessage || "Failed to fetch dashboard data" });
  }
});

app.get('/api/dashboard/pnl', verifyToken, async (req, res) => {
  const { filter = 'weekly' } = req.query;
  let dateCondition = 's.sale_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';

  if (filter === 'today') {
    dateCondition = 'DATE(s.sale_date) = CURDATE()';
  } else if (filter === 'monthly') {
    dateCondition = 's.sale_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)';
  } else if (filter === 'yearly') {
    dateCondition = 's.sale_date >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)';
  }

  try {
    const [pnlData] = await db.query(`
      SELECT 
        COALESCE(SUM(s.net_total), 0) AS total_revenue,
        SUM(COALESCE(cogs.total_cogs, 0)) AS total_cogs,
        COALESCE(SUM(s.discount), 0) AS total_discounts_loss,
        (COALESCE(SUM(s.net_total), 0) - SUM(COALESCE(cogs.total_cogs, 0))) AS net_profit
      FROM sales s
      LEFT JOIN (
        SELECT sale_id, SUM(meters_sold * cost_price) AS total_cogs
        FROM sale_items
        GROUP BY sale_id
      ) AS cogs ON s.id = cogs.sale_id
      WHERE ${dateCondition}
    `);

    res.json(pnlData[0]);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch PNL data" });
  }
});

app.post('/add-customer-payment', verifyToken, async (req, res) => {
  const { customerId, method, amount } = req.body;

  if (!customerId || !method || !amount) {
    return res.status(400).json({ message: "Missing required payment fields" });
  }

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [paymentResult] = await connection.query(
      `INSERT INTO customer_payments (customer_id, amount, method, payment_date) VALUES (?, ?, ?, NOW())`,
      [customerId, amount, method]
    );
    const paymentId = paymentResult.insertId;

    await connection.query(
      `UPDATE customers SET balance_due = balance_due - ? WHERE id = ?`,
      [amount, customerId]
    );

    await connection.commit();
    res.status(200).json({ message: "Payment added successfully", paymentId: paymentId });

  } catch (error) {
    await connection.rollback();
    res.status(500).json({ message: "Payment failed, changes reverted." });
  } finally {
    connection.release();
  }
});

app.post('/api/settings/brand', verifyToken, async (req, res) => {
  const { storeName, address, phone, currency } = req.body;

  try {
    const query = `
            UPDATE brand_info 
            SET store_name = ?, address = ?, phone = ?, currency = ? 
            WHERE id = 1
        `;
    const [result] = await pool.execute(query, [storeName, address, phone, currency]);

    if (result.affectedRows === 0) {
      const insertQuery = `INSERT INTO brand_info (id, store_name, address, phone, currency) VALUES (1, ?, ?, ?, ?)`;
      await pool.execute(insertQuery, [storeName, address, phone, currency]);
    }

    res.status(200).json({ message: 'Brand settings updated successfully' });
  } catch (error) {
    console.error('Error saving brand info:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.get('/api/backup', verifyToken, async (req, res) => {
  const { table } = req.query;

  let sql = '';

  switch (table) {
    case 'customers':
      sql = `
                SELECT id, name, phone, total_spent, total_orders, created_at 
                FROM customers
            `;
      break;

    case 'inventory':
      sql = `
                SELECT 
                    inv.id, 
                    i.name AS item_name, 
                    inv.stock, 
                    inv.updated_at 
                FROM inventory inv
                LEFT JOIN items i ON inv.item_id = i.id
            `;
      break;

    case 'items':
      sql = `
                SELECT 
                    i.id, 
                    i.name, 
                    i.category,
                    b.name AS brand, 
                    COALESCE(vcn.company_name, v.contact_person, 'Unknown Vendor') AS vendor,
                    i.stock, 
                    i.unit, 
                    i.unit_price, 
                    i.selling_price, 
                    i.total_price, 
                    i.created_at
                FROM items i
                LEFT JOIN brands b ON i.brand_id = b.id
                LEFT JOIN vendors v ON i.vendor_id = v.id
                LEFT JOIN vendor_company_names vcn ON vcn.id = (SELECT vc2.id FROM vendor_company_names vc2 WHERE vc2.vendor_id = v.id ORDER BY vc2.is_primary DESC, vc2.id ASC LIMIT 1)
            `;
      break;

    case 'payments':
      sql = `
                SELECT 
                    p.id, 
                    COALESCE(vcn.company_name, v.contact_person, 'Unknown Vendor') AS vendor, 
                    p.amount, 
                    p.method, 
                    p.description, 
                    p.payment_date 
                FROM payments p
                LEFT JOIN vendors v ON p.vendor_id = v.id
                LEFT JOIN vendor_company_names vcn ON vcn.id = (SELECT vc2.id FROM vendor_company_names vc2 WHERE vc2.vendor_id = v.id ORDER BY vc2.is_primary DESC, vc2.id ASC LIMIT 1)
            `;
      break;

    case 'purchases':
      sql = `
                SELECT 
                    p.id, 
                    COALESCE(vcn.company_name, v.contact_person, 'Unknown Vendor') AS vendor, 
                    p.total_amount, 
                    p.description, 
                    p.purchase_date 
                FROM purchases p
                LEFT JOIN vendors v ON p.vendor_id = v.id
                LEFT JOIN vendor_company_names vcn ON vcn.id = (SELECT vc2.id FROM vendor_company_names vc2 WHERE vc2.vendor_id = v.id ORDER BY vc2.is_primary DESC, vc2.id ASC LIMIT 1)
            `;
      break;

    case 'vendors':
      sql = `
                SELECT 
                    v.id, 
                    v.contact_person, 
                    vcn.company_name AS primary_company, 
                    v.phone, 
                    v.current_balance, 
                    v.created_at 
                FROM vendors v
                LEFT JOIN vendor_company_names vcn ON vcn.id = (SELECT vc2.id FROM vendor_company_names vc2 WHERE vc2.vendor_id = v.id ORDER BY vc2.is_primary DESC, vc2.id ASC LIMIT 1)
            `;
      break;

    default:
      return res.status(400).json({ message: 'Invalid table selected' });
  }

  try {
    const [rows] = await db.query(sql);

    const workbook = new excelJS.Workbook();
    const worksheet = workbook.addWorksheet(table);

    if (rows.length > 0) {
      const columns = Object.keys(rows[0]).map(key => ({
        header: key.replace(/_/g, ' ').toUpperCase(),
        key: key,
        width: 25
      }));
      worksheet.columns = columns;

      worksheet.getRow(1).font = { bold: true };

      rows.forEach(row => {
        worksheet.addRow(row);
      });
    } else {
      worksheet.columns = [{ header: 'INFO', key: 'info', width: 40 }];
      worksheet.addRow({ info: `No records found in the ${table} table.` });
    }

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=${table}_backup.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Backup error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.get('/invoices', verifyToken, async (req, res) => {
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(`
      SELECT 
        s.id, 
        s.invoice_number, 
        s.total_amount, 
        s.discount, 
        s.net_total, 
        s.sale_date, 
        s.customer_id,
        c.name as customer_name
      FROM sales s
      LEFT JOIN customers c ON s.customer_id = c.id
      ORDER BY s.sale_date DESC
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  } finally {
    connection.release();
  }
});

app.get('/invoices/:id/items', verifyToken, async (req, res) => {
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(`
      SELECT 
        si.item_id as id,
        si.meters_sold as quantity, 
        si.unit_price as sellingPrice, 
        i.name as productName, 
        i.unit
      FROM sale_items si
      JOIN items i ON si.item_id = i.id
      WHERE si.sale_id = ?
    `, [req.params.id]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  } finally {
    connection.release();
  }
});

app.post('/return', verifyToken, async (req, res) => {
  const { saleId, customerId, returnItems, totalRefund } = req.body;

  if (!returnItems || returnItems.some(item => item.id == null)) {
    return res.status(400).json({
      message: "Invalid payload: 'id' is missing in one or more return items."
    });
  }

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [returnResult] = await connection.query(
      `INSERT INTO returns (sale_id, total_refund) VALUES (?, ?)`,
      [saleId, totalRefund]
    );
    const returnId = returnResult.insertId;

    for (const item of returnItems) {
      if (item.quantity > 0) {
        const itemRefundAmount = item.sellingPrice;

        await connection.query(
          `INSERT INTO return_items (return_id, item_id, quantity, refund_amount) VALUES (?, ?, ?, ?)`,
          [returnId, item.id, item.quantity, itemRefundAmount]
        );

        await connection.query(
          `UPDATE items SET stock = stock + ? WHERE id = ?`,
          [item.quantity, item.id]
        );

        await connection.query(
          `UPDATE inventory SET stock = stock + ? WHERE item_id = ?`,
          [item.quantity, item.id]
        );
      }
    }

    if (customerId) {
      await connection.query(
        `UPDATE customers SET total_spent = total_spent - ? WHERE id = ?`,
        [totalRefund, customerId]
      );
    }

    await connection.commit();
    res.status(200).json({ message: "Return processed successfully" });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ message: error.message });
  } finally {
    connection.release();
  }
});

app.get('/inventory', verifyToken, async (req, res) => {
  try {
    const query = `
      SELECT 
        i.id, 
        i.name AS productName, 
        COALESCE(vc.company_name, v.contact_person) AS vendorName,
        b.name AS brandName, 
        i.category, 
        i.stock, 
        i.unit,
        i.unit_price AS unitPrice,
        i.selling_price AS sellingPrice
      FROM items i
      LEFT JOIN vendors v ON i.vendor_id = v.id
      LEFT JOIN vendor_company_names vc ON vc.id = (SELECT vc2.id FROM vendor_company_names vc2 WHERE vc2.vendor_id = i.vendor_id ORDER BY vc2.is_primary DESC, vc2.id ASC LIMIT 1)
      LEFT JOIN brands b ON i.brand_id = b.id
      WHERE EXISTS (SELECT 1 FROM inventory inv WHERE inv.item_id = i.id)
      ORDER BY i.created_at DESC
    `;

    const [inventoryList] = await db.query(query);
    return res.status(200).json(inventoryList);

  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Failed to fetch inventory data' });
  }
});

app.get('/bank-accounts', verifyToken, async (req, res) => {
  try {
    const [accounts] = await db.query(
      'SELECT id, bank_name, account_title, account_number, qr_code, is_active FROM business_bank_accounts ORDER BY created_at DESC'
    );
    res.status(200).json(accounts);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch bank accounts' });
  }
});

app.post('/bank-accounts', verifyToken, async (req, res) => {
  const { bank_name, account_title, account_number, qr_code } = req.body;

  if (!bank_name || !account_title || !account_number) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  try {
    await db.query(
      `INSERT INTO business_bank_accounts (bank_name, account_title, account_number, qr_code, is_active) 
             VALUES (?, ?, ?, ?, TRUE)`,
      [bank_name, account_title, account_number, qr_code || null]
    );
    res.status(201).json({ message: 'Bank account added successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to add bank account' });
  }
});

app.patch('/bank-accounts/:id/toggle', verifyToken, async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;

  try {
    await db.query(
      'UPDATE business_bank_accounts SET is_active = ? WHERE id = ?',
      [is_active, id]
    );
    res.status(200).json({ message: 'Bank account status updated' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update bank account status' });
  }
});

app.get('/api/bank-accounts/active', verifyToken, async (req, res) => {
  try {
    const [accounts] = await db.query(
      'SELECT id, bank_name, account_title, account_number, qr_code FROM business_bank_accounts WHERE is_active = TRUE ORDER BY bank_name ASC'
    );
    res.status(200).json(accounts);
  } catch (error) {
    console.error('Failed to fetch active bank accounts:', error);
    res.status(500).json({ message: 'Error fetching bank accounts' });
  }
});

app.post('/add-single-product', verifyToken, async (req, res) => {
  const { items, vendorName, vendorPhone } = req.body;
  const vendorId = req.body.vendorId ?? req.body.vendor_id ?? (typeof vendorName === 'object' && vendorName !== null ? vendorName.id ?? vendorName.vendor_id : null);
  const parsedName = typeof vendorName === 'object' && vendorName !== null
    ? vendorName.company_name || vendorName.contact_person || vendorName.name
    : vendorName;

  if (!Array.isArray(items) || !items.length) return res.status(400).json({ message: 'At least one product is required' });
  if (!vendorId && !cleanVendorName(parsedName)) return res.status(400).json({ message: 'Select the vendor for this product' });

  const connection = await db.getConnection();
  let lockName = null;

  try {
    if (!vendorId) lockName = await acquireVendorNameLock(connection, cleanVendorName(parsedName));
    await connection.beginTransaction();
    const finalVendorId = await resolveVendor(connection, { vendorId, vendorName: parsedName, vendorPhone, allowCreate: false });
    let addedCount = 0;
    let updatedCount = 0;

    for (const item of items) {
      const name = cleanVendorName(item.productName);
      const unit = cleanVendorName(item.unit);
      const brandName = cleanVendorName(item.brand);
      const quantity = Number(item.quantity);
      const unitPrice = Number(item.unitPrice);
      const sellingPrice = Number(item.sellingPrice);
      const total = Math.round(quantity * unitPrice);
      if (!name || !unit || !Number.isFinite(quantity) || quantity < 0 || quantity > 99999999 || !Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 99999999 || !Number.isFinite(sellingPrice) || sellingPrice < 0 || sellingPrice > 99999999 || !Number.isSafeInteger(total) || total > 2147483647) {
        throw vendorError('Invalid product details');
      }

      let brandId = null;
      if (brandName) {
        const [brands] = await connection.query('SELECT id FROM brands WHERE LOWER(TRIM(name)) = LOWER(?) ORDER BY id LIMIT 1', [brandName]);
        if (brands.length) {
          brandId = brands[0].id;
        } else {
          const [created] = await connection.query('INSERT INTO brands (name) VALUES (?)', [brandName]);
          brandId = created.insertId;
        }
      }

      const [matches] = await connection.query(
        `SELECT id FROM items
         WHERE vendor_id = ? AND LOWER(TRIM(name)) = LOWER(?)
           AND brand_id <=> ? AND LOWER(TRIM(unit)) = LOWER(?)
         ORDER BY id FOR UPDATE`,
        [finalVendorId, name, brandId, unit]
      );
      if (matches.length > 1) throw vendorError(`Multiple inventory records match ${name}. Update the product from its record instead.`, 409);

      if (matches.length) {
        const itemId = matches[0].id;
        await connection.query(
          `UPDATE items
           SET stock = stock + ?, unit_price = ?, selling_price = ?, total_price = total_price + ?, category = ?, unit = ?
           WHERE id = ?`,
          [quantity, unitPrice, sellingPrice, total, item.category || null, unit, itemId]
        );
        const [updated] = await connection.query('UPDATE inventory SET stock = stock + ? WHERE item_id = ?', [quantity, itemId]);
        if (updated.affectedRows === 0) {
          await connection.query('INSERT INTO inventory (item_id, stock) VALUES (?, ?)', [itemId, quantity]);
        }
        updatedCount += 1;
      } else {
        const [created] = await connection.query(
          `INSERT INTO items (vendor_id, brand_id, name, category, stock, unit, unit_price, selling_price, total_price)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [finalVendorId, brandId, name, item.category || null, quantity, unit, unitPrice, sellingPrice, total]
        );
        await connection.query('INSERT INTO inventory (item_id, stock) VALUES (?, ?)', [created.insertId, quantity]);
        addedCount += 1;
      }
    }

    await connection.commit();
    const message = updatedCount
      ? `${addedCount} new product(s) added, ${updatedCount} existing product(s) restocked`
      : 'Products added successfully';
    return res.status(200).json({ message, vendorId: finalVendorId, addedCount, updatedCount });
  } catch (error) {
    await connection.rollback();
    console.error('Unable to add product:', error);
    return res.status(error.status || 500).json({ message: error.status ? error.message : 'Failed to add products' });
  } finally {
    await releaseVendorNameLock(connection, lockName);
    connection.release();
  }
});

app.post('/customers', verifyToken, async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name) {
      return res.status(400).json({ message: 'Customer name is required' });
    }

    const query = `INSERT INTO customers (name, phone) VALUES (?, ?)`;
    const values = [name, phone || null];
    const result = await db.query(query, values);

    res.status(201).json({
      id: result.insertId,
      name: name,
      phone: phone
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.put('/inventory/:id', verifyToken, async (req, res) => {
  const itemId = Number(req.params.id);
  if (!Number.isSafeInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ message: 'Invalid item ID' });
  }

  const { productName, unitPrice, sellingPrice } = req.body;
  const name = typeof productName === 'string' ? productName.trim() : '';
  const isValidPrice = (value) =>
    (typeof value === 'number' || typeof value === 'string') &&
    /^\d+(?:\.\d{1,2})?$/.test(String(value)) &&
    Number.isFinite(Number(value)) && Number(value) <= 99999999.99;

  if (!name || name.length > 255 || !isValidPrice(unitPrice) || !isValidPrice(sellingPrice)) {
    return res.status(400).json({ message: 'Provide a product name and valid non-negative prices (up to 2 decimal places)' });
  }

  try {
    const [existing] = await db.query('SELECT id, name, vendor_id, brand_id, unit FROM items WHERE id = ?', [itemId]);
    if (!existing.length) return res.status(404).json({ message: 'Product not found' });

    if (name.toLowerCase() !== existing[0].name.trim().toLowerCase()) {
      const [duplicates] = await db.query(
        `SELECT id FROM items
         WHERE id <> ? AND vendor_id = ? AND LOWER(TRIM(name)) = LOWER(?)
           AND brand_id <=> ? AND LOWER(TRIM(unit)) = LOWER(?) LIMIT 1`,
        [itemId, existing[0].vendor_id, name, existing[0].brand_id, existing[0].unit]
      );
      if (duplicates.length) {
        return res.status(409).json({ message: 'A product with this name, brand, and unit already exists for this vendor' });
      }
    }

    await db.query(
      'UPDATE items SET name = ?, unit_price = ?, selling_price = ? WHERE id = ?',
      [name, Number(unitPrice), Number(sellingPrice), itemId]
    );

    return res.status(200).json({
      message: 'Product updated successfully',
      product: { id: itemId, productName: name, unitPrice: Number(unitPrice), sellingPrice: Number(sellingPrice) }
    });
  } catch (error) {
    console.error('Error updating inventory product:', error);
    return res.status(500).json({ message: 'Unable to update product' });
  }
});

app.delete('/inventory/:id', verifyToken, async (req, res) => {
  const itemId = Number(req.params.id);
  if (!Number.isSafeInteger(itemId) || itemId <= 0) return res.status(400).json({ message: 'Invalid item ID' });
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [records] = await connection.query('SELECT id FROM items WHERE id = ? FOR UPDATE', [itemId]);
    if (!records.length) {
      await connection.rollback();
      return res.status(404).json({ message: 'Product not found' });
    }
    const [related] = await connection.query(
      `SELECT
        (SELECT COUNT(*) FROM sale_items WHERE item_id = ?) AS sales,
        (SELECT COUNT(*) FROM purchase_items WHERE item_id = ?) AS purchases,
        (SELECT COUNT(*) FROM return_items WHERE item_id = ?) AS returns_count`,
      [itemId, itemId, itemId]
    );
    if (Number(related[0].sales) || Number(related[0].purchases) || Number(related[0].returns_count)) {
      await connection.query('UPDATE items SET stock = 0 WHERE id = ?', [itemId]);
      await connection.query('DELETE FROM inventory WHERE item_id = ?', [itemId]);
      await connection.commit();
      return res.status(200).json({ message: 'Product removed from inventory. Its sales and purchase history has been kept.', archived: true });
    }
    await connection.query('DELETE FROM inventory WHERE item_id = ?', [itemId]);
    await connection.query('DELETE FROM items WHERE id = ?', [itemId]);
    await connection.commit();
    return res.status(200).json({ message: 'Product deleted successfully' });
  } catch (error) {
    await connection.rollback();
    return res.status(500).json({ message: error.sqlMessage || 'Unable to delete product' });
  } finally {
    connection.release();
  }
});

app.delete('/vendors/:id', verifyToken, async (req, res) => {
  const vendorId = Number(req.params.id);
  if (!Number.isSafeInteger(vendorId) || vendorId <= 0) return res.status(400).json({ message: 'Invalid vendor ID' });
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [vendors] = await connection.query('SELECT id, current_balance FROM vendors WHERE id = ? FOR UPDATE', [vendorId]);
    if (!vendors.length) {
      await connection.rollback();
      return res.status(404).json({ message: 'Vendor not found' });
    }
    const [related] = await connection.query(
      `SELECT
        (SELECT COUNT(*) FROM purchases WHERE vendor_id = ?) AS purchases,
        (SELECT COUNT(*) FROM payments WHERE vendor_id = ?) AS payments,
        (SELECT COUNT(*) FROM items WHERE vendor_id = ?) AS items`,
      [vendorId, vendorId, vendorId]
    );
    if (Number(related[0].purchases) || Number(related[0].payments) || Number(related[0].items) || Number(vendors[0].current_balance) !== 0) {
      await connection.rollback();
      return res.status(409).json({ message: 'Cannot delete a vendor with a balance, products, purchases, or payment history.' });
    }
    await connection.query('DELETE FROM vendor_company_names WHERE vendor_id = ?', [vendorId]);
    await connection.query('DELETE FROM vendors WHERE id = ?', [vendorId]);
    await connection.commit();
    return res.status(200).json({ message: 'Vendor deleted successfully' });
  } catch (error) {
    await connection.rollback();
    return res.status(500).json({ message: error.sqlMessage || 'Unable to delete vendor' });
  } finally {
    connection.release();
  }
});

app.delete('/customers/:id', verifyToken, async (req, res) => {
    const customerId = req.params.id;
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        await connection.query(`DELETE FROM customer_payments WHERE customer_id = ?`, [customerId]);
        await connection.query(`UPDATE sales SET customer_id = NULL WHERE customer_id = ?`, [customerId]);

        const [result] = await connection.query(`DELETE FROM customers WHERE id = ?`, [customerId]);

        if (result.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ message: "Customer not found." });
        }

        await connection.commit();
        res.status(200).json({ message: "Customer deleted successfully." });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ message: error.sqlMessage || error.message });
    } finally {
        connection.release();
    }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});