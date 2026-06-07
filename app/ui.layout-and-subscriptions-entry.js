// 全局 UI 行为：布局 + 订阅入口按钮 + 手动输入
// 1. API Base：区分本地开发与线上部署
(function() {
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    window.API_BASE_URL = 'http://127.0.0.1:8008';
  } else {
    window.API_BASE_URL = '';
  }
})();

// 2. 侧边栏宽度拖拽脚本
(function() {
  function setupSidebarResizer() {
    // 统一“微宽屏 + 窄屏”为同一套逻辑：<1024 时为覆盖式 sidebar，不提供拖拽调宽
    if (window.innerWidth < 1024) return;
    if (document.getElementById('sidebar-resizer')) return;

    var resizer = document.createElement('div');
    resizer.id = 'sidebar-resizer';
    document.body.appendChild(resizer);

    var dragging = false;

    resizer.addEventListener('mousedown', function (e) {
      dragging = true;
      document.body.classList.add('sidebar-resizing');
      e.preventDefault();
    });

    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var styles = getComputedStyle(document.documentElement);
      var min =
        parseInt(styles.getPropertyValue('--sidebar-min-width')) || 180;
      var max =
        parseInt(styles.getPropertyValue('--sidebar-max-width')) || 480;
      var newWidth = e.clientX;
      if (newWidth < min) newWidth = min;
      if (newWidth > max) newWidth = max;
      document.documentElement.style.setProperty(
        '--sidebar-width',
        newWidth + 'px',
      );
      // 同步更新选中区域的阴影宽度
      if (window.syncSidebarActiveIndicator) {
        window.syncSidebarActiveIndicator({ animate: false });
      }
    });

    window.addEventListener('mouseup', function () {
      dragging = false;
      document.body.classList.remove('sidebar-resizing');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupSidebarResizer);
  } else {
    setupSidebarResizer();
  }

  var resizeTimer = null;
  // 侧边栏自动展开/收起的阈值（与 docsify-plugin.js 中的 SIDEBAR_AUTO_COLLAPSE_WIDTH 保持一致）
  var SIDEBAR_COLLAPSE_THRESHOLD = 1024;
  // 记录上一次的窗口宽度状态，避免重复触发
  var lastWasWide = window.innerWidth >= SIDEBAR_COLLAPSE_THRESHOLD;

  // 页面加载时根据屏幕宽度设置 sidebar 初始状态
  function initSidebarState() {
    var body = document.body;
    if (window.innerWidth < SIDEBAR_COLLAPSE_THRESHOLD) {
      // 小屏幕默认收起 sidebar：沿用 Docsify 原生语义，`close` 表示展开，不使用 `close` 表示收起
      if (body.classList.contains('close')) {
        body.classList.remove('close');
      }
    }
  }

  // 在 DOM 加载完成后初始化 sidebar 状态
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSidebarState);
  } else {
    initSidebarState();
  }

  window.addEventListener('resize', function () {
    var resizer = document.getElementById('sidebar-resizer');
    if (window.innerWidth < 1024) {
      if (resizer) resizer.style.display = 'none';
    } else {
      if (resizer) {
        resizer.style.display = 'block';
      } else {
        setupSidebarResizer();
      }
    }

    // 根据窗口宽度自动同步 sidebar 展开/收起状态
    // 桌面：body.close = 收起；移动端（<1024）：body.close = 展开（沿用 Docsify 原生语义）
    var isWide = window.innerWidth >= SIDEBAR_COLLAPSE_THRESHOLD;
    var body = document.body;
    if (isWide !== lastWasWide) {
      if (isWide) {
        // 窗口变宽，自动展开 sidebar（移除 close 类）
        if (body.classList.contains('close')) {
          body.classList.remove('close');
        }
      } else {
        // 窗口变窄，沿用 Docsify 移动端语义：默认不使用 close 表示收起状态
        if (body.classList.contains('close')) {
          body.classList.remove('close');
        }
      }
      lastWasWide = isWide;
    }

    // 即时同步选中区域的尺寸
    if (window.syncSidebarActiveIndicator) {
      window.syncSidebarActiveIndicator({ animate: false });
    }

    // 为窗口调整过程加上 dpr-resizing，禁用输入框/底部条的过渡，让动画更跟手
    document.body.classList.add('dpr-resizing');
    if (resizeTimer) {
      clearTimeout(resizeTimer);
    }
    resizeTimer = setTimeout(function () {
      document.body.classList.remove('dpr-resizing');
      resizeTimer = null;
    }, 150);
  });
})();

