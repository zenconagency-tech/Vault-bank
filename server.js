// 1. WebSocket polyfill (must be first)
const WebSocket = require('ws');
global.WebSocket = WebSocket;

// 2. Imports
const express = require('express');
const session = require('express-session');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
dotenv.config();
const app = express();

// 3. Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY, {
  realtime: { disabled: true },
  auth: { persistSession: false }
});

// 4. Email via Resend API
const RESEND_API_KEY = process.env.SMTP_PASS || '';
const EMAIL_FROM = process.env.SMTP_FROM || 'Vault Bank <onboarding@resend.dev>';
const emailEnabled = !!RESEND_API_KEY;

async function sendEmail({ to, subject, html }) {
  if (!emailEnabled) return;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to, subject, html })
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('Email send failed:', err);
  }
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function sendPasswordResetEmail(email, token, name) {
  const resetUrl = `${process.env.APP_URL}/reset-password?token=${token}`;
  await sendEmail({
    to: email,
    subject: 'Reset Your Password — Vault Bank',
    html: `<table cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;margin:0 auto;font-family:Helvetica,Arial,sans-serif">
      <tr><td style="background:#1a1a2e;padding:24px 32px;text-align:center;border-radius:12px 12px 0 0">
        <span style="color:#fff;font-size:24px;font-weight:700">Vault<span style="color:#3b82f6">Bank</span></span>
      </td></tr>
      <tr><td style="background:#fff;padding:32px;border:1px solid #e5e7eb">
        <p style="color:#111;font-size:16px;margin:0 0 16px">Dear ${name},</p>
        <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
          We received a request to reset the password associated with your Vault Bank account. Use the button below to complete the process.
        </p>
        <table cellpadding="0" cellspacing="0" style="margin:24px auto">
          <tr><td style="background:#3b82f6;border-radius:8px;padding:12px 32px">
            <a href="${resetUrl}" style="color:#fff;font-size:15px;font-weight:600;text-decoration:none;display:inline-block">Reset Password</a>
          </td></tr>
        </table>
        <p style="color:#6b7280;font-size:13px;line-height:1.5;margin:16px 0 0">
          This link expires in 1 hour. If you did not request a password reset, please ignore this email or contact support.
        </p>
      </td></tr>
      <tr><td style="background:#f9fafb;padding:16px 32px;text-align:center;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:0">
        <p style="color:#9ca3af;font-size:11px;margin:0">&copy; 2026 Vault Bank. All rights reserved.</p>
      </td></tr>
    </table>`
  });
}

async function sendAccountVerificationEmail(email, token, name) {
  const verifyUrl = `${process.env.APP_URL}/verify-email?token=${token}`;
  await sendEmail({
    to: email,
    subject: 'Confirm Your Email Address — Vault Bank',
    html: `<table cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;margin:0 auto;font-family:Helvetica,Arial,sans-serif">
      <tr><td style="background:#1a1a2e;padding:24px 32px;text-align:center;border-radius:12px 12px 0 0">
        <span style="color:#fff;font-size:24px;font-weight:700">Vault<span style="color:#3b82f6">Bank</span></span>
      </td></tr>
      <tr><td style="background:#fff;padding:32px;border:1px solid #e5e7eb">
        <p style="color:#111;font-size:16px;margin:0 0 16px">Dear ${name},</p>
        <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
          Thank you for choosing Vault Bank. To activate your account, please confirm your email address by clicking the button below.
        </p>
        <table cellpadding="0" cellspacing="0" style="margin:24px auto">
          <tr><td style="background:#3b82f6;border-radius:8px;padding:12px 32px">
            <a href="${verifyUrl}" style="color:#fff;font-size:15px;font-weight:600;text-decoration:none;display:inline-block">Confirm Email Address</a>
          </td></tr>
        </table>
        <p style="color:#6b7280;font-size:13px;line-height:1.5;margin:16px 0 0">
          This link expires in 24 hours. If you did not create a Vault Bank account, please disregard this message.
        </p>
      </td></tr>
      <tr><td style="background:#f9fafb;padding:16px 32px;text-align:center;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:0">
        <p style="color:#9ca3af;font-size:11px;margin:0">&copy; 2026 Vault Bank. All rights reserved.</p>
      </td></tr>
    </table>`
  });
}

