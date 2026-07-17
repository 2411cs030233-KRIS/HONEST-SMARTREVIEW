-- ============================================================
--  SmartReview — Complete PostgreSQL Database Schema
--  Version: 1.0.0  |  Engine: PostgreSQL 15+
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";     -- for fast text search

-- ============================================================
-- 1. RESTAURANTS & OWNERS
-- ============================================================

CREATE TABLE restaurants (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(120) NOT NULL,
  slug          VARCHAR(120) UNIQUE NOT NULL,          -- "spice-garden-hyd"
  owner_name    VARCHAR(100) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  phone         VARCHAR(20)  NOT NULL,
  whatsapp_no   VARCHAR(20),
  password_hash VARCHAR(255) NOT NULL,
  gstin         VARCHAR(20),
  address       TEXT,
  city          VARCHAR(80),
  state         VARCHAR(80),
  pincode       VARCHAR(10),
  logo_url      TEXT,
  cuisine_type  VARCHAR(80),
  plan          VARCHAR(20) NOT NULL DEFAULT 'basic'   -- basic | premium | pro
                CHECK (plan IN ('basic','premium','pro')),
  plan_expires_at TIMESTAMPTZ,
  razorpay_key_id      VARCHAR(100),
  razorpay_key_secret  VARCHAR(100),
  whatsapp_token       TEXT,
  google_place_id      VARCHAR(120),
  google_review_url    TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_restaurants_email ON restaurants(email);
CREATE INDEX idx_restaurants_slug  ON restaurants(slug);

-- ============================================================
-- 2. BRANCHES
-- ============================================================

CREATE TABLE branches (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id  UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name           VARCHAR(120) NOT NULL,
  address        TEXT,
  city           VARCHAR(80),
  phone          VARCHAR(20),
  manager_name   VARCHAR(100),
  manager_phone  VARCHAR(20),
  table_count    INT NOT NULL DEFAULT 10,
  is_open        BOOLEAN NOT NULL DEFAULT TRUE,
  timezone       VARCHAR(60) NOT NULL DEFAULT 'Asia/Kolkata',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_branches_restaurant ON branches(restaurant_id);

-- ============================================================
-- 3. MENU CATEGORIES & ITEMS
-- ============================================================

CREATE TABLE menu_categories (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          VARCHAR(80) NOT NULL,
  emoji         VARCHAR(8),
  display_order INT NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE menu_items (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id   UUID REFERENCES menu_categories(id) ON DELETE SET NULL,
  name          VARCHAR(120) NOT NULL,
  description   TEXT,
  price         NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  emoji         VARCHAR(8),
  image_url     TEXT,
  is_veg        BOOLEAN NOT NULL DEFAULT TRUE,
  is_available  BOOLEAN NOT NULL DEFAULT TRUE,
  is_featured   BOOLEAN NOT NULL DEFAULT FALSE,
  prep_time_min INT,                     -- estimated preparation time in minutes
  allergens     TEXT[],                  -- ['gluten','dairy',...]
  calories      INT,
  display_order INT NOT NULL DEFAULT 0,
  total_orders  INT NOT NULL DEFAULT 0,  -- denormalized counter
  total_revenue NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_menu_items_restaurant ON menu_items(restaurant_id);
CREATE INDEX idx_menu_items_category   ON menu_items(category_id);
CREATE INDEX idx_menu_items_search     ON menu_items USING GIN(to_tsvector('english', name));

-- ============================================================
-- 4. TABLES
-- ============================================================

CREATE TABLE restaurant_tables (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  branch_id     UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  table_number  INT  NOT NULL,
  capacity      INT  NOT NULL DEFAULT 4,
  status        VARCHAR(20) NOT NULL DEFAULT 'free'
                CHECK (status IN ('free','occupied','billing','dirty','reserved')),
  current_bill_id UUID,             -- FK added later (circular dep)
  occupied_since  TIMESTAMPTZ,
  qr_code_url     TEXT,
  section         VARCHAR(50),      -- 'indoor','outdoor','rooftop'
  UNIQUE (branch_id, table_number)
);

CREATE INDEX idx_tables_branch  ON restaurant_tables(branch_id);
CREATE INDEX idx_tables_status  ON restaurant_tables(status);

-- ============================================================
-- 5. CUSTOMERS
-- ============================================================

CREATE TABLE customers (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  phone         VARCHAR(20) NOT NULL,
  name          VARCHAR(100),
  whatsapp_opt_in BOOLEAN NOT NULL DEFAULT TRUE,
  visit_count   INT NOT NULL DEFAULT 0,
  total_spent   NUMERIC(12,2) NOT NULL DEFAULT 0,
  avg_rating    NUMERIC(3,2),
  last_visit_at TIMESTAMPTZ,
  tags          TEXT[],            -- ['vip','vegetarian','regular']
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (restaurant_id, phone)
);

CREATE INDEX idx_customers_restaurant ON customers(restaurant_id);
CREATE INDEX idx_customers_phone      ON customers(restaurant_id, phone);

-- ============================================================
-- 6. BILLS
-- ============================================================

CREATE TABLE bills (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bill_number     VARCHAR(20) NOT NULL,               -- "B1001"
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id),
  branch_id       UUID NOT NULL REFERENCES branches(id),
  table_id        UUID REFERENCES restaurant_tables(id),
  customer_id     UUID REFERENCES customers(id),
  customer_phone  VARCHAR(20),
  items           JSONB NOT NULL DEFAULT '[]',         -- snapshot at billing time
  subtotal        NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount_pct    NUMERIC(5,2)  NOT NULL DEFAULT 0,
  discount_amt    NUMERIC(10,2) NOT NULL DEFAULT 0,
  gst_pct         NUMERIC(5,2)  NOT NULL DEFAULT 5,
  gst_amt         NUMERIC(10,2) NOT NULL DEFAULT 0,
  total           NUMERIC(10,2) NOT NULL DEFAULT 0,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','paid','refunded','cancelled')),
  qr_url          TEXT,
  feedback_url    TEXT,
  whatsapp_sent   BOOLEAN NOT NULL DEFAULT FALSE,
  created_by      UUID REFERENCES restaurants(id),    -- staff member
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at         TIMESTAMPTZ,
  notes           TEXT
);

-- Sequence for bill numbers per restaurant
CREATE SEQUENCE bill_number_seq START 1001;

CREATE INDEX idx_bills_restaurant   ON bills(restaurant_id);
CREATE INDEX idx_bills_branch       ON bills(branch_id);
CREATE INDEX idx_bills_created_at   ON bills(created_at DESC);
CREATE INDEX idx_bills_status       ON bills(status);
CREATE INDEX idx_bills_customer     ON bills(customer_id);

-- Bill items (line items snapshot + live reference)
CREATE TABLE bill_items (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bill_id     UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  menu_item_id UUID REFERENCES menu_items(id),
  name        VARCHAR(120) NOT NULL,
  price       NUMERIC(10,2) NOT NULL,
  quantity    INT NOT NULL DEFAULT 1,
  subtotal    NUMERIC(10,2) NOT NULL,
  notes       TEXT
);

CREATE INDEX idx_bill_items_bill ON bill_items(bill_id);

-- Add circular FK after both tables exist
ALTER TABLE restaurant_tables
  ADD CONSTRAINT fk_tables_current_bill
  FOREIGN KEY (current_bill_id) REFERENCES bills(id) ON DELETE SET NULL;

-- ============================================================
-- 7. PAYMENTS
-- ============================================================

CREATE TABLE payments (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bill_id              UUID NOT NULL REFERENCES bills(id),
  restaurant_id        UUID NOT NULL REFERENCES restaurants(id),
  razorpay_order_id    VARCHAR(100),
  razorpay_payment_id  VARCHAR(100) UNIQUE,
  razorpay_signature   VARCHAR(255),
  amount               NUMERIC(10,2) NOT NULL,
  currency             VARCHAR(10) NOT NULL DEFAULT 'INR',
  method               VARCHAR(30)
                       CHECK (method IN ('upi','card','netbanking','wallet','cash','other')),
  upi_id               VARCHAR(100),
  bank_name            VARCHAR(80),
  wallet_name          VARCHAR(80),
  status               VARCHAR(20) NOT NULL DEFAULT 'created'
                       CHECK (status IN ('created','authorized','captured','refunded','failed')),
  failure_reason       TEXT,
  receipt_url          TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  captured_at          TIMESTAMPTZ
);

CREATE INDEX idx_payments_bill          ON payments(bill_id);
CREATE INDEX idx_payments_razorpay_pid  ON payments(razorpay_payment_id);
CREATE INDEX idx_payments_status        ON payments(status);
CREATE INDEX idx_payments_created       ON payments(created_at DESC);

-- ============================================================
-- 8. FEEDBACK & RATINGS
-- ============================================================

CREATE TABLE feedback (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bill_id          UUID NOT NULL REFERENCES bills(id),
  restaurant_id    UUID NOT NULL REFERENCES restaurants(id),
  branch_id        UUID NOT NULL REFERENCES branches(id),
  customer_id      UUID REFERENCES customers(id),
  rating           SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  google_review_done BOOLEAN NOT NULL DEFAULT FALSE,
  google_review_at   TIMESTAMPTZ,
  discount_unlocked  BOOLEAN NOT NULL DEFAULT FALSE,
  discount_pct       NUMERIC(5,2) NOT NULL DEFAULT 0,
  complaints       TEXT[],          -- ['waiting_time','food_quality',...]
  comment          TEXT,
  table_number     INT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_feedback_restaurant  ON feedback(restaurant_id);
CREATE INDEX idx_feedback_branch      ON feedback(branch_id);
CREATE INDEX idx_feedback_rating      ON feedback(rating);
CREATE INDEX idx_feedback_created     ON feedback(created_at DESC);

-- ============================================================
-- 9. STAFF
-- ============================================================

CREATE TABLE staff (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id  UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id      UUID REFERENCES branches(id),
  name           VARCHAR(100) NOT NULL,
  phone          VARCHAR(20)  NOT NULL,
  role           VARCHAR(30)  NOT NULL DEFAULT 'waiter'
                 CHECK (role IN ('manager','waiter','cashier','chef','captain')),
  pin            VARCHAR(6),                -- 4-6 digit login PIN
  password_hash  VARCHAR(255),
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  shift          VARCHAR(20) CHECK (shift IN ('morning','afternoon','evening','night')),
  salary         NUMERIC(10,2),
  joined_at      DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (restaurant_id, phone)
);

CREATE INDEX idx_staff_restaurant ON staff(restaurant_id);
CREATE INDEX idx_staff_branch     ON staff(branch_id);

CREATE TABLE table_assignments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id    UUID NOT NULL REFERENCES staff(id),
  table_id    UUID NOT NULL REFERENCES restaurant_tables(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at TIMESTAMPTZ,
  shift_date  DATE NOT NULL DEFAULT CURRENT_DATE
);

-- ============================================================
-- 10. INVENTORY
-- ============================================================

CREATE TABLE inventory_items (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id  UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id      UUID REFERENCES branches(id),
  name           VARCHAR(120) NOT NULL,
  category       VARCHAR(60),         -- 'raw_material','beverage','packaging'
  unit           VARCHAR(20) NOT NULL,-- 'kg','litre','pcs','grams'
  current_stock  NUMERIC(10,3) NOT NULL DEFAULT 0,
  min_stock      NUMERIC(10,3) NOT NULL DEFAULT 0,  -- low stock threshold
  max_stock      NUMERIC(10,3),
  cost_per_unit  NUMERIC(10,2),
  supplier_name  VARCHAR(120),
  supplier_phone VARCHAR(20),
  last_restocked TIMESTAMPTZ,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE inventory_transactions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  inventory_item_id UUID NOT NULL REFERENCES inventory_items(id),
  type             VARCHAR(20) NOT NULL CHECK (type IN ('restock','usage','waste','adjustment')),
  quantity         NUMERIC(10,3) NOT NULL,      -- positive = in, negative = out
  notes            TEXT,
  created_by       UUID REFERENCES staff(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inv_items_restaurant ON inventory_items(restaurant_id);
CREATE INDEX idx_inv_txn_item         ON inventory_transactions(inventory_item_id);

-- ============================================================
-- 11. WHATSAPP CAMPAIGNS
-- ============================================================

CREATE TABLE whatsapp_campaigns (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id  UUID NOT NULL REFERENCES restaurants(id),
  name           VARCHAR(120) NOT NULL,
  segment        VARCHAR(50),          -- 'all','recent','inactive','5star'
  template       TEXT NOT NULL,
  offer_text     VARCHAR(200),
  sent_count     INT NOT NULL DEFAULT 0,
  delivered_count INT NOT NULL DEFAULT 0,
  click_count    INT NOT NULL DEFAULT 0,
  status         VARCHAR(20) NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','scheduled','sent','failed')),
  scheduled_at   TIMESTAMPTZ,
  sent_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE whatsapp_messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id     UUID REFERENCES whatsapp_campaigns(id),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id),
  customer_id     UUID REFERENCES customers(id),
  phone           VARCHAR(20) NOT NULL,
  message         TEXT NOT NULL,
  type            VARCHAR(30) NOT NULL DEFAULT 'campaign'
                  CHECK (type IN ('bill','campaign','receipt','otp','report')),
  status          VARCHAR(20) NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','sent','delivered','failed','read')),
  twilio_sid      VARCHAR(100),
  error_message   TEXT,
  sent_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 12. AUTOMATED REPORTS
-- ============================================================

CREATE TABLE report_schedules (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id  UUID NOT NULL REFERENCES restaurants(id),
  type           VARCHAR(20) NOT NULL CHECK (type IN ('daily','weekly','monthly')),
  delivery       VARCHAR(20) NOT NULL DEFAULT 'whatsapp'
                 CHECK (delivery IN ('whatsapp','email','both')),
  recipients     TEXT[],              -- phone numbers / emails
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  last_sent_at   TIMESTAMPTZ,
  next_send_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 13. ANALYTICS SNAPSHOTS (pre-aggregated for speed)
-- ============================================================

CREATE TABLE analytics_daily (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id),
  branch_id       UUID REFERENCES branches(id),
  date            DATE NOT NULL,
  total_revenue   NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_bills     INT NOT NULL DEFAULT 0,
  avg_bill_value  NUMERIC(10,2),
  avg_rating      NUMERIC(3,2),
  positive_reviews INT NOT NULL DEFAULT 0,
  negative_reviews INT NOT NULL DEFAULT 0,
  google_reviews   INT NOT NULL DEFAULT 0,
  complaints_waiting_time INT DEFAULT 0,
  complaints_food_quality INT DEFAULT 0,
  complaints_service      INT DEFAULT 0,
  complaints_cleanliness  INT DEFAULT 0,
  upi_revenue     NUMERIC(12,2) DEFAULT 0,
  card_revenue    NUMERIC(12,2) DEFAULT 0,
  cash_revenue    NUMERIC(12,2) DEFAULT 0,
  wa_messages_sent INT DEFAULT 0,
  discounts_given  INT DEFAULT 0,
  discount_amount  NUMERIC(12,2) DEFAULT 0,
  UNIQUE (restaurant_id, branch_id, date)
);

CREATE TABLE analytics_hourly (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id),
  branch_id     UUID REFERENCES branches(id),
  date          DATE NOT NULL,
  hour          SMALLINT NOT NULL CHECK (hour BETWEEN 0 AND 23),
  total_bills   INT NOT NULL DEFAULT 0,
  total_revenue NUMERIC(12,2) NOT NULL DEFAULT 0,
  avg_rating    NUMERIC(3,2),
  complaints    INT NOT NULL DEFAULT 0,
  UNIQUE (restaurant_id, branch_id, date, hour)
);

CREATE INDEX idx_analytics_daily_restaurant ON analytics_daily(restaurant_id, date DESC);
CREATE INDEX idx_analytics_hourly_restaurant ON analytics_hourly(restaurant_id, date DESC, hour);

-- ============================================================
-- 14. TRIGGERS — auto-update timestamps
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_restaurants_updated BEFORE UPDATE ON restaurants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_menu_items_updated BEFORE UPDATE ON menu_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_inventory_updated BEFORE UPDATE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 15. VIEWS — commonly used queries
-- ============================================================

CREATE VIEW v_bill_summary AS
SELECT
  b.id, b.bill_number, b.restaurant_id, b.branch_id,
  b.total, b.status, b.created_at, b.paid_at,
  p.method AS payment_method, p.razorpay_payment_id,
  f.rating, f.google_review_done, f.discount_pct,
  c.phone AS customer_phone, c.name AS customer_name,
  rt.table_number
FROM bills b
LEFT JOIN payments      p  ON p.bill_id  = b.id AND p.status = 'captured'
LEFT JOIN feedback      f  ON f.bill_id  = b.id
LEFT JOIN customers     c  ON c.id       = b.customer_id
LEFT JOIN restaurant_tables rt ON rt.id  = b.table_id;

CREATE VIEW v_daily_revenue AS
SELECT
  DATE(b.created_at AT TIME ZONE 'Asia/Kolkata') AS date,
  b.restaurant_id,
  b.branch_id,
  COUNT(*)                          AS bill_count,
  SUM(b.total)                      AS revenue,
  ROUND(AVG(b.total)::NUMERIC, 2)   AS avg_bill,
  ROUND(AVG(f.rating)::NUMERIC, 2)  AS avg_rating
FROM bills b
LEFT JOIN feedback f ON f.bill_id = b.id
WHERE b.status = 'paid'
GROUP BY 1,2,3;

CREATE VIEW v_top_menu_items AS
SELECT
  mi.id, mi.restaurant_id, mi.name, mi.emoji,
  mi.total_orders, mi.total_revenue,
  mc.name AS category,
  RANK() OVER (PARTITION BY mi.restaurant_id ORDER BY mi.total_orders DESC) AS rank
FROM menu_items mi
LEFT JOIN menu_categories mc ON mc.id = mi.category_id;
