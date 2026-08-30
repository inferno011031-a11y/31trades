/**
 * BattleXJournal — Authoritative Dual-Mode (Desktop & Mobile) Navigation Controller
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

    // 1. Active item & group resolution
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

    // 2. Accordion Groups
    const sections = sidebar.querySelectorAll(".sidebar-section");
    sections.forEach((sec) => {
      const secId = sec.getAttribute('data-section');
      if (secId === activeSectionId) {
        sec.classList.add('open');
      } else {
        sec.classList.remove('open');
      }
    });

    sections.forEach((sec) => {
      const header = sec.querySelector(".sidebar-section-header");
      if (!header) return;

      header.addEventListener("click", (e) => {
        e.preventDefault();
        const isAlreadyOpen = sec.classList.contains("open");
        sections.forEach((s) => s.classList.remove("open"));
        if (!isAlreadyOpen) sec.classList.add("open");
      });
    });

    // 3. Search Filter in Sidebar
    const searchInput = sidebar.querySelector('#nav-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        const q = this.value.trim().toLowerCase();
        sections.forEach(sec => {
          let hasMatch = false;
          sec.querySelectorAll('.nav-item').forEach(item => {
            const txt = item.textContent.toLowerCase();
            if (!q || txt.includes(q)) {
              item.style.display = 'flex';
              if (q && txt.includes(q)) hasMatch = true;
            } else {
              item.style.display = 'none';
            }
          });
          if (q) sec.classList.toggle('open', hasMatch);
        });
      });
    }

    // 4. Desktop Collapse Toggle
    const collapseBtn = sidebar.querySelector('#collapse-btn');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', (e) => {
        e.preventDefault();
        document.body.classList.toggle('collapsed');
      });
    }

    // 5. Mobile Drawer & Backdrop Setup
    let backdrop = document.querySelector('.mobile-sidebar-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'mobile-sidebar-backdrop';
      document.body.appendChild(backdrop);
    }

    // Mobile Close [X] Button inside Sidebar Header
    const sidebarHeader = sidebar.querySelector('div:first-child');
    if (sidebarHeader && !sidebarHeader.querySelector('.mobile-sidebar-close-btn')) {
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'mobile-sidebar-close-btn';
      closeBtn.setAttribute('aria-label', 'Close navigation menu');
      closeBtn.innerHTML = '<svg data-lucide="x" class="w-4 h-4"></svg>';
      sidebarHeader.appendChild(closeBtn);

      const closeHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        document.body.classList.remove('mobile-sidebar-open');
      };
      closeBtn.addEventListener('click', closeHandler);
      closeBtn.addEventListener('touchend', closeHandler);
    }

    // Mobile Hamburger [☰] Button in Topbar
    const topbar = document.querySelector('.topbar');
    if (topbar && !topbar.querySelector('.mobile-menu-btn')) {
      const menuBtn = document.createElement('button');
      menuBtn.type = 'button';
      menuBtn.className = 'mobile-menu-btn';
      menuBtn.setAttribute('aria-label', 'Open navigation menu');
      menuBtn.innerHTML = '<svg data-lucide="menu" class="w-5 h-5"></svg>';
      topbar.insertBefore(menuBtn, topbar.firstChild);
      if (!topbar.querySelector('.mobile-topbar-logo')) {
        const mobLogo = document.createElement('img');
        mobLogo.src = 'assets/battlex-logo.png';
        mobLogo.alt = 'BattleX';
        mobLogo.className = 'mobile-topbar-logo';
        topbar.insertBefore(mobLogo, menuBtn.nextSibling);
      }

      const openHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        document.body.classList.toggle('mobile-sidebar-open');
        if (window.lucide && typeof window.lucide.createIcons === 'function') {
          window.lucide.createIcons();
        }
      };
      menuBtn.addEventListener('click', openHandler);
      menuBtn.addEventListener('touchend', openHandler);
    }

    // 6. Mobile Bottom Navigation Bar
    let bottomNav = document.querySelector('.mobile-bottom-nav');
    if (!bottomNav) {
      bottomNav = document.createElement('nav');
      bottomNav.className = 'mobile-bottom-nav';
      bottomNav.innerHTML = `
        <a href="dashboard.html" class="mbn-item ${currentPath === 'dashboard.html' ? 'active' : ''}">
          <svg data-lucide="layout-dashboard"></svg><span>Dashboard</span>
        </a>
        <a href="journal.html" class="mbn-item ${currentPath === 'journal.html' ? 'active' : ''}">
          <svg data-lucide="book-open"></svg><span>Journal</span>
        </a>
        <a href="notes.html" class="mbn-item ${currentPath === 'notes.html' ? 'active' : ''}">
          <svg data-lucide="file-edit"></svg><span>Notes</span>
        </a>
        <a href="ai.html" class="mbn-item ${currentPath === 'ai.html' ? 'active' : ''}">
          <svg data-lucide="brain-circuit"></svg><span>AI Coach</span>
        </a>
        <button type="button" class="mbn-item mbn-menu-trigger">
          <svg data-lucide="menu"></svg><span>More</span>
        </button>
      `;
      document.body.appendChild(bottomNav);

      const moreHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        document.body.classList.toggle('mobile-sidebar-open');
        if (window.lucide && typeof window.lucide.createIcons === 'function') {
          window.lucide.createIcons();
        }
      };
      const trigger = bottomNav.querySelector('.mbn-menu-trigger');
      if (trigger) {
        trigger.addEventListener('click', moreHandler);
        trigger.addEventListener('touchend', moreHandler);
      }
    }

    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }

    // Backdrop tap closes drawer
    const backdropClose = (e) => {
      e.preventDefault();
      document.body.classList.remove('mobile-sidebar-open');
    };
    backdrop.addEventListener('click', backdropClose);
    backdrop.addEventListener('touchend', backdropClose);

    // Sidebar link click on mobile closes drawer
    sidebar.querySelectorAll('.nav-item').forEach(link => {
      link.addEventListener('click', () => {
        if (window.innerWidth <= 1024) {
          document.body.classList.remove('mobile-sidebar-open');
        }
      });
    });

    // Escape key closes drawer
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('mobile-sidebar-open')) {
        document.body.classList.remove('mobile-sidebar-open');
      }
    });

    // 7. Profile Popover
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
            <a href="community.html" class="spp-item"><svg data-lucide="users" class="w-4 h-4"></svg><span>Community</span></a>
            <a href="notifications.html" class="spp-item"><svg data-lucide="bell" class="w-4 h-4"></svg><span>Notifications</span></a>
            <a href="help.html" class="spp-item"><svg data-lucide="help-circle" class="w-4 h-4"></svg><span>Help & Docs</span></a>
            <a href="settings.html" class="spp-item"><svg data-lucide="settings" class="w-4 h-4"></svg><span>Settings</span></a>
          </div>
          <div class="spp-foot">
            <button type="button" class="spp-logout" onclick="window.signOut ? window.signOut() : (location.href='auth.html')">
              <svg data-lucide="log-out" class="w-4 h-4"></svg><span>Sign out</span>
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/* ============================================================================
   BATTLEXJOURNAL — SOURCE CODE & DEVTOOLS INSPECTION PROTECTION
   Disables Right Click, Ctrl+U (View Source), F12, and Ctrl+Shift+I/J/C DevTools
   ============================================================================ */
(function() {
  'use strict';

  // 1. Disable Right Click Context Menu
  document.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    return false;
  }, { capture: true });

  // 2. Disable Keyboard Shortcuts (Ctrl+U, F12, Ctrl+Shift+I, etc.)
  document.addEventListener('keydown', function(e) {
    // F12 key
    if (e.key === 'F12' || e.keyCode === 123) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
    // Ctrl+U / Cmd+Option+U (View Page Source)
    if ((e.ctrlKey || e.metaKey) && (e.key === 'u' || e.key === 'U' || e.keyCode === 85)) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
    // Ctrl+Shift+I / Cmd+Option+I (Inspect DevTools)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'I' || e.key === 'i' || e.keyCode === 73)) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
    // Ctrl+Shift+J / Cmd+Option+J (Console)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'J' || e.key === 'j' || e.keyCode === 74)) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
    // Ctrl+Shift+C (Inspect Element)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'C' || e.key === 'c' || e.keyCode === 67)) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
    // Ctrl+S / Cmd+S (Save Web Page)
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S' || e.keyCode === 83)) {
      if (!['INPUT', 'TEXTAREA'].includes((e.target && e.target.tagName) || '')) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
    }
  }, { capture: true });
})();
