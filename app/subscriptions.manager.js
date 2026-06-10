// 订阅管理总模块（智能 Query）
// 负责：
// 1) 维护本地草稿配置
// 2) 统一渲染 intent_profiles
// 3) 保存前仅保留 intent_profiles

window.SubscriptionsManager = (function () {
  const MAX_KEYWORDS_PER_PROFILE = 6;
  const MAX_INTENT_QUERIES_PER_PROFILE = 4;
  let overlay = null;
  let panel = null;
  let saveBtn = null;
  let closeBtn = null;
  let msgEl = null;
  let resetContentBtn = null;
  let resetContentMsgEl = null;

  let draftConfig = null;
  let hasUnsavedChanges = false;
  let isSavingDraftConfig = false;

  const defaultPromptTemplate = [
    'You are a retrieval planning assistant.',
    '标签 (Tag): {{TAG}}',
    '中文描述 (Description): {{USER_DESCRIPTION}}',
    'Retrieval context: {{RETRIEVAL_CONTEXT}}',
    '',
    'Return JSON only:',
    '{',
    '  "tag": "optional tag suggestion (for user convenience)",',
    '  "description": "optional Chinese description (for user convenience)",',
    '  "keywords": [',
    '    {',
      '      "keyword": "short keyword phrase for BM25 recall",',
      '      "query": "semantic rewrite for this keyword",',
      '      "keyword_cn": "中文直译（可选）",',
    '    },',
    '  ],',
    '  "intent_queries": [',
    '    {',
      '      "query": "intent-oriented semantic query 1",',
      '      "query_cn": "中文直译（可选）",',
    '    },',
    '    {',
      '      "query": "intent-oriented semantic query 2",',
      '      "query_cn": "中文直译（可选）",',
    '    }',
    '  ],',
    '}',
    'Requirements:',
    '1) keywords: output 5-12 objects; each item must include keyword and query, keyword_cn optional.',
    '2) keyword and query MUST be English retrieval text only. Do not put Chinese in keyword or query.',
    '3) keyword_cn and query_cn MUST be Chinese translations/explanations when present.',
    '4) keywords are used for recall and should be meaningful atomic noun phrases, normally 2-4 English words.',
    '5) Do NOT output acronym-only or abbreviation-only keywords such as "rl", "xrl", "sr", "llm". Expand them to full phrases like "reinforcement learning" or "large language model".',
    '6) Do NOT output incomplete modifier phrases ending with generic words like "driven", "based", "related", "guided", "enhanced", "for", or "with".',
    '7) Avoid coupling core terms (e.g., "symbolic regression", "reinforcement learning", "genetic programming", "Transformer") with extra qualifiers into one keyword. Keep core terms atomic in keyword and use query for full intent.',
    '8) Suggested example:',
    '   {"keyword":"symbolic regression","query":"deep symbolic regression methods","keyword_cn":"符号回归","query_cn":"符号回归深度方法"},',
    '   {"keyword":"reinforcement learning","query":"policy gradient symbolic regression","keyword_cn":"强化学习","query_cn":"策略梯度在符号回归中的应用"},',
    '   {"keyword":"Monte Carlo tree search","query":"Monte Carlo tree search for symbolic regression"}',
    '9) intent_queries: output 1-4 actionable intent queries. The query field MUST be English only; query_cn should be Chinese.',
    '10) intent_queries must be specific semantic search sentences, not acronym-only strings.',
    '11) Do not output extra fields like must_have / optional / exclude / rewrite_for_embedding / must_have.',
    '12) Return pure JSON only, no explanations.',
    '13) Tag suggestion must be concise: at most 12 characters total, counting hyphens.',
    '14) Tag suggestion must be English words or an English acronym only. Never output Chinese in tag.',
    '15) Tag suggestion must use hyphen-separated words when multiple words are needed, for example "reinforcement-learning". Do not use spaces or underscores in tag.',
    '16) If the descriptive tag would exceed 12 characters, output an English acronym or a shorter hyphenated label.',
  ].join('\n');

  const normalizeText = (v) => String(v || '').trim();
  const truncateDisplayText = (value, maxChars) => {
    const chars = Array.from(normalizeText(value));
    if (chars.length <= maxChars) return chars.join('');
    return chars.slice(0, maxChars).join('');
  };
  const escapeHtml = (str) => String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const MAX_PROFILE_TAG_CHARS = 12;
  const sanitizeProfileTag = (value) => {
    const base = normalizeText(value);
    if (!base) return '';
    const tag = base
      .replace(/\((?:19|20)\d{2}(?:年)?\)/g, '')
      .replace(/（(?:19|20)\d{2}(?:年)?）/g, '')
      .replace(/([\u4e00-\u9fffA-Za-z]+)\s*(?:19|20)\d{2}(?!\d)/g, '$1')
      .replace(/(?:19|20)\d{2}(?!\d)([\u4e00-\u9fffA-Za-z]+)/g, '$1')
      .replace(/[\s_-]*(?:19|20)\d{2}(?:年)?[\s_-]*/g, '')
      .replace(/\+/g, '-')
      .replace(/[\s_]+/g, '-')
      .replace(/[^A-Za-z-]+/g, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .trim();
    if (!/[A-Za-z]/.test(tag)) return '';
    if (tag.length <= MAX_PROFILE_TAG_CHARS) return tag;
    const words = tag.split('-').filter(Boolean);
    if (words.length > 1) {
      const acronym = words
        .map((word) => word[0] || '')
        .join('')
        .replace(/[^A-Za-z]/g, '');
      if (acronym.length >= 2 && acronym.length <= MAX_PROFILE_TAG_CHARS) {
        const allCapsSource = words.every((word) => word === word.toUpperCase());
        return allCapsSource ? acronym.toUpperCase() : acronym.toLowerCase();
      }
    }
    return tag.slice(0, MAX_PROFILE_TAG_CHARS).replace(/-+$/g, '');
  };
  const deriveProfileTag = (profile, fallback) => {
    const values = [profile && profile.tag];
    (Array.isArray(profile && profile.keywords) ? profile.keywords : []).forEach((item) => {
      if (typeof item === 'string') {
        values.push(item);
        return;
      }
      if (item && typeof item === 'object') {
        values.push(item.keyword, item.query);
      }
    });
    (Array.isArray(profile && profile.intent_queries) ? profile.intent_queries : []).forEach((item) => {
      if (typeof item === 'string') {
        values.push(item);
        return;
      }
      if (item && typeof item === 'object') {
        values.push(item.query);
      }
    });
    values.push(fallback);
    for (let idx = 0; idx < values.length; idx += 1) {
      const tag = sanitizeProfileTag(values[idx]);
      if (tag) return tag;
    }
    return '';
  };
  const normalizeSourceKey = (v) => normalizeText(v).toLowerCase();
  const toStableId = (value) => {
    const text = normalizeText(value).toLowerCase();
    const slug = text
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .trim();
    return slug || 'item';
  };

  const cloneDeep = (obj) => {
    try {
      return JSON.parse(JSON.stringify(obj || {}));
    } catch {
      return obj || {};
    }
  };

  const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

  const PAPER_SOURCE_ORDER = [
    'arxiv',
    'biorxiv',
    'medrxiv',
    'chemrxiv',
    'neurips',
    'iclr',
    'icml',
    'acl',
    'emnlp',
    'aaai',
  ];
  const VISIBLE_PAPER_SOURCES = ['arxiv', 'biorxiv'];
  const SOURCE_BACKEND_DEFAULTS = {
    arxiv: {
      papers_table: 'arxiv_papers',
      use_vector_rpc: true,
      vector_rpc: 'match_arxiv_papers_exact',
      vector_rpc_exact: 'match_arxiv_papers_exact',
      use_bm25_rpc: true,
      bm25_rpc: 'match_arxiv_papers_bm25',
      sync_table: 'arxiv_sync_status',
      sync_success_value: 'success',
      schema: 'public',
    },
    biorxiv: {
      papers_table: 'biorxiv_papers',
      use_vector_rpc: true,
      vector_rpc: 'match_biorxiv_papers_exact',
      vector_rpc_exact: 'match_biorxiv_papers_exact',
      use_bm25_rpc: true,
      bm25_rpc: 'match_biorxiv_papers_bm25',
      schema: 'public',
    },
  };

  const filterVisiblePaperSources = (values) => {
    const visible = new Set(VISIBLE_PAPER_SOURCES);
    return (Array.isArray(values) ? values : []).filter((value) => visible.has(normalizeSourceKey(value)));
  };

  const getAvailablePaperSources = (config) => {
    const cfg = config && typeof config === 'object' ? config : {};
    const rawBackends = cfg.source_backends && typeof cfg.source_backends === 'object'
      ? cfg.source_backends
      : {};
    const seen = new Set();
    const out = [];
    const runtimeCandidates = [];
    if (window.DPR_RUNTIME_SOURCE_BACKENDS && typeof window.DPR_RUNTIME_SOURCE_BACKENDS === 'object') {
      runtimeCandidates.push(...Object.keys(window.DPR_RUNTIME_SOURCE_BACKENDS || {}));
    }
    ['arxiv', ...Object.keys(rawBackends || {}), ...runtimeCandidates].forEach((key) => {
      const normalized = normalizeSourceKey(key);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      out.push(normalized);
    });
    const visibleOut = filterVisiblePaperSources(out);
    visibleOut.sort((a, b) => {
      const idxA = PAPER_SOURCE_ORDER.indexOf(a);
      const idxB = PAPER_SOURCE_ORDER.indexOf(b);
      const rankA = idxA >= 0 ? idxA : Number.MAX_SAFE_INTEGER;
      const rankB = idxB >= 0 ? idxB : Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      return a.localeCompare(b);
    });
    return visibleOut;
  };

  const normalizePaperSources = (values, options = {}) => {
    const fallbackToArxiv = options.fallbackToArxiv !== false;
    const rawList = Array.isArray(values)
      ? values
      : (typeof values === 'string' && values ? [values] : []);
    const seen = new Set();
    const out = [];
    rawList.forEach((value) => {
      const key = normalizeSourceKey(value);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(key);
    });
    const visibleOut = filterVisiblePaperSources(out);
    if (!visibleOut.length && fallbackToArxiv) {
      return ['arxiv'];
    }
    return visibleOut;
  };

  const mergeDefinedFields = (base, override) => {
    const next = { ...(isPlainObject(base) ? base : {}) };
    if (!isPlainObject(override)) return next;
    Object.keys(override).forEach((key) => {
      const value = override[key];
      if (value === undefined) return;
      next[key] = value;
    });
    return next;
  };

  const buildDefaultSourceBackend = (sourceKey, config) => {
    const normalizedKey = normalizeSourceKey(sourceKey);
    const defaults = SOURCE_BACKEND_DEFAULTS[normalizedKey];
    if (!defaults) return null;

    const cfg = isPlainObject(config) ? config : {};
    const shared = isPlainObject(cfg.supabase_shared) ? cfg.supabase_shared : {};
    const legacy = isPlainObject(cfg.supabase) ? cfg.supabase : {};

    let base = {
      kind: normalizeText(shared.kind || legacy.kind || 'supabase') || 'supabase',
      enabled: shared.enabled !== false && legacy.enabled !== false,
      url: normalizeText(shared.url || legacy.url || ''),
      anon_key: normalizeText(shared.anon_key || legacy.anon_key || ''),
      schema: normalizeText(shared.schema || legacy.schema || defaults.schema || 'public') || 'public',
    };

    if (normalizedKey === 'arxiv') {
      base = mergeDefinedFields(base, {
        enabled: Object.prototype.hasOwnProperty.call(legacy, 'enabled') ? legacy.enabled !== false : undefined,
        papers_table: normalizeText(legacy.papers_table || ''),
        use_vector_rpc: Object.prototype.hasOwnProperty.call(legacy, 'use_vector_rpc') ? legacy.use_vector_rpc !== false : undefined,
        vector_rpc: normalizeText(legacy.vector_rpc || ''),
        vector_rpc_exact: normalizeText(legacy.vector_rpc_exact || legacy.vector_rpc || ''),
        use_bm25_rpc: Object.prototype.hasOwnProperty.call(legacy, 'use_bm25_rpc') ? legacy.use_bm25_rpc !== false : undefined,
        bm25_rpc: normalizeText(legacy.bm25_rpc || ''),
        sync_table: normalizeText(legacy.sync_table || ''),
        sync_success_value: normalizeText(legacy.sync_success_value || ''),
      });
    }

    return mergeDefinedFields(defaults, base);
  };

  const ensureSourceBackendsForProfiles = (config) => {
    const next = isPlainObject(config) ? config : {};
    const subs = isPlainObject(next.subscriptions) ? next.subscriptions : {};
    const profiles = Array.isArray(subs.intent_profiles) ? subs.intent_profiles : [];
    const existingBackends = isPlainObject(next.source_backends) ? next.source_backends : {};
    const mergedBackends = cloneDeep(existingBackends);
    let changed = !isPlainObject(next.source_backends);

    profiles.forEach((profile) => {
      if (!isPlainObject(profile)) return;
      const fallbackToArxiv = !Object.prototype.hasOwnProperty.call(profile, 'paper_sources');
      const paperSources = normalizePaperSources(profile.paper_sources, { fallbackToArxiv });
      paperSources.forEach((sourceKey) => {
        const template = buildDefaultSourceBackend(sourceKey, next);
        if (!template) return;
        const current = isPlainObject(mergedBackends[sourceKey]) ? mergedBackends[sourceKey] : {};
        const merged = mergeDefinedFields(template, current);
        const before = JSON.stringify(current);
        const after = JSON.stringify(merged);
        if (before !== after) {
          mergedBackends[sourceKey] = merged;
          changed = true;
        }
      });
    });

    if (changed) {
      next.source_backends = mergedBackends;
    }
    return next;
  };

  const normalizeKeywordItem = (item) => {
    if (typeof item === 'string') {
      const text = normalizeText(item);
      if (!text) return null;
      return {
        keyword: text,
        keyword_cn: '',
        query: text,
      };
    }
    if (!item || typeof item !== 'object') return null;

    const keyword = normalizeText(item.keyword || item.expr || item.text || '');
    if (!keyword) return null;
    const query = normalizeText(
      item.query ||
        item.rewrite ||
        item.rewrite_for_embedding ||
        item.text ||
        item.keyword ||
        '',
    );
    const keywordCn = normalizeText(item.keyword_cn || item.keyword_zh || item.zh || '');

    return {
      keyword,
      keyword_cn: keywordCn,
      query: query || keyword,
      embedding_cache:
        item.embedding_cache && typeof item.embedding_cache === 'object'
          ? cloneDeep(item.embedding_cache)
          : undefined,
    };
  };

  const dedupeKeywords = (items) => {
    const list = Array.isArray(items) ? items : [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const key = normalizeText(item.keyword || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  };

  const normalizeIntentQueryItem = (item) => {
    if (typeof item === 'string') {
      const query = normalizeText(item);
      if (!query) return null;
      return {
        query,
        query_cn: '',
        enabled: true,
        source: 'manual',
      };
    }
    if (!item || typeof item !== 'object') return null;

    const query = normalizeText(item.query || item.text || item.keyword || item.expr || '');
    if (!query) return null;
    const queryCn = normalizeText(item.query_cn || item.query_zh || item.zh || item.note || '');

    return {
      query,
      query_cn: queryCn,
      enabled: item.enabled !== false,
      source: normalizeText(item.source || 'manual'),
      note: normalizeText(item.note || ''),
      embedding_cache:
        item.embedding_cache && typeof item.embedding_cache === 'object'
          ? cloneDeep(item.embedding_cache)
          : undefined,
    };
  };

  const normalizeIntentQueries = (items) => {
    const list = Array.isArray(items) ? items : [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const normalized = normalizeIntentQueryItem(item);
      if (!normalized) continue;
      const key = normalizeText(normalized.query).toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    }
    return out;
  };

  const runResetContent = (msgEl) => {
    if (String(window.DPR_ACCESS_MODE || '') !== 'full') {
      if (msgEl) {
        msgEl.textContent = '未检测到完整登录权限，危险操作未开启。';
        msgEl.style.color = '#c00';
      }
      return;
    }

    const confirmText = window.prompt(
      '危险区域：仅重置论文内容。会将 docs 备份为 docs_backup_xxx 后恢复为 docs_init，并清空 archive；不会删除配置、密钥或词条设置。输入「RESET_ALL」确认。',
    );
    if (confirmText !== 'RESET_ALL') {
      if (msgEl) {
        msgEl.textContent = '已取消危险操作。';
        msgEl.style.color = '#666';
      }
      return;
    }

    if (!window.DPRWorkflowRunner || typeof window.DPRWorkflowRunner.runWorkflowByKey !== 'function') {
      if (msgEl) {
        msgEl.textContent = '工作流触发器未加载到当前页面。';
        msgEl.style.color = '#c00';
      }
      return;
    }

    window.DPRWorkflowRunner.runWorkflowByKey('reset-content');
    if (msgEl) {
      msgEl.textContent = '已发起论文内容重置任务。';
      msgEl.style.color = '#080';
    }
  };

  const normalizeProfiles = (subs, availableSources) => {
    const profiles = Array.isArray(subs.intent_profiles) ? subs.intent_profiles : [];
    return profiles
      .map((p, idx) => {
        if (!p || typeof p !== 'object') return null;
        const tag = deriveProfileTag(p, `profile-${idx + 1}`) || `profile-${idx + 1}`;
        const description = normalizeText(p.description || '');
        const enabled = p.enabled !== false;
        const fallbackToArxiv = !Object.prototype.hasOwnProperty.call(p, 'paper_sources');
        const paperSources = normalizePaperSources(p.paper_sources, { fallbackToArxiv });
        const keywordRules = (Array.isArray(p.keywords) ? p.keywords : []).map(normalizeKeywordItem).filter(Boolean);
        const normalizedKeywords = dedupeKeywords(keywordRules);
        const normalizedIntentQueries = normalizeIntentQueries(p.intent_queries);
        if (!keywordRules.length && !normalizedKeywords.length && !normalizedIntentQueries.length) {
          return null;
        }

        const result = {
          tag,
          description,
          enabled,
          paper_sources: paperSources,
          keywords: normalizedKeywords,
          intent_queries: normalizedIntentQueries,
          updated_at: normalizeText(p.updated_at) || new Date().toISOString(),
        };
        if ('paused' in p) {
          result.paused = !!p.paused;
        }
        if (p.temporary === true || p.conference_only === true || normalizeText(p.scope).toLowerCase() === 'conference') {
          result.scope = 'conference';
          result.temporary = true;
          result.conference_only = true;
        }
        return result;
      })
      .filter(Boolean);
  };

  const validateIntentProfiles = (config) => {
    const cfg = ensureSourceBackendsForProfiles(cloneDeep(config || {}));
    const subs = (cfg && cfg.subscriptions) || {};
    const availableSources = getAvailablePaperSources(cfg);
    const profiles = Array.isArray(subs.intent_profiles) ? subs.intent_profiles : [];
    for (let idx = 0; idx < profiles.length; idx += 1) {
      const profile = profiles[idx];
      if (!profile || typeof profile !== 'object') continue;
      const tag = deriveProfileTag(profile, `profile-${idx + 1}`) || `profile-${idx + 1}`;
      const fallbackToArxiv = !Object.prototype.hasOwnProperty.call(profile, 'paper_sources');
      const paperSources = normalizePaperSources(profile.paper_sources, { fallbackToArxiv });
      const keywords = dedupeKeywords(
        (Array.isArray(profile.keywords) ? profile.keywords : [])
          .map(normalizeKeywordItem)
          .filter(Boolean),
      );
      const intentQueries = normalizeIntentQueries(profile.intent_queries);
      if (!paperSources.length) {
        return `词条「${tag}」至少需要 1 个论文源。`;
      }
      const unknownSources = paperSources.filter((item) => !availableSources.includes(item));
      if (unknownSources.length) {
        return `词条「${tag}」包含未配置的论文源：${unknownSources.join(', ')}。`;
      }
      if (!keywords.length) {
        return `词条「${tag}」至少需要 1 条关键词。`;
      }
      if (keywords.length > MAX_KEYWORDS_PER_PROFILE) {
        return `词条「${tag}」的关键词最多只能保留 ${MAX_KEYWORDS_PER_PROFILE} 条。`;
      }
      if (!intentQueries.length) {
        return `词条「${tag}」至少需要 1 条意图Query。`;
      }
      if (intentQueries.length > MAX_INTENT_QUERIES_PER_PROFILE) {
        return `词条「${tag}」的意图Query 最多只能保留 ${MAX_INTENT_QUERIES_PER_PROFILE} 条。`;
      }
    }
    return '';
  };

  const stripIntentProfileIds = (config) => {
    const next = cloneDeep(config || {});
    if (!next || typeof next !== 'object') return next;
    const subscriptions = next.subscriptions;
    if (!subscriptions || typeof subscriptions !== 'object') return next;
    const profiles = Array.isArray(subscriptions.intent_profiles) ? subscriptions.intent_profiles : [];
    if (!profiles.length) return next;

    subscriptions.intent_profiles = profiles
      .filter((p) => p && typeof p === 'object')
      .map((p) => {
        const profile = cloneDeep(p) || {};
        delete profile.id;

        if (Array.isArray(profile.keywords)) {
          profile.keywords = profile.keywords
            .filter((k) => k && typeof k === 'object')
            .map((k) => {
              const keyword = cloneDeep(k);
              delete keyword.id;
              return keyword;
            });
        }

        if (Array.isArray(profile.intent_queries)) {
          profile.intent_queries = profile.intent_queries
            .filter((item) => item && typeof item === 'object')
            .map((item) => {
              const intentQuery = cloneDeep(item);
              delete intentQuery.id;
              return intentQuery;
            });
        }

        return profile;
      });

    next.subscriptions = subscriptions;
    return next;
  };

  const migrateLegacyToProfilesIfNeeded = (subs) => {
    const existingProfiles = normalizeProfiles(subs);
    if (existingProfiles.length > 0) {
      subs.intent_profiles = existingProfiles;
    } else {
      subs.intent_profiles = [];
    }
    delete subs.keywords;
    delete subs.llm_queries;
    return subs;
  };

  const normalizeSubscriptions = (config) => {
    const next = cloneDeep(config || {});
    if (!next.subscriptions) next.subscriptions = {};
    const subs = next.subscriptions;

    migrateLegacyToProfilesIfNeeded(subs);
      subs.intent_profiles = normalizeProfiles(subs, getAvailablePaperSources(next));

    if (!subs.schema_migration || typeof subs.schema_migration !== 'object') {
      subs.schema_migration = {};
    }
    if (!normalizeText(subs.schema_migration.stage)) {
      subs.schema_migration.stage = 'A';
    }
    if (!normalizeText(subs.schema_migration.diff_threshold_pct)) {
      subs.schema_migration.diff_threshold_pct = 15;
    }

    if (!normalizeText(subs.keyword_recall_mode)) {
      subs.keyword_recall_mode = 'or';
    }

    next.subscriptions = subs;
    ensureSourceBackendsForProfiles(next);
    return stripIntentProfileIds(next);
  };

  const setMessage = (text, color) => {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.style.color = color || '#666';
  };
  const updateSaveReminder = () => {
    if (!msgEl) return;
    if (hasUnsavedChanges) {
      msgEl.innerHTML = '<span class="dpr-save-reminder">⚠ 有未保存修改，请点击右上角「保存」。</span>';
      msgEl.style.color = '#9a6500';
    } else if (/未保存修改/.test(msgEl.textContent || '')) {
      setMessage('', '#666');
    }
  };

  const ensureOverlay = () => {
    if (overlay && panel) return;
    overlay = document.getElementById('arxiv-search-overlay');
    if (overlay) {
      panel = document.getElementById('arxiv-search-panel');
      return;
    }

    overlay = document.createElement('div');
    overlay.id = 'arxiv-search-overlay';
    overlay.innerHTML = `
      <div id="arxiv-search-panel" class="dpr-admin-simple-panel">
        <div id="arxiv-search-panel-header">
          <div class="dpr-admin-header-left">
            <div style="font-weight:600;">后台管理</div>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <button id="arxiv-config-save-btn" class="arxiv-tool-btn" style="padding:2px 10px; background:#2e7d32; color:white;">保存</button>
            <button id="arxiv-open-secret-setup-btn" class="arxiv-tool-btn" style="padding:2px 10px;">密钥配置</button>
            <button id="arxiv-search-close-btn" class="arxiv-tool-btn" style="padding:2px 6px;">关闭</button>
          </div>
        </div>

        <div id="arxiv-search-panel-body" class="dpr-admin-panel-body">
          <div id="dpr-smart-msg" style="font-size:12px; color:#666;">提示：修改后点击「保存」才会写入 config.yaml。</div>

          <div class="dpr-custom-tags-module" style="margin-top:16px; padding:12px; background:#fff8e1; border-radius:8px; border:1px solid #ffe0b2;">
            <div style="font-weight:600; margin-bottom:8px;">\u81ea\u5b9a\u4e49\u6807\u7b7e\u7ba1\u7406</div>
            <div style="font-size:12px; color:#795548; margin-bottom:8px;">
              \u9884\u8bbe\u6807\u7b7e\u5b58\u5728 config.yaml \u7684 user_custom_tags \u5b57\u6bb5\u4e2d\u3002
              \u6bcf\u5f53\u6709\u65b0\u8bba\u6587\u65f6\u002c LLM \u4f1a\u81ea\u52a8\u5339\u914d\u8fd9\u4e9b\u6807\u7b7e\u5e76\u5199\u5165\u8bba\u6587\u9875 front matter\u3002
            </div>
            <div id="dpr-custom-tags-list" style="margin-bottom:8px;">
              <span style="font-size:12px; color:#999;">\u52a0\u8f7d\u4e2d...</span>
            </div>
            <div style="display:flex; gap:8px;">
              <input id="dpr-custom-tag-name-input" type="text" placeholder="\u6807\u7b7e\u540d\u79f0 (e.g. nlp)" style="flex:1; padding:4px 8px; font-size:12px; border:1px solid #ccc; border-radius:4px;" />
              <input id="dpr-custom-tag-desc-input" type="text" placeholder="\u63cf\u8ff0 (e.g. \u81ea\u7136\u8bed\u8a00\u5904\u7406)" style="flex:1; padding:4px 8px; font-size:12px; border:1px solid #ccc; border-radius:4px;" />
              <button id="dpr-custom-tag-add-btn2" class="arxiv-tool-btn" style="padding:4px 12px; background:#e65100; color:white; white-space:nowrap;">\u6dfb\u52a0</button>
            </div>
            <div style="margin-top:8px; display:flex; gap:8px;">
              <button id="dpr-custom-tag-refresh-btn" class="arxiv-tool-btn" style="padding:2px 10px; font-size:12px;">\u5237\u65b0\u6807\u7b7e</button>
              <button id="dpr-custom-tag-save-btn" class="arxiv-tool-btn" style="padding:2px 10px; font-size:12px; background:#2e7d32; color:white;">\u4fdd\u5b58\u5230 config.yaml</button>
            </div>
          </div>

          <div class="dpr-task-danger-module" style="margin-top:16px;">
            <div class="chat-quick-run-title">危险区域</div>
            <div class="dpr-task-danger-desc">恢复初始论文；不删除设置</div>
            <button
              id="arxiv-admin-reset-content-btn"
              class="chat-quick-run-run-btn"
              type="button"
            >
              删除所有
            </button>
            <div id="arxiv-admin-reset-content-msg" class="chat-quick-run-msg"></div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    panel = document.getElementById('arxiv-search-panel');

    saveBtn = document.getElementById('arxiv-config-save-btn');
    closeBtn = document.getElementById('arxiv-search-close-btn');
    msgEl = document.getElementById('dpr-smart-msg');

    bindBaseEvents();
    bindCustomTagsEvents();
  };

  // --- \u81ea\u5b9a\u4e49\u6807\u7b7e\u7ba1\u7406 ---
  let _cachedCustomTags = [];

  const _loadGithubTokenLocal = () => {
    try {
      const s = window.decoded_secret_private || {};
      if (s.github && s.github.token) return String(s.github.token).trim();
    } catch {}
    try {
      const raw = window.localStorage ? localStorage.getItem('github_token_data') : '';
      if (!raw) return '';
      const obj = JSON.parse(raw);
      return String((obj && obj.token) || '').trim();
    } catch { return ''; }
  };

  const _ghFetchLocal = async (token, url, init) => {
    return await fetch(url, {
      ...(init || {}),
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        ...(init && init.headers ? init.headers : {}),
      },
    });
  };

  const _resolveRepoCtxLocal = async (token) => {
    const url = window.location.href || '';
    const m = url.match(/https?:\/\/([^.]+)\.github\.io\/([^/]+)/);
    if (m) return { owner: m[1], repo: m[2] };
    try {
      const res = await _ghFetchLocal(token, 'https://api.github.com/user');
      if (res.ok) {
        const user = await res.json();
        const login = user && user.login ? String(user.login) : '';
        if (login) return { owner: login, repo: 'latest-paper-reader' };
      }
    } catch {}
    return { owner: '', repo: '' };
  };

  const _encodeContentLocal = (text) => {
    const bytes = new TextEncoder().encode(text);
    const bin = Array.from(bytes).map(b => String.fromCharCode(b)).join('');
    return btoa(bin);
  };

  const loadCustomTagsFromConfig = async () => {
    const container = document.getElementById('dpr-custom-tags-list');
    if (!container) return;
    container.innerHTML = '<span style="font-size:12px; color:#999;">加载中...</span>';
    const token = _loadGithubTokenLocal();
    if (!token) {
      container.innerHTML = '<span style="font-size:12px; color:#c62828;">请先配置 GitHub Token（密钥配置按钮）</span>';
      return;
    }
    const repoCtx = await _resolveRepoCtxLocal(token);
    if (!repoCtx.owner || !repoCtx.repo) {
      container.innerHTML = '<span style="font-size:12px; color:#c62828;">无法确定仓库</span>';
      return;
    }
    try {
      const url = `https://api.github.com/repos/${repoCtx.owner}/${repoCtx.repo}/contents/config.yaml`;
      const res = await _ghFetchLocal(token, url);
      if (!res.ok) {
        container.innerHTML = '<span style="font-size:12px; color:#c62828;">读取 config.yaml 失败</span>';
        return;
      }
      const data = await res.json();
      const decoded = atob(data.content);
      const tagMatch = decoded.match(/user_custom_tags:\s*\n((?:\s+- name:.*\n(?:\s+description:.*\n)?)*)/);
      if (!tagMatch) {
        container.innerHTML = '<span style="font-size:12px; color:#999;">未找到 user_custom_tags，请先在 config.yaml 中添加</span>';
        _cachedCustomTags = [];
        return;
      }
      const block = tagMatch[1];
      const tags = [...block.matchAll(/\s+- name:\s*["']?([^"'\n]+)["']?\s*\n\s+description:\s*["']?([^"'\n]*)["']?/g)].map(m => ({ name: m[1].trim(), description: m[2].trim() }));
      _cachedCustomTags = tags;
      renderCustomTagsList(tags);
    } catch (e) {
      container.innerHTML = `<span style="font-size:12px; color:#c62828;">加载失败: ${e.message}</span>`;
    }
  };

  const renderCustomTagsList = (tags) => {
    const container = document.getElementById('dpr-custom-tags-list');
    if (!container) return;
    if (!tags.length) {
      container.innerHTML = '<span style="font-size:12px; color:#999;">暂无预设标签</span>';
      return;
    }
    container.innerHTML = tags.map(t =>
      `<span class="tag-label tag-custom" style="display:inline-flex; align-items:center; gap:4px; margin:2px 4px 2px 0;">
        ${escapeHtml(t.name)}
        <button class="tag-remove-btn" data-tag-name="${escapeHtml(t.name)}" style="font-size:12px;">x</button>
      </span>`
    ).join(' ');
  };

  const saveCustomTagsToConfig = async (tags) => {
    const token = _loadGithubTokenLocal();
    if (!token) { alert('请先配置 GitHub Token'); return false; }
    const repoCtx = await _resolveRepoCtxLocal(token);
    if (!repoCtx.owner || !repoCtx.repo) { alert('无法确定仓库'); return false; }
    try {
      const url = `https://api.github.com/repos/${repoCtx.owner}/${repoCtx.repo}/contents/config.yaml`;
      const res = await _ghFetchLocal(token, url);
      if (!res.ok) { alert('读取 config.yaml 失败'); return false; }
      const data = await res.json();
      const sha = data.sha;
      const decoded = atob(data.content);

      const tagYaml = tags.length
        ? '\nuser_custom_tags:\n' + tags.map(t => `  - name: "${t.name}"\n    description: "${t.description}"`).join('\n')
        : '';

      let newContent;
      if (decoded.includes('user_custom_tags:')) {
        newContent = decoded.replace(/\nuser_custom_tags:[\s\S]*?(?=\n\w|$)/, tagYaml || '');
      } else {
        newContent = decoded.trimEnd() + '\n' + tagYaml + '\n';
      }

      const body = {
        message: '[config] update user_custom_tags',
        content: _encodeContentLocal(newContent),
        sha: sha,
      };
      const updateRes = await _ghFetchLocal(token, url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (updateRes.ok) {
        _cachedCustomTags = tags;
        renderCustomTagsList(tags);
        return true;
      } else {
        const err = await updateRes.text();
        alert(`保存失败: ${err}`);
        return false;
      }
    } catch (e) {
      alert(`保存失败: ${e.message}`);
      return false;
    }
  };

  const bindCustomTagsEvents = () => {
    const refreshBtn = document.getElementById('dpr-custom-tag-refresh-btn');
    if (refreshBtn && !refreshBtn._bound) {
      refreshBtn._bound = true;
      refreshBtn.addEventListener('click', loadCustomTagsFromConfig);
    }
    const addBtn = document.getElementById('dpr-custom-tag-add-btn2');
    if (addBtn && !addBtn._bound) {
      addBtn._bound = true;
      addBtn.addEventListener('click', async () => {
        const nameInput = document.getElementById('dpr-custom-tag-name-input');
        const descInput = document.getElementById('dpr-custom-tag-desc-input');
        const name = (nameInput ? nameInput.value : '').trim();
        const desc = (descInput ? descInput.value : '').trim();
        if (!name) { alert('请输入标签名称'); return; }
        if (_cachedCustomTags.some(t => t.name === name)) {
          alert('标签已存在');
          return;
        }
        _cachedCustomTags.push({ name, description: desc });
        renderCustomTagsList(_cachedCustomTags);
        if (nameInput) nameInput.value = '';
        if (descInput) descInput.value = '';
      });
    }
    const saveBtn = document.getElementById('dpr-custom-tag-save-btn');
    if (saveBtn && !saveBtn._bound) {
      saveBtn._bound = true;
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中...';
        const ok = await saveCustomTagsToConfig(_cachedCustomTags);
        saveBtn.disabled = false;
        saveBtn.textContent = ok ? '已保存' : '保存失败';
        setTimeout(() => { saveBtn.textContent = '保存到 config.yaml'; }, 2000);
      });
    }
    // 委托事件处理删除按钮
    const container = document.getElementById('dpr-custom-tags-list');
    if (container && !container._boundRemove) {
      container._boundRemove = true;
      container.addEventListener('click', (e) => {
        const btn = e.target.closest('.tag-remove-btn');
        if (!btn) return;
        const tagName = btn.getAttribute('data-tag-name');
        if (!tagName) return;
        _cachedCustomTags = _cachedCustomTags.filter(t => t.name !== tagName);
        renderCustomTagsList(_cachedCustomTags);
      });
    }
  };
  // --- \u81ea\u5b9a\u4e49\u6807\u7b7e\u7ba1\u7406\u7ed3\u675f ---

  const renderFromDraft = () => {
    const cfg = draftConfig || {};
    const subs = (cfg && cfg.subscriptions) || {};
    const profiles = Array.isArray(subs.intent_profiles) ? subs.intent_profiles : [];
    if (window.SubscriptionsSmartQuery && window.SubscriptionsSmartQuery.render) {
      window.SubscriptionsSmartQuery.render(profiles);
    }
    if (window.SubscriptionsSmartQuery && window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds) {
      window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds();
    }
  };

  const loadSubscriptions = async () => {
    try {
      if (!window.SubscriptionsGithubToken || !window.SubscriptionsGithubToken.loadConfig) {
        throw new Error('SubscriptionsGithubToken.loadConfig 不可用');
      }
      const { config } = await window.SubscriptionsGithubToken.loadConfig();
      draftConfig = normalizeSubscriptions(config || {});
      hasUnsavedChanges = false;
      if (window.SubscriptionsSmartQuery && window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds) {
        window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds();
      }
      renderFromDraft();
      setMessage('', '#666');
    } catch (e) {
      console.error(e);
      setMessage('加载配置失败，请确认 GitHub Token 可用。', '#c00');
    }
  };

  const saveDraftConfig = async () => {
    if (isSavingDraftConfig) {
      setMessage('正在保存中，请稍后...', '#666');
      return;
    }
    if (!window.SubscriptionsGithubToken || !window.SubscriptionsGithubToken.saveConfig) {
      setMessage('当前无法保存配置，请先完成 GitHub 登录。', '#c00');
      return;
    }
    if (!draftConfig) {
      setMessage('配置尚未加载完成，请先等待配置读取完成后再试。', '#c00');
      return;
    }
    try {
      isSavingDraftConfig = true;
      if (saveBtn) {
        saveBtn.disabled = true;
      }
      const toSave = normalizeSubscriptions(draftConfig || {});
      const validationError = validateIntentProfiles(toSave);
      if (validationError) {
        setMessage(validationError, '#c00');
        return;
      }
      setMessage('正在保存配置...', '#666');
      await window.SubscriptionsGithubToken.saveConfig(
        toSave,
        'chore: save smart query config from dashboard',
      );
      draftConfig = toSave;
      hasUnsavedChanges = false;
      if (window.SubscriptionsSmartQuery && window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds) {
        window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds();
      }
      setMessage('配置已保存。', '#080');
    } catch (e) {
      console.error(e);
      const msg = e && e.message ? e.message : '未知错误';
      setMessage(`保存配置失败：${msg}`.slice(0, 180), '#c00');
    } finally {
      isSavingDraftConfig = false;
      if (saveBtn) {
        saveBtn.disabled = false;
      }
    }
  };

  const reallyCloseOverlay = () => {
    if (!overlay) return;
    overlay.classList.remove('show');
    setTimeout(() => {
      overlay.style.display = 'none';
    }, 300);
  };

  const closeOverlay = () => {
    if (hasUnsavedChanges) {
      const ok = window.confirm('检测到未保存修改，确认直接关闭并丢弃本地草稿吗？');
      if (!ok) return;
      if (window.SubscriptionsSmartQuery && window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds) {
        window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds();
      }
      draftConfig = null;
      hasUnsavedChanges = false;
    }
    reallyCloseOverlay();
  };

  const openOverlay = () => {
    ensureOverlay();
    if (!overlay) return;
    overlay.style.display = 'flex';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        overlay.classList.add('show');
      });
    });

    if (draftConfig) {
      renderFromDraft();
    } else {
      loadSubscriptions();
    }
    setTimeout(() => loadCustomTagsFromConfig(), 500);
  };

  const bindBaseEvents = () => {
    if (closeBtn && !closeBtn._bound) {
      closeBtn._bound = true;
      closeBtn.addEventListener('click', closeOverlay);
    }

    if (overlay && !overlay._boundClick) {
      overlay._boundClick = true;
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) closeOverlay();
      });
    }

    if (saveBtn && !saveBtn._bound) {
      saveBtn._bound = true;
      saveBtn.addEventListener('click', saveDraftConfig);
    }

    const secretBtn = document.getElementById('arxiv-open-secret-setup-btn');
    if (secretBtn && !secretBtn._bound) {
      secretBtn._bound = true;
      secretBtn.addEventListener('click', () => {
        try {
          if (window.DPRSecretSetup && window.DPRSecretSetup.openStep2) {
            window.DPRSecretSetup.openStep2();
          } else {
            alert('当前页面尚未加载密钥配置向导脚本，请刷新后重试。');
          }
        } catch (e) {
          console.error(e);
        }
      });
    }

    resetContentBtn = document.getElementById('arxiv-admin-reset-content-btn');
    resetContentMsgEl = document.getElementById('arxiv-admin-reset-content-msg');

    if (resetContentBtn && !resetContentBtn._bound) {
      resetContentBtn._bound = true;
      resetContentBtn.addEventListener('click', () => {
        runResetContent(resetContentMsgEl);
      });
    }

  };

  const init = () => {
    const run = () => {
      ensureOverlay();
      document.addEventListener('ensure-arxiv-ui', () => {
        ensureOverlay();
      });
      if (!document._arxivLoadSubscriptionsEventBound) {
        document._arxivLoadSubscriptionsEventBound = true;
        document.addEventListener('load-arxiv-subscriptions', () => {
          ensureOverlay();
          loadSubscriptions();
          openOverlay();
        });
      }
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run);
    } else {
      run();
    }
  };

  return {
    init,
    openOverlay,
    closeOverlay,
    loadSubscriptions,
    markConfigDirty: () => {
      hasUnsavedChanges = true;
      updateSaveReminder();
    },
    updateDraftConfig: (updater) => {
      const base = draftConfig || {};
      const next = typeof updater === 'function' ? updater(cloneDeep(base)) || base : base;
      draftConfig = normalizeSubscriptions(next);
      hasUnsavedChanges = true;
      updateSaveReminder();
    },
    getDraftConfig: () => cloneDeep(draftConfig || {}),
    validateDraftConfig: () => validateIntentProfiles(draftConfig || {}),
  };
})();
