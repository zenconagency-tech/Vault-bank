// 1. WebSocket polyfill (must be first)
const WebSocket = require('ws');
global.WebSocket = WebSocket;

// 2. Imports
const express = require('express');
const session = require('express-session');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const app = express();

// 3. Supabase client
const supabaseUrl = process.env.SUPABASE_URL || 'https://lxpbtmtpeixeuxqlxhhz.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx4cGJ0bXRwZWl4ZXV4cWx4aGh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzOTE1OTUsImV4cCI6MjA5NTk2NzU5NX0.CSjROUphKSlSmv8yRBpYmID0SkuJGjsoJrWWPeLV_54';
const supabase = createClient(supabaseUrl, supabaseKey, {
  realtime: { disabled: true },
  auth: { persistSession: false }
});

// 4. Middleware
app.use(express.json());
app.use(session({
  secret: 'vault-real-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3600000 }
}));
app.use(express.static('public'));

// Auth middleware
function requireLogin(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({ error: 'Unauthorized' });
}
function requireAdmin(req, res, next) {
  if (req.session.user && req.session.user.isAdmin) return next();
  res.status(403).json({ error: 'Admin only' });
}

// ==================== AUTH ====================
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });

  // Admin login (hardcoded – uses no Supabase)
  if (email === 'admin@bank.com' && password === 'admin123') {
    req.session.user = { isAdmin: true, email };
    return res.json({ isAdmin: true, email });
  }

  // User login
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .single();

  if (error || !user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!user.approved || user.suspended) return res.status(403).json({ error: 'Account suspended' });
  if (user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });

  req.session.user = { isAdmin: false, email };
  res.json({ isAdmin: false, email });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logged out' });
});

// ==================== USER DATA ====================
app.get('/api/user', requireLogin, async (req, res) => {
  if (req.session.user.isAdmin) return res.json({ isAdmin: true });

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', req.session.user.email)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });

  const { password, ...safe } = user;

  const { data: transactions } = await supabase
    .from('transactions')
    .select('*')
    .eq('userEmail', user.email)
    .order('dateTime', { ascending: false });

  const { data: payees } = await supabase
    .from('payees')
    .select('*')
    .eq('userEmail', user.email);

  res.json({ ...safe, transactions: transactions || [], payees: payees || [] });
});

// ==================== USER LOOKUP (for Zelle/Internal) ====================
app.get('/api/user/lookup', requireLogin, async (req, res) => {
  const { email, phone } = req.query;
  let query = supabase.from('users').select('email');
  if (email) query = query.eq('email', email);
  if (!email && phone) query = query.eq('phone', phone);

  const { data, error } = await query.single();
  if (error || !data) return res.status(404).json({ error: 'User not found' });
  res.json({ email: data.email });
});

// ==================== TRANSFER ====================
app.post('/api/transfer', requireLogin, async (req, res) => {
  const { toEmail, amount, pin, external, externalDetails } = req.body;
  if (!amount || !pin) return res.status(400).json({ error: 'Missing fields' });

  // Fetch sender
  const { data: sender, error: senderErr } = await supabase
    .from('users')
    .select('*')
    .eq('email', req.session.user.email)
    .single();

  if (senderErr || !sender) return res.status(404).json({ error: 'User not found' });
  if (pin !== sender.transactionPin) return res.status(403).json({ error: 'Incorrect Transaction PIN' });
  if (sender.irsHold) return res.status(403).json({ error: 'Account under IRS hold' });
  if (sender.availableBalance < amount) return res.status(400).json({ error: 'Insufficient funds' });

  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

  if (external) {
    // External transfer: only deduct sender
    const { error: updErr } = await supabase
      .from('users')
      .update({
        availableBalance: sender.availableBalance - amount,
        currentBalance: sender.currentBalance - amount
      })
      .eq('email', sender.email);

    if (updErr) return res.status(500).json({ error: 'Transfer failed' });

    await supabase.from('transactions').insert({
      userEmail: sender.email,
      name: externalDetails.fullName || 'External Transfer',
      dateTime: now,
      type: 'debit',
      status: 'successful',
      amount,
      category: 'Transfer',
      externalDetails: JSON.stringify(externalDetails)
    });

    return res.json({ message: 'Transfer successful' });
  } else {
    // Internal / Zelle transfer
    if (!toEmail) return res.status(400).json({ error: 'Recipient email required' });

    const { data: recipient, error: recErr } = await supabase
      .from('users')
      .select('*')
      .eq('email', toEmail)
      .single();

    if (recErr || !recipient) return res.status(404).json({ error: 'Recipient not found' });
    if (recipient.suspended) return res.status(400).json({ error: 'Recipient suspended' });

    // Update sender
    const { error: sUpd } = await supabase
      .from('users')
      .update({
        availableBalance: sender.availableBalance - amount,
        currentBalance: sender.currentBalance - amount
      })
      .eq('email', sender.email);

    // Update recipient
    const { error: rUpd } = await supabase
      .from('users')
      .update({
        availableBalance: recipient.availableBalance + amount,
        currentBalance: recipient.currentBalance + amount
      })
      .eq('email', recipient.email);

    if (sUpd || rUpd) return res.status(500).json({ error: 'Transfer failed' });

    // Insert transactions for both
    await supabase.from('transactions').insert([
      {
        userEmail: sender.email,
        name: `Transfer to ${toEmail}`,
        dateTime: now,
        type: 'debit',
        status: 'successful',
        amount,
        category: 'Transfer'
      },
      {
        userEmail: recipient.email,
        name: `Transfer from ${sender.email}`,
        dateTime: now,
        type: 'credit',
        status: 'successful',
        amount,
        category: 'Transfer'
      }
    ]);

    return res.json({ message: 'Transfer successful' });
  }
});

