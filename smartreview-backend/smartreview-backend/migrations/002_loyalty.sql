-- ============================================================
--  SmartReview — Migration 002: Loyalty Points & Rewards
-- ============================================================

-- Add loyalty fields to customers
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS loyalty_points INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lifetime_points INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tier VARCHAR(20) NOT NULL DEFAULT 'bronze'
    CHECK (tier IN ('bronze','silver','gold','platinum'));

-- Points transaction ledger (every earn/redeem is logged)
CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  bill_id       UUID REFERENCES bills(id),
  type          VARCHAR(20) NOT NULL CHECK (type IN ('earn','redeem','bonus','expired','adjustment')),
  points        INT NOT NULL,              -- positive = earn/bonus, negative = redeem/expired
  reason        TEXT,
  balance_after INT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_txn_customer ON loyalty_transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_txn_restaurant ON loyalty_transactions(restaurant_id, created_at DESC);

-- Tier configuration per restaurant (customizable thresholds)
CREATE TABLE IF NOT EXISTS loyalty_tiers (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id    UUID NOT NULL REFERENCES restaurants(id),
  tier             VARCHAR(20) NOT NULL CHECK (tier IN ('bronze','silver','gold','platinum')),
  min_points       INT NOT NULL,
  perk_description TEXT,
  bonus_multiplier NUMERIC(3,2) NOT NULL DEFAULT 1.0,  -- e.g. gold earns 1.5x points
  UNIQUE (restaurant_id, tier)
);

-- Redeemable rewards catalogue
CREATE TABLE IF NOT EXISTS loyalty_rewards (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id),
  name          VARCHAR(120) NOT NULL,
  description   TEXT,
  points_cost   INT NOT NULL,
  reward_type   VARCHAR(20) NOT NULL DEFAULT 'discount_pct'
    CHECK (reward_type IN ('discount_pct','discount_flat','free_item','custom')),
  reward_value  NUMERIC(10,2),             -- pct or flat ₹ amount, depending on type
  menu_item_id  UUID REFERENCES menu_items(id),  -- for free_item rewards
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default tier setup function — call after restaurant registration
CREATE OR REPLACE FUNCTION seed_default_loyalty_tiers(p_restaurant_id UUID)
RETURNS VOID AS $$
BEGIN
  INSERT INTO loyalty_tiers (restaurant_id, tier, min_points, perk_description, bonus_multiplier)
  VALUES
    (p_restaurant_id, 'bronze',   0,    'Earn 1 point per ₹10 spent',                 1.0),
    (p_restaurant_id, 'silver',   500,  'Earn 1.25x points + birthday reward',        1.25),
    (p_restaurant_id, 'gold',     1500, 'Earn 1.5x points + priority table booking',  1.5),
    (p_restaurant_id, 'platinum', 4000, 'Earn 2x points + free dessert every visit',  2.0)
  ON CONFLICT (restaurant_id, tier) DO NOTHING;
END;
$$ LANGUAGE plpgsql;
