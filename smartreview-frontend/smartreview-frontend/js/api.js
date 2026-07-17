/* ============================================================
   SmartReview Frontend — API Client (api.js)
   RULE: This is the ONLY file allowed to call fetch().
   All pages import this and use the named methods.
   Response shapes match exactly what the backend returns.
   ============================================================ */
'use strict';

const API = (() => {

  // ── CONFIG ────────────────────────────────────────────────
  const BASE  = (window.SR_CONFIG?.API_URL) || 'http://localhost:3000/api/v1';
  const TOKEN_KEY   = 'sr_access_token';
  const USER_KEY    = 'sr_user';

  // ── TOKEN STORAGE ─────────────────────────────────────────
  const getToken  = ()  => localStorage.getItem(TOKEN_KEY);
  const setToken  = (t) => localStorage.setItem(TOKEN_KEY, t);
  const getUser   = ()  => { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } };
  const setUser   = (u) => localStorage.setItem(USER_KEY, JSON.stringify(u));
  const clearAuth = ()  => { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); };
  const isLoggedIn= ()  => !!getToken();

  // ── ERROR CLASS ───────────────────────────────────────────
  class ApiError extends Error {
    constructor(message, status = 0, details = null) {
      super(message);
      this.name = 'ApiError'; this.status = status; this.details = details;
    }
  }

  // ── CORE REQUEST (only place fetch() is called) ───────────
  async function request(method, path, body = null, opts = {}) {
    const url     = path.startsWith('http') ? path : `${BASE}${path}`;
    const token   = getToken();
    const headers = {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...opts.headers,
    };

    let res;
    try {
      res = await fetch(url, {
        method: method.toUpperCase(),
        headers,
        ...(body !== null && { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError('Network error — check your internet connection', 0);
    }

    // 401: clear auth and redirect to login
    if (res.status === 401 && !opts._retry) {
      clearAuth();
      if (!window.location.pathname.includes('login')) {
        window.location.href = '/login.html?expired=1';
      }
      throw new ApiError('Session expired', 401);
    }

    let data;
    try { data = await res.json(); } catch { data = {}; }

    if (!res.ok) {
      throw new ApiError(
        data.error || data.message || `Request failed (${res.status})`,
        res.status,
        data.details || null
      );
    }
    return data;
  }

  const get  = (path, opts)  => request('GET',    path, null, opts || {});
  const post = (path, body)  => request('POST',   path, body);
  const patch= (path, body)  => request('PATCH',  path, body);
  const del  = (path)        => request('DELETE', path);

  // ── QUERY STRING BUILDER ──────────────────────────────────
  function qs(params = {}) {
    if (!params) return '';
    return Object.entries(params)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }

  // ── PAGE GUARDS ───────────────────────────────────────────
  function requireAuth() {
    if (!isLoggedIn()) {
      window.location.href = `/login.html?next=${encodeURIComponent(window.location.pathname)}`;
      return false;
    }
    return true;
  }
  function requireGuest() {
    if (isLoggedIn()) { window.location.href = '/dashboard.html'; return false; }
    return true;
  }

  // ══════════════════════════════════════════════════════════
  //  AUTH  — mirrors authController.js exactly
  //  Controller: authController.js
  //  Table: restaurants
  //  Routes: POST /register, /login, /logout,
  //          /forgot-password, /reset-password, /change-password
  //          GET  /me, /sessions   PATCH /me
  // ══════════════════════════════════════════════════════════
  const auth = {
    // POST /auth/register → { token, restaurant }
    register: (data) => post('/auth/register', data),

    // POST /auth/login → { token, restaurant }
    login: (email, password) => post('/auth/login', { email, password }),

    // POST /auth/logout → { message }
    logout: () => post('/auth/logout').finally(clearAuth),

    // POST /auth/forgot-password → { message }
    forgotPassword: (email) => post('/auth/forgot-password', { email }),

    // POST /auth/reset-password → { message }
    resetPassword: (email, otp, new_password) =>
      post('/auth/reset-password', { email, otp, new_password }),

    // POST /auth/change-password → { message }
    changePassword: (current_password, new_password) =>
      post('/auth/change-password', { current_password, new_password }),

    // GET /auth/me → { data: { id, name, email, phone, owner_name, plan, city, ... } }
    me: () => get('/auth/me'),

    // PATCH /auth/me → { data: { id, name, email, plan, phone, city } }
    updateMe: (data) => patch('/auth/me', data),

    // GET /auth/sessions → { data: [...] }
    sessions: () => get('/auth/sessions'),

    // Helper — login then store token + user
    loginAndStore: async (email, password) => {
      const data = await auth.login(email, password);
      // Backend returns: { token, restaurant: { id, name, email, plan, is_active } }
      setToken(data.token);
      setUser(data.restaurant);
      return data;
    },

    // Helper — register then store token + user
    registerAndStore: async (payload) => {
      const data = await auth.register(payload);
      setToken(data.token);
      setUser(data.restaurant);
      return data;
    },
  };

  // ══════════════════════════════════════════════════════════
  //  ANALYTICS  — analyticsController.js
  //  Table: bills, feedback (aggregated)
  // ══════════════════════════════════════════════════════════
  const analytics = {
    overview:        (p)    => get(`/analytics/overview?${qs(p)}`),
    revenueChart:    (days) => get(`/analytics/revenue-chart?days=${days||7}`),
    heatmap:         ()     => get('/analytics/heatmap'),
    peakHours:       ()     => get('/analytics/peak-hours'),
    complaints:      ()     => get('/analytics/complaints'),
    forecast:        ()     => get('/analytics/forecast'),
    menuPerformance: ()     => get('/analytics/menu-performance'),
    paymentMethods:  ()     => get('/analytics/payment-methods'),
    branchComparison:()     => get('/analytics/branch-comparison'),
  };

  // ══════════════════════════════════════════════════════════
  //  BILLS  — billController.js
  //  Table: bills, bill_items
  // ══════════════════════════════════════════════════════════
  const bills = {
    list:         (p)         => get(`/bills?${qs(p)}`),
    create:       (data)      => post('/bills', data),
    get:          (id)        => get(`/bills/${id}`),
    updateStatus: (id, status)=> patch(`/bills/${id}/status`, { status }),
  };

  // ══════════════════════════════════════════════════════════
  //  MENU  — menuController.js
  //  Table: menu_items, menu_categories
  // ══════════════════════════════════════════════════════════
  const menu = {
    list:    (p)      => get(`/menu?${qs(p)}`),
    create:  (data)   => post('/menu', data),
    update:  (id, d)  => patch(`/menu/${id}`, d),
    remove:  (id)     => del(`/menu/${id}`),
    toggle:  (id)     => patch(`/menu/${id}/toggle-availability`),
    categories: {
      list:   ()      => get('/menu/categories'),
      create: (data)  => post('/menu/categories', data),
      update: (id, d) => patch(`/menu/categories/${id}`, d),
      remove: (id)    => del(`/menu/categories/${id}`),
    },
  };

  // ══════════════════════════════════════════════════════════
  //  FEEDBACK  — feedbackController.js
  //  Table: feedback
  // ══════════════════════════════════════════════════════════
  const feedback = {
    list:    (p)    => get(`/feedback?${qs(p)}`),
    summary: ()     => get('/feedback/summary'),
    submit:  (data) => post('/feedback/submit', data),
  };

  // ══════════════════════════════════════════════════════════
  //  PAYMENTS  — paymentController.js
  //  Table: payments
  // ══════════════════════════════════════════════════════════
  const payments = {
    createOrder: (data) => post('/payments/create-order', data),
    verify:      (data) => post('/payments/verify', data),
    cash:        (data) => post('/payments/cash', data),
    list:        (p)    => get(`/payments?${qs(p)}`),
  };

  // ══════════════════════════════════════════════════════════
  //  STAFF  — staffController.js
  //  Table: staff, table_assignments
  // ══════════════════════════════════════════════════════════
  const staff = {
    list:        (p)      => get(`/staff?${qs(p)}`),
    create:      (data)   => post('/staff', data),
    update:      (id, d)  => patch(`/staff/${id}`, d),
    remove:      (id)     => del(`/staff/${id}`),
    performance: (days)   => get(`/staff/performance?days=${days||7}`),
    assignments: (p)      => get(`/staff/table-assignments?${qs(p)}`),
    assignTable: (data)   => post('/staff/assign-table', data),
    shifts:      ()       => get('/staff/shifts'),
    updateShift: (id, s)  => patch(`/staff/${id}/shift`, { shift: s }),
  };

  // ══════════════════════════════════════════════════════════
  //  INVENTORY  — inventoryController.js
  //  Table: inventory_items, inventory_transactions
  // ══════════════════════════════════════════════════════════
  const inventory = {
    list:         (p)     => get(`/inventory?${qs(p)}`),
    alerts:       ()      => get('/inventory/alerts'),
    suppliers:    ()      => get('/inventory/suppliers'),
    transactions: (p)     => get(`/inventory/transactions?${qs(p)}`),
    create:       (data)  => post('/inventory', data),
    update:       (id, d) => patch(`/inventory/${id}`, d),
    remove:       (id)    => del(`/inventory/${id}`),
    transact:     (id, d) => post(`/inventory/${id}/transaction`, d),
  };

  // ══════════════════════════════════════════════════════════
  //  REPORTS  — reportController.js
  //  Table: report_schedules, whatsapp_messages
  // ══════════════════════════════════════════════════════════
  const reports = {
    preview:   (type)  => get(`/reports/preview?type=${type||'daily'}`),
    sendNow:   (data)  => post('/reports/send-now', data),
    schedules: ()      => get('/reports/schedules'),
    upsert:    (data)  => post('/reports/schedules', data),
    history:   ()      => get('/reports/history'),
  };

  // ══════════════════════════════════════════════════════════
  //  LOYALTY  — loyaltyController.js
  //  Table: loyalty_transactions, loyalty_tiers, loyalty_rewards
  // ══════════════════════════════════════════════════════════
  const loyalty = {
    customer:     (id)      => get(`/loyalty/customer/${id}`),
    byPhone:      (ph, rid) => get(`/loyalty/customer/by-phone/${ph}?restaurant_id=${rid}`),
    rewards:      ()        => get('/loyalty/rewards'),
    createReward: (data)    => post('/loyalty/rewards', data),
    updateReward: (id, d)   => patch(`/loyalty/rewards/${id}`, d),
    redeem:       (data)    => post('/loyalty/redeem', data),
    tiers:        ()        => get('/loyalty/tiers'),
    updateTier:   (t, d)    => patch(`/loyalty/tiers/${t}`, d),
    leaderboard:  ()        => get('/loyalty/leaderboard'),
  };

  // ── PUBLIC EXPORT ──────────────────────────────────────────
  return {
    get, post, patch, del,
    getToken, setToken, getUser, setUser, clearAuth, isLoggedIn,
    requireAuth, requireGuest,
    auth, analytics, bills, menu, feedback,
    payments, staff, inventory, reports, loyalty,
    ApiError,
  };

})();

window.API = API;

// ── HONEST REVIEW MODE API additions ─────────────────────────
// Appended to existing api.js — do not remove anything above
const _origFeedback = API.feedback;
Object.assign(API.feedback, {
  unresolved:      ()          => API.get('/feedback/unresolved'),
  resolve:         (id, note)  => API.post(`/feedback/${id}/resolve`, { resolution_note: note }),
  resolutionStats: ()          => API.get('/feedback/resolution-stats'),
  redeemCoupon:    (code, rid) => API.post('/feedback/coupon/redeem', { coupon_code: code, restaurant_id: rid }),
});
Object.assign(API.auth, {
  toggleHonestMode: (enabled)  => API.patch('/auth/honest-review-mode', { enabled }),
});
