// 1. WebSocket polyfill
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

// ---------- Helper: convert DB row (lowercase) to camelCase for frontend ----------
function toCamelCaseUser(dbUser) {
  return {
    id: dbUser.id,
    email: dbUser.email,
    password: dbUser.password, // not sent normally
    name: dbUser.name,
    phone: dbUser.phone,
    accountNumber: dbUser.accountnumber,
    routingNumber: dbUser.routingnumber,
    approved: dbUser.approved,
    suspended: dbUser.suspended,
    irsHold: dbUser.irshold,
    availableBalance: dbUser.availablebalance,
    currentBalance: dbUser.currentbalance,
    cardLocked: dbUser.cardlocked,
    cardLastFour: dbUser.cardlastfour,
    cardFull: dbUser.cardfull,
    cardExpiry: dbUser.cardexpiry,
    cardCVV: dbUser.cardcvv,
    transactionPin: dbUser.transactionpin,
    showCardDigits: dbUser.showcarddigits,
    darkMode: dbUser.darkmode
  };
}

function toCamelCaseTransaction(tx) {
  return {
    id: tx.id,
    userEmail: tx.useremail,
    name: tx.name,
    dateTime: tx.datetime,
    type: tx.type,
    status: tx.status,
    amount: tx.amount,
    category: tx.category,
    externalDetails: tx.externaldetails
  };
}

function toCamelCaseBankInfo(info) {
  return {
    supportEmail: info.supportemail,
    supportPhone: info.supportphone
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

  const safe = toCamelCaseUser(user);

  const { data: transactions } = await supabase
    .from('transactions')
    .select('*')
    .eq('useremail', user.email)
    .order('datetime', { ascending: false });

  const { data: payees } = await supabase
    .from('payees')
    .select('*')
    .eq('useremail', user.email);

  res.json({
    ...safe,
    transactions: (transactions || []).map(toCamelCaseTransaction),
    payees: payees || []
  });
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

// ==================== TRANSFER ====================
// PIN validation helper (reuse what you already have)
function validatePin(user, pin) {
  if (!pin || pin !== user.transactionpin) {
    return false;
  }
  return true;
}

app.post('/api/transfer', requireLogin, async (req, res) => {
  const { toEmail, amount, pin, description } = req.body;
  if (!toEmail || !amount || !pin) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  // Fetch sender for PIN and IRS hold check
  const { data: sender, error: senderErr } = await supabase
    .from('users')
    .select('email, transactionpin, irshold, availablebalance')
    .eq('email', req.session.user.email)
    .single();

  if (senderErr || !sender) {
    return res.status(404).json({ error: 'Sender not found' });
  }

  // PIN check
  if (!validatePin(sender, pin)) {
    return res.status(403).json({ error: 'Incorrect Transaction PIN' });
  }

  // Quick IRS check before hitting DB transaction (optional but efficient)
  if (sender.irshold) {
    return res.status(403).json({ error: 'Transfer failed: Account currently under regulatory review.' });
  }

  // Quick balance check (can also be done inside RPC, but saves a call)
  if (sender.availablebalance < amt) {
    return res.status(400).json({ error: 'Insufficient funds' });
  }

  // Prevent self‑transfer
  if (toEmail === req.session.user.email) {
    return res.status(400).json({ error: 'Cannot transfer to yourself' });
  }

  // Call the atomic RPC
  const { data: result, error } = await supabase.rpc('transfer_funds', {
    p_sender_email: req.session.user.email,
    p_receiver_email: toEmail,
    p_amount: amt,
    p_description: description || `Transfer to ${toEmail}`
  });

  if (error) {
    console.error('RPC error:', error);
    return res.status(500).json({ error: 'Transfer processing failed' });
  }

  if (!result.success) {
    const msg = result.error || 'Transfer failed';
    // Map known errors to appropriate HTTP status codes
    if (msg.includes('regulatory review')) return res.status(403).json({ error: msg });
    if (msg.includes('Insufficient')) return res.status(400).json({ error: msg });
    if (msg.includes('yourself')) return res.status(400).json({ error: msg });
    if (msg.includes('Receiver not found')) return res.status(404).json({ error: msg });
    return res.status(500).json({ error: msg });
  }

  res.json({ message: 'Transfer successful' });
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
  if (pin !== user.transactionpin) return res.status(403).json({ error: 'Incorrect Transaction PIN' });
  if (user.irshold) return res.status(403).json({ error: 'Account under IRS hold' });
  if (user.availablebalance < amount) return res.status(400).json({ error: 'Insufficient funds' });

  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

  const { error: updErr } = await supabase
    .from('users')
    .update({
      availablebalance: user.availablebalance - amount,
      currentbalance: user.currentbalance - amount
    })
    .eq('email', user.email);

  if (updErr) return res.status(500).json({ error: 'Payment failed' });

  await supabase.from('transactions').insert({
    useremail: user.email,
    name: `Bill Payment - ${payee}`,
    datetime: now,
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
    .select('availablebalance, currentbalance')
    .eq('email', req.session.user.email)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });

  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

  await supabase
    .from('users')
    .update({
      availablebalance: user.availablebalance + amount,
      currentbalance: user.currentbalance + amount
    })
    .eq('email', req.session.user.email);

  await supabase.from('transactions').insert({
    useremail: req.session.user.email,
    name: `Deposit - ${source}`,
    datetime: now,
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
    .select('cardlocked')
    .eq('email', req.session.user.email)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });

  const newLocked = !user.cardlocked;
  await supabase
    .from('users')
    .update({ cardlocked: newLocked })
    .eq('email', req.session.user.email);

  res.json({ locked: newLocked });
});

// ==================== PROFILE UPDATES ====================
app.post('/api/profile/pin', requireLogin, async (req, res) => {
  const { currentPin, newPin } = req.body;
  const { data: user, error } = await supabase
    .from('users')
    .select('transactionpin')
    .eq('email', req.session.user.email)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });
  if (currentPin !== user.transactionpin) return res.status(400).json({ error: 'Incorrect current PIN' });
  if (!/^\d{4}$/.test(newPin)) return res.status(400).json({ error: 'Invalid new PIN' });

  await supabase
    .from('users')
    .update({ transactionpin: newPin })
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
    .select('showcarddigits')
    .eq('email', req.session.user.email)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });

  await supabase
    .from('users')
    .update({ showcarddigits: !user.showcarddigits })
    .eq('email', req.session.user.email);

  res.json({ showCardDigits: !user.showcarddigits });
});

