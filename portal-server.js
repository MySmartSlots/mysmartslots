import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import crypto from "crypto";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";

const app = express();
app.use(express.json());
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"] }));
app.options("*", cors());

// ── HEALTH / KEEP-ALIVE ───────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status:"ok", time: new Date().toISOString() }));
app.get("/ping",   (req, res) => res.json({ pong: true }));

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

// ── DROPBOX SIGN ──────────────────────────────────────────────────────────────
const DROPBOX_SIGN_API_KEY = process.env.DROPBOX_SIGN_API_KEY || "0b5ce16caa513fb657c04291f0e5e1840e4e5e20539c0e62387f5e9437d6a260";
const DROPBOX_SIGN_TEMPLATE_ID = process.env.DROPBOX_SIGN_TEMPLATE_ID || "373a711264ee46b59f5a19c53eab7ab4588ddbfc";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "hello@mysmartslots.com";
const OWNER_NAME  = "My Smart Slots";

async function sendAgreement({ rep_name, rep_email, client_name, client_email, plan, billing_type }) {
  try {
    const planLabels = { starter:"Starter", pro:"Pro", elite:"Elite" };
    const planLabel  = planLabels[plan] || plan;

    const payload = {
      template_ids: [DROPBOX_SIGN_TEMPLATE_ID],
      test_mode: process.env.DROPBOX_SIGN_TEST_MODE === "true" ? 1 : 0,
      subject: `My Smart Slots — Business Services Agreement (${planLabel} Plan)`,
      message: `Hi ${client_name}, please review and sign your My Smart Slots Business Services Agreement. Your Account Manager ${rep_name} will sign first, then it will come to you, and finally to our owner for countersignature. All parties receive a copy once complete.`,
      signing_options: { draw:true, type:true, upload:true, phone:false, default_type:"type" },
      signers: [
        { role:"Account Manager", name:rep_name,    email_address:rep_email,    order:0 },
        { role:"Client",          name:client_name, email_address:client_email, order:1 },
        { role:"Owner",           name:OWNER_NAME,  email_address:OWNER_EMAIL,  order:2 },
      ],
    };

    const authHeader = "Basic " + Buffer.from(DROPBOX_SIGN_API_KEY + ":").toString("base64");
    const response = await fetch("https://api.hellosign.com/v3/signature_request/send_with_template", {
      method: "POST",
      headers: { "Authorization": authHeader, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("Dropbox Sign error:", JSON.stringify(data));
      return { success: false, error: data?.error?.error_msg || "Dropbox Sign API error" };
    }
    console.log("Agreement sent:", data?.signature_request?.signature_request_id);
    return { success: true, signature_request_id: data?.signature_request?.signature_request_id };
  } catch (e) {
    console.error("Dropbox Sign exception:", e.message);
    return { success: false, error: e.message };
  }
}

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

    // Send Dropbox Sign agreement (non-blocking — don't fail checkout if this errors)
    if (!test_mode) {
      sendAgreement({
        rep_name:     rep_name || "Account Manager",
        rep_email:    rep_email || "hello@mysmartslots.com",
        client_name:  client_name || "",
        client_email: client_email.toLowerCase(),
        plan,
        billing_type: billing_type || "monthly",
      }).then(r => {
        if (!r.success) console.error("Agreement send failed:", r.error);
      });
    }

    res.json({ success: true, url: session.url, session_id: session.id });
  } catch (e) {
    console.error("Stripe error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── BILLING — Manually send agreement ────────────────────────────────────────
app.post("/portal/billing/send-agreement", requireAuth, async (req, res) => {
  const { rep_name, rep_email, client_name, client_email, plan, billing_type, setup_fee } = req.body;
  if (!client_email || !plan) return res.status(400).json({ error: "client_email and plan required." });
  const result = await sendAgreement({ rep_name, rep_email, client_name, client_email, plan, billing_type, setup_fee });
  res.json(result);
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

// ── AGREEMENT SYSTEM ─────────────────────────────────────────────────────────

const emailTransporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

// Create agreement and send to client
app.post("/portal/agreement/create", requireAuth, async (req, res) => {
  const { rep_name, rep_email, client_name, client_email, plan, billing_type, setup_fee } = req.body;
  if (!client_email || !client_name || !plan) {
    return res.status(400).json({ error: "client_name, client_email, and plan are required." });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

  const planLabels = { starter:"Starter — $125/mo", pro:"Pro — $225/mo", elite:"Elite — $375/mo" };
  const planLabel  = planLabels[plan] || plan;
  const billingLabel = billing_type === "annual" ? "Annual (12-month commitment)" : "Monthly";
  const today = new Date().toLocaleDateString("en-US", { month:"long", day:"numeric", year:"numeric" });

  // Save to Supabase
  const { error } = await supabase.from("agreements").insert({
    token,
    rep_name:      rep_name || "Account Manager",
    rep_email:     rep_email || "hello@mysmartslots.com",
    client_name,
    client_email:  client_email.toLowerCase(),
    plan,
    plan_label:    planLabel,
    billing_type:  billingLabel,
    setup_fee:     setup_fee || 199,
    agreement_date: today,
    status:        "pending",
    expires_at:    expiresAt,
    created_at:    new Date().toISOString(),
  });
  if (error) return res.status(500).json({ error: error.message });

  // Email client
  const signUrl = `https://mysmartslots.com/sign?token=${token}`;
  try {
    await emailTransporter.sendMail({
      from: `"My Smart Slots" <${process.env.GMAIL_USER}>`,
      to: client_email,
      subject: "My Smart Slots — Please Sign Your Services Agreement",
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;">
          <div style="background:#1A1A2E;padding:24px;border-radius:12px 12px 0 0;text-align:center;">
            <h1 style="color:#00C896;margin:0;font-size:24px;letter-spacing:2px;">MY SMART SLOTS</h1>
          </div>
          <div style="background:#f5f7fb;padding:32px;border-radius:0 0 12px 12px;border:1px solid #e4e8f0;">
            <p style="font-size:16px;color:#111827;">Hi ${client_name},</p>
            <p style="color:#374151;line-height:1.7;">Your Account Manager <strong>${rep_name}</strong> has prepared your My Smart Slots Business Services Agreement. Please review and sign it at your earliest convenience — your automations will be configured and live within 24 hours of signing and payment.</p>
            <div style="background:#fff;border:1px solid #e4e8f0;border-radius:10px;padding:20px;margin:24px 0;">
              <div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="color:#6b7280;">Plan:</span><strong style="color:#00C896;">${planLabel}</strong></div>
              <div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="color:#6b7280;">Billing:</span><strong>${billingLabel}</strong></div>
              <div style="display:flex;justify-content:space-between;"><span style="color:#6b7280;">Setup Fee:</span><strong>$${setup_fee || 199}.00 (one-time)</strong></div>
            </div>
            <div style="text-align:center;margin:32px 0;">
              <a href="${signUrl}" style="background:#00C896;color:#fff;padding:16px 40px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block;">Review & Sign Agreement →</a>
            </div>
            <p style="color:#6b7280;font-size:13px;line-height:1.7;">This link expires in 7 days. If you have any questions before signing, contact your Account Manager ${rep_name} at <a href="mailto:${rep_email}" style="color:#00C896;">${rep_email}</a> or call 785-329-0202.</p>
            <hr style="border:none;border-top:1px solid #e4e8f0;margin:24px 0;"/>
            <p style="color:#9ca3af;font-size:12px;text-align:center;">My Smart Slots · Clair Group LLC · mysmartslots.com</p>
          </div>
        </div>`,
    });
  } catch (e) {
    console.error("Email error:", e.message);
    // Don't fail — agreement is saved, email can be resent
  }

  res.json({ success: true, token, sign_url: signUrl });
});

// Get agreement by token (client-facing, no auth)
app.post("/portal/agreement/get", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Token required." });
  const { data, error } = await supabase.from("agreements").select("*").eq("token", token).single();
  if (error || !data) return res.status(404).json({ error: "Agreement not found or expired." });
  if (data.status === "signed") return res.json({ success: true, agreement: data, already_signed: true });
  if (new Date(data.expires_at) < new Date()) return res.status(410).json({ error: "This agreement link has expired. Contact your Account Manager for a new one." });
  res.json({ success: true, agreement: data });
});

// Submit signed agreement — CLIENT signs
app.post("/portal/agreement/sign", async (req, res) => {
  const { token, signer_name, signer_title, signature_data, agreed } = req.body;
  if (!token || !signer_name || !signature_data || !agreed) {
    return res.status(400).json({ error: "Token, name, signature, and agreement are required." });
  }

  const { data: agreement, error: getErr } = await supabase.from("agreements").select("*").eq("token", token).single();
  if (getErr || !agreement) return res.status(404).json({ error: "Agreement not found." });
  if (agreement.status === "signed") return res.status(409).json({ error: "Agreement already signed." });

  const signedAt = new Date().toISOString();
  const signedDate = new Date().toLocaleDateString("en-US", { month:"long", day:"numeric", year:"numeric" });

  // Update Supabase — client signed
  const { error: updateErr } = await supabase.from("agreements").update({
    status:         "client_signed",
    signer_name,
    signer_title:   signer_title || "Owner / Authorized Representative",
    signature_data,
    signed_at:      signedAt,
  }).eq("token", token);
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  // Generate owner countersign token
  const ownerToken = crypto.randomBytes(32).toString("hex");
  await supabase.from("agreements").update({ owner_token: ownerToken }).eq("token", token);

  const ownerSignUrl = `https://mysmartslots.com/countersign?token=${ownerToken}`;

  try {
    // 1. Email REP — client signed, send payment link now
    await emailTransporter.sendMail({
      from: `"My Smart Slots" <${process.env.GMAIL_USER}>`,
      to: agreement.rep_email,
      subject: `✓ ${agreement.client_name} signed — send payment link now`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;">
        <div style="background:#1A1A2E;padding:24px;border-radius:12px 12px 0 0;text-align:center;"><h1 style="color:#00C896;margin:0;font-size:24px;">MY SMART SLOTS</h1></div>
        <div style="background:#f5f7fb;padding:32px;border-radius:0 0 12px 12px;border:1px solid #e4e8f0;">
          <p style="color:#16a34a;font-size:18px;font-weight:700;">✓ ${agreement.client_name} just signed their agreement</p>
          <p style="color:#374151;line-height:1.7;"><strong>Action required:</strong> Send the payment link now. The final countersigned agreement will be sent to all parties once the owner signs.</p>
          <div style="background:#fff;border:1px solid #e4e8f0;border-radius:10px;padding:20px;margin:16px 0;">
            <div><strong>Client:</strong> ${agreement.client_name} (${agreement.client_email})</div>
            <div><strong>Plan:</strong> ${agreement.plan_label}</div>
            <div><strong>Billing:</strong> ${agreement.billing_type}</div>
            <div><strong>Signed:</strong> ${signedDate}</div>
          </div>
          <div style="text-align:center;margin:24px 0;">
            <a href="https://mysmartslots.com/financial" style="background:#00C896;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;display:inline-block;">Send Payment Link →</a>
          </div>
        </div></div>`
    });

    // 2. Email CLIENT — confirmation they signed, waiting for countersign
    await emailTransporter.sendMail({
      from: `"My Smart Slots" <${process.env.GMAIL_USER}>`,
      to: agreement.client_email,
      subject: "✓ Agreement Received — Countersignature in Progress",
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;">
        <div style="background:#1A1A2E;padding:24px;border-radius:12px 12px 0 0;text-align:center;"><h1 style="color:#00C896;margin:0;font-size:24px;">MY SMART SLOTS</h1></div>
        <div style="background:#f5f7fb;padding:32px;border-radius:0 0 12px 12px;border:1px solid #e4e8f0;">
          <p style="color:#16a34a;font-size:18px;font-weight:700;">✓ Your signature was received</p>
          <p style="color:#374151;line-height:1.7;">Hi ${agreement.client_name}, thank you for signing. Your Account Manager <strong>${agreement.rep_name}</strong> will be in touch shortly with your payment link.</p>
          <p style="color:#374151;line-height:1.7;">Once the agreement is countersigned by our owner, a fully executed copy will be emailed to you for your records.</p>
          <p style="color:#6b7280;font-size:13px;">Questions? Contact ${agreement.rep_email} or call 785-329-0202.</p>
        </div></div>`
    });

    // 3. Email OWNER — countersign request
    await emailTransporter.sendMail({
      from: `"My Smart Slots" <${process.env.GMAIL_USER}>`,
      to: OWNER_EMAIL,
      subject: `New agreement to countersign — ${agreement.client_name} (${agreement.plan_label})`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;">
        <div style="background:#1A1A2E;padding:24px;border-radius:12px 12px 0 0;text-align:center;"><h1 style="color:#00C896;margin:0;font-size:24px;">MY SMART SLOTS</h1></div>
        <div style="background:#f5f7fb;padding:32px;border-radius:0 0 12px 12px;border:1px solid #e4e8f0;">
          <p style="color:#16a34a;font-size:18px;font-weight:700;">Countersignature Required</p>
          <p style="color:#374151;line-height:1.7;">${agreement.client_name} has signed their services agreement. Please countersign to finalize and send the executed copy to all parties.</p>
          <div style="background:#fff;border:1px solid #e4e8f0;border-radius:10px;padding:20px;margin:16px 0;">
            <div><strong>Client:</strong> ${agreement.client_name} (${agreement.client_email})</div>
            <div><strong>Plan:</strong> ${agreement.plan_label}</div>
            <div><strong>Billing:</strong> ${agreement.billing_type}</div>
            <div><strong>Rep:</strong> ${agreement.rep_name}</div>
            <div><strong>Client Signed:</strong> ${signedDate}</div>
          </div>
          <div style="text-align:center;margin:24px 0;">
            <a href="${ownerSignUrl}" style="background:#00C896;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;display:inline-block;">Countersign Agreement →</a>
          </div>
          <p style="color:#6b7280;font-size:12px;">Once you sign, a fully executed PDF will be sent automatically to the client and rep.</p>
        </div></div>`
    });

  } catch (e) {
    console.error("Email error after client sign:", e.message);
  }

  res.json({ success: true, message: "Agreement signed. Rep notified. Owner countersign request sent." });
});

// Owner countersign page — get agreement by owner token
app.post("/portal/agreement/get-countersign", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Token required." });
  const { data, error } = await supabase.from("agreements").select("*").eq("owner_token", token).single();
  if (error || !data) return res.status(404).json({ error: "Agreement not found." });
  if (data.status === "fully_executed") return res.json({ success: true, agreement: data, already_signed: true });
  res.json({ success: true, agreement: data });
});

// Owner countersigns — final execution
app.post("/portal/agreement/countersign", async (req, res) => {
  const { token, owner_name, owner_signature_data } = req.body;
  if (!token || !owner_signature_data) return res.status(400).json({ error: "Token and signature required." });

  const { data: agreement, error: getErr } = await supabase.from("agreements").select("*").eq("owner_token", token).single();
  if (getErr || !agreement) return res.status(404).json({ error: "Agreement not found." });
  if (agreement.status === "fully_executed") return res.status(409).json({ error: "Already countersigned." });

  const executedDate = new Date().toLocaleDateString("en-US", { month:"long", day:"numeric", year:"numeric" });

  // Update Supabase — fully executed
  const { error: updateErr } = await supabase.from("agreements").update({
    status:               "fully_executed",
    owner_signature_data,
    owner_name:           owner_name || "My Smart Slots",
    executed_at:          new Date().toISOString(),
  }).eq("owner_token", token);
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  // Generate final PDF and send to all parties
  try {
    const pdfBuffer = await generateAgreementPDF({
      ...agreement,
      owner_signature_data,
      owner_name: owner_name || "My Smart Slots",
      executed_at: executedDate,
    });

    const emailOpts = {
      from: `"My Smart Slots" <${process.env.GMAIL_USER}>`,
      subject: `✓ Fully Executed — My Smart Slots Services Agreement (${agreement.plan_label})`,
      attachments: [{ filename:`MySmartSlots_Agreement_${agreement.client_name.replace(/\s+/g,"_")}.pdf`, content:pdfBuffer }],
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;">
        <div style="background:#1A1A2E;padding:24px;border-radius:12px 12px 0 0;text-align:center;"><h1 style="color:#00C896;margin:0;font-size:24px;">MY SMART SLOTS</h1></div>
        <div style="background:#f5f7fb;padding:32px;border-radius:0 0 12px 12px;border:1px solid #e4e8f0;">
          <p style="color:#16a34a;font-size:18px;font-weight:700;">✓ Agreement Fully Executed</p>
          <p style="color:#374151;line-height:1.7;">Your My Smart Slots Business Services Agreement has been signed by all parties. The fully executed copy is attached for your records.</p>
          <div style="background:#fff;border:1px solid #e4e8f0;border-radius:10px;padding:20px;margin:16px 0;">
            <div><strong>Client:</strong> ${agreement.client_name}</div>
            <div><strong>Plan:</strong> ${agreement.plan_label} · ${agreement.billing_type}</div>
            <div><strong>Executed:</strong> ${executedDate}</div>
          </div>
          <p style="color:#6b7280;font-size:13px;">Keep this email for your records. Questions? Call 785-329-0202 or email hello@mysmartslots.com.</p>
        </div></div>`
    };

    // Send final PDF to client, rep, and owner
    await emailTransporter.sendMail({ ...emailOpts, to: agreement.client_email });
    await emailTransporter.sendMail({ ...emailOpts, to: agreement.rep_email });
    await emailTransporter.sendMail({ ...emailOpts, to: OWNER_EMAIL });

  } catch (e) {
    console.error("Final PDF/email error:", e.message);
  }

  res.json({ success: true, message: "Agreement fully executed. Final PDF sent to all parties." });
});

// List agreements (admin)
app.post("/portal/agreement/list", requireAuth, requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from("agreements").select("*").order("created_at", { ascending:false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success:true, agreements: data || [] });
});

// Resend agreement email
app.post("/portal/agreement/resend", requireAuth, async (req, res) => {
  const { token } = req.body;
  const { data, error } = await supabase.from("agreements").select("*").eq("token", token).single();
  if (error || !data) return res.status(404).json({ error: "Agreement not found." });
  const signUrl = `https://mysmartslots.com/sign?token=${token}`;
  try {
    await emailTransporter.sendMail({
      from: `"My Smart Slots" <${process.env.GMAIL_USER}>`,
      to: data.client_email,
      subject: "Reminder — Please Sign Your My Smart Slots Agreement",
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;"><p>Hi ${data.client_name}, this is a reminder to sign your My Smart Slots services agreement.</p><p><a href="${signUrl}" style="background:#00C896;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;display:inline-block;">Sign Agreement →</a></p></div>`,
    });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── PDF GENERATOR ─────────────────────────────────────────────────────────────
function generateAgreementPDF(agreement) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ margin:72, size:"LETTER" });
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const GREEN = "#00C896";
    const NAVY  = "#1A1A2E";
    const GRAY  = "#6B7280";

    // Header
    doc.rect(0,0,612,80).fill(NAVY);
    doc.fillColor(GREEN).fontSize(22).font("Helvetica-Bold").text("MY SMART SLOTS", 72, 25, { align:"center" });
    doc.fillColor("white").fontSize(11).font("Helvetica").text("Business Services Agreement — Executed Copy", 72, 52, { align:"center" });

    doc.moveDown(3);

    // Cover info box
    doc.fillColor(NAVY).fontSize(13).font("Helvetica-Bold").text("Agreement Details", 72, 110);
    doc.moveTo(72,128).lineTo(540,128).stroke(GREEN);
    doc.moveDown(0.5);

    const details = [
      ["Client Business Name:", agreement.client_name],
      ["Client Representative:", agreement.signer_name],
      ["Plan Selected:", agreement.plan_label],
      ["Billing Type:", agreement.billing_type],
      ["Setup Fee:", `$${agreement.setup_fee}.00 (one-time)`],
      ["Agreement Date:", agreement.agreement_date],
      ["Account Manager:", agreement.rep_name],
      ["Signed On:", agreement.signed_at],
    ];

    details.forEach(([label, value]) => {
      doc.fillColor(GRAY).fontSize(10).font("Helvetica-Bold").text(label, 72, doc.y, { continued:true, width:180 });
      doc.fillColor(NAVY).font("Helvetica").text(value || "—");
    });

    doc.moveDown(1.5);
    doc.moveTo(72, doc.y).lineTo(540, doc.y).stroke("#E5E7EB");
    doc.moveDown(1);

    // Agreement text — all sections
    const sections = [
      ["1. Parties & Agreement Overview",
       `This Business Services Agreement ("Agreement") is entered into between Clair Group LLC, doing business as My Smart Slots ("Company"), and ${agreement.client_name} ("Client"). This Agreement governs your access to and use of My Smart Slots' AI-powered automation services including missed call follow-up, SMS booking confirmations, appointment reminders, AI chat booking, review requests, lead re-engagement, job status updates, calendar sync, and monthly reporting (collectively, the "Services"). By signing this Agreement, the Client agrees to all terms set forth herein.`],
      ["2. Services & Plan Description",
       `The Company will provide the Services associated with the ${agreement.plan_label} plan. All plans include: AI Chat Booking, SMS Confirmations, Appointment Reminders, Calendar Sync, Monthly Report, and a Dedicated Account Manager. Pro and Elite plans additionally include Missed Call Text Back, Live SMS Chat, and Post-Job Review Requests. Elite plan additionally includes Lead Re-Engagement, Partial Email Replies, Job Status Update Texts, and Quarterly Strategy Review. Service will be activated within 24 hours of receiving the completed onboard form.`],
      ["3. Fees, Billing & Payment Terms",
       `A one-time setup fee of $${agreement.setup_fee}.00 is due at signing. This fee is non-refundable once configuration begins. The Client has selected ${agreement.billing_type} billing at the rate associated with the ${agreement.plan_label} plan.\n\nMonthly subscribers may cancel at any time. Cancellation takes effect at the end of the current billing cycle.\n\nAnnual subscribers commit to a 12-month term. Refund schedule: within 30 days — full refund minus setup fee; days 31–90 — 25% of remaining balance only; day 91 and beyond — no refund, service continues through term end.`],
      ["4. 30-Day Results Guarantee",
       `If the Client does not see measurable improvement in the first 30 days of active service, the Company will provide month two at no charge. To invoke this guarantee, the Client must submit a written request to hello@mysmartslots.com within 37 days of service activation.`],
      ["5. Client Obligations",
       `The Client agrees to: complete the onboard form within 7 days of payment; provide a valid phone number for SMS configuration; provide calendar access where required; notify the Company of business changes within 5 business days; not use the Services for any unlawful purpose.`],
      ["6. Intellectual Property",
       `All software, systems, templates, and automation workflows are the exclusive property of Clair Group LLC. The Client is granted a limited, non-exclusive license to use the Services during the term of this Agreement. The Client retains ownership of all business data and customer information they provide.`],
      ["7. Limitation of Liability",
       `The Company's total liability for any claim shall not exceed the total fees paid in the three months preceding the claim. The Company is not liable for indirect, incidental, or consequential damages, or for interruptions caused by third-party providers.`],
      ["8. Governing Law",
       `This Agreement is governed by the laws of the State of Kansas. Disputes shall be submitted to binding arbitration in Topeka, Kansas under the rules of the American Arbitration Association.`],
      ["9. Electronic Signature",
       `The parties agree that electronic signatures are legally binding under the Electronic Signatures in Global and National Commerce Act (ESIGN) and the Uniform Electronic Transactions Act (UETA). This signed document constitutes a legally enforceable agreement.`],
    ];

    sections.forEach(([title, body]) => {
      if (doc.y > 650) doc.addPage();
      doc.fillColor(NAVY).fontSize(12).font("Helvetica-Bold").text(title, { underline:false });
      doc.moveDown(0.3);
      doc.fillColor("#374151").fontSize(10).font("Helvetica").text(body, { lineGap:3 });
      doc.moveDown(1);
    });

    // Signature section
    if (doc.y > 580) doc.addPage();
    doc.moveDown(1);
    doc.moveTo(72, doc.y).lineTo(540, doc.y).stroke(GREEN);
    doc.moveDown(0.5);
    doc.fillColor(NAVY).fontSize(13).font("Helvetica-Bold").text("10. Signatures");
    doc.moveDown(0.5);

    // Client signature
    doc.fillColor(NAVY).fontSize(11).font("Helvetica-Bold").text("Client / Authorized Representative");
    doc.moveDown(0.3);
    doc.fillColor(GRAY).fontSize(10).font("Helvetica").text(`Name: ${agreement.signer_name}`);
    doc.fillColor(GRAY).fontSize(10).text(`Title: ${agreement.signer_title || "Owner / Authorized Representative"}`);
    doc.fillColor(GRAY).fontSize(10).text(`Date: ${agreement.signed_at}`);
    doc.fillColor(GRAY).fontSize(10).text(`IP Address: ${agreement.signed_ip || "recorded"}`);
    doc.moveDown(0.5);

    // Draw signature image if available
    if (agreement.signature_data && agreement.signature_data.startsWith("data:image")) {
      try {
        const base64 = agreement.signature_data.split(",")[1];
        const imgBuf = Buffer.from(base64, "base64");
        doc.image(imgBuf, 72, doc.y, { width:200, height:60 });
        doc.moveDown(4);
      } catch(e) {
        doc.fillColor(GREEN).fontSize(11).text("[Signed electronically]");
        doc.moveDown(1);
      }
    } else {
      doc.fillColor(GREEN).fontSize(11).font("Helvetica-Bold").text("[Signed electronically]");
      doc.moveDown(1);
    }

    doc.moveTo(72, doc.y).lineTo(300, doc.y).stroke("#E5E7EB");
    doc.moveDown(0.3);
    doc.fillColor(GRAY).fontSize(9).font("Helvetica").text("Client Signature", 72, doc.y);
    doc.moveDown(1.5);

    // Company signature block
    doc.fillColor(NAVY).fontSize(11).font("Helvetica-Bold").text("My Smart Slots / Clair Group LLC");
    doc.moveDown(0.3);
    doc.fillColor(GRAY).fontSize(10).font("Helvetica").text("Title: Owner / Founder");
    doc.fillColor(GRAY).fontSize(10).text("Signature: ___________________________");
    doc.fillColor(GRAY).fontSize(10).text("Date: ___________________________");
    doc.moveDown(2);

    // Footer
    doc.moveTo(72, doc.y).lineTo(540, doc.y).stroke("#E5E7EB");
    doc.moveDown(0.5);
    doc.fillColor(GRAY).fontSize(9).text("My Smart Slots · Clair Group LLC · 785-329-0202 · hello@mysmartslots.com · mysmartslots.com", { align:"center" });
    doc.fillColor(GRAY).fontSize(9).text(`Document ID: ${agreement.token?.substring(0,16)}... · Generated: ${new Date().toISOString()}`, { align:"center" });

    doc.end();
  });
}

// ── REP AGREEMENT SYSTEM (Admin only) ────────────────────────────────────────
const REP_DETAILS = {
  orion1:  { name:"Orion",  email:"orion@mysmartslots.com"  },
  braden1: { name:"Braden", email:"braden@mysmartslots.com" },
  carson1: { name:"Carson", email:"carson@mysmartslots.com" },
  rep2:    { name:"Rep 2",  email:"rep2@mysmartslots.com"   },
};

app.post("/portal/rep-agreement/create", requireAuth, requireAdmin, async (req, res) => {
  const { rep_username, rep_name_custom, rep_email_custom, territory, start_date, agreement_type, referring_manager } = req.body;
  let repName, repEmail;
  if (rep_username && REP_DETAILS[rep_username]) {
    repName = REP_DETAILS[rep_username].name;
    repEmail = REP_DETAILS[rep_username].email;
  } else if (rep_name_custom && rep_email_custom) {
    repName = rep_name_custom;
    repEmail = rep_email_custom;
  } else {
    return res.status(400).json({ error: "Rep name and email required." });
  }
  const token      = crypto.randomBytes(32).toString("hex");
  const ownerToken = crypto.randomBytes(32).toString("hex");
  const today      = new Date().toLocaleDateString("en-US", { month:"long", day:"numeric", year:"numeric" });
  const expiresAt  = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const typeLabel  = agreement_type === "rep" ? "Rep Agreement" : "Partnership Agreement";

  const { error } = await supabase.from("rep_agreements").insert({
    token, owner_token: ownerToken, rep_name: repName, rep_email: repEmail,
    territory: territory || "Assigned Territory", start_date: start_date || today,
    agreement_date: today, agreement_type: agreement_type || "partnership",
    referring_manager: referring_manager || "", status: "pending",
    expires_at: expiresAt, created_at: new Date().toISOString(),
  });
  if (error) return res.status(500).json({ error: error.message });

  const signUrl = `https://mysmartslots.com/rep-sign?token=${token}`;
  try {
    await emailTransporter.sendMail({
      from: `"My Smart Slots" <${process.env.GMAIL_USER}>`,
      to: repEmail,
      subject: `My Smart Slots — Please Sign Your ${typeLabel}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;">
        <div style="background:#1A1A2E;padding:24px;border-radius:12px 12px 0 0;text-align:center;"><h1 style="color:#00C896;margin:0;font-size:24px;">MY SMART SLOTS</h1></div>
        <div style="background:#f5f7fb;padding:32px;border-radius:0 0 12px 12px;border:1px solid #e4e8f0;">
          <p style="font-size:16px;color:#111827;">Hi ${repName},</p>
          <p style="color:#374151;line-height:1.7;">Your My Smart Slots <strong>${typeLabel}</strong> is ready for your review and signature. Please read it carefully before signing.</p>
          <div style="background:#fff;border:1px solid #e4e8f0;border-radius:10px;padding:20px;margin:24px 0;">
            <div><strong>Type:</strong> ${typeLabel}</div>
            <div><strong>Territory:</strong> ${territory||"Assigned Territory"}</div>
            <div><strong>Start Date:</strong> ${start_date||today}</div>
            ${referring_manager?`<div><strong>Referring Manager:</strong> ${referring_manager}</div>`:""}
          </div>
          <div style="text-align:center;margin:32px 0;">
            <a href="${signUrl}" style="background:#00C896;color:#fff;padding:16px 40px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block;">Review & Sign Agreement →</a>
          </div>
          <p style="color:#6b7280;font-size:13px;">This link expires in 14 days. Questions? Call 785-329-0202.</p>
        </div></div>`,
    });
  } catch(e) { console.error("Rep agreement email error:", e.message); }
  res.json({ success: true, token, sign_url: signUrl });
});

app.post("/portal/rep-agreement/get", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Token required." });
  const { data, error } = await supabase.from("rep_agreements").select("*").eq("token", token).single();
  if (error || !data) return res.status(404).json({ error: "Agreement not found or expired." });
  if (data.status === "rep_signed" || data.status === "fully_executed") return res.json({ success:true, agreement:data, already_signed:true });
  if (new Date(data.expires_at) < new Date()) return res.status(410).json({ error: "This link has expired. Contact hello@mysmartslots.com for a new one." });
  res.json({ success: true, agreement: data });
});

app.post("/portal/rep-agreement/sign", async (req, res) => {
  const { token, signer_name, signature_data, agreed } = req.body;
  if (!token || !signer_name || !signature_data || !agreed) return res.status(400).json({ error: "All fields required." });
  const { data: agreement, error: getErr } = await supabase.from("rep_agreements").select("*").eq("token", token).single();
  if (getErr || !agreement) return res.status(404).json({ error: "Agreement not found." });
  if (agreement.status !== "pending") return res.status(409).json({ error: "Already signed." });

  const signedDate   = new Date().toLocaleDateString("en-US", { month:"long", day:"numeric", year:"numeric" });
  const ownerSignUrl = `https://mysmartslots.com/rep-countersign?token=${agreement.owner_token}`;
  const typeLabel    = agreement.agreement_type === "rep" ? "Rep Agreement" : "Partnership Agreement";

  const { error: updateErr } = await supabase.from("rep_agreements").update({
    status: "rep_signed", rep_signer_name: signer_name, signature_data, signed_at: new Date().toISOString(),
  }).eq("token", token);
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  try {
    await emailTransporter.sendMail({
      from: `"My Smart Slots" <${process.env.GMAIL_USER}>`, to: OWNER_EMAIL,
      subject: `✓ ${agreement.rep_name} signed their ${typeLabel} — countersign needed`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;">
        <div style="background:#1A1A2E;padding:24px;border-radius:12px 12px 0 0;text-align:center;"><h1 style="color:#00C896;margin:0;font-size:24px;">MY SMART SLOTS</h1></div>
        <div style="background:#f5f7fb;padding:32px;border-radius:0 0 12px 12px;border:1px solid #e4e8f0;">
          <p style="color:#16a34a;font-size:18px;font-weight:700;">✓ ${agreement.rep_name} signed their ${typeLabel}</p>
          <div style="background:#fff;border:1px solid #e4e8f0;border-radius:10px;padding:20px;margin:16px 0;">
            <div><strong>Rep:</strong> ${agreement.rep_name} (${agreement.rep_email})</div>
            <div><strong>Type:</strong> ${typeLabel}</div>
            <div><strong>Territory:</strong> ${agreement.territory}</div>
            <div><strong>Signed:</strong> ${signedDate}</div>
          </div>
          <div style="text-align:center;margin:24px 0;">
            <a href="${ownerSignUrl}" style="background:#00C896;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;display:inline-block;">Countersign Agreement →</a>
          </div>
        </div></div>`,
    });
    await emailTransporter.sendMail({
      from: `"My Smart Slots" <${process.env.GMAIL_USER}>`, to: agreement.rep_email,
      subject: `✓ ${typeLabel} Received — Countersignature in Progress`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;">
        <div style="background:#1A1A2E;padding:24px;border-radius:12px 12px 0 0;text-align:center;"><h1 style="color:#00C896;margin:0;font-size:24px;">MY SMART SLOTS</h1></div>
        <div style="background:#f5f7fb;padding:32px;border-radius:0 0 12px 12px;border:1px solid #e4e8f0;">
          <p style="color:#16a34a;font-size:18px;font-weight:700;">✓ Your signature was received</p>
          <p style="color:#374151;line-height:1.7;">Hi ${agreement.rep_name}, your ${typeLabel} has been received. The owner will countersign shortly and you'll receive the fully executed copy via email.</p>
          <p style="color:#374151;font-weight:700;">Welcome to the team. 🚀</p>
        </div></div>`,
    });
  } catch(e) { console.error("Rep sign email error:", e.message); }
  res.json({ success: true, message: "Agreement signed. Owner notified." });
});

app.post("/portal/rep-agreement/get-countersign", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Token required." });
  const { data, error } = await supabase.from("rep_agreements").select("*").eq("owner_token", token).single();
  if (error || !data) return res.status(404).json({ error: "Agreement not found." });
  if (data.status === "fully_executed") return res.json({ success:true, agreement:data, already_signed:true });
  res.json({ success: true, agreement: data });
});

app.post("/portal/rep-agreement/countersign", async (req, res) => {
  const { token, owner_signature_data, owner_name } = req.body;
  if (!token || !owner_signature_data) return res.status(400).json({ error: "Token and signature required." });
  const { data: agreement, error: getErr } = await supabase.from("rep_agreements").select("*").eq("owner_token", token).single();
  if (getErr || !agreement) return res.status(404).json({ error: "Agreement not found." });
  if (agreement.status === "fully_executed") return res.status(409).json({ error: "Already countersigned." });

  const executedDate = new Date().toLocaleDateString("en-US", { month:"long", day:"numeric", year:"numeric" });
  const typeLabel    = agreement.agreement_type === "rep" ? "Rep Agreement" : "Partnership Agreement";

  const { error: updateErr } = await supabase.from("rep_agreements").update({
    status: "fully_executed", owner_signature_data, owner_name: owner_name || "My Smart Slots / Clair Group LLC", executed_at: new Date().toISOString(),
  }).eq("owner_token", token);
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  try {
    const pdfBuffer = await generateRepAgreementPDF({ ...agreement, owner_signature_data, executed_at: executedDate });
    const emailOpts = {
      from: `"My Smart Slots" <${process.env.GMAIL_USER}>`,
      subject: `✓ Fully Executed — My Smart Slots ${typeLabel}`,
      attachments: [{ filename:`MySmartSlots_${typeLabel.replace(/ /g,"_")}_${agreement.rep_name.replace(/ /g,"_")}.pdf`, content:pdfBuffer }],
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;">
        <div style="background:#1A1A2E;padding:24px;border-radius:12px 12px 0 0;text-align:center;"><h1 style="color:#00C896;margin:0;font-size:24px;">MY SMART SLOTS</h1></div>
        <div style="background:#f5f7fb;padding:32px;border-radius:0 0 12px 12px;border:1px solid #e4e8f0;">
          <p style="color:#16a34a;font-size:18px;font-weight:700;">✓ ${typeLabel} Fully Executed</p>
          <p style="color:#374151;line-height:1.7;">The fully executed copy is attached for your records.</p>
          <div style="background:#fff;border:1px solid #e4e8f0;border-radius:10px;padding:20px;margin:16px 0;">
            <div><strong>Rep:</strong> ${agreement.rep_name}</div>
            <div><strong>Territory:</strong> ${agreement.territory}</div>
            <div><strong>Executed:</strong> ${executedDate}</div>
          </div>
        </div></div>`,
    };
    await emailTransporter.sendMail({ ...emailOpts, to: agreement.rep_email });
    await emailTransporter.sendMail({ ...emailOpts, to: OWNER_EMAIL });
  } catch(e) { console.error("Rep countersign PDF error:", e.message); }
  res.json({ success: true });
});

app.post("/portal/rep-agreement/list", requireAuth, requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from("rep_agreements").select("*").order("created_at", { ascending:false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success:true, agreements: data || [] });
});

function generateRepAgreementPDF(agreement) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ margin:72, size:"LETTER", bufferPages:true });
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const typeLabel = agreement.agreement_type === "rep" ? "Rep Agreement" : "Partnership Agreement";
    const isRep = agreement.agreement_type === "rep";
    const n  = agreement.rep_name || "_______________";
    const t  = agreement.territory || "Assigned Territory";
    const sd = agreement.start_date || "_______________";
    const d  = agreement.agreement_date || "_______________";
    const rm = agreement.referring_manager || "";

    const NAVY  = "#1A1A2E";
    const GREEN = "#00C896";
    const GRAY  = "#6B7280";
    const BODY  = "#374151";

    // Helper functions
    const h1 = (text) => {
      if (doc.y > 680) doc.addPage();
      doc.moveDown(0.5);
      doc.fillColor(NAVY).fontSize(12).font("Helvetica-Bold").text(text);
      doc.moveTo(72, doc.y+2).lineTo(540, doc.y+2).stroke(GREEN);
      doc.moveDown(0.4);
    };
    const h2 = (text) => {
      doc.fillColor(NAVY).fontSize(11).font("Helvetica-Bold").text(text);
      doc.moveDown(0.2);
    };
    const p = (text) => {
      if (doc.y > 700) doc.addPage();
      doc.fillColor(BODY).fontSize(10).font("Helvetica").text(text, { lineGap:3 });
      doc.moveDown(0.4);
    };
    const highlight = (text) => {
      if (doc.y > 680) doc.addPage();
      doc.rect(72, doc.y, 468, doc.heightOfString(text, {width:448})+16).fill("#E6FAF5");
      doc.fillColor("#065F46").fontSize(10).font("Helvetica-Bold").text(text, 86, doc.y-doc.heightOfString(text,{width:448})-8, {width:448, lineGap:3});
      doc.moveDown(0.6);
    };
    const warn = (text) => {
      if (doc.y > 680) doc.addPage();
      doc.rect(72, doc.y, 468, doc.heightOfString(text, {width:448})+16).fill("#FFFBEB");
      doc.fillColor("#78350F").fontSize(10).font("Helvetica-Bold").text(text, 86, doc.y-doc.heightOfString(text,{width:448})-8, {width:448, lineGap:3});
      doc.moveDown(0.6);
    };
    const tableRow = (cells, widths, bold=false, header=false) => {
      if (doc.y > 700) doc.addPage();
      const rowY = doc.y;
      let x = 72;
      cells.forEach((cell, i) => {
        if (header) doc.rect(x, rowY, widths[i], 18).fill(NAVY);
        doc.fillColor(header?"#FFFFFF":bold?"#1A1A2E":BODY)
           .fontSize(9).font(header||bold?"Helvetica-Bold":"Helvetica")
           .text(cell, x+4, rowY+4, {width:widths[i]-8, lineBreak:false});
        x += widths[i];
      });
      doc.moveTo(72, rowY+20).lineTo(540, rowY+20).stroke("#E5E7EB");
      doc.y = rowY + 22;
    };

    // ── COVER PAGE ─────────────────────────────────────────────────────────────
    doc.rect(0,0,612,90).fill(NAVY);
    doc.fillColor(GREEN).fontSize(24).font("Helvetica-Bold").text("MY SMART SLOTS", 72, 22, {align:"center"});
    doc.fillColor("white").fontSize(12).font("Helvetica-Bold").text(`ACCOUNT MANAGER ${typeLabel.toUpperCase()}`, 72, 54, {align:"center"});
    doc.fillColor(GRAY).fontSize(10).font("Helvetica").text("Clair Group LLC  |  785-329-0202  |  hello@mysmartslots.com", 72, 74, {align:"center"});

    doc.y = 110;
    doc.fillColor(NAVY).fontSize(11).font("Helvetica-Bold").text("Agreement Details");
    doc.moveTo(72, doc.y+2).lineTo(540, doc.y+2).stroke(GREEN);
    doc.moveDown(0.5);

    const details = [
      ["Rep Name:", n],
      ["Agreement Type:", typeLabel],
      ["Territory:", t],
      ["Start Date:", sd],
      ["Agreement Date:", d],
      ...(rm?[["Referring Manager:", rm]]:[]),
      ["Rep Signed:", agreement.signed_at ? new Date(agreement.signed_at).toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"}) : "—"],
      ["Executed:", agreement.executed_at || "—"],
    ];
    details.forEach(([label, value]) => {
      doc.fillColor(GRAY).fontSize(10).font("Helvetica-Bold").text(label, 72, doc.y, {continued:true, width:160});
      doc.fillColor(NAVY).font("Helvetica").text(value||"—");
    });

    doc.moveDown(1);
    doc.moveTo(72,doc.y).lineTo(540,doc.y).stroke("#E5E7EB");
    doc.moveDown(0.5);

    // ── AGREEMENT BODY ─────────────────────────────────────────────────────────
    if (isRep) {
      h1("1. Parties & Agreement Overview");
      p(`This Account Manager Rep Agreement ("Agreement") is entered into between Clair Group LLC, doing business as My Smart Slots ("Company"), ${rm?"the Referring Manager "+rm+' ("Referring Manager"),':""} and ${n} ("Rep", "you").`);
      p("This Agreement governs the independent contractor relationship, including commission structure, performance incentives, advancement eligibility, and all related terms. This Agreement differs from the original Account Manager Partnership Agreement in commission rate, trip eligibility structure, and advancement terms.");
      warn("The Rep is an independent contractor — not an employee. This Agreement does not create an employment relationship or entitle the Rep to benefits.");

      h1("2. Role & Responsibilities");
      p("The Rep will represent My Smart Slots to prospective clients under the supervision of their Referring Manager. Responsibilities include prospecting, running audit calls, managing pipeline, sending agreements, collecting payment, facilitating onboarding, and maintaining client relationships.");
      p("The Rep agrees to complete all 7 training modules before making first client contact, maintain accurate pipeline records, and report activity to their Referring Manager.");
      h2("2.1 First Independent Close Requirement");
      p("Milestone bonuses and incentive eligibility do not activate until the Rep's first fully independent close is confirmed — defined the same as in the original Partnership Agreement. During onboarding the Referring Manager or Company owner may participate in joint audit calls. The Company owner has sole authority to designate whether a close qualifies as independent.");

      h1("3. Commission Structure");
      p("The Rep earns 25% of the monthly subscription price for every active client they close, paid monthly for as long as the client remains active. This is lifetime recurring commission.");
      doc.moveDown(0.2);
      tableRow(["Plan","Monthly","Annual","Your Monthly Commission","Annual Commission"],[80,70,80,160,78],false,true);
      tableRow(["Starter","$125/mo","$1,250/yr","$31.25/mo","$312.50"],[80,70,80,160,78]);
      tableRow(["Pro (Recommended)","$225/mo","$2,250/yr","$56.25/mo","$562.50"],[80,70,80,160,78],true);
      tableRow(["Elite","$375/mo","$3,750/yr","$93.75/mo","$937.50"],[80,70,80,160,78]);
      doc.moveDown(0.4);
      p("A setup bonus of $50.00 is paid within 7 business days of each new client's first payment clearing. Monthly commission is paid on the last Friday of each month. W-9 required before first payment.");
      warn("25% is the Rep's base rate. The 5% difference from the standard 30% funds the override income earned by the Referring Manager and their upline. This structure is fixed and not negotiable.");
      h2("3.1 Book Report Commission Bonus");
      p("For every qualifying book report submitted and approved by the Company owner, the Rep earns a permanent +0.5% commission increase on all active accounts, up to a maximum of +5.0% (10 books). A qualifying report must include: book title and author, key lessons learned, specific takeaways applicable to sales and client management, and how the Rep plans to apply it to their approach and personal growth.");

      h1("4. Advancement Eligibility");
      p("Advancement is available to Reps who demonstrate sustained performance, professional conduct, and leadership potential. Advancement is not guaranteed and is granted at the Company owner's sole discretion.");
      h2("4.1 Path to Jr Regional Manager");
      p("A Rep who reaches 25 active clients, demonstrates consistent independent performance, and receives endorsement from their Referring Manager may be considered for promotion to Jr Regional Manager status. Upon promotion, the Rep graduates to the full Account Manager Partnership Agreement terms — including 30% commission, override eligibility, and company MRR trip eligibility.");
      highlight("Promotion to Jr Regional Manager converts this Rep Agreement to a full Partnership Agreement. All prior active clients are credited toward the new commission structure effective the following billing cycle.");
      p("The decision to promote rests entirely with the Company owner. The Referring Manager may recommend but not unilaterally promote a Rep.");

      h1("5. Company Trip Eligibility");
      p("Reps covered by this Agreement are eligible for company incentive trips based on their own personal active client milestones — not company-wide MRR milestones.");
      doc.moveDown(0.2);
      tableRow(["Rep's Active Clients","Incentive","Details"],[130,130,208],false,true);
      tableRow(["10 active clients","Team Dinner","Invited to the next team dinner event"],[130,130,208]);
      tableRow(["20 active clients","Weekend Trip","2 nights — hotel and meals covered"],[130,130,208]);
      tableRow(["35 active clients","Company Retreat","3–4 days — flights and accommodation covered"],[130,130,208]);
      tableRow(["50 active clients","Premium Destination","5 days international — fully covered"],[130,130,208]);
      doc.moveDown(0.4);
      p("Trip eligibility is cumulative — once a Rep hits a milestone, they retain eligibility for that tier's incentive regardless of future client fluctuation, provided they remain in good standing.");

      h1("6. Monthly Leaderboard");
      p("Reps participate in the same monthly points leaderboard as Account Managers. Points: new close +3, retained client +1, churn -5. Top performer with at least 1 new close earns $100 cash. Quarterly perfect retention bonus of $150 applies.");

      h1("7. General Provisions");
      p("Independent Contractor: The Rep is an independent contractor. Nothing in this Agreement creates employment.");
      p("Anti-Poaching: The Rep may not recruit existing Company clients or active reps for competing businesses during the term and for 90 days following termination.");
      p("90-Day Tail: Upon termination, the Rep earns commission on existing active clients for 90 calendar days.");
      p("Governing Law: This Agreement is governed by the laws of the State of Kansas.");
      p("Entire Agreement: This Agreement supersedes all prior discussions between the parties.");
      p("Amendments: Changes require written consent from the Company owner.");

    } else {

      h1("1. Parties & Agreement Overview");
      p(`This Account Manager Partnership Agreement ("Agreement") is entered into between Clair Group LLC, doing business as My Smart Slots ("Company"), and ${n} ("Account Manager", "you").`);
      p("This Agreement governs the independent contractor relationship between the parties, including commission structure, career advancement, team building rights, incentive programs, and all related terms.");
      warn("The Account Manager is an independent contractor — not an employee. This Agreement does not create an employment relationship, entitle the Account Manager to benefits, or obligate the Company to provide a minimum income.");

      h1("2. Role & Responsibilities");
      p("The Account Manager will represent My Smart Slots to prospective clients in their assigned territory. Responsibilities include prospecting, running audit calls, managing pipeline, sending client agreements, collecting payment, facilitating onboarding, and maintaining client relationships.");
      p("The Account Manager agrees to complete all 7 training modules before making their first client contact, maintain accurate pipeline records, and conduct themselves professionally in all interactions.");
      h2("2.1 First Independent Close Requirement");
      p("An Account Manager is not considered fully active until completing their first fully independent close — defined as running an audit call, sending the client agreement, and generating the payment link without direct assistance from the owner. A close may be credited as independent during a joint call if the Account Manager takes full lead, with the owner present in an observational role only.");
      highlight("Closes completed with owner assistance still earn 30% commission. However milestone bonuses and incentive eligibility do not activate until the first independent close is confirmed by the owner.");

      h1("3. Commission Structure");
      h2("3.1 Base Commission");
      p("The Account Manager earns 30% of the monthly subscription price for every active client they close, paid monthly for as long as the client remains active. This is lifetime recurring commission.");
      doc.moveDown(0.2);
      tableRow(["Plan","Monthly","Annual","Your Monthly Commission","Annual Commission"],[80,70,80,160,78],false,true);
      tableRow(["Starter","$125/mo","$1,250/yr","$37.50/mo","$312.50"],[80,70,80,160,78]);
      tableRow(["Pro (Recommended)","$225/mo","$2,250/yr","$67.50/mo","$562.50"],[80,70,80,160,78],true);
      tableRow(["Elite","$375/mo","$3,750/yr","$112.50/mo","$937.50"],[80,70,80,160,78]);
      doc.moveDown(0.4);
      p("Annual commission is paid out upon receipt of the client's annual payment. Monthly commission is paid on the last Friday of each month. A one-time setup bonus of $50.00 is paid within 7 business days of each new client's first payment clearing.");
      warn("A client is considered closed only when their first payment clears through Stripe. Verbal commitments and signed agreements alone do not trigger commission.");
      h2("3.2 Book Report Commission Bonus");
      p("For every business, sales, or personal development book the Account Manager reads and submits a qualifying book report to the owner, they earn a permanent commission increase of +0.5% on all active accounts, up to a maximum of +5.0% (10 books). A qualifying report must include: book title and author, key lessons learned, specific takeaways applicable to sales and client management, and how they plan to apply the content to their sales approach and personal growth. Reports must be substantive — summaries copied from the internet will not be accepted.");
      highlight("Example: An Account Manager who completes 6 qualifying book reports earns 33% commission on all active accounts instead of 30%. This increase is permanent and applies to all existing and future clients.");

      h1("4. Career Advancement & Tier Structure");
      doc.moveDown(0.2);
      tableRow(["Tier","Active Clients","Commission","Override","Advancement Bonus"],[130,80,70,90,98],false,true);
      tableRow(["Account Manager","0–24","30%","None","$500 at 10 clients"],[130,80,70,90,98]);
      tableRow(["Jr Regional Manager","25–49","30%","See §5","$1,000 cash"],[130,80,70,90,98],true);
      tableRow(["Sr Regional Manager","50+","30%","See §5","$2,000 cash"],[130,80,70,90,98],true);
      doc.moveDown(0.4);
      h2("4.1 Individual Milestone Bonuses");
      doc.moveDown(0.2);
      tableRow(["Milestone","Bonus","Additional"],[180,150,138],false,true);
      tableRow(["First independent close","$100 cash","Fully active status activated"],[180,150,138]);
      tableRow(["5 active clients","$250 cash",""],[180,150,138]);
      tableRow(["10 active clients","$500 cash",""],[180,150,138]);
      tableRow(["25 active clients","$1,000 cash + Jr Regional Manager","Override income begins"],[180,150,138]);
      tableRow(["50 active clients","$2,000 cash + Sr Regional Manager","Bought-In eligibility"],[180,150,138]);
      doc.moveDown(0.4);

      h1("5. Override Income & Downline Structure");
      p("Upon reaching Jr Regional Manager status, the Account Manager earns override commissions on closes made by Account Managers they recruit and manage:");
      doc.moveDown(0.2);
      tableRow(["Level","Who","Override Rate"],[80,220,168],false,true);
      tableRow(["Level 1","Your direct recruits' closes","15% (Sr Regional Manager) / 10% (Jr Regional Manager)"],[80,220,168]);
      tableRow(["Level 2","Your recruits' recruits' closes","7%"],[80,220,168]);
      tableRow(["Level 3","Third level down","3%"],[80,220,168]);
      doc.moveDown(0.4);
      p("Override income is paid on the last Friday of each month alongside regular commission. Override income only applies to Account Managers recruited through the manager's direct efforts or their downline team.");

      h1("6. Team Building & Hiring Authority");
      h2("6.1 Jr Regional Manager Hiring Authority");
      p("May recruit and interview candidates. Final interview requires the Company owner plus any available Sr Regional Managers. May maintain up to 5 direct recruits without additional owner approval. Expanding beyond 5 requires explicit written approval from the owner. Owner retains final hiring authority on all candidates.");
      h2("6.2 Sr Regional Manager Hiring Authority");
      p("May recruit with no cap on team size. All final interviews require the owner's attendance. All available Sr Regional Managers must attend final interviews. Owner retains final hiring authority.");
      h2("6.3 Anti-Poaching & Downline Protection");
      p("Account Managers may not recruit existing Company clients, active Account Managers, or employees of active clients for competing businesses during the term and for 90 days following termination. A 90-day tail applies — commission continues on existing active clients for 90 calendar days after termination.");
      h2("6.4 Account Managers Hired by Managers");
      p("Account Managers recruited by Jr or Sr Regional Managers are governed by a separate Rep Agreement at 25% base commission. Managers are responsible for ensuring their recruits sign the correct agreement before beginning any client-facing work.");

      h1("7. Bought-In Status (Sr Regional Manager Passive Transition)");
      p("Upon reaching Sr Regional Manager status, the Account Manager becomes eligible to apply for Bought-In status — a formal transition from active selling to a team leadership and oversight role, while retaining all override income.");
      h2("7.1 Eligibility Requirements");
      p("Must hold Sr Regional Manager status with 50+ active personal clients. Must have at least one Jr Regional Manager actively managing a team within their downline. The team must be generating a combined minimum of $5,000 MRR. Must receive written approval from the Company owner.");
      h2("7.2 Bought-In Rights & Obligations");
      p("No longer required to make personal cold calls or close new personal clients. Role transitions to team oversight, training support, and strategic input. Retains 100% of existing override income on all downline levels. May promote one qualified Account Manager to Jr Regional Manager status, subject to owner approval.");
      warn("If the team's combined MRR drops below $5,000 in any given month, the Bought-In Sr Regional Manager reverts to active status and must resume personal selling until the threshold is restored for two consecutive months.");

      h1("8. Company Incentive Program");
      p("The following company-wide incentives apply to all original Account Managers covered by this Agreement. Eligibility is based on company-wide Monthly Recurring Revenue (MRR) milestones:");
      doc.moveDown(0.2);
      tableRow(["Company MRR","Incentive","Details"],[120,140,208],false,true);
      tableRow(["$5,000/mo","Team Dinner","Full team — strategy and celebration"],[120,140,208]);
      tableRow(["$15,000/mo","Weekend Trip","2 nights — hotel and meals fully covered"],[120,140,208]);
      tableRow(["$30,000/mo","Company Retreat","3–4 days — flights and accommodation covered"],[120,140,208]);
      tableRow(["$50,000/mo","Premium Destination","5 days international — full team, all covered"],[120,140,208]);
      doc.moveDown(0.4);
      p("Milestones are permanent once hit — they never reset. Good standing required. These milestones are Year 1 terms only. New incentive goals will be negotiated annually.");

      h1("9. Monthly Leaderboard & Performance Recognition");
      p("Points: new client closed +3, active client retained +1, client churned -5. Top Account Manager with at least 1 new close earns $100 cash at month end. Jr and Sr Regional Managers compete separately. Quarterly perfect retention bonus of $150 awarded to any Account Manager who retains 100% of their client base for a full quarter.");

      h1("10. Payment Terms");
      p("All commission and bonus payments are made via CashApp or cashier's check. Monthly recurring commission is paid on the last Friday of each month. Setup bonuses, milestone bonuses, and advancement bonuses are paid within 7 business days of the qualifying event. W-9 required before first commission payment. Payments of $600+ per year reported on 1099-NEC.");

      h1("11. General Provisions");
      p("Independent Contractor: Nothing in this Agreement creates employment, partnership, or agency.");
      p("Governing Law: This Agreement is governed by the laws of the State of Kansas.");
      p("Entire Agreement: This Agreement supersedes all prior discussions, representations, and agreements between the parties.");
      p("Amendments: Changes to this Agreement require written consent from both parties.");
      p("Good Standing: All bonuses, incentives, and advancement recognition require the Account Manager to be in good standing.");
      p("Year 1 Term: Company incentive milestones and leaderboard terms apply to Year 1 only.");
    }

    // ── SIGNATURES ─────────────────────────────────────────────────────────────
    if (doc.y > 580) doc.addPage();
    h1("Signatures");
    p("By signing below, all parties acknowledge they have read, understand, and agree to all terms of this Agreement. Electronic signatures are legally binding under the ESIGN Act and UETA.");

    doc.moveDown(0.5);

    // Rep signature
    doc.fillColor(NAVY).fontSize(11).font("Helvetica-Bold").text("Rep / Account Manager");
    doc.moveDown(0.2);
    doc.fillColor(GRAY).fontSize(10).font("Helvetica").text(`Name: ${agreement.rep_signer_name || n}`);
    doc.fillColor(GRAY).text(`Date: ${agreement.signed_at ? new Date(agreement.signed_at).toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"}) : "—"}`);
    doc.moveDown(0.4);
    if (agreement.signature_data && agreement.signature_data.startsWith("data:image")) {
      try {
        const b = Buffer.from(agreement.signature_data.split(",")[1],"base64");
        doc.image(b, 72, doc.y, {width:200, height:60});
        doc.y += 68;
      } catch(e) { doc.fillColor(GREEN).text("[Signed electronically]"); }
    }
    doc.moveTo(72,doc.y).lineTo(300,doc.y).stroke("#E5E7EB");
    doc.fillColor(GRAY).fontSize(9).text("Account Manager Signature");
    doc.moveDown(1.5);

    // Owner signature
    doc.fillColor(NAVY).fontSize(11).font("Helvetica-Bold").text("My Smart Slots / Clair Group LLC");
    doc.moveDown(0.2);
    doc.fillColor(GRAY).fontSize(10).font("Helvetica").text(`Name: ${agreement.owner_name || "My Smart Slots / Clair Group LLC"}`);
    doc.fillColor(GRAY).text("Title: Owner / Founder");
    doc.fillColor(GRAY).text(`Executed: ${agreement.executed_at || "—"}`);
    doc.moveDown(0.4);
    if (agreement.owner_signature_data && agreement.owner_signature_data.startsWith("data:image")) {
      try {
        const b = Buffer.from(agreement.owner_signature_data.split(",")[1],"base64");
        doc.image(b, 72, doc.y, {width:200, height:60});
        doc.y += 68;
      } catch(e) { doc.fillColor(GREEN).text("[Countersigned electronically]"); }
    }
    doc.moveTo(72,doc.y).lineTo(300,doc.y).stroke("#E5E7EB");
    doc.fillColor(GRAY).fontSize(9).text("Owner Signature");
    doc.moveDown(2);

    // Footer
    doc.moveTo(72,doc.y).lineTo(540,doc.y).stroke("#E5E7EB");
    doc.moveDown(0.5);
    doc.fillColor(GRAY).fontSize(9).text("My Smart Slots · Clair Group LLC · 785-329-0202 · hello@mysmartslots.com · mysmartslots.com", {align:"center"});
    doc.fillColor(GRAY).fontSize(8).text(`Document ID: ${agreement.token?.substring(0,16)}... · Generated: ${new Date().toISOString()} · Confidential — Internal Use Only`, {align:"center"});

    doc.end();
  });
}


const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`MySmartSlots portal server running on port ${PORT}`));