// 5. Middleware
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3600000 }
}));
app.use(express.static('public'));

function requireLogin(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({ error: 'Unauthorized' });
}
function requireAdmin(req, res, next) {
  if (req.session.user && req.session.user.isAdmin) return next();
  res.status(403).json({ error: 'Admin only' });
}

// ---------- Helper: convert DB row to camelCase ----------
function toCamelCaseUser(dbUser) {
  return {
    id: dbUser.id, email: dbUser.email, password: dbUser.password, name: dbUser.name,
    phone: dbUser.phone, accountNumber: dbUser.accountnumber, routingNumber: dbUser.routingnumber,
    approved: dbUser.approved, suspended: dbUser.suspended, irsHold: dbUser.irshold,
    availableBalance: dbUser.availablebalance, currentBalance: dbUser.currentbalance,
    cardLocked: dbUser.cardlocked, cardLastFour: dbUser.cardlastfour, cardFull: dbUser.cardfull,
    cardExpiry: dbUser.cardexpiry, cardCVV: dbUser.cardcvv, transactionPin: dbUser.transactionpin,
    showCardDigits: dbUser.showcarddigits, darkMode: dbUser.darkmode
  };
}
function toCamelCaseTransaction(tx) {
  return {
    id: tx.id, userEmail: tx.useremail, name: tx.name, dateTime: tx.datetime,
    type: tx.type, status: tx.status, amount: tx.amount, category: tx.category,
    externalDetails: tx.externaldetails
  };
}

// ==================== AUTH ====================
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
  if (email === 'admin@bank.com' && password === 'admin123') {
    req.session.user = { isAdmin: true, email };
    return res.json({ isAdmin: true, email });
  }
  const { data: user, error } = await supabase.from('users').select('*').eq('email', email).single();
  if (error || !user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!user.approved || user.suspended) return res.status(403).json({ error: 'Account suspended' });
  if (user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.user = { isAdmin: false, email };
  res.json({ isAdmin: false, email });
});

