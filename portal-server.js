import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());
app.use(cors());

// ── SUPABASE ──────────────────────────────────────────────────────────────────
// These are set as environment variables in Render — never hardcode them here
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── USERS ─────────────────────────────────────────────────────────────────────
// Same users as rep.html — keep these in sync when you add new reps
const USERS = {
  "admin":   { password: process.env.ADMIN_PASSWORD   || "slots2025",   name: "Owner",  isAdmin: true  },
  "orion1":  { password: process.env.REP1_PASSWORD    || "Orion2026$",  name: "Orion",  isAdmin: false },
  "braden1": { password: process.env.BRADEN_PASSWORD  || "Braden2026$", name: "Braden", isAdmin: false },
  "carson1": { password: process.env.CARSON_PASSWORD  || "Carson2026$", name: "Carson", isAdmin: false },
  "rep2":    { password: process.env.REP2_PASSWORD    || "rep2pass",    name: "Rep 2",  isAdmin: false },
};

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const { username, password } = req.body;
  const user = USERS[username?.toLowerCase()];
  if (!user || user.password !== password) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.user = { username: username.toLowerCase(), name: user.name, isAdmin: user.isAdmin };
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Health check
app.get("/health", (_, res) => res.json({ status: "ok" }));

// ── LOGIN ─────────────────────────────────────────────────────────────────────
app.post("/portal/login", async (req, res) => {
  const { username, password } = req.body;
  const user = USERS[username?.toLowerCase()];

  if (!user || user.password !== password) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }

  // Log the login to Supabase
  const { error } = await supabase.from("logins").insert({
    username: username.toLowerCase(),
    rep_name: user.name,
    logged_in_at: new Date().toISOString(),
  });

  if (error) console.error("Login log error:", error);

  res.json({
    success: true,
    name: user.name,
    isAdmin: user.isAdmin,
  });
});

// ── CONTACTS — Add ────────────────────────────────────────────────────────────
app.post("/portal/contacts", requireAuth, async (req, res) => {
  const { biz_name, contact_name, phone, trade, method, status, notes, follow_up_date } = req.body;

  if (!biz_name) return res.status(400).json({ error: "Business name is required." });

  const { data, error } = await supabase.from("contacts").insert({
    rep_username: req.user.username,
    biz_name,
    contact_name: contact_name || null,
    phone: phone || null,
    trade: trade || null,
    method: method || null,
    status: status || "new",
    notes: notes || null,
    follow_up_date: follow_up_date || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, contact: data });
});

// ── CONTACTS — Get (rep sees own, admin sees all) ─────────────────────────────
app.post("/portal/contacts/get", requireAuth, async (req, res) => {
  let query = supabase.from("contacts").select("*").order("created_at", { ascending: false });

  if (!req.user.isAdmin) {
    query = query.eq("rep_username", req.user.username);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, contacts: data });
});

// ── CONTACTS — Cross-rep duplicate check ─────────────────────────────────────
app.post("/portal/contacts/check", requireAuth, async (req, res) => {
  const { biz_name } = req.body;
  if (!biz_name) return res.status(400).json({ error: "biz_name required" });
  const { data, error } = await supabase
    .from("contacts")
    .select("biz_name, rep_username, status")
    .ilike("biz_name", biz_name.trim());
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, matches: data || [] });
});

// ── CONTACTS — Update ─────────────────────────────────────────────────────────
app.post("/portal/contacts/update", requireAuth, async (req, res) => {
  const { id, status, notes, follow_up_date, audit, ob_steps, phone } = req.body;
  if (!id) return res.status(400).json({ error: "Contact ID required." });

  const updatePayload = { updated_at: new Date().toISOString() };
  if (status !== undefined) updatePayload.status = status;
  if (notes !== undefined) updatePayload.notes = notes;
  if (follow_up_date !== undefined) updatePayload.follow_up_date = follow_up_date || null;
  if (audit !== undefined) updatePayload.audit = audit;
  if (ob_steps !== undefined) updatePayload.ob_steps = ob_steps;
  if (phone !== undefined) updatePayload.phone = phone;

  let query = supabase.from("contacts").update(updatePayload).eq("id", id);

  if (!req.user.isAdmin) {
    query = query.eq("rep_username", req.user.username);
  }

  const { data, error } = await query.select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, contact: data });
});

