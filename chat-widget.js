(function(){
  // ── CONFIG ──────────────────────────────────────────────────────────────────
  const SCRIPT_EL = document.currentScript || (function(){
    const scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();

  const params    = new URLSearchParams(SCRIPT_EL.src.split('?')[1] || '');
  const CLIENT_ID = params.get('client') || 'demo';
  const API_URL   = 'https://mysmartslots-chat.onrender.com';

  // ── STYLES ──────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #mss-widget * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    #mss-bubble {
      position: fixed; bottom: 24px; right: 24px; z-index: 999999;
      width: 56px; height: 56px; border-radius: 50%;
      background: var(--mss-color, #00C896); color: #fff;
      border: none; cursor: pointer; font-size: 24px;
      box-shadow: 0 4px 20px rgba(0,0,0,.25);
      display: flex; align-items: center; justify-content: center;
      transition: transform .2s, box-shadow .2s;
    }
    #mss-bubble:hover { transform: scale(1.08); box-shadow: 0 6px 28px rgba(0,0,0,.3); }
    #mss-bubble .mss-badge {
      position: absolute; top: -4px; right: -4px;
      background: #EF4444; color: #fff; border-radius: 50%;
      width: 20px; height: 20px; font-size: 11px; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
      border: 2px solid #fff;
    }
    #mss-window {
      position: fixed; bottom: 92px; right: 24px; z-index: 999998;
      width: 360px; height: 520px; border-radius: 18px;
      background: #fff; box-shadow: 0 8px 40px rgba(0,0,0,.2);
      display: none; flex-direction: column; overflow: hidden;
      border: 1px solid rgba(0,0,0,.08);
      animation: mssSlideUp .25s ease;
    }
    @keyframes mssSlideUp {
      from { opacity: 0; transform: translateY(16px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @media (max-width: 480px) {
      #mss-window {
        width: calc(100vw - 24px); right: 12px; bottom: 82px;
        height: calc(100vh - 110px); border-radius: 18px;
      }
    }
    #mss-header {
      background: var(--mss-color, #00C896);
      padding: 14px 16px; display: flex; align-items: center; gap: 10px;
      flex-shrink: 0;
    }
    .mss-avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: rgba(255,255,255,.25);
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; flex-shrink: 0;
    }
    .mss-header-info { flex: 1; min-width: 0; }
    .mss-header-name { font-size: 14px; font-weight: 700; color: #fff; }
    .mss-header-status { font-size: 11px; color: rgba(255,255,255,.8); display: flex; align-items: center; gap: 4px; }
    .mss-status-dot { width: 7px; height: 7px; border-radius: 50%; background: #fff; opacity: .9; }
    #mss-close {
      background: none; border: none; color: rgba(255,255,255,.8);
      font-size: 20px; cursor: pointer; padding: 4px; line-height: 1;
    }
    #mss-close:hover { color: #fff; }
    #mss-messages {
      flex: 1; overflow-y: auto; padding: 16px;
      display: flex; flex-direction: column; gap: 10px;
      scroll-behavior: smooth;
    }
    #mss-messages::-webkit-scrollbar { width: 4px; }
    #mss-messages::-webkit-scrollbar-track { background: transparent; }
    #mss-messages::-webkit-scrollbar-thumb { background: #ddd; border-radius: 2px; }
    .mss-msg {
      max-width: 82%; padding: 10px 13px; border-radius: 16px;
      font-size: 13.5px; line-height: 1.55; word-break: break-word;
    }
    .mss-msg.bot {
      background: #F1F5F9; color: #1E293B;
      border-radius: 4px 16px 16px 16px; align-self: flex-start;
    }
    .mss-msg.user {
      background: var(--mss-color, #00C896); color: #fff;
      border-radius: 16px 4px 16px 16px; align-self: flex-end;
    }
    .mss-booking-btn {
      display: inline-block; margin-top: 8px;
      background: var(--mss-color, #00C896); color: #fff !important;
      padding: 8px 16px; border-radius: 8px; font-size: 13px;
      font-weight: 700; text-decoration: none; cursor: pointer;
    }
    .mss-typing {
      display: flex; align-items: center; gap: 4px;
      padding: 10px 14px; background: #F1F5F9;
      border-radius: 4px 16px 16px 16px;
      align-self: flex-start; width: fit-content;
    }
    .mss-typing span {
      width: 7px; height: 7px; border-radius: 50%;
      background: #94A3B8; display: inline-block;
      animation: mssBounce 1.2s infinite;
    }
    .mss-typing span:nth-child(2) { animation-delay: .2s; }
    .mss-typing span:nth-child(3) { animation-delay: .4s; }
    @keyframes mssBounce {
      0%,80%,100% { transform: translateY(0); }
      40% { transform: translateY(-5px); }
    }
    #mss-input-wrap {
      padding: 12px; border-top: 1px solid #F1F5F9;
      display: flex; gap: 8px; flex-shrink: 0; background: #fff;
    }
    #mss-input {
      flex: 1; border: 1.5px solid #E2E8F0; border-radius: 22px;
      padding: 9px 14px; font-size: 13.5px; outline: none;
      color: #1E293B; background: #F8FAFC; resize: none;
      max-height: 80px; line-height: 1.4;
      transition: border-color .15s;
    }
    #mss-input:focus { border-color: var(--mss-color, #00C896); background: #fff; }
    #mss-send {
      width: 38px; height: 38px; border-radius: 50%;
      background: var(--mss-color, #00C896); color: #fff;
      border: none; cursor: pointer; font-size: 16px;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; transition: opacity .15s; align-self: flex-end;
    }
    #mss-send:hover { opacity: .85; }
    #mss-send:disabled { opacity: .4; cursor: not-allowed; }
    .mss-powered {
      text-align: center; font-size: 10px; color: #CBD5E1;
      padding: 4px 0 8px; flex-shrink: 0;
    }
    .mss-powered a { color: #CBD5E1; text-decoration: none; }
  `;
  document.head.appendChild(style);

  // ── DOM ─────────────────────────────────────────────────────────────────────
  const widget = document.createElement('div');
  widget.id = 'mss-widget';
  widget.innerHTML = `
    <button id="mss-bubble" aria-label="Open chat">
      💬
      <div class="mss-badge">1</div>
    </button>
    <div id="mss-window" role="dialog" aria-label="Chat with us">
      <div id="mss-header">
        <div class="mss-avatar">🤖</div>
        <div class="mss-header-info">
          <div class="mss-header-name" id="mss-biz-name">Loading...</div>
          <div class="mss-header-status"><div class="mss-status-dot"></div>Online · Usually replies instantly</div>
        </div>
        <button id="mss-close" aria-label="Close chat">×</button>
      </div>
      <div id="mss-messages"></div>
      <div id="mss-input-wrap">
        <textarea id="mss-input" placeholder="Type a message..." rows="1" aria-label="Message"></textarea>
        <button id="mss-send" aria-label="Send">➤</button>
      </div>
      <div class="mss-powered">Powered by <a href="https://mysmartslots.com" target="_blank" rel="noopener">My Smart Slots</a></div>
    </div>`;
  document.body.appendChild(widget);

  // ── STATE ────────────────────────────────────────────────────────────────────
  let history = [];
  let opened  = false;
  let config  = null;

  const bubble  = document.getElementById('mss-bubble');
  const win     = document.getElementById('mss-window');
  const msgs    = document.getElementById('mss-messages');
  const input   = document.getElementById('mss-input');
  const sendBtn = document.getElementById('mss-send');
  const closeBtn= document.getElementById('mss-close');

  // ── LOAD CONFIG ──────────────────────────────────────────────────────────────
  async function loadConfig() {
    try {
      const r = await fetch(`${API_URL}/config?client=${CLIENT_ID}`);
      if (r.ok) {
        config = await r.json();
        applyConfig(config);
      }
    } catch(e) {
      // Use defaults
      applyConfig({ business_name: 'Us', brand_color: '#00C896' });
    }
  }

  function applyConfig(cfg) {
    if (!cfg) return;
    const color = cfg.brand_color || '#00C896';
    document.documentElement.style.setProperty('--mss-color', color);
    const nameEl = document.getElementById('mss-biz-name');
    if (nameEl && cfg.business_name) nameEl.textContent = cfg.business_name;
  }

  // ── MESSAGES ─────────────────────────────────────────────────────────────────
  function addMsg(text, role, bookingUrl) {
    const el = document.createElement('div');
    el.className = 'mss-msg ' + role;
    el.textContent = text;
    if (bookingUrl) {
      const a = document.createElement('a');
      a.href = bookingUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'mss-booking-btn';
      a.textContent = 'Book Your Appointment →';
      el.appendChild(document.createElement('br'));
      el.appendChild(a);
    }
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }

  function showTyping() {
    const el = document.createElement('div');
    el.className = 'mss-typing';
    el.innerHTML = '<span></span><span></span><span></span>';
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }

  // ── SEND ─────────────────────────────────────────────────────────────────────
  async function send() {
    const text = input.value.trim();
    if (!text || sendBtn.disabled) return;
    input.value = '';
    input.style.height = 'auto';
    addMsg(text, 'user');
    history.push({ role: 'user', content: text });
    sendBtn.disabled = true;

    const typing = showTyping();
    try {
      const r = await fetch(`${API_URL}/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ messages: history, client_id: CLIENT_ID }),
      });
      const d = await r.json();
      typing.remove();
      const reply = d.reply || d.error || 'Sorry, something went wrong. Please try again.';
      addMsg(reply, 'bot', d.booking_url || null);
      history.push({ role: 'assistant', content: reply });
    } catch(e) {
      typing.remove();
      addMsg("Sorry, I'm having trouble connecting right now. Please call us directly.", 'bot');
    }
    sendBtn.disabled = false;
    input.focus();
  }

  // ── OPEN / CLOSE ─────────────────────────────────────────────────────────────
  bubble.addEventListener('click', () => {
    win.style.display = 'flex';
    bubble.style.display = 'none';
    if (!opened) {
      opened = true;
      setTimeout(() => {
        const greeting = config?.greeting ||
          `👋 Hi! I'm here to help answer questions or schedule a service. What can I help you with today?`;
        addMsg(greeting, 'bot');
      }, 400);
    }
    setTimeout(() => input.focus(), 300);
  });

  closeBtn.addEventListener('click', () => {
    win.style.display = 'none';
    bubble.style.display = 'flex';
    // Remove badge after first open
    const badge = bubble.querySelector('.mss-badge');
    if (badge) badge.remove();
  });

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 80) + 'px';
  });

  // ── INIT ─────────────────────────────────────────────────────────────────────
  loadConfig();

  // Add /config endpoint handler note — the greeting + brand_color come from config
  // If /config doesn't exist yet the widget uses defaults and still works fine

})();