// 3. 自定义订阅管理入口按钮脚本（左下角 📚）
(function() {
  function createCustomButton() {
    if (document.getElementById('custom-toggle-btn')) return;

    var sidebarToggle = document.querySelector('.sidebar-toggle');
    if (!sidebarToggle) {
      setTimeout(createCustomButton, 100);
      return;
    }

    var btn = document.createElement('button');
    btn.id = 'custom-toggle-btn';
    btn.className = 'custom-toggle-btn';
    btn.innerHTML = '⚙️';
    btn.title = '后台管理';

    btn.addEventListener('click', function () {
      var event = new CustomEvent('ensure-arxiv-ui');
      document.dispatchEvent(event);

      setTimeout(function () {
        var loadEvent = new CustomEvent('load-arxiv-subscriptions');
        document.dispatchEvent(loadEvent);

        var overlay = document.getElementById('arxiv-search-overlay');
        if (overlay) {
          overlay.style.display = 'flex';
          requestAnimationFrame(function () {
            requestAnimationFrame(function () {
              overlay.classList.add('show');
            });
          });
        }
      }, 100);
    });

    document.body.appendChild(btn);
  }

  // 左下角保留一个独立触发函数，暂不自动挂载按钮（防止重复入口）
  function createQuickRunButton() {
    if (document.getElementById('custom-quick-run-btn')) return;

    function requestQuickRunPanel() {
      window.__dprQuickRunOpenRequested = true;

      if (window.PrivateDiscussionChat && typeof window.PrivateDiscussionChat.openQuickRunPanel === 'function') {
        const opened = window.PrivateDiscussionChat.openQuickRunPanel();
        if (opened) {
          window.__dprQuickRunOpenRequested = false;
          return;
        }
      }

      if (window.DPRWorkflowRunner && typeof window.DPRWorkflowRunner.open === 'function') {
        window.__dprQuickRunOpenRequested = false;
        window.DPRWorkflowRunner.open();
        return;
      }

      var event = new CustomEvent('dpr-open-quick-run');
      document.dispatchEvent(event);
    }

    var quickBtn = document.createElement('button');
    quickBtn.id = 'custom-quick-run-btn';
    quickBtn.className = 'custom-toggle-btn custom-quick-run-btn';
    quickBtn.innerHTML = '🚀';
    quickBtn.title = '快速抓取';
    quickBtn.setAttribute('aria-label', '快速抓取');

    quickBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      requestQuickRunPanel();
    });

    document.body.appendChild(quickBtn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createCustomButton);
  } else {
    createCustomButton();
  }
})();

