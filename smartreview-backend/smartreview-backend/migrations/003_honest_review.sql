-- ============================================================
--  SmartReview — Migration 003: Honest Review Mode
--  Run: psql $DATABASE_URL -f migrations/003_honest_review.sql
-- ============================================================

-- Add honest_review_mode toggle to restaurants
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS honest_review_mode BOOLEAN NOT NULL DEFAULT FALSE;

-- Add next-visit coupon fields to feedback table
ALTER TABLE feedback
  ADD COLUMN IF NOT EXISTS coupon_code       VARCHAR(20)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS coupon_redeemed   BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS coupon_redeemed_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS resolved          BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS resolved_at       TIMESTAMPTZ  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS resolved_by       UUID         DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS resolution_note   TEXT         DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS wa_resolution_sent BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS wa_resolution_sent_at TIMESTAMPTZ DEFAULT NULL;

-- Complaint resolutions log
-- Every time owner clicks "Mark Resolved" it logs here
CREATE TABLE IF NOT EXISTS complaint_resolutions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  feedback_id     UUID NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id),
  resolved_by     UUID REFERENCES restaurants(id),  -- owner user id
  resolution_note TEXT,                              -- what was fixed
  coupon_code     VARCHAR(20),                       -- generated coupon
  coupon_pct      SMALLINT NOT NULL DEFAULT 3,       -- always 3%
  wa_sent         BOOLEAN NOT NULL DEFAULT FALSE,
  wa_sent_at      TIMESTAMPTZ,
  customer_returned BOOLEAN NOT NULL DEFAULT FALSE,
  customer_new_rating SMALLINT,                      -- rating after returning
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resolutions_feedback    ON complaint_resolutions(feedback_id);
CREATE INDEX IF NOT EXISTS idx_resolutions_restaurant  ON complaint_resolutions(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_resolutions_wa_pending  ON complaint_resolutions(restaurant_id, wa_sent) WHERE wa_sent = FALSE;

-- Function to generate unique coupon code
CREATE OR REPLACE FUNCTION generate_coupon_code(p_restaurant_id UUID, p_feedback_id UUID)
RETURNS VARCHAR AS $$
DECLARE
  v_code VARCHAR(20);
BEGIN
  -- Format: CB-XXXXXX (CB = ComeBack, 6 random alphanumeric chars)
  v_code := 'CB-' || UPPER(SUBSTRING(MD5(p_restaurant_id::text || p_feedback_id::text || NOW()::text), 1, 6));
  RETURN v_code;
END;
$$ LANGUAGE plpgsql;