app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, phone, kyc } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Missing required fields: name, email, password' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (!kyc || !kyc.dob || !kyc.address || !kyc.idType || !kyc.idNumber) {
      return res.status(400).json({ error: 'KYC documentation (Date of Birth, Address, ID Type, ID Number) is required' });
    }
    if (!kyc.ssn || !/^[0-9]{3}-[0-9]{2}-[0-9]{4}$/.test(kyc.ssn)) {
      return res.status(400).json({ error: 'Invalid SSN/Tax ID format. Must be XXX-XX-XXXX' });
    }

    const { data: existing, error: existingErr } = await supabase.from('users').select('id').eq('email', email).single();
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const id = 'u' + Date.now().toString(36);
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const hashedPassword = password;
    const accNum = Math.floor(100000000000 + Math.random() * 900000000000).toString();
    const routingNumber = '0210000' + Math.floor(10 + Math.random() * 90).toString();

    const { error: insertError } = await supabase.from('users').insert({
      id, email, password: hashedPassword, name, phone,
      accountnumber: accNum, routingnumber: routingNumber,
      approved: false, suspended: false, irshold: false,
      availablebalance: 0, currentbalance: 0,
      cardlocked: false, cardlastfour: '0000',
      cardfull: '0000000000000000', cardexpiry: '12/25',
      cardcvv: '000', transactionpin: '0000',
      showcarddigits: false, darkmode: false,
      kyc_data: kyc
    });
    if (insertError) { console.error('Insert error:', insertError); return res.status(500).json({ error: 'Registration failed' }); }

    const { error: tokenInsertError } = await supabase.from('email_tokens').insert({
      user_id: id,
      token: verifyToken,
      type: 'verification',
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    });
    if (tokenInsertError) { console.error('Token insert error:', tokenInsertError); return res.status(500).json({ error: 'Failed to create verification token' }); }

    try { await sendAccountVerificationEmail(email, verifyToken, name); } catch (e) { console.error('Email send failed (non-blocking):', e.message); }
    res.json({ message: 'Registration successful. Please check your email for verification.', userId: id });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/verify-email', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Missing verification token' });

    const { data: tokenData, error: tokenErr } = await supabase
      .from('email_tokens')
      .select('user_id, expires_at')
      .eq('token', token)
      .eq('type', 'verification')
      .single();
    if (tokenErr || !tokenData) return res.status(400).json({ error: 'Invalid verification token' });

    const expiresAt = new Date(tokenData.expires_at);
    if (expiresAt < new Date()) return res.status(400).json({ error: 'Verification token expired' });

    const { error: updateErr } = await supabase
      .from('users')
      .update({ approved: true })
      .eq('id', tokenData.user_id);
    if (updateErr) return res.status(500).json({ error: 'Failed to verify user' });

    await supabase.from('email_tokens').delete().eq('token', token);
    res.json({ message: 'Email verified successfully' });
  } catch (err) {
    console.error('Verification error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ message: 'Logged out' }); });

// ==================== USER DATA ====================
app.get('/api/user', requireLogin, async (req, res) => {
  if (req.session.user.isAdmin) return res.json({ isAdmin: true });
  const { data: user, error } = await supabase.from('users').select('*').eq('email', req.session.user.email).single();
  if (error || !user) return res.status(404).json({ error: 'User not found' });
  const safe = toCamelCaseUser(user);
  const { data: transactions } = await supabase.from('transactions').select('*').eq('useremail', user.email).order('datetime', { ascending: false });
  const { data: payees } = await supabase.from('payees').select('*').eq('useremail', user.email);
  res.json({ ...safe, transactions: (transactions || []).map(toCamelCaseTransaction), payees: payees || [] });
});

// ==================== USER LOOKUP ====================
app.get('/api/user/lookup', requireLogin, async (req, res) => {
  const { email, phone } = req.query;
  let query = supabase.from('users').select('email');
  if (email) query = query.eq('email', email);
  if (!email && phone) query = query.eq('phone', phone);
  const { data, error } = await query.single();
  if (error || !data) return res.status(404).json({ error: 'User not found' });
  res.json({ email: data.email });
});

// ==================== TRANSFER (Atomic RPC) ====================
app.post('/api/transfer', requireLogin, async (req, res) => {
  try {
    const { toEmail, amount, pin, external, externalDetails, description } = req.body;
    if (!amount || !pin) return res.status(400).json({ error: 'Missing required fields: amount, pin' });
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const { data: sender, error: senderErr } = await supabase.from('users').select('email, transactionpin, irshold, availablebalance').eq('email', req.session.user.email).single();
    if (senderErr || !sender) return res.status(404).json({ error: 'Sender account not found' });
    if (pin !== sender.transactionpin) return res.status(403).json({ error: 'Incorrect Transaction PIN' });
    if (sender.irshold) return res.status(403).json({ error: 'Transfer failed: Account currently under regulatory review.' });
    if (sender.availablebalance < amt) return res.status(400).json({ error: 'Insufficient funds' });

    if (external) {
      const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const { error: updateErr } = await supabase.from('users')
        .update({ availablebalance: sender.availablebalance - amt, currentbalance: sender.availablebalance - amt })
        .eq('email', req.session.user.email);
      if (updateErr) return res.status(500).json({ error: 'Failed to process external transfer' });
      const ed = externalDetails || {};
      const { error: txErr } = await supabase.from('transactions').insert({
        useremail: req.session.user.email,
        name: description || `External Transfer to ${ed.fullName || 'External Account'}`,
        datetime: now, type: 'debit', status: 'successful', amount: amt,
        category: 'External Transfer',
        externaldetails: ed
      });
      if (txErr) return res.status(500).json({ error: 'Failed to record transaction' });
      return res.json({ message: 'External transfer successful' });
    }

    if (!toEmail) return res.status(400).json({ error: 'Missing required field: toEmail for internal transfer' });

    const { data: result, error: rpcError } = await supabase.rpc('process_transfer', {
      p_sender_email: req.session.user.email,
      p_receiver_email: toEmail,
      p_amount: amt,
      p_description: description || `Transfer to ${toEmail}`
    });
    if (rpcError) { console.error('RPC error:', rpcError); return res.status(500).json({ error: 'Transfer processing failed' }); }
    if (!result.success) {
      const msg = result.error || 'Transfer failed';
      if (msg.includes('regulatory review')) return res.status(403).json({ error: msg });
      if (msg.includes('Insufficient funds')) return res.status(400).json({ error: msg });
      if (msg.includes('yourself')) return res.status(400).json({ error: msg });
      if (msg.includes('Receiver not found')) return res.status(404).json({ error: msg });
      if (msg.includes('Sender not found')) return res.status(404).json({ error: msg });
      return res.status(500).json({ error: msg });
    }
    res.json({ message: 'Transfer successful' });
  } catch (err) {
    console.error('Unexpected transfer error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== BILL PAY ====================
app.post('/api/billpay', requireLogin, async (req, res) => {
  const { payee, amount, pin } = req.body;
  if (!payee || !amount || !pin) return res.status(400).json({ error: 'Missing fields' });
  const { data: user, error } = await supabase.from('users').select('*').eq('email', req.session.user.email).single();
  if (error || !user) return res.status(404).json({ error: 'User not found' });
  if (pin !== user.transactionpin) return res.status(403).json({ error: 'Incorrect Transaction PIN' });
  if (user.irshold) return res.status(403).json({ error: 'Account under IRS hold' });
  if (user.availablebalance < amount) return res.status(400).json({ error: 'Insufficient funds' });
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  await supabase.from('users').update({ availablebalance: user.availablebalance - amount, currentbalance: user.currentbalance - amount }).eq('email', user.email);
  await supabase.from('transactions').insert({ useremail: user.email, name: `Bill Payment - ${payee}`, datetime: now, type: 'debit', status: 'successful', amount, category: 'Bills' });
  res.json({ message: 'Bill paid' });
});

// ==================== DEPOSIT ====================
app.post('/api/deposit', requireLogin, async (req, res) => {
  const { amount, source } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const { data: user, error } = await supabase.from('users').select('availablebalance, currentbalance').eq('email', req.session.user.email).single();
  if (error || !user) return res.status(404).json({ error: 'User not found' });
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  await supabase.from('users').update({ availablebalance: user.availablebalance + amount, currentbalance: user.currentbalance + amount }).eq('email', req.session.user.email);
  await supabase.from('transactions').insert({ useremail: req.session.user.email, name: `Deposit - ${source}`, datetime: now, type: 'credit', status: 'successful', amount, category: 'Deposit' });
  res.json({ message: 'Deposit successful' });
});

// ==================== CARD LOCK ====================
app.post('/api/card/lock', requireLogin, async (req, res) => {
  const { data: user } = await supabase.from('users').select('cardlocked').eq('email', req.session.user.email).single();
  if (!user) return res.status(404).json({ error: 'User not found' });
  const newLocked = !user.cardlocked;
  await supabase.from('users').update({ cardlocked: newLocked }).eq('email', req.session.user.email);
  res.json({ locked: newLocked });
});

// ==================== PROFILE UPDATES ====================
app.post('/api/profile/pin', requireLogin, async (req, res) => {
  const { currentPin, newPin } = req.body;
  const { data: user } = await supabase.from('users').select('transactionpin').eq('email', req.session.user.email).single();
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (currentPin !== user.transactionpin) return res.status(400).json({ error: 'Incorrect current PIN' });
  if (!/^\d{4}$/.test(newPin)) return res.status(400).json({ error: 'Invalid new PIN' });
  await supabase.from('users').update({ transactionpin: newPin }).eq('email', req.session.user.email);
  res.json({ message: 'PIN updated' });
});

app.post('/api/profile/password', requireLogin, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Min 6 characters' });
  await supabase.from('users').update({ password: newPassword }).eq('email', req.session.user.email);
  res.json({ message: 'Password changed' });
});

app.post('/api/profile/card/visibility', requireLogin, async (req, res) => {
  const { data: user } = await supabase.from('users').select('showcarddigits').eq('email', req.session.user.email).single();
  if (!user) return res.status(404).json({ error: 'User not found' });
  await supabase.from('users').update({ showcarddigits: !user.showcarddigits }).eq('email', req.session.user.email);
  res.json({ showCardDigits: !user.showcarddigits });
});

app.post('/api/profile/darkmode', requireLogin, async (req, res) => {
  const { darkMode } = req.body;
  await supabase.from('users').update({ darkmode: darkMode }).eq('email', req.session.user.email);
  res.json({ darkMode });
});

// ==================== BANK INFO ====================
app.get('/api/bankinfo', async (req, res) => {
  const { data } = await supabase.from('bank_info').select('*').eq('id', 1).single();
  res.json({ supportEmail: data.supportemail, supportPhone: data.supportphone });
});

// ==================== ADMIN ROUTES ====================
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('users').select('*');
  if (error) return res.status(500).json({ error: 'Database error' });
  res.json(data.map(toCamelCaseUser));
});

app.post('/api/admin/toggle-suspend', requireAdmin, async (req, res) => {
  const { id } = req.body;
  const { data: user } = await supabase.from('users').select('approved, suspended').eq('id', id).single();
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.approved) {
    await supabase.from('users').update({ approved: true, suspended: false }).eq('id', id);
  } else {
    await supabase.from('users').update({ suspended: !user.suspended }).eq('id', id);
  }
  res.json({ success: true });
});

app.post('/api/admin/toggle-irs', requireAdmin, async (req, res) => {
  const { id } = req.body;
  const { data: user } = await supabase.from('users').select('irshold').eq('id', id).single();
  await supabase.from('users').update({ irshold: !user.irshold }).eq('id', id);
  res.json({ success: true });
});

app.post('/api/admin/delete-user', requireAdmin, async (req, res) => {
  const { id } = req.body;
  const { data: user } = await supabase.from('users').select('email').eq('id', id).single();
  if (!user) return res.status(404).json({ error: 'User not found' });
  await supabase.from('transactions').delete().eq('useremail', user.email);
  await supabase.from('payees').delete().eq('useremail', user.email);
  await supabase.from('users').delete().eq('id', id);
  res.json({ success: true });
});

function generateUniqueAccountNumber() {
  return Math.floor(100000000000 + Math.random() * 900000000000).toString();
}
function generateUniqueCard() {
  return Math.floor(1000000000000000 + Math.random() * 9000000000000000).toString();
}

app.post('/api/admin/create-user', requireAdmin, async (req, res) => {
  const { name, email, password, phone, balance } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  const { data: existing } = await supabase.from('users').select('id').eq('email', email).single();
  if (existing) return res.status(400).json({ error: 'Email already exists' });
  const id = 'u' + Date.now().toString(36);
  const accNum = generateUniqueAccountNumber();
  const cardFull = generateUniqueCard();
  const now = new Date();
  const expiry = (now.getFullYear() + 3).toString().slice(2) + '/' + (now.getMonth() + 1).toString().padStart(2, '0');
  const cvv = Math.floor(100 + Math.random() * 900).toString();
  const routingNumber = '0210000' + Math.floor(10 + Math.random() * 90).toString();
  const initialBalance = balance || 0;
  const userPhone = phone || `(${Math.floor(200)+900}) ${Math.floor(100)+900}-${Math.floor(1000)+9000}`;
  const { error } = await supabase.from('users').insert({
    id, email, password, name, phone: userPhone, accountnumber: accNum, routingnumber: routingNumber,
    availablebalance: initialBalance, currentbalance: initialBalance,
    cardfull: cardFull, cardlastfour: cardFull.slice(-4), cardexpiry: expiry, cardcvv: cvv,
    approved: true, suspended: false
  });
  if (error) { console.error(error); return res.status(500).json({ error: error.message }); }
  res.json({ success: true });
});

app.post('/api/admin/update-balance', requireAdmin, async (req, res) => {
  const { id, availableBalance, currentBalance } = req.body;
  await supabase.from('users').update({ availablebalance: availableBalance, currentbalance: currentBalance }).eq('id', id);
  res.json({ success: true });
});

app.post('/api/admin/update-user', requireAdmin, async (req, res) => {
  const { id, name, email, phone, accountNumber, routingNumber } = req.body;
  const updates = {};
  if (name) updates.name = name;
  if (email) updates.email = email;
  if (phone) updates.phone = phone;
  if (accountNumber) updates.accountnumber = accountNumber;
  if (routingNumber) updates.routingnumber = routingNumber;
  await supabase.from('users').update(updates).eq('id', id);
  res.json({ success: true });
});

app.post('/api/admin/update-contact', requireAdmin, async (req, res) => {
  const { supportEmail, supportPhone } = req.body;
  await supabase.from('bank_info').update({ supportemail: supportEmail, supportphone: supportPhone }).eq('id', 1);
  res.json({ success: true });
});

app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (currentPassword !== 'admin123') return res.status(400).json({ error: 'Incorrect current password' });
  res.json({ success: true });
});

