/**
 * BattleXJournal — Compact Tree Sidebar Controller
 * Manages active states, collapsible accordion folders, search, and collapse toggle.
 */
(function () {
  'use strict';

  function init() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    let currentPath = window.location.pathname.split('/').pop() || 'dashboard.html';
    if (currentPath === 'index.html' || currentPath === '') {
      currentPath = 'dashboard.html';
    }

    // 1. Mark active item and open its group
    let activeItem = null;
    let activeSectionId = 'core';
    sidebar.querySelectorAll('.nav-item').forEach(item => {
      const href = item.getAttribute('href');
      if (href === currentPath) {
        item.classList.add('active');
        activeItem = item;
        const parentSec = item.closest('.sidebar-section');
        if (parentSec) {
          const sec = parentSec.getAttribute('data-section');
          if (sec) activeSectionId = sec;
        }
      } else if (href && href !== '#') {
        item.classList.remove('active');
      }
    });

    // Apply initial single-open state to DOM elements on load
    const sections = sidebar.querySelectorAll(".sidebar-section");
    sections.forEach((sec) => {
      const secId = sec.getAttribute('data-section');
      if (secId === activeSectionId) {
        sec.classList.add('open');
      } else {
        sec.classList.remove('open');
      }
    });

    // 2. Accordion Toggle Handlers (Single-expansion accordion pattern)
    sections.forEach((sec) => {
      const header = sec.querySelector(".sidebar-section-header");
      if (!header) return;

      header.addEventListener("click", (e) => {
        e.preventDefault();
        const isAlreadyOpen = sec.classList.contains("open");

        // Close all sections first
        sections.forEach((s) => {
          s.classList.remove("open");
        });

        // If it wasn't open, open it (toggles open/close)
        if (!isAlreadyOpen) {
          sec.classList.add("open");
        }
      });
    });

    // 3. Search Filter
    const searchInput = sidebar.querySelector('#nav-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        const q = this.value.trim().toLowerCase();

        if (!q) {
          groups.forEach(g => {
            g.style.display = '';
            const hasActive = g.querySelector('.tree-item.active');
            const isJournal = g.getAttribute('data-group-id') === 'journal';
            const shouldBeOpen = hasActive || (!activeItem && isJournal);
            g.classList.toggle('open', !!shouldBeOpen);
            g.querySelectorAll('.tree-item').forEach(i => i.style.display = '');
          });
          return;
        }

        groups.forEach(g => {
          let hasMatch = false;
          g.querySelectorAll('.tree-item').forEach(item => {
            const txt = item.textContent.toLowerCase();
            if (txt.includes(q)) {
              item.style.display = 'flex';
              hasMatch = true;
            } else {
              item.style.display = 'none';
            }
          });

          if (hasMatch) {
            g.style.display = '';
            g.classList.add('open');
          } else {
            g.style.display = 'none';
          }
        });
      });
    }

    // 4. Collapse Toggle
    const collapseBtn = sidebar.querySelector('#collapse-btn');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', (e) => {
        e.preventDefault();
        document.body.classList.toggle('collapsed');
      });
    }

    // 5. Mobile Drawer & Backdrop Controller
    let backdrop = document.querySelector('.mobile-sidebar-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'mobile-sidebar-backdrop';
      document.body.appendChild(backdrop);
    }

    // Add mobile hamburger button to topbar if missing
    const topbar = document.querySelector('.topbar');
    if (topbar && !topbar.querySelector('.mobile-menu-btn')) {
      const menuBtn = document.createElement('button');
      menuBtn.type = 'button';
      menuBtn.className = 'mobile-menu-btn';
      menuBtn.setAttribute('aria-label', 'Open navigation menu');
      menuBtn.innerHTML = '<svg data-lucide="menu" class="w-5 h-5"></svg>';
      topbar.insertBefore(menuBtn, topbar.firstChild);
      if (window.lucide && typeof window.lucide.createIcons === 'function') {
        window.lucide.createIcons();
      }
      
      menuBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        document.body.classList.toggle('mobile-sidebar-open');
      });
    }

    // Close mobile drawer on backdrop click
    backdrop.addEventListener('click', () => {
      document.body.classList.remove('mobile-sidebar-open');
    });

    // Close mobile drawer when any link is clicked inside the sidebar
    sidebar.querySelectorAll('.nav-item').forEach(link => {
      link.addEventListener('click', () => {
        if (window.innerWidth < 768) {
          document.body.classList.remove('mobile-sidebar-open');
        }
      });
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('mobile-sidebar-open')) {
        document.body.classList.remove('mobile-sidebar-open');
      }
    });

    // 6. User Profile Popover Card (Community, Notifications, Help, Settings, Sign Out)
    const profileChip = sidebar.querySelector('#profile-chip');
    if (profileChip) {
      let popover = document.getElementById('sidebar-profile-popover');
      if (!popover) {
        popover = document.createElement('div');
        popover.id = 'sidebar-profile-popover';
        popover.innerHTML = `
          <div class="spp-head">
            <div class="spp-avatar">TR</div>
            <div class="spp-info">
              <div class="spp-name">Trader</div>
              <div class="spp-role">Battlex Pro Member</div>
            </div>
          </div>
          <div class="spp-menu">
            <a href="community.html" class="spp-item">
              <svg data-lucide="users" class="w-4 h-4"></svg>
              <span>Community</span>
            </a>
            <a href="notifications.html" class="spp-item">
              <svg data-lucide="bell" class="w-4 h-4"></svg>
              <span>Notifications</span>
            </a>
            <a href="help.html" class="spp-item">
              <svg data-lucide="help-circle" class="w-4 h-4"></svg>
              <span>Help & Docs</span>
            </a>
            <a href="settings.html" class="spp-item">
              <svg data-lucide="settings" class="w-4 h-4"></svg>
              <span>Settings</span>
            </a>
          </div>
          <div class="spp-foot">
            <button type="button" class="spp-logout" onclick="window.signOut ? window.signOut() : (location.href='auth.html')">
              <svg data-lucide="log-out" class="w-4 h-4"></svg>
              <span>Sign out</span>
            </button>
          </div>
        `;
        document.body.appendChild(popover);
      }

      function positionPopover() {
        const rect = profileChip.getBoundingClientRect();
        popover.style.left = `${Math.max(10, rect.left)}px`;
        popover.style.bottom = `${window.innerHeight - rect.top + 8}px`;
        popover.style.width = `${Math.min(235, window.innerWidth - 20)}px`;
      }

      profileChip.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isOpen = popover.classList.contains('show');
        if (isOpen) {
          popover.classList.remove('show');
        } else {
          // Sync user info from session if available
          try {
            if (window.TradeMindCore && window.TradeMindCore.user) {
              const u = window.TradeMindCore.user();
              if (u && u.email) {
                const name = u.email.split('@')[0];
                const nameEl = popover.querySelector('.spp-name');
                const avEl = popover.querySelector('.spp-avatar');
                if (nameEl) nameEl.textContent = name.charAt(0).toUpperCase() + name.slice(1);
                if (avEl) avEl.textContent = name.slice(0, 2).toUpperCase();
              }
            }
          } catch (err) {}

          positionPopover();
          popover.classList.add('show');
          if (window.lucide && typeof window.lucide.createIcons === 'function') {
            window.lucide.createIcons();
          }
        }
      });

      document.addEventListener('click', (e) => {
        if (!popover.contains(e.target) && !profileChip.contains(e.target)) {
          popover.classList.remove('show');
        }
      });

      window.addEventListener('resize', () => {
        if (popover.classList.contains('show')) positionPopover();
      });
    }

    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  let initialized = false;
  function tryInit() {
    if (initialized) return;
    if (document.readyState === 'loading') return;
    initialized = true;
    init();
  }

  document.addEventListener('DOMContentLoaded', tryInit);
  window.addEventListener('load', tryInit);
  tryInit();
})();
