const initTables = (db) => {
  const query = `
    CREATE DATABASE alifabrics_pos;
USE alifabrics_pos;

-- 1. Users
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50),
    password VARCHAR(256)
);

-- 2. Vendors (Suppliers)
CREATE TABLE vendors (
    id INT AUTO_INCREMENT PRIMARY KEY,
    contact_person VARCHAR(100),
    phone VARCHAR(20),
    current_balance INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE vendor_company_names (
    id INT AUTO_INCREMENT PRIMARY KEY,
    vendor_id INT NOT NULL,
    company_name VARCHAR(150) NOT NULL,
    is_primary BOOLEAN DEFAULT FALSE, 
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
);

CREATE TABLE payments(
    id INT AUTO_INCREMENT PRIMARY KEY,
    vendor_id INT NOT NULL,
    amount INT NOT NULL,
    method VARCHAR(50) NOT NULL,
    description VARCHAR(250),
    payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (vendor_id) REFERENCES vendors(id)
);

CREATE TABLE purchases (
    id INT AUTO_INCREMENT PRIMARY KEY,
    vendor_id INT NOT NULL,
    total_amount INT NOT NULL,
    description VARCHAR(250),
    purchase_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE RESTRICT
);

-- 3. Brands
CREATE TABLE brands (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    description VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Customers
CREATE TABLE customers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(20) NOT NULL UNIQUE,
    total_spent INT DEFAULT 0,
    total_orders INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. Items (Inventory Master List)
CREATE TABLE items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    vendor_id INT NOT NULL,
    brand_id INT,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(50),
    stock DECIMAL(10, 2) DEFAULT 0.00,
    unit VARCHAR(50) NOT NULL,
    unit_price DECIMAL(10, 2) DEFAULT 0.00 NOT NULL,
    selling_price DECIMAL(10, 2) DEFAULT 0.00 NOT NULL,
    total_price DECIMAL(10, 2) DEFAULT 0.00 NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE RESTRICT,
    FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL
);	

-- 6. Inventory (Stock Tracking)
CREATE TABLE inventory (
    id INT AUTO_INCREMENT PRIMARY KEY,
    item_id INT NOT NULL,
    stock DECIMAL(10, 2) DEFAULT 0.00,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

-- 7. Sales (Main POS Page)
CREATE TABLE sales (
    id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT DEFAULT NULL,
    total_amount INT NOT NULL,
    discount INT DEFAULT 0,
    net_total INT GENERATED ALWAYS AS (total_amount - discount) STORED,
    sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
);

-- 8. Sale Items (Line items for each sale)
CREATE TABLE sale_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sale_id INT NOT NULL,
    item_id INT NOT NULL,
    meters_sold DECIMAL(10, 2) NOT NULL,      
    unit_price INT NOT NULL,
    subtotal INT GENERATED ALWAYS AS (ROUND(meters_sold * unit_price)) STORED,
    
    FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
    FOREIGN KEY (item_id) REFERENCES items(id)
);

CREATE TABLE customer_payments (
	id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL,
    amount INT NOT NULL,
    method VARCHAR(50) NOT NULL,
    payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE brand_info (
    id INT AUTO_INCREMENT PRIMARY KEY,
    store_name VARCHAR(100) NOT NULL,
    address VARCHAR(255),
    phone VARCHAR(20)
);

INSERT INTO brand_info (store_name, address, phone) 
VALUES ('Ali Fabrics', '', '');

ALTER TABLE sale_items ADD COLUMN cost_price DECIMAL(10, 2) NOT NULL DEFAULT 0.00;
ALTER TABLE customers ADD COLUMN balance_due DECIMAL(10, 2) NOT NULL DEFAULT 0.00;
ALTER TABLE sales ADD COLUMN payment_method VARCHAR(50) DEFAULT 'Cash';
ALTER TABLE sales ADD COLUMN amount_paid DECIMAL(10, 2) NOT NULL DEFAULT 0.00;
ALTER TABLE sales ADD COLUMN invoice_number VARCHAR(50) UNIQUE;

CREATE TABLE returns (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sale_id INT NOT NULL,
    total_refund INT NOT NULL,
    return_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sale_id) REFERENCES sales(id)
);

CREATE TABLE return_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    return_id INT NOT NULL,
    item_id INT NOT NULL,
    quantity DECIMAL(10, 2) NOT NULL,
    refund_amount INT NOT NULL,
    FOREIGN KEY (return_id) REFERENCES returns(id),
    FOREIGN KEY (item_id) REFERENCES items(id)
);

CREATE TABLE purchase_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    purchase_id INT NOT NULL,
    item_id INT NOT NULL,
    quantity DECIMAL(10, 2) NOT NULL,
    unit_cost DECIMAL(10, 2) NOT NULL, 
    subtotal DECIMAL(10, 2) GENERATED ALWAYS AS (quantity * unit_cost) STORED,
    
    FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE,
    FOREIGN KEY (item_id) REFERENCES items(id)
);

ALTER TABLE purchases 
ADD COLUMN vendor_invoice_number VARCHAR(100);

CREATE TABLE business_bank_accounts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    bank_name VARCHAR(100) NOT NULL,
    account_title VARCHAR(150) NOT NULL,
    account_number VARCHAR(100) NOT NULL,
    qr_code LONGTEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE sales ADD COLUMN bank_account_id INT DEFAULT NULL;
ALTER TABLE customer_payments ADD COLUMN bank_account_id INT DEFAULT NULL;

-- Optional but recommended: Link them properly
ALTER TABLE sales ADD CONSTRAINT fk_sales_bank FOREIGN KEY (bank_account_id) REFERENCES business_bank_accounts(id) ON DELETE SET NULL;
ALTER TABLE customer_payments ADD CONSTRAINT fk_payments_bank FOREIGN KEY (bank_account_id) REFERENCES business_bank_accounts(id) ON DELETE SET NULL;
  `;

  db.query(query, (err) => {
    if (err) {
      console.error("Error creating database tables:", err);
    } else {
      console.log("All database tables verified and ready.");
    }
  });
};

module.exports = initTables;