// ---------- FIXED: admin/transactions route (manual join, no foreign key needed) ----------
app.get('/api/admin/transactions', requireAdmin, async (req, res) => {
  try {
    // Fetch all transactions
    const { data: transactions, error: txErr } = await supabase
      .from('transactions')
      .select('*')
      .order('datetime', { ascending: false });

    if (txErr) {
      console.error('Supabase transactions error:', txErr);
      return res.status(500).json({ error: 'Database error fetching transactions' });
    }

    // Fetch all users (only needed fields)
    const { data: users, error: userErr } = await supabase
      .from('users')
      .select('email, name');

    if (userErr) {
      console.error('Supabase users error:', userErr);
      return res.status(500).json({ error: 'Database error fetching users' });
    }

    // Build lookup map
    const userMap = {};
    (users || []).forEach(u => { userMap[u.email] = u; });

    // Merge user name into each transaction
    const txs = (transactions || []).map(tx => {
      const user = userMap[tx.useremail] || {};
      return {
        ...toCamelCaseTransaction(tx),
        userEmail: tx.useremail,
        userName: user.name || null
      };
    });

    res.json(txs);
  } catch (err) {
    console.error('Unexpected error in admin/transactions:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Fallback
app.get('/*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const PORT = process.env.PORT || 3000;

// Startup validation
const checks = [
  ['SUPABASE_URL', process.env.SUPABASE_URL],
  ['SUPABASE_SERVICE_KEY or SUPABASE_ANON_KEY', process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY],
  ['SESSION_SECRET', process.env.SESSION_SECRET],
];
const missing = checks.filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error('Missing required env vars:', missing.join(', '));
  process.exit(1);
}
if (!process.env.SMTP_PASS) {
  console.warn('SMTP not configured (SMTP_PASS missing) — verification/reset emails will not be sent');
}
if (process.env.APP_URL === 'http://localhost:3000') {
  console.warn('APP_URL is set to localhost — change it in production for correct email links');
}

app.listen(PORT, () => console.log(`Vault Bank server on port ${PORT}`));
