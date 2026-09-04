require('dotenv').config();
const express = require("express");
const cors = require("cors");
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const excelJS = require('exceljs');
const initTables = require('./schema');

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
    initTables(db);
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
      { expiresIn: '1h' }
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

app.post('/add-product', async (req, res) => {
  const { vendorName, vendorPhone, items } = req.body;

  const parsedVendorName = typeof vendorName === 'object' && vendorName !== null
    ? vendorName.contact_person || vendorName.company_name
    : vendorName;

  if (!parsedVendorName) return res.status(400).json({ message: 'Missing: vendorName' });
  if (!items || items.length === 0) return res.status(400).json({ message: 'Missing: items' });

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    let finalVendorId;

    const [existingVendor] = await connection.query(
      'SELECT vendor_id FROM vendor_company_names WHERE company_name = ?',
      [parsedVendorName]
    );

    if (existingVendor.length > 0) {
      finalVendorId = existingVendor[0].vendor_id;
    } else {
      const [newVendorResult] = await connection.query(
        'INSERT INTO vendors (current_balance, contact_person, phone) VALUES (0, ?, ?)',
        [parsedVendorName, vendorPhone || null]
      );
      finalVendorId = newVendorResult.insertId;

      await connection.query(
        'INSERT INTO vendor_company_names (vendor_id, company_name, is_primary) VALUES (?, ?, TRUE)',
        [finalVendorId, parsedVendorName]
      );
    }

    for (const item of items) {
      const { productName, brand, category, unit, quantity, unitPrice, sellingPrice, total } = item;

      await connection.query(
        'UPDATE vendors SET current_balance = current_balance + ? WHERE id = ?',
        [total, finalVendorId]
      );

      let actualBrandId = null;
      if (brand) {
        const [existingBrand] = await connection.query(
          'SELECT id FROM brands WHERE name = ?',
          [brand]
        );
        if (existingBrand.length > 0) {
          actualBrandId = existingBrand[0].id;
        } else {
          const [newBrandResult] = await connection.query(
            'INSERT INTO brands (name) VALUES (?)',
            [brand]
          );
          actualBrandId = newBrandResult.insertId;
        }
      }

      const [existingItem] = await connection.query(
        'SELECT id FROM items WHERE name = ? AND vendor_id = ?',
        [productName, finalVendorId]
      );

      let itemId;

      if (existingItem.length > 0) {
        itemId = existingItem[0].id;

        await connection.query(
          `UPDATE items 
           SET stock = stock + ?, unit_price = ?, selling_price = ?, total_price = total_price + ?, category = ?, unit = ?, brand_id = ?
           WHERE id = ?`,
          [quantity, unitPrice, sellingPrice, total, category, unit, actualBrandId, itemId]
        );

        await connection.query(
          'UPDATE inventory SET stock = stock + ? WHERE item_id = ?',
          [quantity, itemId]
        );

      } else {
        const [newItemResult] = await connection.query(
          `INSERT INTO items (vendor_id, brand_id, name, category, stock, unit, unit_price, selling_price, total_price) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [finalVendorId, actualBrandId, productName, category, quantity, unit, unitPrice, sellingPrice, total]
        );

        itemId = newItemResult.insertId;

        await connection.query(
          'INSERT INTO inventory (item_id, stock) VALUES (?, ?)',
          [itemId, quantity]
        );
      }

      const purchaseDescription = `Purchased ${quantity} ${unit} of ${productName}`;
      await connection.query(
        'INSERT INTO purchases (vendor_id, total_amount, description) VALUES (?, ?, ?)',
        [finalVendorId, total, purchaseDescription]
      );
    }

    await connection.commit();

    return res.status(200).json({ message: 'Data saved successfully!' });

  } catch (error) {
    await connection.rollback();
    console.error("ADD PRODUCT ERROR:", error);
    return res.status(500).json({ message: 'Internal Server Error' });
  } finally {
    connection.release();
  }
});

app.post('/checkout', async (req, res) => {
  const { cart, subtotal, discount, customerName, customerPhone, sendWhatsApp, paymentMethod, amountPaid } = req.body;

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

    // --- CREDIT UPDATE LOGIC ---
    if (customerPhone) {
      const balanceAddition = netTotal - paid; // This is the credit amount
      
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
          `INSERT INTO customer_payments (customer_id, amount, method) VALUES (?, ?, ?)`,
          [customerId, paid, paymentMethod || 'Cash']
        );
      }
    }

    const [saleResult] = await connection.query(
      `INSERT INTO sales (customer_id, total_amount, discount, payment_method, amount_paid, invoice_number) VALUES (?, ?, ?, ?, ?, ?)`,
      [customerId, subtotal, discount || 0, paymentMethod || 'Cash', paid, invoiceNumber]
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

app.get('/customers', async (req, res) => {
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

app.get('/customers/:id/history', async (req, res) => {
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

app.get('/customers/:id/history', async (req, res) => {
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

app.get('/vendors', async (req, res) => {
  try {
    const query = `
      SELECT 
        v.id, 
        v.contact_person, 
        vc.company_name 
      FROM vendors v
      LEFT JOIN vendor_company_names vc ON v.id = vc.vendor_id AND vc.is_primary = TRUE
      ORDER BY v.created_at DESC
    `;
    const [vendors] = await db.query(query);
    return res.status(200).json(vendors);

  } catch (error) {
    console.error('Database Error during /vendors fetch:', error);
    return res.status(500).json({ message: 'Failed to fetch vendors' });
  }
});

app.get('/inventory/:id/history', async (req, res) => {
  const itemId = req.params.id;

  try {
    const query = `
      SELECT 
        s.sale_date, 
        s.id AS receipt_no,
        si.meters_sold, 
        si.unit_price, 
        si.subtotal  -- Now pulling directly from the generated column
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

app.post('/add-vendors', async (req, res) => {
  const { vendorName, contact, balance } = req.body;

  try {
    const insertVendorQuery = `
    INSERT INTO vendors (contact_person, phone, current_balance) 
    VALUES (?,?,?)`

    await db.query(insertVendorQuery, [vendorName, contact, balance]);
    return res.status(200).json({ message: 'Vendor Entry Successful' });
  } catch (error) {
    console.log(`Couldn't add vendors: `, error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

app.get('/get-vendors', async (req, res) => {
  try {
    const getVendorQuery =
      `SELECT id, contact_person, phone, current_balance FROM vendors ORDER BY created_at ASC`

    const [record] = await db.query(getVendorQuery);
    return res.status(200).json(record);
  } catch (error) {
    console.log('Error occured while fetching vendors: ', error);
    return res.status(500).json({ message: 'Failed to fetch vendors' });
  }
});

app.get('/vendors/:vendorName/brands', async (req, res) => {
  const vendorName = req.params.vendorName;
  const connection = await db.getConnection();

  try {
    const [vendor] = await connection.query(
      'SELECT vendor_id FROM vendor_company_names WHERE company_name = ?',
      [vendorName]
    );

    if (vendor.length === 0) return res.status(200).json([]);

    const vendorId = vendor[0].vendor_id;

    const [brands] = await connection.query(
      `SELECT DISTINCT b.id, b.name 
             FROM brands b
             JOIN items i ON b.id = i.brand_id
             WHERE i.vendor_id = ?`,
      [vendorId]
    );

    return res.status(200).json(brands);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Internal Server Error' });
  } finally {
    connection.release();
  }
});

app.get('/vendors/:id/details', async (req, res) => {
  const vendorId = req.params.id;

  try {
    const [brandsData] = await db.query(
      `SELECT DISTINCT b.name 
             FROM brands b
             JOIN items i ON b.id = i.brand_id
             WHERE i.vendor_id = ?`,
      [vendorId]
    );

    const brands = brandsData.map(b => b.name);

    const [purchases] = await db.query(
      `SELECT name AS product_name, stock, unit, total_price 
             FROM items 
             WHERE vendor_id = ?`,
      [vendorId]
    );

    return res.status(200).json({ brands, purchases });

  } catch (error) {
    console.error("Failed to fetch vendor details:", error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

app.post('/add-payment', async (req, res) => {
  const { amount, method, vendor_id, description } = req.body;
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const insertPaymentQuery = `
    INSERT INTO payments (vendor_id, amount, method, description) 
    VALUES (?,?,?,?)`;
    await connection.query(insertPaymentQuery, [vendor_id, amount, method, description]);

    const updateBalanceQuery = `
    UPDATE vendors SET current_balance = current_balance - ? WHERE id = ?`;
    await connection.query(updateBalanceQuery, [amount, vendor_id]);

    await connection.commit();

    try {
      const [vendorRows] = await connection.query(`SELECT contact_person, phone FROM vendors WHERE id = ?`, [vendor_id]);
      
      if (vendorRows.length > 0 && vendorRows[0].phone) {
        const cleanPhone = vendorRows[0].phone.replace(/\D/g, '');
        const vendorName = vendorRows[0].contact_person || 'Vendor';
        const messageText = `Hello *${vendorName}*,\n\nWe have successfully processed a payment of *${Number(amount).toLocaleString()} PKR* via ${method}.\n\nThank you!`;

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
    return res.status(500).json({ message: 'Internal Server Error' });
  } finally {
    connection.release();
  }
});

app.get('/get-payments', async (req, res) => {
  try {
    const getPayments = `
      SELECT
        v.contact_person AS vendor_name,
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

app.get('/vendors/:id/ledger', async (req, res) => {
  const vendorId = req.params.id;

  try {
    const query = `
            SELECT 
                purchase_date AS transaction_date, 
                'Purchase Bill' AS type, 
                description, 
                0 AS debit_paid, 
                total_amount AS credit_owed
            FROM purchases 
            WHERE vendor_id = ? 
            
            UNION ALL
            
            SELECT 
                payment_date AS transaction_date, 
                CONCAT('Payment - ', method) AS type, 
                description, 
                amount AS debit_paid, 
                0 AS credit_owed
            FROM payments 
            WHERE vendor_id = ? 
            
            ORDER BY transaction_date ASC;
        `;

    const [ledgerData] = await db.query(query, [vendorId, vendorId]);

    return res.status(200).json({
      success: true,
      data: ledgerData
    });

  } catch (error) {
    console.error("Failed to fetch ledger details:", error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const fetchUsersSql = 'SELECT id, username, password FROM users';
    const [users] = await db.query(fetchUsersSql);
    
    return res.status(200).json(users);
  } catch (error) {
    console.error('Fetch users error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

app.delete('/api/users/:id', async (req, res) => {
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

app.get('/api/dashboard/summary', async (req, res) => {
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
          COALESCE((SELECT company_name FROM vendor_company_names WHERE vendor_id = p.vendor_id LIMIT 1), 'Vendor') as vendor_name
        FROM payments p
        ORDER BY p.payment_date DESC 
        LIMIT 5
      `),
      db.query(`
        SELECT 
          b.bank_name, 
          b.account_title,
          COALESCE((SELECT SUM(amount_paid) FROM sales WHERE bank_account_id = b.id), 0) +
          COALESCE((SELECT SUM(amount) FROM customer_payments WHERE bank_account_id = b.id), 0) AS balance
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

app.get('/api/dashboard/pnl', async (req, res) => {
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

app.post('/add-customer-payment', async (req, res) => {
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

app.post('/api/settings/brand', async (req, res) => {
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

app.get('/api/backup', async (req, res) => {
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
                LEFT JOIN vendor_company_names vcn ON v.id = vcn.vendor_id AND vcn.is_primary = TRUE
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
                LEFT JOIN vendor_company_names vcn ON v.id = vcn.vendor_id AND vcn.is_primary = TRUE
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
                LEFT JOIN vendor_company_names vcn ON v.id = vcn.vendor_id AND vcn.is_primary = TRUE
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
                LEFT JOIN vendor_company_names vcn ON v.id = vcn.vendor_id AND vcn.is_primary = TRUE
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

app.get('/invoices', async (req, res) => {
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

app.get('/invoices/:id/items', async (req, res) => {
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

app.post('/return', async (req, res) => {
  const { saleId, customerId, returnItems, totalRefund } = req.body;
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
        await connection.query(
          `INSERT INTO return_items (return_id, item_id, quantity, refund_amount) VALUES (?, ?, ?, ?)`,
          [returnId, item.itemId, item.quantity, item.refundAmount]
        );

        await connection.query(
          `UPDATE items SET stock = stock + ? WHERE id = ?`,
          [item.quantity, item.itemId]
        );

        await connection.query(
          `UPDATE inventory SET stock = stock + ? WHERE item_id = ?`,
          [item.quantity, item.itemId]
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

app.get('/inventory', async (req, res) => {
  try {
    const query = `
      SELECT 
        i.id, 
        i.name AS productName, 
        vc.company_name AS vendorName,
        b.name AS brandName, 
        i.category, 
        i.stock, 
        i.unit,
        i.unit_price AS unitPrice,
        i.selling_price AS sellingPrice
      FROM items i
      LEFT JOIN vendor_company_names vc ON i.vendor_id = vc.vendor_id AND vc.is_primary = TRUE
      LEFT JOIN brands b ON i.brand_id = b.id
      ORDER BY i.created_at DESC
    `;

    const [inventoryList] = await db.query(query);
    return res.status(200).json(inventoryList);

  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Failed to fetch inventory data' });
  }
});

app.get('/bank-accounts', async (req, res) => {
    try {
        const [accounts] = await db.query(
            'SELECT id, bank_name, account_title, account_number, qr_code, is_active FROM business_bank_accounts ORDER BY created_at DESC'
        );
        res.status(200).json(accounts);
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch bank accounts' });
    }
});

app.post('/bank-accounts', async (req, res) => {
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

app.patch('/bank-accounts/:id/toggle', async (req, res) => {
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

app.get('/api/bank-accounts/active', async (req, res) => {
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

app.post('/add-single-product', async (req, res) => {
    try {
        const { items } = req.body;
        
        const [vendors] = await db.query(`SELECT id FROM vendors LIMIT 1`);
        if (vendors.length === 0) {
            return res.status(400).json({ message: 'A vendor must exist in the database to add a product.' });
        }
        const defaultVendorId = vendors[0].id;

        for (const item of items) {
            let brandId = null;
            if (item.brand) {
                const [existingBrand] = await db.query(`SELECT id FROM brands WHERE name = ?`, [item.brand]);
                if (existingBrand.length > 0) {
                    brandId = existingBrand[0].id;
                } else {
                    const [newBrand] = await db.query(`INSERT INTO brands (name) VALUES (?)`, [item.brand]);
                    brandId = newBrand.insertId;
                }
            }

            const [newItem] = await db.query(
                `INSERT INTO items (vendor_id, brand_id, name, category, stock, unit, unit_price, selling_price, total_price) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    defaultVendorId,
                    brandId,
                    item.productName,
                    item.category,
                    item.quantity,
                    item.unit,
                    item.unitPrice,
                    item.sellingPrice,
                    item.total
                ]
            );

            await db.query(
                `INSERT INTO inventory (item_id, stock) VALUES (?, ?)`,
                [newItem.insertId, item.quantity]
            );
        }

        res.status(200).json({ message: 'Products added successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});