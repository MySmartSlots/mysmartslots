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
import crypto from "crypto";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";

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

// Submit signed agreement
app.post("/portal/agreement/sign", async (req, res) => {
  const { token, signer_name, signer_title, signature_data, ip_address, agreed } = req.body;
  if (!token || !signer_name || !signature_data || !agreed) {
    return res.status(400).json({ error: "Token, name, signature, and agreement are required." });
  }

  // Get agreement
  const { data: agreement, error: getErr } = await supabase.from("agreements").select("*").eq("token", token).single();
  if (getErr || !agreement) return res.status(404).json({ error: "Agreement not found." });
  if (agreement.status === "signed") return res.status(409).json({ error: "Agreement already signed." });

  const signedAt = new Date().toISOString();
  const signedDate = new Date().toLocaleDateString("en-US", { month:"long", day:"numeric", year:"numeric" });

  // Update Supabase
  const { error: updateErr } = await supabase.from("agreements").update({
    status:         "signed",
    signer_name,
    signer_title:   signer_title || "Owner / Authorized Representative",
    signature_data,
    signed_at:      signedAt,
    signed_ip:      ip_address || "unknown",
  }).eq("token", token);
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  // Generate PDF and send emails
  try {
    const pdfBuffer = await generateAgreementPDF({ ...agreement, signer_name, signer_title, signature_data, signed_at:signedDate });

    const emailOpts = {
      from: `"My Smart Slots" <${process.env.GMAIL_USER}>`,
      attachments: [{ filename:`MySmartSlots_Agreement_${agreement.client_name.replace(/\s+/g,"_")}.pdf`, content:pdfBuffer }],
    };

    // Email client
    await emailTransporter.sendMail({ ...emailOpts, to:agreement.client_email, subject:"✓ Signed — My Smart Slots Services Agreement",
      html:`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;">
        <div style="background:#1A1A2E;padding:24px;border-radius:12px 12px 0 0;text-align:center;"><h1 style="color:#00C896;margin:0;font-size:24px;">MY SMART SLOTS</h1></div>
        <div style="background:#f5f7fb;padding:32px;border-radius:0 0 12px 12px;border:1px solid #e4e8f0;">
          <p style="color:#16a34a;font-size:18px;font-weight:700;">✓ Agreement Signed Successfully</p>
          <p style="color:#374151;line-height:1.7;">Hi ${agreement.client_name}, thank you for signing. Your fully executed agreement is attached to this email. Keep it for your records.</p>
          <p style="color:#374151;line-height:1.7;">Your Account Manager <strong>${agreement.rep_name}</strong> will be in touch shortly with your payment link. Once payment is complete your automations will be live within 24 hours.</p>
          <p style="color:#6b7280;font-size:13px;">Questions? Contact ${agreement.rep_email} or call 785-329-0202.</p>
        </div></div>`
    });

    // Email rep
    await emailTransporter.sendMail({ ...emailOpts, to:agreement.rep_email, subject:`✓ ${agreement.client_name} signed — send payment link now`,
      html:`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;">
        <div style="background:#1A1A2E;padding:24px;border-radius:12px 12px 0 0;text-align:center;"><h1 style="color:#00C896;margin:0;font-size:24px;">MY SMART SLOTS</h1></div>
        <div style="background:#f5f7fb;padding:32px;border-radius:0 0 12px 12px;border:1px solid #e4e8f0;">
          <p style="color:#16a34a;font-size:18px;font-weight:700;">✓ ${agreement.client_name} just signed their agreement</p>
          <p style="color:#374151;line-height:1.7;"><strong>Action required:</strong> Log into the billing page and send the payment link now.</p>
          <div style="background:#fff;border:1px solid #e4e8f0;border-radius:10px;padding:20px;margin:16px 0;">
            <div><strong>Client:</strong> ${agreement.client_name} (${agreement.client_email})</div>
            <div><strong>Plan:</strong> ${agreement.plan_label}</div>
            <div><strong>Billing:</strong> ${agreement.billing_type}</div>
            <div><strong>Signed:</strong> ${signedDate}</div>
          </div>
          <div style="text-align:center;margin:24px 0;">
            <a href="https://mysmartslots.com/financial" style="background:#00C896;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;display:inline-block;">Send Payment Link →</a>
          </div>
          <p style="color:#6b7280;font-size:12px;">The signed agreement PDF is attached for your records.</p>
        </div></div>`
    });

    // Email owner
    await emailTransporter.sendMail({ ...emailOpts, to:OWNER_EMAIL, subject:`New signed agreement — ${agreement.client_name} (${agreement.plan_label})`,
      html:`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;">
        <div style="background:#1A1A2E;padding:24px;border-radius:12px 12px 0 0;text-align:center;"><h1 style="color:#00C896;margin:0;font-size:24px;">MY SMART SLOTS</h1></div>
        <div style="background:#f5f7fb;padding:32px;border-radius:0 0 12px 12px;border:1px solid #e4e8f0;">
          <p style="color:#16a34a;font-size:18px;font-weight:700;">New Agreement Signed</p>
          <div style="background:#fff;border:1px solid #e4e8f0;border-radius:10px;padding:20px;margin:16px 0;">
            <div><strong>Client:</strong> ${agreement.client_name} (${agreement.client_email})</div>
            <div><strong>Plan:</strong> ${agreement.plan_label}</div>
            <div><strong>Billing:</strong> ${agreement.billing_type}</div>
            <div><strong>Rep:</strong> ${agreement.rep_name} (${agreement.rep_email})</div>
            <div><strong>Setup Fee:</strong> $${agreement.setup_fee}</div>
            <div><strong>Signed:</strong> ${signedDate}</div>
          </div>
          <p style="color:#6b7280;font-size:12px;">Signed agreement attached. ${agreement.rep_name} has been notified to send the payment link.</p>
        </div></div>`
    });
  } catch (e) {
    console.error("PDF/email error:", e.message);
    // Agreement is saved — return success even if email fails
  }

  res.json({ success: true, message: "Agreement signed. PDF sent to all parties." });
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`MySmartSlots portal server running on port ${PORT}`));