app.post('/api/profile/darkmode', requireLogin, async (req, res) => {
  const { darkMode } = req.body;
  await supabase
    .from('users')
    .update({ darkmode: darkMode })
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
  res.json(toCamelCaseBankInfo(data));
});

// ==================== ADMIN ROUTES ====================
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('*');

  if (error) return res.status(500).json({ error: 'Database error' });
  res.json(data.map(toCamelCaseUser));
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
    .select('irshold')
    .eq('id', id)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });

  await supabase
    .from('users')
    .update({ irshold: !user.irshold })
    .eq('id', id);

  res.json({ success: true });
});

app.post('/api/admin/delete-user', requireAdmin, async (req, res) => {
  const { id } = req.body;
  const { data: user, error } = await supabase
    .from('users')
    .select('email')
    .eq('id', id)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });

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
    id, email, password, name,
    phone: userPhone,
    accountnumber: accNum,
    routingnumber: routingNumber,
    availablebalance: initialBalance,
    currentbalance: initialBalance,
    cardfull: cardFull,
    cardlastfour: cardLastFour,
    cardexpiry: expiry,
    cardcvv: cvv,
    approved: true,
    suspended: false
  });

  if (error) {
    console.error('Create user failed:', error);
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true });
});

app.post('/api/admin/update-balance', requireAdmin, async (req, res) => {
  const { id, availableBalance, currentBalance } = req.body;
  await supabase
    .from('users')
    .update({
      availablebalance: availableBalance,
      currentbalance: currentBalance
    })
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
  if (accountNumber) updates.accountnumber = accountNumber;
  if (routingNumber) updates.routingnumber = routingNumber;

  const { error } = await supabase
    .from('users')
    .update(updates)
    .eq('id', id);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/admin/update-contact', requireAdmin, async (req, res) => {
  const { supportEmail, supportPhone } = req.body;
  await supabase
    .from('bank_info')
    .update({ supportemail: supportEmail, supportphone: supportPhone })
    .eq('id', 1);
  res.json({ success: true });
});

app.post('/api/admin/change-password', requireAdmin, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (currentPassword !== 'admin123') return res.status(400).json({ error: 'Incorrect current password' });
  res.json({ success: true });
});

app.get('/api/admin/transactions', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('transactions')
    .select('*, users!inner(email)')
    .order('datetime', { ascending: false });

  if (error) return res.status(500).json({ error: 'Database error' });

  const txs = data.map(tx => ({
    ...toCamelCaseTransaction(tx),
    userEmail: tx.users ? tx.users.email : tx.useremail
  }));
  res.json(txs);
});

// Fallback
app.get('/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vault Bank server on port ${PORT}`));