// 4. 手动输入 arXiv ID 入口（📝 按钮 + 独立浮层）
(function () {
  function createManualInputButton() {
    if (document.getElementById('dpr-manual-input-btn')) return;

    var btn = document.createElement('button');
    btn.id = 'dpr-manual-input-btn';
    btn.className = 'custom-toggle-btn dpr-manual-input-btn';
    btn.innerHTML = '📝';
    btn.title = '手动输入 arXiv ID';
    btn.setAttribute('aria-label', '手动输入 arXiv ID');

    btn.addEventListener('click', function () {
      openManualInputPanel();
    });

    // Insert after the last existing floating button
    var existing = document.getElementById('custom-quick-run-btn') || document.getElementById('custom-toggle-btn');
    if (existing && existing.parentNode) {
      existing.parentNode.insertBefore(btn, existing.nextSibling);
    } else {
      document.body.appendChild(btn);
    }
  }

  function createManualInputOverlay() {
    var existing = document.getElementById('dpr-manual-input-overlay');
    if (existing) return existing;

    var overlay = document.createElement('div');
    overlay.id = 'dpr-manual-input-overlay';
    overlay.className = 'dpr-manual-overlay';
    overlay.innerHTML =
      '<div id="dpr-manual-input-panel" class="dpr-manual-panel">' +
        '<div class="dpr-manual-panel-header">' +
          '<div style="font-weight:600;">手动输入 arXiv ID</div>' +
          '<button id="dpr-manual-close-btn" class="arxiv-tool-btn" style="padding:2px 6px;">关闭</button>' +
        '</div>' +
        '<div class="dpr-manual-panel-body">' +
          '<div class="dpr-choice-field">' +
            '<label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">arXiv ID（必填，每行一个）</label>' +
            '<textarea id="dpr-manual-ids-input" class="dpr-manual-textarea" placeholder="例如：&#10;2401.12345&#10;2402.67890&#10;2303.abcde" style="width:100%; height:120px; resize:vertical; padding:8px; border:1px solid #ccc; border-radius:6px; font-family:monospace; font-size:13px;"></textarea>' +
          '</div>' +
          '<div class="dpr-choice-field" style="margin-top:10px;">' +
            '<label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">精读 ID（可选，每行一个）</label>' +
            '<textarea id="dpr-manual-deep-dive-input" class="dpr-manual-textarea" placeholder="指定需要精读的 arXiv ID（留空则全部进入速览）" style="width:100%; height:80px; resize:vertical; padding:8px; border:1px solid #ccc; border-radius:6px; font-family:monospace; font-size:13px;"></textarea>' +
          '</div>' +
          '<div style="margin-top:12px;">' +
            '<button id="dpr-manual-run-btn" class="chat-quick-run-run-btn dpr-task-start-btn" type="button">开始处理</button>' +
            '<div id="dpr-manual-run-msg" class="chat-quick-run-msg" style="margin-top:6px;"></div>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    return overlay;
  }

  function openManualInputPanel() {
    var overlay = createManualInputOverlay();
    overlay.style.display = 'flex';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        overlay.classList.add('show');
      });
    });

    // Wire close button
    var closeBtn = document.getElementById('dpr-manual-close-btn');
    if (closeBtn && !closeBtn._bound) {
      closeBtn._bound = true;
      closeBtn.addEventListener('click', function () {
        overlay.classList.remove('show');
        setTimeout(function () { overlay.style.display = 'none'; }, 300);
      });
    }

    // Wire overlay backdrop click
    if (!overlay._boundClick) {
      overlay._boundClick = true;
      overlay.addEventListener('mousedown', function (e) {
        if (e.target === overlay) {
          overlay.classList.remove('show');
          setTimeout(function () { overlay.style.display = 'none'; }, 300);
        }
      });
    }

    // Wire run button
    var runBtn = document.getElementById('dpr-manual-run-btn');
    var msgEl = document.getElementById('dpr-manual-run-msg');
    if (runBtn && !runBtn._bound) {
      runBtn._bound = true;
      runBtn.addEventListener('click', async function () {
        if (!msgEl) return;
        var idsInput = document.getElementById('dpr-manual-ids-input');
        var deepInput = document.getElementById('dpr-manual-deep-dive-input');
        var rawIds = idsInput ? (idsInput.value || '').trim() : '';
        var rawDeep = deepInput ? (deepInput.value || '').trim() : '';
        if (!rawIds) {
          msgEl.textContent = '请至少输入一个 arXiv ID。';
          msgEl.style.color = '#c00';
          return;
        }
        var csvIds = rawIds.split(/[\r\n]+/).map(function (s) { return s.trim(); }).filter(Boolean).join(',');
        var csvDeep = rawDeep ? rawDeep.split(/[\r\n]+/).map(function (s) { return s.trim(); }).filter(Boolean).join(',') : '';
        msgEl.textContent = '正在触发处理...';
        msgEl.style.color = '#666';
        try {
          await window.DPRWorkflowRunner.dispatchManualWorkflow(csvIds, csvDeep);
          msgEl.textContent = '已触发，请查看工作流面板运行状态。';
          msgEl.style.color = '#080';
        } catch (e) {
          msgEl.textContent = '触发失败：' + (e.message || String(e));
          msgEl.style.color = '#c00';
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createManualInputButton);
  } else {
    createManualInputButton();
  }
})();