// ── CONTACTS — Delete ─────────────────────────────────────────────────────────
app.post("/portal/contacts/delete", requireAuth, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "Contact ID required." });

  let query = supabase.from("contacts").delete().eq("id", id);
  if (!req.user.isAdmin) {
    query = query.eq("rep_username", req.user.username);
  }

  const { error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── ADMIN — Login history ─────────────────────────────────────────────────────
app.post("/portal/admin/logins", requireAuth, requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from("logins")
    .select("*")
    .order("logged_in_at", { ascending: false })
    .limit(200);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, logins: data });
});

// ── ADMIN — All contacts ──────────────────────────────────────────────────────
app.post("/portal/admin/contacts", requireAuth, requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Group by rep
  const byRep = {};
  data.forEach(c => {
    if (!byRep[c.rep_username]) byRep[c.rep_username] = [];
    byRep[c.rep_username].push(c);
  });

  res.json({ success: true, contacts: data, byRep });
});

// ── ADMIN — Summary stats ─────────────────────────────────────────────────────
app.post("/portal/admin/stats", requireAuth, requireAdmin, async (req, res) => {
  const [loginsRes, contactsRes] = await Promise.all([
    supabase.from("logins").select("username, rep_name, logged_in_at").order("logged_in_at", { ascending: false }),
    supabase.from("contacts").select("rep_username, status"),
  ]);

  if (loginsRes.error || contactsRes.error) {
    return res.status(500).json({ error: "Failed to fetch stats" });
  }

  const logins   = loginsRes.data;
  const contacts = contactsRes.data;

  // Login counts per rep
  const loginCounts = {};
  const lastLogin   = {};
  logins.forEach(l => {
    loginCounts[l.rep_name] = (loginCounts[l.rep_name] || 0) + 1;
    if (!lastLogin[l.rep_name]) lastLogin[l.rep_name] = l.logged_in_at;
  });

  // Contact counts per rep
  const contactCounts = {};
  const closedCounts  = {};
  contacts.forEach(c => {
    contactCounts[c.rep_username] = (contactCounts[c.rep_username] || 0) + 1;
    if (c.status === "closed") {
      closedCounts[c.rep_username] = (closedCounts[c.rep_username] || 0) + 1;
    }
  });

  res.json({
    success: true,
    totalLogins: logins.length,
    totalContacts: contacts.length,
    totalClosed: contacts.filter(c => c.status === "closed").length,
    loginCounts,
    lastLogin,
    contactCounts,
    closedCounts,
  });
});

// ── SETUP — Log access ────────────────────────────────────────────────────────
app.post("/portal/setup/log", requireAuth, async (req, res) => {
  const { action, client_name } = req.body;
  await supabase.from("logins").insert({
    username: req.user.username,
    rep_name: req.user.name + " [setup]" + (client_name ? ": " + client_name : ""),
    logged_in_at: new Date().toISOString(),
  });
  res.json({ success: true });
});

// ── ONBOARD — Submit client intake form (public, no auth) ─────────────────────
app.post("/portal/onboard/submit", async (req, res) => {
  const data = req.body;
  if (!data.biz_name || !data.contact_email) {
    return res.status(400).json({ error: "Business name and email are required." });
  }
  // Flatten hours/services for storage
  const payload = {
    ...data,
    hours: typeof data.hours === "object" ? JSON.stringify(data.hours) : data.hours,
    services: Array.isArray(data.services) ? JSON.stringify(data.services) : data.services,
    submitted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    onboard_status: "pending",
  };
  // Check for existing submission by email
  const { data: existing } = await supabase
    .from("onboard_submissions").select("id").eq("contact_email", data.contact_email.toLowerCase()).single();
  if (existing) {
    const { error } = await supabase.from("onboard_submissions")
      .update({ ...payload, updated_at: new Date().toISOString() }).eq("contact_email", data.contact_email.toLowerCase());
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true, updated: true });
  }
  const { error } = await supabase.from("onboard_submissions").insert(payload);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── ONBOARD — List all submissions (admin only) ───────────────────────────────
app.post("/portal/onboard/list", requireAuth, requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from("onboard_submissions").select("*").order("submitted_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, submissions: data });
});

