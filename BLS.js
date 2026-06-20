// ==UserScript==
// @name         B站直播弹幕过滤 & 一键拉黑
// @namespace    https://github.com/mavis/bilibili-live-shield
// @version      2.0.8
// @description  按 UID / 粉丝牌 / 荣耀等级 屏蔽B站直播弹幕，聊天框一键拉黑；支持过滤无牌/无荣耀用户
// @author       洋葱炸鱼饼
// @match        https://live.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @connect      api.bilibili.com
// @run-at       document-idle
// ==/UserScript==

/*
 * 配置结构：
 *   blockedUids:        string[]                              // 直接拉黑的 UID
 *   blockedFansBrands:  [{ name, minLevel }]                  // 粉丝牌黑名单（牌子名 + 最低等级）
 *   medalIconLevels:    { [normalizedIconUrl]: number }       // 用户维护的「勋章图标 → 等级数字」映射表
 *   blockedMedalMinLevel: number                              // 屏蔽荣耀等级 >= 该值的弹幕；<=0 表示不启用
 *   blockNoFans:        boolean                               // 是否屏蔽没有粉丝牌的用户
 *   blockNoMedal:       boolean                               // 是否屏蔽没有荣耀等级的用户
 *   showShielded:       boolean                               // 是否保留被屏蔽的弹幕（变灰）
 *   panelOpen:          boolean                               // 面板默认开
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'bls_config_v2';
  const SCAN_REQUEST_KEY = '_bls_scan_request';
  const SCAN_RESPONSE_KEY = '_bls_scan_response';

  const defaultConfig = {
    blockedUids: [],
    blockedFansBrands: [],
    medalIconLevels: {},
    blockedMedalMinLevel: 0,
    blockNoFans: false,
    blockNoMedal: false,
    showShielded: false,
    panelOpen: true,
  };

  function loadConfig() {
    const raw = GM_getValue(STORAGE_KEY, null);
    if (!raw) return JSON.parse(JSON.stringify(defaultConfig));
    try {
      const obj = JSON.parse(raw);
      if (obj.blockedMedals) delete obj.blockedMedals;
      const merged = Object.assign(JSON.parse(JSON.stringify(defaultConfig)), obj);
      return merged;
    } catch {
      return JSON.parse(JSON.stringify(defaultConfig));
    }
  }
  function saveConfig(cfg) {
    GM_setValue(STORAGE_KEY, JSON.stringify(cfg));
  }

  let config = loadConfig();
  const uidSet = new Set(config.blockedUids);

  // ====================== 样式 ======================
  GM_addStyle(`
    .bls-shielded {
      opacity: 0.25 !important;
      filter: grayscale(0.9);
    }
    .bls-block-btn {
      display: inline-block;
      margin-left: 6px;
      padding: 0 6px;
      height: 16px;
      line-height: 16px;
      font-size: 11px;
      color: #fff;
      background: #fb7299;
      border-radius: 8px;
      cursor: pointer;
      user-select: none;
      vertical-align: middle;
    }
    .bls-block-btn:hover { background: #ff8aab; }
    .bls-block-btn:active { transform: scale(0.95); }
    .bls-floating-btn {
      position: fixed;
      right: 16px;
      bottom: 80px;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: #fb7299;
      color: #fff;
      font-size: 22px;
      line-height: 44px;
      text-align: center;
      cursor: pointer;
      z-index: 9999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.25);
      user-select: none;
    }
    .bls-panel {
      position: fixed;
      right: 16px;
      bottom: 130px;
      width: 420px;
      max-height: 75vh;
      background: #ffffff;
      border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.25);
      padding: 14px;
      z-index: 9999;
      font-size: 13px;
      color: #222;
      overflow-y: auto;
      display: none;
    }
    .bls-panel.show { display: block; }
    .bls-panel h3 { margin: 0 0 8px; font-size: 15px; }
    .bls-panel h4 { margin: 14px 0 6px; font-size: 13px; color: #fb7299; }
    .bls-panel h4 small { color: #888; font-weight: normal; }
    .bls-panel input[type="text"],
    .bls-panel input[type="number"] {
      width: 100%;
      box-sizing: border-box;
      padding: 4px 6px;
      border: 1px solid #ddd;
      border-radius: 4px;
      margin: 2px 0;
      background: #ffffff !important;
      color: #000000 !important;
    }
    .bls-panel input[type="number"].sm { width: 60px; }
    .bls-panel button {
      background: #fb7299;
      color: #fff;
      border: none;
      border-radius: 4px;
      padding: 4px 10px;
      cursor: pointer;
      margin-left: 4px;
      font-size: 12px;
    }
    .bls-panel button:hover { background: #ff8aab; }
    .bls-panel button.secondary { background: #aaa; }
    .bls-panel button.secondary:hover { background: #888; }
    .bls-panel .row { display: flex; gap: 4px; align-items: center; margin: 4px 0; flex-wrap: wrap; }
    .bls-panel .list { margin: 4px 0; padding: 0; list-style: none; max-height: 160px; overflow-y: auto; }
    .bls-panel .list li {
      display: flex; justify-content: space-between; align-items: center;
      padding: 4px 6px; background: #f6f6f6; border-radius: 4px; margin: 2px 0; gap: 6px;
    }
    .bls-panel .list li button {
      background: #aaa; padding: 1px 6px; font-size: 11px; margin-left: 2px;
    }
    .bls-panel .list li button:hover { background: #fb7299; }
    .bls-medal-thumb {
      width: 36px; height: 16px; border-radius: 2px; object-fit: cover;
      vertical-align: middle; margin-right: 6px; flex-shrink: 0;
    }
    .bls-medal-row {
      display: flex; align-items: center; gap: 4px;
      padding: 4px 6px; background: #fff8f0; border: 1px dashed #fb7299;
      border-radius: 4px; margin: 2px 0;
    }
    .bls-medal-row img { width: 54px; height: 24px; object-fit: cover; flex-shrink: 0; }
    .bls-medal-row .url { flex: 1; font-size: 10px; color: #888; word-break: break-all; }
    .bls-medal-row .lvl { width: 60px; }
    .bls-stat { font-size: 11px; color: #888; margin-top: 8px; padding-top: 8px; border-top: 1px dashed #ddd; }
    .bls-empty { font-size: 11px; color: #888; font-style: italic; padding: 4px 0; }
    .bls-save-all-btn { margin: 6px 0; }
    .bls-success-msg { color: #4caf50; }
  `);

  // ====================== 解析 ======================
  function normalizeIconUrl(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch {
      return url.split('?')[0];
    }
  }

  function parseChatItem(item) {
    const uid = item.getAttribute('data-uid');
    const uname = item.getAttribute('data-uname') || '';
    const danmaku = item.getAttribute('data-danmaku') || '';
    let fansBrand = null;
    let medal = null;

    const fansEl = item.querySelector('.fans-medal-item-ctnr');
    if (fansEl) {
      const name = fansEl.querySelector('.fans-medal-content')?.textContent.trim();
      const level = parseInt(
        fansEl.querySelector('.fans-medal-level-font')?.textContent.trim() || '0',
        10
      );
      const anchorId = fansEl.getAttribute('data-anchor-id');
      fansBrand = { name, level, anchorId };
    }

    const medalEl = item.querySelector('.wealth-medal-ctnr');
    if (medalEl) {
      const img = medalEl.querySelector('img.wealth-medal');
      const iconUrl = img?.getAttribute('src') || '';
      const hoverText = medalEl.getAttribute('title') || '';
      medal = { iconUrl, hoverText };
    }

    return { uid, uname, danmaku, fansBrand, medal };
  }

  function shouldShield(info) {
    if (info.uid && uidSet.has(String(info.uid))) return 'uid';
    if (config.blockNoFans && !info.fansBrand) return 'nofans';
    if (config.blockNoMedal && !info.medal) return 'nomedal';
    if (info.fansBrand) {
      for (const rule of config.blockedFansBrands || []) {
        if (info.fansBrand.name === rule.name && info.fansBrand.level <= (rule.minLevel || 1)) {
          return 'fans';
        }
      }
    }
    if (info.medal && info.medal.iconUrl && (config.blockedMedalMinLevel || 0) > 0 && config.medalIconLevels) {
      const normUrl = normalizeIconUrl(info.medal.iconUrl);
      const lv = config.medalIconLevels[normUrl];
      if (typeof lv === 'number' && lv <= config.blockedMedalMinLevel) {
        return 'medal';
      }
    }
    return null;
  }

  // ====================== DOM 处理 ======================
  function processItem(item) {
    if (!item || item.dataset.blsProcessed === '1') return;
    item.dataset.blsProcessed = '1';
    const info = parseChatItem(item);
    const reason = shouldShield(info);
    if (reason) {
      if (config.showShielded) {
        item.classList.add('bls-shielded');
      } else {
        item.style.display = 'none';
      }
      item.dataset.blsShielded = reason;
    }
    injectBlockButton(item, info);
  }

  function injectBlockButton(item, info) {
    if (!info.uid || item.querySelector('.bls-block-btn')) return;
    const btn = document.createElement('span');
    btn.className = 'bls-block-btn';
    btn.textContent = '拉黑';
    btn.title = `拉黑 ${info.uname} (UID: ${info.uid})`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      blockUser(info.uid, info.uname, btn);
    });
    const right = item.querySelector('.danmaku-item-right');
    if (right && right.parentElement) {
      right.parentElement.appendChild(btn);
    } else {
      item.appendChild(btn);
    }
  }

  let watchRetry = 0;
  function watchChat() {
    const container = document.getElementById('chat-items');
    if (!container) {
      if (watchRetry < 5) {
        watchRetry++;
        setTimeout(watchChat, 1000);
      }
      return;
    }
    if (container.dataset.blsObserved === '1') return;
    container.dataset.blsObserved = '1';
    container.querySelectorAll('.chat-item.danmaku-item').forEach(processItem);
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (!(n instanceof HTMLElement)) return;
          if (n.classList?.contains('danmaku-item')) {
            processItem(n);
          } else {
            n.querySelectorAll?.('.chat-item.danmaku-item').forEach(processItem);
          }
        });
      }
    });
    mo.observe(container, { childList: true, subtree: true });
    console.log('[BLS] 聊天框监听已挂载');
  }

  function refreshAllVisible() {
    document.querySelectorAll('#chat-items .chat-item.danmaku-item').forEach((el) => {
      const info = parseChatItem(el);
      const reason = shouldShield(info);
      if (reason) {
        if (config.showShielded) {
          el.style.display = '';
          el.classList.add('bls-shielded');
        } else {
          el.style.display = 'none';
          el.classList.remove('bls-shielded');
        }
      } else {
        el.style.display = '';
        el.classList.remove('bls-shielded');
      }
    });
  }

  // ====================== 拉黑 API ======================
  let csrf = '';
  function refreshCsrf() {
    csrf = getCookie('bili_jct') || '';
  }
  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return m ? decodeURIComponent(m[2]) : '';
  }

  function blockUser(uid, uname, btnEl) {
    if (!confirm(`确定拉黑用户 ${uname} (UID: ${uid}) 吗？\n这会让他/她的弹幕被屏蔽（本次会话）。`)) return;
    refreshCsrf();
    if (!csrf) {
      alert('未取到 CSRF，可能未登录。请登录后再试。');
      return;
    }
    btnEl.textContent = '拉黑中…';
    btnEl.style.pointerEvents = 'none';

    if (!uidSet.has(String(uid))) {
      uidSet.add(String(uid));
      config.blockedUids = Array.from(uidSet);
      saveConfig(config);
    }

    GM_xmlhttpRequest({
      method: 'POST',
      url: 'https://api.bilibili.com/x/relation/modify',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: `fid=${uid}&act=5&re_src=18&csrf=${csrf}&csrf_token=${csrf}`,
      onload(resp) {
        try {
          const json = JSON.parse(resp.responseText);
          if (json.code === 0) {
            btnEl.textContent = '已拉黑';
            btnEl.style.background = '#888';
            refreshAllVisible();
          } else {
            btnEl.textContent = '失败';
            btnEl.style.background = '#e74c3c';
            console.error('[BLS] 拉黑失败', json);
            alert(`拉黑失败：${json.message || json.code}`);
          }
        } catch (e) {
          btnEl.textContent = '失败';
          console.error(e);
        }
      },
      onerror(err) {
        btnEl.textContent = '失败';
        console.error(err);
      },
    });
  }

  // ====================== 配置面板 ======================
  function createPanel() {
    if (window.top !== window) return;
    if (document.querySelector('.bls-floating-btn, .bls-panel')) return;

    const fab = document.createElement('div');
    fab.className = 'bls-floating-btn';
    fab.textContent = 'BLS';
    fab.title = '弹幕过滤设置';
    fab.addEventListener('click', togglePanel);
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.className = 'bls-panel';
    panel.innerHTML = `
      <h3>BLS · 弹幕过滤设置</h3>
      <div class="row">
        <label><input type="checkbox" id="bls-show-shielded"> 显示被屏蔽的弹幕（灰色）</label>
      </div>
      <div class="row">
        <label><input type="checkbox" id="bls-block-nofans"> 屏蔽无粉丝牌的用户</label>
        <label style="margin-left:10px"><input type="checkbox" id="bls-block-nomedal"> 屏蔽无荣耀等级的用户</label>
      </div>

      <h4>① UID 拉黑</h4>
      <div class="row">
        <input type="text" id="bls-uid-input" placeholder="UID 数字">
        <button id="bls-uid-add">加入</button>
      </div>
      <ul class="list" id="bls-uid-list"></ul>

      <h4>② 粉丝牌过滤 <small>(牌子名 + 最高等级 ≤)</small></h4>
      <div class="row">
        <input type="text" id="bls-fb-name" placeholder="牌子名 (如 三千八)">
        <input type="number" id="bls-fb-level" placeholder="≤" min="1" max="40" class="sm">
        <button id="bls-fb-add">加入</button>
      </div>
      <ul class="list" id="bls-fb-list"></ul>

      <h4>③ 荣耀等级过滤 <small>(通过图标映射表)</small></h4>
      <div class="row">
        <label>屏蔽等级 ≤</label>
        <input type="number" id="bls-medal-min" min="1" max="60" class="sm" placeholder="0=关">
        <button id="bls-medal-apply" class="secondary">应用</button>
        <button id="bls-medal-scan" class="secondary">从聊天框扫描图标</button>
      </div>
      <div id="bls-medal-scan-result"></div>
      <div class="row">
        <input type="text" id="bls-medal-manual-url" placeholder="或手动粘贴图标 URL">
        <input type="number" id="bls-medal-manual-lv" placeholder="等级" min="1" max="60" class="sm">
        <button id="bls-medal-manual-add">加入映射</button>
      </div>
      <ul class="list" id="bls-medal-list"></ul>

      <div class="row">
        <button id="bls-export" class="secondary">导出配置 JSON</button>
        <button id="bls-import" class="secondary">导入配置 JSON</button>
      </div>
      <div class="bls-stat" id="bls-stat"></div>
    `;
    document.body.appendChild(panel);
    if (config.panelOpen) panel.classList.add('show');

    bindPanelEvents(panel);
    renderLists();
  }

  function togglePanel() {
    const panel = document.querySelector('.bls-panel');
    if (!panel) return;
    panel.classList.toggle('show');
    config.panelOpen = panel.classList.contains('show');
    saveConfig(config);
  }

  function saveScannedIcons(area) {
    const rows = area.querySelectorAll('.bls-medal-row');
    let updated = false;
    rows.forEach((row) => {
      const img = row.querySelector('img');
      const input = row.querySelector('.lvl');
      const url = img.getAttribute('src');
      const val = parseInt(input.value, 10);
      if (url && val && val >= 1) {
        const normUrl = normalizeIconUrl(url);
        config.medalIconLevels[normUrl] = val;
        updated = true;
      }
    });
    if (updated) {
      saveConfig(config);
      renderLists();
      refreshAllVisible();
      const msg = document.createElement('div');
      msg.className = 'bls-empty bls-success-msg';
      msg.textContent = '✅ 已保存所有填写的映射！';
      area.prepend(msg);
      setTimeout(() => { msg.remove(); }, 3000);
    } else {
      alert('未填写任何有效的等级数字，请至少填写一个。');
    }
  }

  function bindPanelEvents(panel) {
    panel.querySelector('#bls-show-shielded').checked = !!config.showShielded;
    panel.querySelector('#bls-show-shielded').addEventListener('change', (e) => {
      config.showShielded = e.target.checked;
      saveConfig(config);
    });

    panel.querySelector('#bls-block-nofans').checked = !!config.blockNoFans;
    panel.querySelector('#bls-block-nofans').addEventListener('change', (e) => {
      config.blockNoFans = e.target.checked;
      saveConfig(config);
    });

    panel.querySelector('#bls-block-nomedal').checked = !!config.blockNoMedal;
    panel.querySelector('#bls-block-nomedal').addEventListener('change', (e) => {
      config.blockNoMedal = e.target.checked;
      saveConfig(config);
    });

    panel.querySelector('#bls-uid-add').addEventListener('click', () => {
      const v = panel.querySelector('#bls-uid-input').value.trim();
      if (!v) return;
      if (!uidSet.has(v)) {
        uidSet.add(v);
        config.blockedUids = Array.from(uidSet);
        saveConfig(config);
        renderLists();
      }
      panel.querySelector('#bls-uid-input').value = '';
    });

    panel.querySelector('#bls-fb-add').addEventListener('click', () => {
      const name = panel.querySelector('#bls-fb-name').value.trim();
      const level = parseInt(panel.querySelector('#bls-fb-level').value, 10) || 1;
      if (!name) return;
      config.blockedFansBrands.push({ name, minLevel: level });
      saveConfig(config);
      renderLists();
    });

    panel.querySelector('#bls-medal-min').value = config.blockedMedalMinLevel || 0;
    panel.querySelector('#bls-medal-apply').addEventListener('click', () => {
      const v = parseInt(panel.querySelector('#bls-medal-min').value, 10) || 0;
      config.blockedMedalMinLevel = v;
      saveConfig(config);
      renderLists();
    });

    // 扫描图标
    panel.querySelector('#bls-medal-scan').addEventListener('click', () => {
      const area = panel.querySelector('#bls-medal-scan-result');
      area.innerHTML = '<div class="bls-empty">正在扫描，请稍候…</div>';

      const requestId = Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      console.log('[BLS] 发送扫描请求，ID:', requestId);

      GM_setValue(SCAN_RESPONSE_KEY, '');
      GM_setValue(SCAN_REQUEST_KEY, JSON.stringify({ id: requestId, action: 'scan' }));

      let responseReceived = false;
      const listenerId = GM_addValueChangeListener(SCAN_RESPONSE_KEY, (name, oldVal, newVal) => {
        if (!newVal) return;
        try {
          const resp = JSON.parse(newVal);
          if (resp.id !== requestId) return;
          responseReceived = true;
          console.log('[BLS] 收到扫描响应，图标数:', resp.icons?.length || 0);

          let icons = resp.icons || [];
          // 过滤掉已经存在映射的图标
          const existingUrls = Object.keys(config.medalIconLevels);
          const newIcons = icons.filter(url => !existingUrls.includes(normalizeIconUrl(url)));

          if (newIcons.length === 0) {
            if (icons.length === 0) {
              area.innerHTML = '<div class="bls-empty">聊天框里现在没有带荣耀勋章的弹幕，等一会儿再点。</div>';
            } else {
              area.innerHTML = '<div class="bls-empty">所有扫描到的图标均已存在映射，无需重复添加。</div>';
            }
          } else {
            let html = `<div class="bls-empty">扫描到 ${newIcons.length} 个新图标（已过滤已映射的），填入等级后点保存:</div>`;
            html += `<div class="row bls-save-all-btn"><button id="bls-save-scanned" class="secondary">💾 一键保存所有</button></div>`;
            area.innerHTML = html;
            const container = area;

            newIcons.forEach((url) => {
              const row = document.createElement('div');
              row.className = 'bls-medal-row';
              row.innerHTML = `
                <img src="${url}" referrerpolicy="no-referrer">
                <span class="url">${escapeHtml(url)}</span>
                <input type="number" class="sm lvl" placeholder="等级" min="1" max="60" value="">
              `;
              container.appendChild(row);
            });

            container.querySelector('#bls-save-scanned').addEventListener('click', () => {
              saveScannedIcons(container);
            });
          }

          GM_removeValueChangeListener(listenerId);
          GM_setValue(SCAN_RESPONSE_KEY, '');
        } catch (e) {
          console.error('[BLS] 处理扫描响应出错', e);
          area.innerHTML = '<div class="bls-empty">扫描出错，请重试。</div>';
          GM_removeValueChangeListener(listenerId);
          GM_setValue(SCAN_RESPONSE_KEY, '');
        }
      });

      setTimeout(() => {
        if (!responseReceived) {
          try {
            GM_removeValueChangeListener(listenerId);
            if (area.querySelector('.bls-empty')?.textContent === '正在扫描，请稍候…') {
              area.innerHTML = '<div class="bls-empty">扫描超时，请确保聊天框已加载并重试。</div>';
              console.warn('[BLS] 扫描超时，未收到响应');
            }
            GM_setValue(SCAN_RESPONSE_KEY, '');
          } catch (e) {}
        }
      }, 10000);
    });

    // 手动添加映射
    panel.querySelector('#bls-medal-manual-add').addEventListener('click', () => {
      const url = normalizeIconUrl(panel.querySelector('#bls-medal-manual-url').value.trim());
      const lv = parseInt(panel.querySelector('#bls-medal-manual-lv').value, 10);
      if (!url || !lv || lv < 1) {
        alert('请填入完整的 URL 和等级数字');
        return;
      }
      config.medalIconLevels[url] = lv;
      saveConfig(config);
      renderLists();
      refreshAllVisible();
      panel.querySelector('#bls-medal-manual-url').value = '';
      panel.querySelector('#bls-medal-manual-lv').value = '';
    });

    // 导入/导出
    panel.querySelector('#bls-export').addEventListener('click', () => {
      const txt = JSON.stringify(config, null, 2);
      const blob = new Blob([txt], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `bls-config-${Date.now()}.json`;
      a.click();
    });

    panel.querySelector('#bls-import').addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.onchange = (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => {
          try {
            const obj = JSON.parse(r.result);
            if (!obj || typeof obj !== 'object') throw new Error('不是有效 JSON');
            if (!confirm('确定要用导入的配置覆盖当前配置？')) return;
            config = Object.assign({}, loadConfig(), obj);
            uidSet.clear();
            (config.blockedUids || []).forEach((u) => uidSet.add(String(u)));
            saveConfig(config);
            renderLists();
            refreshAllVisible();
          } catch (err) {
            alert('导入失败: ' + err.message);
          }
        };
        r.readAsText(f);
      };
      inp.click();
    });
  }

  function renderLists() {
    const panel = document.querySelector('.bls-panel');
    if (!panel) return;

    panel.querySelector('#bls-show-shielded').checked = !!config.showShielded;
    panel.querySelector('#bls-block-nofans').checked = !!config.blockNoFans;
    panel.querySelector('#bls-block-nomedal').checked = !!config.blockNoMedal;
    panel.querySelector('#bls-medal-min').value = config.blockedMedalMinLevel || 0;

    const uidList = panel.querySelector('#bls-uid-list');
    uidList.innerHTML = '';
    config.blockedUids.forEach((u) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>UID: ${escapeHtml(u)}</span><button>移除</button>`;
      li.querySelector('button').addEventListener('click', () => {
        uidSet.delete(u);
        config.blockedUids = config.blockedUids.filter((x) => x !== u);
        saveConfig(config);
        renderLists();
        refreshAllVisible();
      });
      uidList.appendChild(li);
    });
    if (!config.blockedUids.length) {
      uidList.innerHTML = '<li class="bls-empty" style="background:none">（空）</li>';
    }

    const fbList = panel.querySelector('#bls-fb-list');
    fbList.innerHTML = '';
    config.blockedFansBrands.forEach((r, idx) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(r.name)} ≤ Lv.${r.minLevel}</span><button>移除</button>`;
      li.querySelector('button').addEventListener('click', () => {
        config.blockedFansBrands.splice(idx, 1);
        saveConfig(config);
        renderLists();
        refreshAllVisible();
      });
      fbList.appendChild(li);
    });
    if (!config.blockedFansBrands.length) {
      fbList.innerHTML = '<li class="bls-empty" style="background:none">（空）</li>';
    }

    const mdList = panel.querySelector('#bls-medal-list');
    mdList.innerHTML = '';
    // 获取映射条目并按等级升序排序
    const entries = Object.entries(config.medalIconLevels);
    entries.sort((a, b) => a[1] - b[1]); // 按等级从小到大

    entries.forEach(([url, lv]) => {
      const li = document.createElement('li');
      li.innerHTML = `
        <span style="display:flex;align-items:center;flex:1;overflow:hidden">
          <img class="bls-medal-thumb" src="${escapeHtml(url)}" referrerpolicy="no-referrer">
          <span style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(url.split('/').pop())}</span>
        </span>
        <span>Lv.${lv}</span>
        <button>移除</button>`;
      li.querySelector('button').addEventListener('click', () => {
        delete config.medalIconLevels[url];
        saveConfig(config);
        renderLists();
        refreshAllVisible();
      });
      mdList.appendChild(li);
    });
    if (!entries.length) {
      mdList.innerHTML = '<li class="bls-empty" style="background:none">（空，点上面的"扫描图标"自动抓）</li>';
    }

    panel.querySelector('#bls-stat').textContent =
      `当前：UID ${config.blockedUids.length} / 粉丝牌 ${config.blockedFansBrands.length} / 图标映射 ${entries.length} / 荣耀阈值 ${config.blockedMedalMinLevel || '关'}` +
      (config.blockNoFans ? ' / 屏蔽无牌' : '') +
      (config.blockNoMedal ? ' / 屏蔽无荣耀' : '');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ====================== 跨 frame 通信处理 ======================
  function onConfigChanged() {
    const newConfig = loadConfig();
    config = newConfig;
    uidSet.clear();
    (config.blockedUids || []).forEach((u) => uidSet.add(String(u)));
    refreshAllVisible();
    if (window.top === window) {
      renderLists();
    }
  }

  function handleScanRequest() {
    GM_addValueChangeListener(SCAN_REQUEST_KEY, (name, oldVal, newVal) => {
      if (!newVal) return;
      try {
        const req = JSON.parse(newVal);
        if (req.action !== 'scan') return;
        console.log('[BLS] 收到扫描请求，ID:', req.id);

        const container = document.getElementById('chat-items');
        if (!container) {
          console.warn('[BLS] 当前 frame 没有聊天框，忽略扫描请求');
          return;
        }

        setTimeout(() => {
          const iconSet = new Set();
          container.querySelectorAll('.chat-item.danmaku-item .wealth-medal-ctnr img.wealth-medal').forEach((img) => {
            const src = img.getAttribute('src');
            if (src) {
              const norm = normalizeIconUrl(src);
              if (norm) iconSet.add(norm);
            }
          });
          const icons = Array.from(iconSet);
          console.log('[BLS] 扫描完成，发现图标数:', icons.length);
          GM_setValue(SCAN_RESPONSE_KEY, JSON.stringify({ id: req.id, icons: icons }));
          GM_setValue(SCAN_REQUEST_KEY, '');
        }, 200);
      } catch (e) {
        console.error('[BLS] 处理扫描请求失败', e);
        try {
          const req = JSON.parse(newVal);
          GM_setValue(SCAN_RESPONSE_KEY, JSON.stringify({ id: req.id, icons: [] }));
          GM_setValue(SCAN_REQUEST_KEY, '');
        } catch (_) {}
      }
    });
  }

  // ====================== 启动 ======================
  function boot() {
    if (window.__blsBooted) return;
    window.__blsBooted = true;

    refreshCsrf();
    watchChat();

    GM_addValueChangeListener(STORAGE_KEY, (name, oldVal, newVal) => {
      if (newVal) onConfigChanged();
    });

    handleScanRequest();

    if (window.top === window) {
      createPanel();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
