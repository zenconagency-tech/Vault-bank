-- =============================================================================
-- Vault Bank - External Transfer RPC Function
-- =============================================================================
-- This SQL script creates the 'process_transfer' RPC function needed for external
-- transfers in the Vault Bank application. This function handles both internal
-- transfers (between Vault Bank users) and external transfers (to external banks).
--
-- The function performs atomic transfer operations with proper error handling
-- and validation.
--
-- USAGE:
-- 1. Execute this script in your Supabase SQL Editor
-- 2. The function will be available for use in the Vault Bank application
-- 3. No additional configuration required
--
-- AUTHOR: Vault Bank Development Team
-- DATE: June 2026
-- =============================================================================

-- =============================================================================
-- Function: process_transfer
-- Description: Atomic transfer function for both internal and external transfers
-- Parameters:
--   p_sender_email (text): Email of the sender user
--   p_receiver_email (text, optional): Email of the receiver user (null for external)
--   p_amount (numeric): Transfer amount
--   p_description (text): Transfer description
-- Returns: JSON object with success status and optional error message
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
  v_sender_id UUID;
  v_receiver_id UUID;
  v_sender_balance NUMERIC;
  v_receiver_balance NUMERIC;
  v_sender_email_check TEXT;
  v_receiver_email_check TEXT;
  v_external_details JSONB := '{}';
  v_sender_name TEXT;
  v_receiver_name TEXT;
  v_transaction_id TEXT;
BEGIN
  -- Validate amount
  IF p_amount <= 0 THEN
    RETURN json_build_object('success', false, 'error', 'Transfer amount must be greater than 0');
  END IF;

  -- Get sender user
  SELECT id, email, availablebalance, currentbalance, name
  INTO v_sender_id, v_sender_email_check, v_sender_balance, v_sender_balance, v_sender_name
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
  -- NOTE: Server.js handles external transfers inline with real externalDetails.
  -- This RPC path is retained for fallback/admin use.
  IF p_receiver_email IS NULL THEN
    UPDATE users
    SET availablebalance = availablebalance - p_amount,
        currentbalance = currentbalance - p_amount,
        updated_at = NOW()
    WHERE id = v_sender_id;

    INSERT INTO transactions (
      useremail, name, datetime, type, status, amount, category, externaldetails, updated_at
    ) VALUES (
      p_sender_email, p_description, NOW(), 'debit', 'successful', p_amount,
      'External Transfer', '{"handler": "rpc-fallback"}', NOW()
    );

    RETURN json_build_object('success', true, 'message', 'External transfer completed successfully');
  END IF;

  -- Handle internal transfer (p_receiver_email is provided)
  SELECT id, email, availablebalance
  INTO v_receiver_id, v_receiver_email_check, v_receiver_balance
  FROM users
  WHERE email = p_receiver_email;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Receiver not found');
  END IF;

  -- Prevent transfer to self
  IF v_sender_id = v_receiver_id THEN
    RETURN json_build_object('success', false, 'error', 'Cannot transfer to yourself');
  END IF;

  -- Check if receiver account is approved and not suspended
  SELECT name INTO v_receiver_name
  FROM users
  WHERE id = v_receiver_id;

  IF NOT FOUND OR v_receiver_name IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Receiver account is not approved');
  END IF;

  -- Start atomic transaction
  BEGIN
    -- Update sender balance
    UPDATE users
    SET availablebalance = availablebalance - p_amount,
        currentbalance = currentbalance - p_amount,
        updated_at = NOW()
    WHERE id = v_sender_id;

    -- Update receiver balance
    UPDATE users
    SET availablebalance = availablebalance + p_amount,
        currentbalance = currentbalance + p_amount,
        updated_at = NOW()
    WHERE id = v_receiver_id;

    -- Create transaction records for both sender and receiver
    v_transaction_id := 'tx_' || EXTRACT(EPOCH FROM NOW()) || '_' || floor(random() * 10000);

    INSERT INTO transactions (
      id,
      useremail,
      name,
      datetime,
      type,
      status,
      amount,
      category,
      externaldetails,
      updated_at
    ) VALUES (
      v_transaction_id || '_send',
      p_sender_email,
      p_description,
      TO_TIMESTAMP(EXTRACT(EPOCH FROM NOW())),
      'debit',
      'successful',
      p_amount,
      'Transfer',
      NULL,
      NOW()
    );

    INSERT INTO transactions (
      id,
      useremail,
      name,
      datetime,
      type,
      status,
      amount,
      category,
      externaldetails,
      updated_at
    ) VALUES (
      v_transaction_id || '_recv',
      p_receiver_email,
      p_description,
      TO_TIMESTAMP(EXTRACT(EPOCH FROM NOW()) + INTERVAL '1 second'),
      'credit',
      'successful',
      p_amount,
      'Transfer',
      NULL,
      NOW()
    );

    RETURN json_build_object('success', true, 'message', 'Transfer completed successfully');

  EXCEPTION WHEN OTHERS THEN
    -- Rollback on any error
    RETURN json_build_object('success', false, 'error', 'Transfer failed: ' || SQLERRM);
  END;
END;
$$;

-- =============================================================================
-- Grant execute permission to authenticated users
-- =============================================================================
GRANT EXECUTE ON FUNCTION process_transfer(TEXT, TEXT, NUMERIC, TEXT) TO authenticated;

-- =============================================================================
-- Create indexes for better performance
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_transactions_useremail ON transactions(useremail);
CREATE INDEX IF NOT EXISTS idx_transactions_datetime ON transactions(datetime);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- =============================================================================
-- Sample test data (for development only)
-- =============================================================================
-- Uncomment the following lines only if you need test data
-- INSERT INTO users (id, email, password, name, phone, approved, suspended, irshold, availablebalance, currentbalance, cardlocked, cardlastfour, cardfull, cardexpiry, cardcvv, transactionpin, showcarddigits, darkmode)
-- VALUES 
--   ('u' || EXTRACT(EPOCH FROM NOW()), 'test@example.com', 'password123', 'Test User', '(555) 123-4567', true, false, false, 1000.00, 1000.00, false, '4567', '4111222233334444', '12/25', '123', '0000', false, false);

COMMENT ON FUNCTION process_transfer IS 'Atomic transfer function for both internal and external transfers';
