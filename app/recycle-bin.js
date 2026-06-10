// 回收站模块：右键删除论文、恢复、回收站页面渲染
// 依赖：无外部模块依赖，自行实现 GitHub API 调用以保持独立性

window.DPRRecycleBin = (function () {
  const STORAGE_KEY = 'dpr_deleted_papers';
  const QUEUE_PATH = 'archive/delete-queue.json';
  const RECYCLE_BIN_DIR = 'archive/recycle-bin';
  const QUEUE_COMMIT_MSG = '[chore] add paper to recycle bin queue';
  const RESTORE_COMMIT_MSG = '[chore] restore paper from recycle bin';

  // ─── 工具函数 ───

  const escapeHtml = (str) => {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  const loadGithubToken = () => {
    try {
      const secret = window.decoded_secret_private || {};
      if (secret.github && secret.github.token) {
        return String(secret.github.token || '').trim();
      }
    } catch { /* ignore */ }
    try {
      const raw = window.localStorage
        ? window.localStorage.getItem('github_token_data')
        : '';
      if (!raw) return '';
      const obj = JSON.parse(raw);
      return String((obj && obj.token) || '').trim();
    } catch { return ''; }
  };

  const ghFetch = async (token, url, init) => {
    const res = await fetch(url, {
      ...(init || {}),
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        ...(init && init.headers ? init.headers : {}),
      },
    });
    return res;
  };

  const resolveRepoFromUrl = async (token) => {
    const currentUrl = window.location.href || '';
    const match = currentUrl.match(
      /https?:\/\/([^.]+)\.github\.io\/([^/]+)/,
    );
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
    try {
      const userRes = await ghFetch(token, 'https://api.github.com/user');
      if (userRes.ok) {
        const user = await userRes.json();
        const login = (user && user.login) ? String(user.login) : '';
        if (login) return { owner: login, repo: 'latest-paper-reader' };
      }
    } catch { /* ignore */ }
    return { owner: '', repo: '' };
  };

  const resolveRepoContext = async (token) => {
    const { owner, repo } = await resolveRepoFromUrl(token);
    if (!owner || !repo) {
      return { owner: '', repo: '', defaultBranch: 'main' };
    }
    try {
      const repoUrl = `https://api.github.com/repos/${owner}/${repo}`;
      const res = await ghFetch(token, repoUrl);
      if (res.ok) {
        const data = await res.json().catch(() => null);
        return {
          owner,
          repo,
          defaultBranch: String((data && data.default_branch) || 'main'),
        };
      }
    } catch { /* ignore */ }
    return { owner, repo, defaultBranch: 'main' };
  };

  // Base64 编码/解码（UTF-8 安全）
  const encodeContent = (text) => {
    const bytes = new TextEncoder().encode(text);
    const bin = Array.from(bytes).map((b) => String.fromCharCode(b)).join('');
    return btoa(bin);
  };

  const decodeContent = (b64) => {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  };

  // ─── localStorage 操作 ───

  const getDeletedMap = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  };

  const setDeletedMap = (map) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch { /* ignore */ }
  };

  const isDeleted = (paperId) => {
    const map = getDeletedMap();
    return !!map[paperId];
  };

  // ─── GitHub API: delete-queue.json 操作 ───

  const readDeleteQueue = async (token, repoCtx) => {
    const { owner, repo } = repoCtx;
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${QUEUE_PATH}`;
    const res = await ghFetch(token, url);
    if (res.status === 404) {
      return { exists: false, sha: null, queue: [] };
    }
    if (!res.ok) {
      throw new Error(`读取 delete-queue.json 失败: HTTP ${res.status}`);
    }
    const data = await res.json();
    const content = decodeContent(data.content || '');
    let queue = [];
    try {
      const parsed = JSON.parse(content);
      queue = Array.isArray(parsed.queue) ? parsed.queue : [];
    } catch { queue = []; }
    return { exists: true, sha: data.sha, queue };
  };

  const writeDeleteQueue = async (token, repoCtx, queue, existingSha) => {
    const { owner, repo } = repoCtx;
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${QUEUE_PATH}`;
    const body = {
      message: QUEUE_COMMIT_MSG,
      content: encodeContent(JSON.stringify({ queue }, null, 2)),
    };
    if (existingSha) {
      body.sha = existingSha;
    }
    const res = await ghFetch(token, url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`写入 delete-queue.json 失败: HTTP ${res.status} ${txt}`);
    }
    return res.json();
  };

  // ─── GitHub API: 文件操作 ───

  const getFileSha = async (token, repoCtx, filePath) => {
    const { owner, repo } = repoCtx;
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
    const res = await ghFetch(token, url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.sha || null;
  };

  const moveFile = async (token, repoCtx, fromPath, toPath, message) => {
    const { owner, repo } = repoCtx;
    // 读取源文件
    const srcUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${fromPath}`;
    const srcRes = await ghFetch(token, srcUrl);
    if (!srcRes.ok) throw new Error(`读取文件失败: ${fromPath}`);
    const srcData = await srcRes.json();
    const content = decodeContent(srcData.content || '');

    // 创建目标文件
    const createUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${toPath}`;
    const createRes = await ghFetch(token, createUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        content: encodeContent(content),
      }),
    });
    if (!createRes.ok) throw new Error(`创建文件失败: ${toPath}`);

    // 删除源文件
    const delUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${fromPath}`;
    const delRes = await ghFetch(token, delUrl, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: message + ' (remove original)',
        sha: srcData.sha,
      }),
    });
    if (!delRes.ok) throw new Error(`删除文件失败: ${fromPath}`);
    return true;
  };

  const deleteFile = async (token, repoCtx, filePath, message) => {
    const sha = await getFileSha(token, repoCtx, filePath);
    if (!sha) throw new Error(`文件不存在: ${filePath}`);
    const { owner, repo } = repoCtx;
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
    const res = await ghFetch(token, url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sha }),
    });
    if (!res.ok) throw new Error(`删除文件失败: HTTP ${res.status}`);
    return true;
  };

  // ─── 删除/恢复操作 ───

  const markDeleted = async (paperId, meta) => {
    const map = getDeletedMap();
    map[paperId] = {
      title: meta.title || '',
      href: meta.href || '',
      filePath: meta.filePath || '',
      deletedAt: new Date().toISOString(),
    };
    setDeletedMap(map);

    // 同步到 GitHub 仓库的 delete-queue.json
    const token = loadGithubToken();
    if (!token) {
      console.warn('[DPR RecycleBin] 未配置 GitHub Token，仅保存到本地存储。');
      return { ok: true, synced: false };
    }
    try {
      const repoCtx = await resolveRepoContext(token);
      if (!repoCtx.owner || !repoCtx.repo) {
        console.warn('[DPR RecycleBin] 无法解析仓库信息，仅保存到本地存储。');
        return { ok: true, synced: false };
      }
      const { sha, queue } = await readDeleteQueue(token, repoCtx);
      // 避免重复添加
      if (!queue.some((item) => item.paperId === paperId)) {
        queue.push({
          paperId,
          title: meta.title || '',
          filePath: meta.filePath || '',
          queuedAt: new Date().toISOString(),
        });
      }
      await writeDeleteQueue(token, repoCtx, queue, sha);
      return { ok: true, synced: true };
    } catch (err) {
      console.error('[DPR RecycleBin] 同步 delete-queue.json 失败:', err);
      return { ok: true, synced: false, error: err.message };
    }
  };

  const restore = async (paperId) => {
    const map = getDeletedMap();
    const entry = map[paperId];
    if (!entry) return { ok: false, error: '论文不在回收站中' };

    // 从 localStorage 移除
    delete map[paperId];
    setDeletedMap(map);

    // 从 GitHub 仓库恢复
    const token = loadGithubToken();
    if (!token) {
      return { ok: true, synced: false, restored: false };
    }
    try {
      const repoCtx = await resolveRepoContext(token);
      if (!repoCtx.owner || !repoCtx.repo) {
        return { ok: true, synced: false, restored: false };
      }

      // 从 delete-queue.json 中移除
      const { sha, queue } = await readDeleteQueue(token, repoCtx);
      const newQueue = queue.filter((item) => item.paperId !== paperId);
      await writeDeleteQueue(token, repoCtx, newQueue, sha);

      // 如果有 filePath，从 archive/recycle-bin/ 恢复文件
      if (entry.filePath) {
        const recyclePath = `${RECYCLE_BIN_DIR}/${entry.filePath}`;
        const originalPath = `docs/${entry.filePath}`;
        try {
          await moveFile(
            token,
            repoCtx,
            recyclePath,
            originalPath,
            RESTORE_COMMIT_MSG + `: ${entry.title || paperId}`,
          );
          return { ok: true, synced: true, restored: true };
        } catch (err) {
          console.warn('[DPR RecycleBin] 恢复文件失败，可能尚未被清理:', err);
          return { ok: true, synced: true, restored: false };
        }
      }
      return { ok: true, synced: true, restored: false };
    } catch (err) {
      console.error('[DPR RecycleBin] 恢复操作失败:', err);
      return { ok: false, error: err.message };
    }
  };

  const getDeletedList = () => {
    const map = getDeletedMap();
    return Object.entries(map).map(([id, meta]) => ({
      paperId: id,
      ...meta,
    }));
  };

  // ─── 右键菜单 ───

  let activeMenu = null;

  const hideContextMenu = () => {
    if (activeMenu) {
      activeMenu.remove();
      activeMenu = null;
    }
    document.removeEventListener('click', hideContextMenu, true);
    document.removeEventListener('contextmenu', hideContextMenu, true);
  };

  const showContextMenu = (event, paperId, meta) => {
    event.preventDefault();
    event.stopPropagation();
    hideContextMenu();

    const menu = document.createElement('div');
    menu.className = 'dpr-ctx-menu';
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;

    const menuItem = document.createElement('div');
    menuItem.className = 'dpr-ctx-menu-item danger';
    menuItem.textContent = '删除论文';
    menuItem.addEventListener('click', async (e) => {
      e.stopPropagation();
      hideContextMenu();
      const title = (meta && meta.title) || paperId;
      if (!confirm(`确定将「${title}」移入回收站？`)) return;
      const result = await markDeleted(paperId, meta);
      // 隐藏侧边栏中的对应项
      const nav = document.querySelector('.sidebar-nav');
      if (nav) {
        const links = nav.querySelectorAll('a.dpr-sidebar-item-link');
        links.forEach((a) => {
          const href = a.getAttribute('href') || '';
          if (href.includes(paperId)) {
            const li = a.closest('li');
            if (li) li.style.display = 'none';
          }
        });
      }
      if (result.synced) {
        console.log(`[DPR RecycleBin] 已将「${title}」移入回收站并同步到仓库。`);
      } else {
        console.log(`[DPR RecycleBin] 已将「${title}」移入回收站（仅本地）。`);
      }
    });

    menu.appendChild(menuItem);
    document.body.appendChild(menu);
    activeMenu = menu;

    // 点击其他地方关闭菜单
    setTimeout(() => {
      document.addEventListener('click', hideContextMenu, true);
      document.addEventListener('contextmenu', hideContextMenu, true);
    }, 0);
  };

  // ─── 回收站页面渲染 ───

  const renderRecycleBinPage = async (container) => {
    if (!container) return;
    container.innerHTML = '<div class="dpr-recycle-bin-loading">正在加载回收站...</div>';

    const items = getDeletedList();
    if (items.length === 0) {
      container.innerHTML = `
        <div class="dpr-recycle-bin-page">
          <div class="dpr-recycle-bin-header">
            <h2>回收站</h2>
            <p class="dpr-recycle-bin-desc">已删除的论文会在这里保留 30 天，之后将被自动清理。</p>
          </div>
          <div class="dpr-recycle-bin-empty">
            <div class="dpr-recycle-bin-empty-icon">&#128465;</div>
            <p>回收站为空</p>
          </div>
        </div>`;
      return;
    }

    // 按删除时间倒序
    items.sort((a, b) => {
      try {
        return new Date(b.deletedAt) - new Date(a.deletedAt);
      } catch { return 0; }
    });

    const formatTime = (isoStr) => {
      try {
        const d = new Date(isoStr);
        return d.toLocaleDateString('zh-CN', {
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit',
        });
      } catch { return isoStr || '-'; }
    };

    const listHtml = items.map((item) => {
      const title = escapeHtml(item.title || item.paperId);
      const time = formatTime(item.deletedAt);
      const path = escapeHtml(item.filePath || '');
      return `
        <div class="dpr-recycle-bin-item" data-paper-id="${escapeHtml(item.paperId)}">
          <div class="dpr-recycle-bin-item-info">
            <div class="dpr-recycle-bin-item-title">${title}</div>
            <div class="dpr-recycle-bin-item-meta">删除于 ${time}${path ? ` · ${path}` : ''}</div>
          </div>
          <div class="dpr-recycle-bin-item-actions">
            <button class="dpr-recycle-bin-btn dpr-recycle-bin-btn-restore" data-action="restore">恢复</button>
            <button class="dpr-recycle-bin-btn dpr-recycle-bin-btn-delete" data-action="permanent-delete">永久删除</button>
          </div>
        </div>`;
    }).join('');

    container.innerHTML = `
      <div class="dpr-recycle-bin-page">
        <div class="dpr-recycle-bin-header">
          <h2>回收站</h2>
          <p class="dpr-recycle-bin-desc">
            共 ${items.length} 篇论文 · 已删除的论文保留 30 天后自动清理
          </p>
        </div>
        <div class="dpr-recycle-bin-actions-bar">
          <button class="dpr-recycle-bin-btn dpr-recycle-bin-btn-clean" id="dpr-recycle-bin-trigger-clean">
            立即清理
          </button>
        </div>
        <div class="dpr-recycle-bin-list">${listHtml}</div>
      </div>`;

    // 绑定恢复按钮事件
    container.querySelectorAll('.dpr-recycle-bin-btn-restore').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = btn.closest('.dpr-recycle-bin-item');
        const pid = item && item.dataset.paperId;
        if (!pid) return;
        btn.disabled = true;
        btn.textContent = '恢复中...';
        const result = await restore(pid);
        if (result.ok) {
          item.remove();
          const remaining = container.querySelectorAll('.dpr-recycle-bin-item');
          if (remaining.length === 0) {
            renderRecycleBinPage(container);
          } else {
            const desc = container.querySelector('.dpr-recycle-bin-desc');
            if (desc) {
              desc.textContent = `共 ${remaining.length} 篇论文 · 已删除的论文保留 30 天后自动清理`;
            }
          }
        } else {
          btn.disabled = false;
          btn.textContent = '恢复';
          alert(`恢复失败: ${result.error || '未知错误'}`);
        }
      });
    });

    // 绑定永久删除按钮事件
    container.querySelectorAll('.dpr-recycle-bin-btn-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = btn.closest('.dpr-recycle-bin-item');
        const pid = item && item.dataset.paperId;
        if (!pid) return;
        const entry = items.find((i) => i.paperId === pid);
        const title = (entry && entry.title) || pid;
        if (!confirm(`确定永久删除「${title}」？此操作不可撤销。`)) return;
        btn.disabled = true;
        btn.textContent = '删除中...';
        try {
          const token = loadGithubToken();
          if (token) {
            const repoCtx = await resolveRepoContext(token);
            if (repoCtx.owner && repoCtx.repo && entry && entry.filePath) {
              const recyclePath = `${RECYCLE_BIN_DIR}/${entry.filePath}`;
              await deleteFile(token, repoCtx, recyclePath, `permanently delete: ${title}`);
            }
          }
          // 从 localStorage 和 queue 移除
          const map = getDeletedMap();
          delete map[pid];
          setDeletedMap(map);
          if (token) {
            const repoCtx = await resolveRepoContext(token);
            if (repoCtx.owner && repoCtx.repo) {
              const { sha, queue } = await readDeleteQueue(token, repoCtx);
              const newQueue = queue.filter((q) => q.paperId !== pid);
              await writeDeleteQueue(token, repoCtx, newQueue, sha);
            }
          }
          item.remove();
          const remaining = container.querySelectorAll('.dpr-recycle-bin-item');
          if (remaining.length === 0) {
            renderRecycleBinPage(container);
          } else {
            const desc = container.querySelector('.dpr-recycle-bin-desc');
            if (desc) {
              desc.textContent = `共 ${remaining.length} 篇论文 · 已删除的论文保留 30 天后自动清理`;
            }
          }
        } catch (err) {
          console.error('[DPR RecycleBin] 永久删除失败:', err);
          btn.disabled = false;
          btn.textContent = '永久删除';
          alert(`永久删除失败: ${err.message}`);
        }
      });
    });

    // 立即清理按钮：触发 cleanup workflow
    const cleanBtn = container.querySelector('#dpr-recycle-bin-trigger-clean');
    if (cleanBtn) {
      cleanBtn.addEventListener('click', async () => {
        const token = loadGithubToken();
        if (!token) {
          alert('未配置 GitHub Token，无法触发清理。请先在"密钥配置"中设置 GitHub Token。');
          return;
        }
        cleanBtn.disabled = true;
        cleanBtn.textContent = '正在触发...';
        try {
          const repoCtx = await resolveRepoContext(token);
          if (!repoCtx.owner || !repoCtx.repo) {
            throw new Error('无法解析仓库信息');
          }
          const dispatchUrl = `https://api.github.com/repos/${repoCtx.owner}/${repoCtx.repo}/actions/workflows/cleanup-recycle-bin.yml/dispatches`;
          const res = await ghFetch(token, dispatchUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: repoCtx.defaultBranch }),
          });
          if (!res.ok) {
            const txt = await res.text().catch(() => '');
            throw new Error(`触发清理工作流失败: HTTP ${res.status} ${txt}`);
          }
          cleanBtn.textContent = '已触发，请等待清理完成';
        } catch (err) {
          console.error('[DPR RecycleBin] 触发清理失败:', err);
          cleanBtn.disabled = false;
          cleanBtn.textContent = '立即清理';
          alert(`触发清理失败: ${err.message}`);
        }
      });
    }
  };

  // ─── 初始化：为侧边栏论文项绑定右键菜单 ───

  const bindContextMenu = () => {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav) return;
    const links = nav.querySelectorAll('a.dpr-sidebar-item-link.dpr-sidebar-item-structured');
    links.forEach((a) => {
      if (a.dataset.recycleBinBound === '1') return;
      a.dataset.recycleBinBound = '1';
      a.addEventListener('contextmenu', (e) => {
        const li = a.closest('li');
        if (li && li.style.display === 'none') return;
        const href = String(a.getAttribute('href') || '').trim();
        const routeMatch = href.match(/#\/(.+)$/);
        const paperId = routeMatch ? decodeURIComponent(routeMatch[1]).replace(/\/$/, '') : '';
        if (!paperId) return;
        let meta = {};
        const raw = a.getAttribute('data-sidebar-item') || '';
        if (raw) {
          try { meta = JSON.parse(raw); } catch { meta = {}; }
        }
        showContextMenu(e, paperId, {
          title: meta.title || a.textContent || '',
          href: href,
          filePath: paperId + '.md',
        });
      });
    });
  };

  // ─── 回收站路由页面检测 ───

  const isRecycleBinRoute = (file) => {
    return /recycle-bin\/README\.md$/i.test(String(file || ''));
  };

  // ─── 公开 API ───

  return {
    isDeleted,
    markDeleted,
    restore,
    getDeletedList,
    showContextMenu,
    hideContextMenu,
    renderRecycleBinPage,
    bindContextMenu,
    isRecycleBinRoute,
  };
})();
