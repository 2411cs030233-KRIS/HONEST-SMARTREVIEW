/* ============================================================
   SmartReview Frontend — Shared App Utilities
   js/app.js  — Load after api.js on every page
   ============================================================ */

'use strict';

/* ── CONFIG ──────────────────────────────────────────────────── */
window.SR_CONFIG = {
  API_URL: 'http://localhost:3000/api/v1',  // Change to your Railway URL for production
  APP_NAME: 'SmartReview',
};

/* ── TOAST SYSTEM ───────────────────────────────────────────── */
const Toast = (() => {
  let container;

  function _getContainer() {
    if (!container) {
      container = document.getElementById('toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
      }
    }
    return container;
  }

  function show(message, type = 'info', duration = 4000) {
    const icons = { success: 'ti-check-circle', error: 'ti-alert-circle', warning: 'ti-alert-triangle', info: 'ti-info-circle' };
    const c = _getContainer();
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.innerHTML = `
      <i class="ti ${icons[type] || icons.info}"></i>
      <span class="toast-msg">${message}</span>
      <button class="toast-close" onclick="this.closest('.toast').remove()"><i class="ti ti-x"></i></button>`;
    c.appendChild(t);
    if (duration > 0) setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(20px)'; t.style.transition = 'all .3s'; setTimeout(() => t.remove(), 300); }, duration);
    return t;
  }

  return {
    success: (msg, dur) => show(msg, 'success', dur),
    error:   (msg, dur) => show(msg, 'error',   dur),
    warning: (msg, dur) => show(msg, 'warning', dur),
    info:    (msg, dur) => show(msg, 'info',    dur),
  };
})();
window.Toast = Toast;

/* ── FORM HELPERS ───────────────────────────────────────────── */
const Form = {
  // Set loading state on a button
  setLoading(btn, loading, text = null) {
    if (!btn) return;
    if (loading) {
      btn.dataset.originalText = btn.innerHTML;
      btn.disabled = true;
      btn.classList.add('btn-loading');
      if (text) btn.textContent = text;
    } else {
      btn.disabled = false;
      btn.classList.remove('btn-loading');
      if (btn.dataset.originalText) btn.innerHTML = btn.dataset.originalText;
    }
  },

  // Show field-level error
  showError(inputId, message) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.classList.add('error');
    const err = input.closest('.form-group')?.querySelector('.form-error');
    if (err) { err.textContent = message; err.classList.add('show'); }
  },

  // Clear field-level error
  clearError(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.classList.remove('error');
    const err = input.closest('.form-group')?.querySelector('.form-error');
    if (err) err.classList.remove('show');
  },

  // Clear all errors in a form
  clearAllErrors(formEl) {
    formEl.querySelectorAll('.form-input.error').forEach(el => el.classList.remove('error'));
    formEl.querySelectorAll('.form-error.show').forEach(el => el.classList.remove('show'));
  },

  // Serialize form to object
  serialize(formEl) {
    const data = {};
    new FormData(formEl).forEach((v, k) => { data[k] = v; });
    return data;
  },

  // Validate and show API error details
  handleApiError(err, formEl = null) {
    if (err.details && Array.isArray(err.details) && formEl) {
      err.details.forEach(detail => {
        const field = detail.match(/"([^"]+)"/)?.[1];
        if (field) Form.showError(field, detail);
      });
    }
    Toast.error(err.message || 'Something went wrong');
  },
};
window.Form = Form;

/* ── MODAL SYSTEM ───────────────────────────────────────────── */
const Modal = {
  open(id) {
    const el = document.getElementById(id);
    if (el) { el.classList.add('open'); document.body.style.overflow = 'hidden'; }
  },
  close(id) {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('open'); document.body.style.overflow = ''; }
  },
  closeAll() {
    document.querySelectorAll('.modal-overlay.open').forEach(el => el.classList.remove('open'));
    document.body.style.overflow = '';
  },
};
window.Modal = Modal;

// Close modal on overlay click
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) Modal.closeAll();
});
// Close modal on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') Modal.closeAll();
});

/* ── DROPDOWN SYSTEM ────────────────────────────────────────── */
document.addEventListener('click', (e) => {
  const trigger = e.target.closest('[data-dropdown]');
  if (trigger) {
    e.stopPropagation();
    const targetId = trigger.dataset.dropdown;
    const menu = document.getElementById(targetId);
    if (menu) {
      const isOpen = menu.classList.contains('open');
      document.querySelectorAll('.dropdown-menu.open').forEach(m => m.classList.remove('open'));
      if (!isOpen) menu.classList.add('open');
    }
    return;
  }
  // Close all dropdowns when clicking outside
  document.querySelectorAll('.dropdown-menu.open').forEach(m => m.classList.remove('open'));
});

