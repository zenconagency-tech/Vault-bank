-- =============================================================================
-- Vault Bank - Database Schema for New Features
-- =============================================================================
-- Execute this entire script in your Supabase SQL Editor at:
-- https://supabase.com/dashboard/project/lxpbtmtpeixeuxqlxhhz/sql/new
-- =============================================================================

-- =============================================================================
-- 1. EMAIL TOKENS TABLE (for registration verification)
-- =============================================================================
CREATE TABLE IF NOT EXISTS email_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'verification',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_tokens_token ON email_tokens(token);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user_id ON email_tokens(user_id);

-- =============================================================================
-- 2. ADD KYC_DATA COLUMN TO USERS TABLE
-- =============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_data JSONB;

-- =============================================================================
-- 3. PROCESS TRANSFER RPC FUNCTION (for internal + external transfers)
-- =============================================================================
CREATE OR REPLACE FUNCTION process_transfer(
  p_sender_email TEXT,
  p_receiver_email TEXT,
  p_amount NUMERIC,
  p_description TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_sender_id TEXT;
  v_sender_balance NUMERIC;
  v_receiver_id TEXT;
  v_receiver_balance NUMERIC;
  v_transaction_id TEXT;
BEGIN
  -- Validate amount
  IF p_amount <= 0 THEN
    RETURN json_build_object('success', false, 'error', 'Transfer amount must be greater than 0');
  END IF;

  -- Get sender user
  SELECT id, availablebalance, currentbalance
  INTO v_sender_id, v_sender_balance, v_sender_balance
  FROM users
  WHERE email = p_sender_email;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Sender not found');
  END IF;

  -- Check if sender has sufficient balance
  IF v_sender_balance < p_amount THEN
    RETURN json_build_object('success', false, 'error', 'Insufficient funds');
  END IF;

  -- Handle external transfer (p_receiver_email is NULL)
  -- Note: The server.js now handles external transfers inline with real externalDetails.
  -- This RPC path is retained for admin/code-reuse but server prefers inline handling.
  IF p_receiver_email IS NULL THEN
    UPDATE users
    SET availablebalance = availablebalance - p_amount,
        currentbalance = currentbalance - p_amount
    WHERE id = v_sender_id;

    INSERT INTO transactions (useremail, name, datetime, type, status, amount, category)
    VALUES (p_sender_email, p_description, NOW(), 'debit', 'successful', p_amount, 'External Transfer');

    RETURN json_build_object('success', true, 'message', 'External transfer successful');
  END IF;

  -- Handle internal transfer
  SELECT id, availablebalance, currentbalance
  INTO v_receiver_id, v_receiver_balance, v_receiver_balance
  FROM users
  WHERE email = p_receiver_email;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Receiver not found');
  END IF;

  IF v_sender_id = v_receiver_id THEN
    RETURN json_build_object('success', false, 'error', 'Cannot transfer to yourself');
  END IF;

  -- Atomic transfer
  BEGIN
    UPDATE users
    SET availablebalance = availablebalance - p_amount,
        currentbalance = currentbalance - p_amount
    WHERE id = v_sender_id;

    UPDATE users
    SET availablebalance = availablebalance + p_amount,
        currentbalance = currentbalance + p_amount
    WHERE id = v_receiver_id;

    INSERT INTO transactions (useremail, name, datetime, type, status, amount, category)
    VALUES (p_sender_email, p_description, NOW(), 'debit', 'successful', p_amount, 'Transfer');

    INSERT INTO transactions (useremail, name, datetime, type, status, amount, category)
    VALUES (p_receiver_email, p_description, NOW() + INTERVAL '1 second', 'credit', 'successful', p_amount, 'Transfer');

    RETURN json_build_object('success', true, 'message', 'Transfer successful');
  EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', 'Transfer failed: ' || SQLERRM);
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION process_transfer(TEXT, TEXT, NUMERIC, TEXT) TO authenticated;

-- =============================================================================
-- 3. INDEXES (add if missing)
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_transactions_useremail ON transactions(useremail);
CREATE INDEX IF NOT EXISTS idx_transactions_datetime ON transactions(datetime);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
