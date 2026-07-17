/* ============================================================
   SmartReview — Shared Layout Builder
   js/layout.js — Builds sidebar + topbar HTML on every app page
   ============================================================ */

function buildLayout({ page = '', title = '', subtitle = '', actions = '' } = {}) {
  const sidebarHTML = `
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-logo">
      <div class="logo-mark"><i class="ti ti-star"></i></div>
      <span class="logo-text">Smart<span>Review</span></span>
    </div>

    <div class="sidebar-section">Main</div>
    <a href="dashboard.html"  class="nav-item" data-page="dashboard.html">
      <i class="ti ti-layout-dashboard"></i> Dashboard
    </a>
    <a href="billing.html"    class="nav-item" data-page="billing.html">
      <i class="ti ti-receipt"></i> Billing
    </a>
    <a href="feedback.html"   class="nav-item" data-page="feedback.html">
      <i class="ti ti-star"></i> Feedback
      <span class="nav-badge" id="feedback-badge" style="display:none">0</span>
    </a>
    <a href="analytics.html"  class="nav-item" data-page="analytics.html">
      <i class="ti ti-chart-bar"></i> Analytics
    </a>

    <div class="sidebar-section">Management</div>
    <a href="menu.html"       class="nav-item" data-page="menu.html">
      <i class="ti ti-tools-kitchen-2"></i> Menu
    </a>
    <a href="#" onclick="comingSoon('Staff');return false"      class="nav-item" data-page="staff.html">
      <i class="ti ti-users"></i> Staff
    </a>
    <a href="#" onclick="comingSoon('Inventory');return false"  class="nav-item" data-page="inventory.html">
      <i class="ti ti-package"></i> Inventory
      <span class="nav-badge" id="inv-badge" style="display:none">0</span>
    </a>
    <a href="#" onclick="comingSoon('Loyalty');return false"    class="nav-item" data-page="loyalty.html">
      <i class="ti ti-gift"></i> Loyalty
    </a>

    <div class="sidebar-section">Reports</div>
    <a href="honest-complaints.html" class="nav-item" data-page="honest-complaints.html">
      <i class="ti ti-heart-handshake"></i> Honest Reviews
      <span class="nav-badge" id="honest-badge" style="display:none">0</span>
    </a>
    <a href="#" onclick="comingSoon('WhatsApp');return false" class="nav-item" data-page="whatsapp.html">
      <i class="ti ti-brand-whatsapp"></i> WhatsApp
    </a>
    <a href="#" onclick="comingSoon('Reports');return false"    class="nav-item" data-page="reports.html">
      <i class="ti ti-file-analytics"></i> Reports
    </a>

    <div class="sidebar-section">Account</div>
    <a href="settings.html"   class="nav-item" data-page="settings.html">
      <i class="ti ti-settings"></i> Settings
    </a>
    <a href="profile.html"    class="nav-item" data-page="profile.html">
      <i class="ti ti-user-circle"></i> Profile
    </a>

    <div class="sidebar-footer">
      <div class="user-card" data-dropdown="user-dropdown">
        <div class="avatar avatar-sm" id="user-avatar">SR</div>
        <div class="user-info">
          <div class="user-name truncate" id="user-name">Loading…</div>
          <div class="user-plan" id="user-plan">—</div>
        </div>
        <i class="ti ti-chevron-up" style="font-size:.85rem"></i>
      </div>
      <div class="dropdown-menu" id="user-dropdown" style="bottom:100%;top:auto;margin-bottom:6px">
        <a href="profile.html" class="dropdown-item"><i class="ti ti-user"></i> View profile</a>
        <a href="settings.html" class="dropdown-item"><i class="ti ti-settings"></i> Settings</a>
        <div class="dropdown-separator"></div>
        <button class="dropdown-item danger" onclick="logout()"><i class="ti ti-logout"></i> Sign out</button>
      </div>
    </div>
  </aside>

  <div class="sidebar-overlay" id="sidebar-overlay"></div>`;

  const topbarHTML = `
  <div class="topbar">
    <button class="sidebar-toggle" id="sidebar-toggle" aria-label="Toggle sidebar">
      <i class="ti ti-menu-2" style="font-size:1.2rem"></i>
    </button>
    <div>
      <div class="topbar-title">
        ${title}
        ${subtitle ? `<span class="topbar-subtitle">${subtitle}</span>` : ''}
      </div>
    </div>
    <div class="topbar-actions" style="margin-left:auto">
      ${actions}
      <div class="topbar-divider"></div>
      <div style="position:relative">
        <button class="icon-btn" data-dropdown="notif-dropdown" aria-label="Notifications">
          <i class="ti ti-bell" style="font-size:1rem"></i>
          <span class="dot" id="notif-dot" style="display:none"></span>
        </button>
        <div class="dropdown-menu" id="notif-dropdown" style="min-width:300px">
          <div style="padding:12px 16px;font-size:.8rem;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border)">NOTIFICATIONS</div>
          <div id="notif-list" style="max-height:320px;overflow-y:auto">
            <div class="empty-state" style="padding:24px"><div class="empty-state-icon" style="font-size:1.5rem">🔔</div><p style="font-size:.8rem">No new notifications</p></div>
          </div>
        </div>
      </div>
      <a href="profile.html" class="avatar avatar-sm" id="topbar-avatar" style="cursor:pointer;text-decoration:none">SR</a>
    </div>
  </div>`;

  // Inject into #app-sidebar and #app-topbar
  const sidebarEl = document.getElementById('app-sidebar');
  const topbarEl  = document.getElementById('app-topbar');
  if (sidebarEl) sidebarEl.innerHTML = sidebarHTML;
  if (topbarEl)  topbarEl.innerHTML  = topbarHTML;

  // Set active nav item
  const currentPage = window.location.pathname.split('/').pop() || 'dashboard.html';
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.classList.toggle('active', item.dataset.page === currentPage);
  });

  // Load notification badges
  loadNavBadges();
}

async function loadNavBadges() {
  try {
    const [inv, fb] = await Promise.allSettled([
      API.inventory.alerts(),
      API.feedback.summary(),
    ]);
    const invCount = inv.value?.count || 0;
    const badge = document.getElementById('inv-badge');
    if (badge && invCount > 0) { badge.textContent = invCount; badge.style.display = 'inline-flex'; }

    // Show notification dot if anything needs attention
    if (invCount > 0) {
      const dot = document.getElementById('notif-dot');
      if (dot) dot.style.display = 'block';
      const list = document.getElementById('notif-list');
      if (list && invCount > 0) {
        list.innerHTML = `<div class="dropdown-item" style="cursor:default">
          <i class="ti ti-package" style="color:var(--warning)"></i>
          <span>${invCount} inventory item${invCount > 1 ? 's' : ''} low on stock</span>
        </div>`;
      }
    }
  } catch (_) {}
}

window.buildLayout = buildLayout;

function comingSoon(name) {
  if (window.Toast) Toast.info(name + ' module coming soon!');
  else alert(name + ' module coming soon!');
}
window.comingSoon = comingSoon;

// ── Load honest complaint badge ──────────────────────────────
async function loadHonestBadge() {
  try {
    const res   = await API.feedback.unresolved();
    const count = res.count || 0;
    const badge = document.getElementById('honest-badge');
    if (badge && count > 0) {
      badge.textContent     = count;
      badge.style.display   = 'inline-flex';
    }
  } catch { /* non-fatal */ }
}
// Override loadNavBadges to also load honest badge
const _origLoadNavBadges = loadNavBadges;
window.loadNavBadges = async function() {
  await _origLoadNavBadges();
  await loadHonestBadge();
};