/* ── NUMBER FORMATTERS ──────────────────────────────────────── */
const Format = {
  currency: (n, compact = false) => {
    if (n == null) return '₹0';
    if (compact && n >= 100000) return `₹${(n/100000).toFixed(1)}L`;
    if (compact && n >= 1000)   return `₹${(n/1000).toFixed(1)}K`;
    return `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  },
  number: (n) => Number(n || 0).toLocaleString('en-IN'),
  percent: (n) => `${Number(n || 0).toFixed(1)}%`,
  rating: (n) => Number(n || 0).toFixed(1),
  date: (d) => d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—',
  dateTime: (d) => d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—',
  timeAgo: (d) => {
    if (!d) return '—';
    const diff = (Date.now() - new Date(d)) / 1000;
    if (diff < 60)    return 'just now';
    if (diff < 3600)  return `${Math.floor(diff/60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
    return `${Math.floor(diff/86400)}d ago`;
  },
  initials: (name) => (name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase(),
  stars: (n) => '★'.repeat(Math.round(n || 0)) + '☆'.repeat(5 - Math.round(n || 0)),
  planLabel: (plan) => ({ basic: 'Basic', premium: 'Premium', pro: 'Pro' }[plan] || plan),
};
window.Format = Format;

/* ── SIDEBAR ACTIVE STATE ───────────────────────────────────── */
function setSidebarActive() {
  const page = window.location.pathname.split('/').pop() || 'dashboard.html';
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.classList.toggle('active', item.dataset.page === page);
  });
}

/* ── SIDEBAR TOGGLE (mobile) ────────────────────────────────── */
function initSidebarToggle() {
  const toggle  = document.getElementById('sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (!toggle || !sidebar) return;

  toggle.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('open');
  });
  overlay?.addEventListener('click', () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  });
}

/* ── USER MENU ──────────────────────────────────────────────── */
function initUserMenu() {
  const user = API.getUser();
  if (!user) return;

  // Populate sidebar user card
  const nameEl = document.getElementById('user-name');
  const planEl = document.getElementById('user-plan');
  const avatarEl = document.getElementById('user-avatar');
  if (nameEl) nameEl.textContent = user.name || user.owner_name || 'Restaurant';
  if (planEl) planEl.textContent = Format.planLabel(user.plan) + ' plan';
  if (avatarEl) avatarEl.textContent = Format.initials(user.name || user.owner_name);

  // Topbar restaurant name
  const restNameEl = document.getElementById('restaurant-name');
  if (restNameEl) restNameEl.textContent = user.name || '';
}

/* ── LOGOUT ─────────────────────────────────────────────────── */
async function logout() {
  try { await API.auth.logout(); } catch (_) {}
  finally { API.clearAuth(); window.location.href = '/login.html'; }
}
window.logout = logout;

/* ── LOAD STATS ON DASHBOARD ────────────────────────────────── */
async function loadTopbarAlerts() {
  try {
    const [inv, feedback] = await Promise.allSettled([
      API.inventory.alerts(),
      API.feedback.summary(),
    ]);
    const lowStock = inv.value?.count || 0;
    const badge = document.getElementById('alert-badge');
    if (badge && lowStock > 0) { badge.textContent = lowStock; badge.style.display = 'flex'; }
  } catch (_) {}
}

/* ── PASSWORD STRENGTH ──────────────────────────────────────── */
function checkPasswordStrength(pwd) {
  let score = 0;
  if (pwd.length >= 8)  score++;
  if (pwd.length >= 12) score++;
  if (/[A-Z]/.test(pwd)) score++;
  if (/[0-9]/.test(pwd)) score++;
  if (/[^A-Za-z0-9]/.test(pwd)) score++;
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
  const colors = ['', '#D94040', '#C47F1A', '#84cc16', '#0E9E6A'];
  return { score: Math.min(score, 4), label: labels[Math.min(score, 4)], color: colors[Math.min(score, 4)] };
}
window.checkPasswordStrength = checkPasswordStrength;

/* ── SKELETON LOADERS ───────────────────────────────────────── */
function showSkeletons(containerId, count = 3, height = 60) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = Array(count).fill(0).map(() =>
    `<div class="skeleton skeleton-block" style="height:${height}px;margin-bottom:10px"></div>`
  ).join('');
}
window.showSkeletons = showSkeletons;

/* ── CHART HELPERS (uses Chart.js from CDN) ─────────────────── */
const Charts = {
  _defaults: {
    font: { family: 'Plus Jakarta Sans', size: 12 },
    color: '#9CA3AF',
  },

  bar(canvasId, labels, data, label = '', color = '#4A3CCC') {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    if (canvas._chart) canvas._chart.destroy();
    const chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label, data, backgroundColor: color + '99', borderColor: color, borderWidth: 2, borderRadius: 6 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => Format.currency(ctx.raw) } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#9CA3AF', font: Charts._defaults.font } },
          y: { grid: { color: '#F3F4F6' }, ticks: { color: '#9CA3AF', callback: v => Format.currency(v, true), font: Charts._defaults.font } },
        },
      },
    });
    canvas._chart = chart;
    return chart;
  },

  line(canvasId, labels, data, label = '', color = '#4A3CCC') {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    if (canvas._chart) canvas._chart.destroy();
    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label, data, borderColor: color, backgroundColor: color + '15',
          borderWidth: 2.5, pointRadius: 4, pointBackgroundColor: color,
          tension: 0.4, fill: true,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#9CA3AF', font: Charts._defaults.font } },
          y: { grid: { color: '#F3F4F6' }, ticks: { color: '#9CA3AF', callback: v => Format.currency(v, true), font: Charts._defaults.font } },
        },
      },
    });
    canvas._chart = chart;
    return chart;
  },

  doughnut(canvasId, labels, data, colors) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    if (canvas._chart) canvas._chart.destroy();
    const chart = new Chart(canvas, {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0, hoverOffset: 4 }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '68%',
        plugins: { legend: { position: 'bottom', labels: { padding: 16, font: Charts._defaults.font, color: '#4B5563' } } },
      },
    });
    canvas._chart = chart;
    return chart;
  },
};
window.Charts = Charts;

/* ── INIT (runs on every page that includes this script) ─────── */
document.addEventListener('DOMContentLoaded', () => {
  setSidebarActive();
  initSidebarToggle();
  initUserMenu();
  if (API.isLoggedIn()) loadTopbarAlerts();
});