// ==================== BILL PAY ====================
app.post('/api/billpay', requireLogin, async (req, res) => {
  const { payee, amount, pin } = req.body;
  if (!payee || !amount || !pin) return res.status(400).json({ error: 'Missing fields' });

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', req.session.user.email)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });
  if (pin !== user.transactionPin) return res.status(403).json({ error: 'Incorrect Transaction PIN' });
  if (user.irsHold) return res.status(403).json({ error: 'Account under IRS hold' });
  if (user.availableBalance < amount) return res.status(400).json({ error: 'Insufficient funds' });

  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

  const { error: updErr } = await supabase
    .from('users')
    .update({
      availableBalance: user.availableBalance - amount,
      currentBalance: user.currentBalance - amount
    })
    .eq('email', user.email);

  if (updErr) return res.status(500).json({ error: 'Payment failed' });

  await supabase.from('transactions').insert({
    userEmail: user.email,
    name: `Bill Payment - ${payee}`,
    dateTime: now,
    type: 'debit',
    status: 'successful',
    amount,
    category: 'Bills'
  });

  res.json({ message: 'Bill paid' });
});

// ==================== DEPOSIT ====================
app.post('/api/deposit', requireLogin, async (req, res) => {
  const { amount, source } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const { data: user, error } = await supabase
    .from('users')
    .select('availableBalance, currentBalance')
    .eq('email', req.session.user.email)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });

  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

  await supabase
    .from('users')
    .update({
      availableBalance: user.availableBalance + amount,
      currentBalance: user.currentBalance + amount
    })
    .eq('email', req.session.user.email);

  await supabase.from('transactions').insert({
    userEmail: req.session.user.email,
    name: `Deposit - ${source}`,
    dateTime: now,
    type: 'credit',
    status: 'successful',
    amount,
    category: 'Deposit'
  });

  res.json({ message: 'Deposit successful' });
});

// ==================== CARD LOCK ====================
app.post('/api/card/lock', requireLogin, async (req, res) => {
  const { data: user, error } = await supabase
    .from('users')
    .select('cardLocked')
    .eq('email', req.session.user.email)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });

  const newLocked = !user.cardLocked;
  await supabase
    .from('users')
    .update({ cardLocked: newLocked })
    .eq('email', req.session.user.email);

  res.json({ locked: newLocked });
});

// ==================== PROFILE UPDATES ====================
app.post('/api/profile/pin', requireLogin, async (req, res) => {
  const { currentPin, newPin } = req.body;
  const { data: user, error } = await supabase
    .from('users')
    .select('transactionPin')
    .eq('email', req.session.user.email)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });
  if (currentPin !== user.transactionPin) return res.status(400).json({ error: 'Incorrect current PIN' });
  if (!/^\d{4}$/.test(newPin)) return res.status(400).json({ error: 'Invalid new PIN' });

  await supabase
    .from('users')
    .update({ transactionPin: newPin })
    .eq('email', req.session.user.email);

  res.json({ message: 'PIN updated' });
});

app.post('/api/profile/password', requireLogin, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Min 6 characters' });

  await supabase
    .from('users')
    .update({ password: newPassword })
    .eq('email', req.session.user.email);

  res.json({ message: 'Password changed' });
});

app.post('/api/profile/card/visibility', requireLogin, async (req, res) => {
  const { data: user, error } = await supabase
    .from('users')
    .select('showCardDigits')
    .eq('email', req.session.user.email)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });

  await supabase
    .from('users')
    .update({ showCardDigits: !user.showCardDigits })
    .eq('email', req.session.user.email);

  res.json({ showCardDigits: !user.showCardDigits });
});

app.post('/api/profile/darkmode', requireLogin, async (req, res) => {
  const { darkMode } = req.body;
  await supabase
    .from('users')
    .update({ darkMode })
    .eq('email', req.session.user.email);

  res.json({ darkMode });
});

// ==================== BANK INFO ====================
app.get('/api/bankinfo', async (req, res) => {
  const { data, error } = await supabase
    .from('bank_info')
    .select('*')
    .eq('id', 1)
    .single();

  if (error) return res.status(500).json({ error: 'Could not fetch bank info' });
  res.json(data);
});