// ── ONBOARD — Update status (admin only) ─────────────────────────────────────
app.post("/portal/onboard/update", requireAuth, requireAdmin, async (req, res) => {
  const { id, onboard_status, admin_notes } = req.body;
  if (!id) return res.status(400).json({ error: "ID required." });
  const { error } = await supabase.from("onboard_submissions")
    .update({ onboard_status, admin_notes, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── CLIENT — Login by email ───────────────────────────────────────────────────
app.post("/portal/client/login", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required." });
  const { data, error } = await supabase
    .from("onboard_submissions").select("*").eq("contact_email", email.toLowerCase().trim()).single();
  if (error || !data) return res.status(404).json({ error: "No account found with that email." });
  await supabase.from("logins").insert({
    username: email.toLowerCase(),
    rep_name: data.biz_name + " [client]",
    logged_in_at: new Date().toISOString(),
  });
  res.json({ success: true, client: data });
});

// ── CLIENT — Get monthly reports ──────────────────────────────────────────────
app.post("/portal/client/reports", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required." });
  const { data, error } = await supabase
    .from("monthly_reports").select("*").eq("client_email", email.toLowerCase().trim())
    .order("report_month", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, reports: data || [] });
});

// ── ADMIN — Full dashboard ────────────────────────────────────────────────────
app.post("/portal/admin/dashboard", requireAuth, requireAdmin, async (req, res) => {
  const [contactsRes, onboardRes, loginsRes] = await Promise.all([
    supabase.from("contacts").select("*").order("created_at", { ascending: false }),
    supabase.from("onboard_submissions").select("*").order("submitted_at", { ascending: false }),
    supabase.from("logins").select("*").order("logged_in_at", { ascending: false }).limit(500),
  ]);
  const contacts = contactsRes.data || [];
  const submissions = onboardRes.data || [];
  const logins = loginsRes.data || [];
  const PLAN_MRR = { starter: 125, pro: 225, elite: 375 };
  let mrr = 0;
  submissions.filter(s => s.onboard_status === "active").forEach(s => {
    mrr += PLAN_MRR[(s.plan || "pro").toLowerCase()] || 225;
  });
  const pipeline = {};
  ["new","contacted","audit","followup","closed","dead"].forEach(s => {
    pipeline[s] = contacts.filter(c => c.status === s).length;
  });
  const repStats = {};
  contacts.filter(c => c.status !== "prospect").forEach(c => {
    if (!repStats[c.rep_username]) repStats[c.rep_username] = { contacts: 0, closed: 0, audits: 0 };
    repStats[c.rep_username].contacts++;
    if (c.status === "closed") repStats[c.rep_username].closed++;
    if (c.status === "audit") repStats[c.rep_username].audits++;
  });
  res.json({
    success: true, mrr,
    activeClients: submissions.filter(s => s.onboard_status === "active").length,
    pendingOnboards: submissions.filter(s => !s.onboard_status || s.onboard_status === "pending").length,
    totalContacts: contacts.filter(c => c.status !== "prospect").length,
    pipeline, repStats,
    recentLogins: logins.slice(0, 50),
    contacts: contacts.filter(c => c.status !== "prospect"),
  });
});

// ── ADMIN — Save monthly report ───────────────────────────────────────────────
app.post("/portal/admin/report/save", requireAuth, requireAdmin, async (req, res) => {
  const { client_email, report_month, calls_recovered, bookings_confirmed, reviews_requested, revenue_impact, notes } = req.body;
  if (!client_email || !report_month) return res.status(400).json({ error: "Email and month required." });
  const { error } = await supabase.from("monthly_reports").upsert({
    client_email: client_email.toLowerCase(),
    report_month, calls_recovered: calls_recovered || 0,
    bookings_confirmed: bookings_confirmed || 0,
    reviews_requested: reviews_requested || 0,
    revenue_impact: revenue_impact || 0,
    notes: notes || "",
    created_at: new Date().toISOString(),
  }, { onConflict: "client_email,report_month" });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── STRIPE — Create Checkout Session ─────────────────────────────────────────
// Install: npm install stripe  (add to package.json dependencies)
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

// ── Stripe Price IDs ──────────────────────────────────────────────────────────
const STRIPE_PRICES = {
  starter_monthly: "price_1TQKLuFHISSP9GxXZtEIMgrd",
  pro_monthly:     "price_1TQKOyFHISSP9GxXwYgSKIM7",
  elite_monthly:   "price_1TQKQ8FHISSP9GxXhs3izl53",
  starter_annual:  "price_1TQKRBFHISSP9GxXX02OhJn0",
  pro_annual:      "price_1TQKS7FHISSP9GxXYyAbDEUX",
  elite_annual:    "price_1TQKSjFHISSP9GxXJRXaZCmB",
};

app.post("/portal/billing/create-checkout", async (req, res) => {
  const { rep_name, rep_email, client_name, client_email, plan, billing_type, setup_fee_cents, web_design_cents, description, success_url, cancel_url, test_mode } = req.body;
  if (!client_email || !plan) {
    return res.status(400).json({ error: "client_email and plan are required." });
  }

  const stripeKey = test_mode && process.env.STRIPE_TEST_KEY
    ? process.env.STRIPE_TEST_KEY
    : process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return res.status(500).json({ error: "Stripe not configured. Add STRIPE_SECRET_KEY to Render environment variables." });
  }
  const stripeInstance = new Stripe(stripeKey);

  // Get the correct price ID
  const priceKey = `${plan}_${billing_type || "monthly"}`;
  const priceId = STRIPE_PRICES[priceKey];
  if (!priceId) {
    return res.status(400).json({ error: `No price found for plan: ${priceKey}` });
  }

  // Build line items — subscription + one-time setup fee + optional web design
  const setupFee = setup_fee_cents || 19900; // default $199
  const lineItems = [];

  // One-time setup fee
  lineItems.push({
    price_data: {
      currency: "usd",
      unit_amount: setupFee,
      product_data: { name: "My Smart Slots — One-Time Setup Fee" },
    },
    quantity: 1,
  });

  // Optional web design one-time charge
  if (web_design_cents && web_design_cents > 0) {
    lineItems.push({
      price_data: {
        currency: "usd",
        unit_amount: web_design_cents,
        product_data: { name: "My Smart Slots — Website Design & Build" },
      },
      quantity: 1,
    });
  }

  // Recurring subscription
  lineItems.push({ price: priceId, quantity: 1 });

  try {
    const session = await stripeInstance.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer_email: client_email,
      line_items: lineItems,
      subscription_data: {
        metadata: {
          rep_name: rep_name || "",
          rep_email: rep_email || "hello@mysmartslots.com",
          client_name: client_name || "",
          plan,
          billing_type: billing_type || "monthly",
        },
      },
      metadata: {
        rep_name: rep_name || "",
        rep_email: rep_email || "hello@mysmartslots.com",
        client_name: client_name || "",
        plan,
        billing_type: billing_type || "monthly",
        test_mode: test_mode ? "true" : "false",
      },
      success_url: success_url || `https://mysmartslots.com/financial?success=true&plan=${encodeURIComponent(plan)}&email=${encodeURIComponent(client_email)}`,
      cancel_url: cancel_url || "https://mysmartslots.com/financial?cancelled=true",
    });

    // Log the sale to Supabase
    const totalCents = setupFee + (web_design_cents || 0);
    const { error: saleError } = await supabase.from("sales").insert({
      rep_name: rep_name || "Unknown",
      rep_email: rep_email || "hello@mysmartslots.com",
      client_name: client_name || "",
      client_email: client_email.toLowerCase(),
      plan,
      billing_type: billing_type || "monthly",
      amount_cents: totalCents,
      stripe_session_id: session.id,
      status: "pending_payment",
      test_mode: test_mode || false,
      created_at: new Date().toISOString(),
    });
    if (saleError) console.error("Sales log error:", saleError);

    res.json({ success: true, url: session.url, session_id: session.id });
  } catch (e) {
    console.error("Stripe error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── BILLING — Get sales log (admin only) ──────────────────────────────────────
app.post("/portal/billing/sales", requireAuth, requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from("sales").select("*").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, sales: data || [] });
});

// ── ADMIN — Wipe training progress for a rep ──────────────────────────────────
app.post("/portal/admin/training/wipe", requireAuth, requireAdmin, async (req, res) => {
  const { rep_username } = req.body;
  if (!rep_username) return res.status(400).json({ error: "rep_username required." });
  // Log a training reset flag — training portal checks for this on login
  const { error } = await supabase.from("logins").insert({
    username: rep_username,
    rep_name: `${rep_username} [training_reset]`,
    logged_in_at: new Date().toISOString(),
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, wiped: rep_username });
});

// ── ADMIN — Delete all contacts for a specific rep ────────────────────────────
app.post("/portal/admin/contacts/wipe", requireAuth, requireAdmin, async (req, res) => {
  const { rep_username } = req.body;
  if (!rep_username) return res.status(400).json({ error: "rep_username required." });
  const { error } = await supabase
    .from("contacts").delete().eq("rep_username", rep_username);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, wiped: rep_username });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`MySmartSlots portal server running on port ${PORT}`));