// ==================== ADMIN ROUTES ====================
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, email, name, phone, accountNumber, routingNumber, approved, suspended, irsHold, availableBalance, currentBalance, cardLocked, cardLastFour, cardExpiry, cardCVV');

  if (error) return res.status(500).json({ error: 'Database error' });
  res.json(data);
});

app.get('/api/admin/user/:id', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'User not found' });
  res.json(data);
});

app.post('/api/admin/toggle-suspend', requireAdmin, async (req, res) => {
  const { id } = req.body;
  const { data: user, error } = await supabase
    .from('users')
    .select('suspended')
    .eq('id', id)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });

  await supabase
    .from('users')
    .update({ suspended: !user.suspended })
    .eq('id', id);

  res.json({ success: true });
});

app.post('/api/admin/toggle-irs', requireAdmin, async (req, res) => {
  const { id } = req.body;
  const { data: user, error } = await supabase
    .from('users')
    .select('irsHold')
    .eq('id', id)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });

  await supabase
    .from('users')
    .update({ irsHold: !user.irsHold })
    .eq('id', id);

  res.json({ success: true });
});

app.post('/api/admin/delete-user', requireAdmin, async (req, res) => {
  const { id } = req.body;
  // Find the user first to get email for transaction/payee cleanup
  const { data: user, error } = await supabase
    .from('users')
    .select('email')
    .eq('id', id)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });

  // Delete associated transactions and payees
  await supabase.from('transactions').delete().eq('userEmail', user.email);
  await supabase.from('payees').delete().eq('userEmail', user.email);
  await supabase.from('users').delete().eq('id', id);

  res.json({ success: true });
});

// Helper functions for unique account/card generation
function generateUniqueAccountNumber() {
  return Math.floor(100000000000 + Math.random() * 900000000000).toString();
}
function generateUniqueCard() {
  return Math.floor(1000000000000000 + Math.random() * 9000000000000000).toString();
}

app.post('/api/admin/create-user', requireAdmin, async (req, res) => {
  const { name, email, password, phone, balance } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Missing fields' });

  // Check email uniqueness
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('email', email)
    .single();

  if (existing) return res.status(400).json({ error: 'Email already exists' });

  const id = 'u' + Date.now().toString(36);
  const accNum = generateUniqueAccountNumber();
  const cardFull = generateUniqueCard();
  const cardLastFour = cardFull.slice(-4);
  const now = new Date();
  const expiry = (now.getFullYear() + 3).toString().slice(2) + '/' + (now.getMonth() + 1).toString().padStart(2, '0');
  const cvv = Math.floor(100 + Math.random() * 900).toString();
  const routingNumber = '0210000' + Math.floor(10 + Math.random() * 90).toString();
  const initialBalance = balance || 0;
  const userPhone = phone || `(${Math.floor(200)+900}) ${Math.floor(100)+900}-${Math.floor(1000)+9000}`;

  const { error } = await supabase.from('users').insert({
    id, email, password, name, phone: userPhone, accountNumber: accNum, routingNumber,
    availableBalance: initialBalance, currentBalance: initialBalance,
    cardFull, cardLastFour, cardExpiry: expiry, cardCVV: cvv
  });

  if (error) return res.status(500).json({ error: 'Failed to create user' });
  res.json({ success: true });
});

app.post('/api/admin/update-balance', requireAdmin, async (req, res) => {
  const { id, availableBalance, currentBalance } = req.body;
  await supabase
    .from('users')
    .update({ availableBalance, currentBalance })
    .eq('id', id);
  res.json({ success: true });
});

app.post('/api/admin/update-user', requireAdmin, async (req, res) => {
  const { id, name, email, phone, accountNumber, routingNumber } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing ID' });

  const updates = {};
  if (name) updates.name = name;
  if (email) updates.email = email;
  if (phone) updates.phone = phone;
  if (accountNumber) updates.accountNumber = accountNumber;
  if (routingNumber) updates.routingNumber = routingNumber;

  const { error } = await supabase
    .from('users')
    .update(updates)
    .eq('id', id);

  if (error) return res.status(400).json({ error: 'Update failed' });
  res.json({ success: true });
});

app.post('/api/admin/update-contact', requireAdmin, async (req, res) => {
  const { supportEmail, supportPhone } = req.body;
  await supabase
    .from('bank_info')
    .update({ supportEmail, supportPhone })
    .eq('id', 1);
  res.json({ success: true });
});

app.post('/api/admin/change-password', requireAdmin, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (currentPassword !== 'admin123') return res.status(400).json({ error: 'Incorrect current password' });
  // For a real implementation you'd update the admin password in DB. For now we acknowledge.
  res.json({ success: true });
});

app.get('/api/admin/transactions', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('transactions')
    .select('*, users!inner(email)')
    .order('dateTime', { ascending: false });

  if (error) return res.status(500).json({ error: 'Database error' });

  const txs = data.map(tx => ({
    ...tx,
    userEmail: tx.users ? tx.users.email : tx.userEmail,
    users: undefined
  }));
  res.json(txs);
});

// Fallback
app.get('/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vault Bank server on port ${PORT}`));
