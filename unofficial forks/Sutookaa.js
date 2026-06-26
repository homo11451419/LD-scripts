// ==UserScript==
// @name         LinuxDo 追觅
// @namespace    https://linux.do/
// @version      4.0.0
// @description  在网页上实时监控 Linux.do 活动（面板版 + Boost）
// @author       ChiGamma
// @license      Fair License
// @match        https://linux.do/*
// @connect      linux.do
// @icon         https://linux.do/uploads/default/original/3X/9/d/9dd4973138ccd78e8907865261d7b14d45a96d1c.png
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        window.focus
// ==/UserScript==

(function () {
    'use strict';

    if (window.top !== window.self) return;
    if (window.ld_seeking_init_done) return;
    window.ld_seeking_init_done = true;

    // ═══════════════════════════════════════
    //  配置
    // ═══════════════════════════════════════
    const CONFIG = {
        MAX_USERS: 5,
        PANEL_WIDTH: '340px',
        PANEL_MAX_HEIGHT: '70vh',
        REFRESH_INTERVAL_MS: 60 * 1000,
        LOG_LIMIT_PER_USER: 10,
        HOST: 'https://linux.do',
        MAX_RETRIES: 2,
        RETRY_DELAY_MS: 2000,
        ERROR_BACKOFF_MS: 5 * 60 * 1000,
        THROTTLE_MS: 500,
        TOAST_DURATION_MS: 3000,
    };

    const nameColors = [
        "#ffd700",
        "#f87eca", "#4d5ef7", "#00d4ff", "#ff6b6b", "#c77dff", "#00ff88",
    ];

    // ═══════════════════════════════════════
    //  类别
    // ═══════════════════════════════════════
    const categoryColors = {
        '开发调优': '#32c3c3', '国产替代': '#D12C25', '资源荟萃': '#12A89D',
        '网盘资源': '#16b176', '文档共建': '#9cb6c4', '跳蚤市场': '#ED207B',
        '非我莫属': '#a8c6fe', '读书成诗': '#e0d900', '扬帆起航': '#ff9838',
        '前沿快讯': '#BB8FCE', '网络记忆': '#F7941D', '福利羊毛': '#E45735',
        '搞七捻三': '#3AB54A', '社区孵化': '#ffbb00', '运营反馈': '#808281',
        '深海幽域': '#45B7D1', '积分乐园': '#fcca44', '虫洞广场': '#ff00f7',
        '未分区':   '#9e9e9e',
    };
    const categoryMap = new Map();
    const category_dict = {
        "开发调优": [4, 20, 31, 88], "国产替代": [98, 99, 100, 101], "资源荟萃": [14, 83, 84, 85],
        '网盘资源': [94, 95, 96, 97], "文档共建": [42, 75, 76, 77], "跳蚤市场": [10, 13, 81, 82],
        "非我莫属": [27, 72, 73, 74], "读书成诗": [32, 69, 70, 71], "扬帆起航": [46, 66, 67, 68],
        "前沿快讯": [34, 78, 79, 80], "网络记忆": [92], "福利羊毛": [36, 60, 61, 62],
        "搞七捻三": [11, 35, 89, 21], "社区孵化": [102, 103, 104, 105], "运营反馈": [2, 63, 64, 65],
        "深海幽域": [45, 57, 58, 59], "积分乐园": [106, 107, 108, 109], "虫洞广场": [110],
    };
    for (const name in category_dict) category_dict[name].forEach(id => categoryMap.set(id, name));

    // ═══════════════════════════════════════
    //  状态
    // ═══════════════════════════════════════
    function loadConfig() {
        try { return JSON.parse(GM_getValue('ld_v21_config', '{}')); }
        catch { return {}; }
    }
    function getSelfUser() {
        try {
            const el = document.getElementById('data-preloaded');
            if (el) { const d = JSON.parse(el.dataset.preloaded); if (d.currentUser) return JSON.parse(d.currentUser).username; }
        } catch {}
        return null;
    }

    const saved = loadConfig();
    const pushedIds = new Set();

    const State = {
        users: saved.users || [],
        lastIds: saved.lastIds || {},
        multipliers: {},
        enableSysNotify: saved.enableSysNotify !== false,
        enableDanmaku: saved.enableDanmaku !== false,
        data: {},
        panelOpen: false,
        isProcessing: false,
        hiddenUsers: new Set(saved.hiddenUsers || []),
        selfUser: getSelfUser(),
        nextFetchTime: {},
        userProfiles: {},
        isLeader: false,
        unreadCount: 0,
    };

    // ═══════════════════════════════════════
    //  工具函数
    // ═══════════════════════════════════════
    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    function formatTimeAgo(isoTime) {
        if (!isoTime) return '--';
        const diff = Date.now() - new Date(isoTime).getTime();
        if (diff < 0) return '0s';
        const s = Math.floor(diff / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
        if (d > 0) return `${d}d${h % 24}h`;
        if (h > 0) return `${h}h${m % 60}m`;
        if (m > 0) return `${m}m${s % 60}s`;
        return `${s}s`;
    }

    function getTimeAgoColor(isoTime, userColor) {
        if (!isoTime) return '#666';
        const ratio = Math.min(1, Math.max(0, (Date.now() - new Date(isoTime).getTime()) / 3600000));
        const hex = userColor.replace('#', '');
        const r1 = parseInt(hex.substr(0, 2), 16), g1 = parseInt(hex.substr(2, 2), 16), b1 = parseInt(hex.substr(4, 2), 16);
        return `rgb(${Math.round(r1 + (204 - r1) * ratio)},${Math.round(g1 + (204 - g1) * ratio)},${Math.round(b1 + (204 - b1) * ratio)})`;
    }

    function getUserColor(username) {
        return nameColors[1 + State.users.indexOf(username) % nameColors.length];
    }

    function getIntervalMultiplier(lastSeenAt) {
        const cm = State.panelOpen ? 1 : 2;
        if (!lastSeenAt) return 20 * cm;
        const m = (Date.now() - new Date(lastSeenAt).getTime()) / 60000;
        if (m < 2) return 1 * cm;
        if (m < 10) return 1.5 * cm;
        if (m < 20) return 2 * cm;
        if (m < 30) return 3 * cm;
        if (m < 60) return 4 * cm;
        if (m < 120) return 5 * cm;
        if (m < 720) return 10 * cm;
        return 20 * cm;
    }

    function getUserCycleDuration(u) {
        return CONFIG.REFRESH_INTERVAL_MS * (State.multipliers[u] || 1);
    }

    // ═══════════════════════════════════════
    //  跨 Tab 通信
    // ═══════════════════════════════════════
    const channel = new BroadcastChannel('ld_seeking_channel');
    let leaderCheckTimeout = null, pendingLeadershipTimer = null;

    function saveConfig() {
        GM_setValue('ld_v21_config', JSON.stringify({
            users: State.users, lastIds: State.lastIds,
            enableSysNotify: State.enableSysNotify, enableDanmaku: State.enableDanmaku,
            hiddenUsers: Array.from(State.hiddenUsers)
        }));
    }

    function broadcastState() {
        channel.postMessage({
            type: 'data_update', data: State.data, lastIds: State.lastIds,
            hiddenUsers: Array.from(State.hiddenUsers), nextFetchTime: State.nextFetchTime,
            multipliers: State.multipliers, userProfiles: State.userProfiles, users: State.users
        });
    }

    // ═══════════════════════════════════════
    //  网络层
    // ═══════════════════════════════════════
    function safeFetch(url, timeout = 30000, retryCount = 0) {
        return new Promise(async (resolve, reject) => {
            const isSame = url.startsWith(CONFIG.HOST) || url.startsWith('/');
            const meta = document.querySelector('meta[name="csrf-token"]');
            const headers = { "X-CSRF-Token": meta ? meta.content : '' };

            if (isSame) {
                const ctrl = new AbortController();
                const tid = setTimeout(() => ctrl.abort(), timeout);
                try {
                    const res = await fetch(url, { method: 'GET', headers, credentials: 'include', signal: ctrl.signal });
                    clearTimeout(tid);
                    if (res.ok) { try { resolve(await res.json()); } catch { reject(new Error("JSON Parse Error")); } }
                    else if ((res.status >= 500 || res.status === 429) && retryCount < CONFIG.MAX_RETRIES) {
                        await wait(CONFIG.RETRY_DELAY_MS * (retryCount + 1));
                        resolve(safeFetch(url, timeout, retryCount + 1));
                    } else { const e = new Error(`Status ${res.status}`); e.status = res.status; reject(e); }
                } catch (err) {
                    clearTimeout(tid);
                    if (retryCount < CONFIG.MAX_RETRIES && err.name !== 'AbortError') {
                        await wait(CONFIG.RETRY_DELAY_MS * (retryCount + 1));
                        resolve(safeFetch(url, timeout, retryCount + 1));
                    } else reject(err.name === 'AbortError' ? new Error("Timeout") : err);
                }
            } else {
                GM_xmlhttpRequest({
                    method: "GET", url, timeout,
                    headers: { ...headers, "User-Agent": navigator.userAgent, "X-Requested-With": "XMLHttpRequest", "Referer": CONFIG.HOST + "/", "Origin": CONFIG.HOST, "Cookie": document.cookie },
                    onload: async (r) => {
                        if (r.status >= 200 && r.status < 300) { try { resolve(JSON.parse(r.responseText)); } catch { reject(new Error("JSON Parse Error")); } }
                        else if ((r.status >= 500 || r.status === 429) && retryCount < CONFIG.MAX_RETRIES) { await wait(CONFIG.RETRY_DELAY_MS * (retryCount + 1)); resolve(safeFetch(url, timeout, retryCount + 1)); }
                        else { const e = new Error(`Status ${r.status}`); e.status = r.status; reject(e); }
                    },
                    ontimeout: async () => { if (retryCount < CONFIG.MAX_RETRIES) { await wait(CONFIG.RETRY_DELAY_MS * (retryCount + 1)); resolve(safeFetch(url, timeout, retryCount + 1)); } else reject(new Error("Timeout")); },
                    onerror: (e) => reject(e)
                });
            }
        });
    }

    // ═══════════════════════════════════════
    //  数据处理
    // ═══════════════════════════════════════
    async function fetchUser(username, isInitial = false) {
        const timeout = Math.floor(getUserCycleDuration(username) / 3);

        try {
            const pj = await safeFetch(`${CONFIG.HOST}/u/${username}.json`, timeout);
            if (!pj?.user) return [];
            State.multipliers[username] = getIntervalMultiplier(pj.user.last_seen_at);
            const old = State.userProfiles[username];
            const changed = !old || old.last_seen_at !== pj.user.last_seen_at;
            State.userProfiles[username] = { last_posted_at: pj.user.last_posted_at, last_seen_at: pj.user.last_seen_at };
            if (!isInitial && !changed && State.data[username]?.length > 0) return 'SKIPPED';
        } catch (e) {
            if (e.status === 404) return 'NOT_FOUND';
            if (e.status === 429) {
                State.multipliers[username] = 5;
                const old = State.userProfiles[username];
                State.userProfiles[username] = old || { last_posted_at: '', last_seen_at: '' };
                return 'RATE_LIMIT';
            }
            return 'ERROR';
        }

        try {
            await wait(CONFIG.THROTTLE_MS);
            const [resA, resR, resB] = await Promise.allSettled([
                safeFetch(`${CONFIG.HOST}/user_actions.json?offset=0&limit=${CONFIG.LOG_LIMIT_PER_USER}&username=${username}&filter=1,4,5`, timeout),
                safeFetch(`${CONFIG.HOST}/discourse-reactions/posts/reactions.json?username=${username}`, timeout),
                safeFetch(`${CONFIG.HOST}/u/${username}/activity/boosts-given.json`, timeout)
            ]);
            const jA = resA.status === 'fulfilled' ? resA.value : { user_actions: [] };
            const jR = resR.status === 'fulfilled' ? resR.value : [];
            const jB = resB.status === 'fulfilled' ? resB.value : { user_actions: [] };

            const actions = (jA.user_actions || []).map(a => {
                if (a.action_type === 1) return { ...a, username: a.acting_username, name: a.acting_name, user_id: a.acting_user_id, avatar_template: a.acting_avatar_template, acting_username: a.username, acting_name: a.name, acting_user_id: a.user_id, acting_avatar_template: a.avatar_template };
                return a;
            });
            const reactions = (jR || []).map(r => ({
                id: r.id, post_id: r.post_id, created_at: r.created_at,
                username: r.user?.username || '', name: r.user?.name || '', user_id: r.user_id, avatar_template: r.user?.avatar_template || '',
                acting_username: r.post?.user?.username || r.post?.username || '', acting_name: r.post?.user?.name || r.post?.name || '', acting_user_id: r.post?.user_id || '', acting_avatar_template: r.post?.user?.avatar_template || r.post?.avatar_template || '',
                topic_id: r.post?.topic_id, post_number: r.post?.post_number, title: r.post?.topic_title || r.post?.topic?.title || '', excerpt: r.post?.excerpt || '', category_id: r.post?.category_id,
                action_type: r.reaction?.reaction_value || 'reaction', reaction_value: r.reaction?.reaction_value
            }));
            const boosts = (jB.user_actions || []).map(b => ({ ...b, action_type: 'boost' }));

            return [...actions, ...reactions, ...boosts].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, CONFIG.LOG_LIMIT_PER_USER);
        } catch (e) {
            return e.status === 429 ? 'RATE_LIMIT' : 'ERROR';
        }
    }

    function getUniqueId(a) { return a.id || (a.topic_id && a.post_number ? `${a.topic_id}_${a.post_number}` : `ts_${Date.now()}`); }

    function cleanHtml(html) {
        if (!html) return '';
        const t = document.createElement('div'); t.innerHTML = html;
        t.querySelectorAll('img').forEach(i => i.classList.contains('emoji') ? i.replaceWith(i.alt) : i.remove());
        return (t.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function extractImg(html) {
        if (!html) return null;
        const t = document.createElement('div'); t.innerHTML = html;
        const i = t.querySelector('img:not(.emoji)'); if (!i) return null;
        let s = i.src; if (s.startsWith('/')) s = CONFIG.HOST + s;
        if (!s.startsWith('http')) { const r = i.getAttribute('src'); if (r?.startsWith('/')) return CONFIG.HOST + r; }
        return s;
    }

    function getActionIcon(at) {
        const I = {
            reply: '<svg class="fa svg-icon" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 512 512"><path d="M8.309 189.836L184.313 37.851C199.719 24.546 224 35.347 224 56.015v80.053c160.629 1.839 288 34.032 288 186.258 0 61.441-39.581 122.309-83.333 154.132-13.653 9.931-33.111-2.533-28.077-18.631 45.344-145.012-21.507-183.51-176.59-185.742V360c0 20.7-24.3 31.453-39.687 18.164l-176.004-152c-11.071-9.562-11.086-26.753 0-36.328z"/></svg>',
            post: '<svg class="fa svg-icon" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 512 512"><path d="M497.9 142.1l-46.1 46.1c-4.7 4.7-12.3 4.7-17 0l-111-111c-4.7-4.7-4.7-12.3 0-17l46.1-46.1c18.7-18.7 49.1-18.7 67.9 0l60.1 60.1c18.8 18.7 18.8 49.1 0 67.9zM284.2 99.8L21.6 362.4.4 483.9c-2.9 16.4 11.4 30.6 27.8 27.8l121.5-21.3 262.6-262.6c4.7-4.7 4.7-12.3 0-17l-111-111c-4.8-4.7-12.4-4.7-17.1 0zM88 424h48v36.3l-64.5 11.3-31.1-31.1L51.7 376H88v48z"/></svg>',
            like: '<svg class="fa svg-icon" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 640 640"><path fill="#fa6c8d" d="M305 151.1L320 171.8L335 151.1C360 116.5 400.2 96 442.9 96C516.4 96 576 155.6 576 229.1L576 231.7C576 343.9 436.1 474.2 363.1 529.9C350.7 539.3 335.5 544 320 544C304.5 544 289.2 539.4 276.9 529.9C203.9 474.2 64 343.9 64 231.7L64 229.1C64 155.6 123.6 96 197.1 96C239.8 96 280 116.5 305 151.1z"/></svg>',
            boost: '<svg class="fa svg-icon" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 512 512"><path fill="#f7c948" d="M256 0l80 160 176 26-128 124 30 176-158-84-158 84 30-176L0 186l176-26z"/></svg>',
        };
        const RI = {
            "tieba_087": '/uploads/default/original/3X/2/e/2e09f3a3c7b27eacbabe9e9614b06b88d5b06343.png?v=15',
            "bili_057": '/uploads/default/original/3X/1/a/1a9f6c30e88a7901b721fffc1aaeec040f54bdf3.png?v=15'
        };
        if (at === 'boost') return I.boost;
        if (at === 5) return I.reply;
        if (at === 4) return I.post;
        if (at === 1) return I.like;
        if (typeof at === 'string') {
            if (RI[at]) return `<img src="${CONFIG.HOST}${RI[at]}" class="act-emoji" alt=":${at}:">`;
            return `<img src="${CONFIG.HOST}/images/emoji/twemoji/${at}.png?v=15" class="act-emoji" alt=":${at}:">`;
        }
        return I.reply;
    }

    function getUsernameColor(u) {
        if (!u) return null;
        const l = u.toLowerCase();
        if (State.selfUser && l === State.selfUser.toLowerCase()) return nameColors[0];
        const i = State.users.findIndex(x => x.toLowerCase() === l);
        if (i !== -1 && i + 1 < nameColors.length) return nameColors[i + 1];
        return null;
    }

    function formatActionInfo(action) {
        const icon = getActionIcon(action.action_type);
        const user = action.username || '', act = action.acting_username || '';
        const actAvatar = action.acting_avatar_template ? CONFIG.HOST + action.acting_avatar_template.replace("{size}", "24") : null;
        const uc = getUsernameColor(user), ac = getUsernameColor(act);
        const fmt = (c, clr) => clr ? `<span style="color:${clr};display:flex;align-items:center;gap:1px">${c}</span>` : c;
        const uh = fmt(user, uc);
        if (act && act !== user) {
            const ac2 = actAvatar ? `<img src="${actAvatar}" class="avatar-sm">&nbsp;${act}` : act;
            return { html: `${uh} ${icon} ${fmt(ac2, ac)}` };
        }
        return { html: `${uh} ${icon}` };
    }

    // ═══════════════════════════════════════
    //  通知 & 弹幕
    // ═══════════════════════════════════════
    function sendNotification(action) {
        const uid = getUniqueId(action);
        if (pushedIds.has(uid)) return;
        pushedIds.add(uid);
        if (pushedIds.size > 200) pushedIds.delete(pushedIds.values().next().value);

        let avatar = CONFIG.HOST + "/uploads/default/original/3X/9/d/9dd4973138ccd78e8907865261d7b14d45a96d1c.png";
        if (action.avatar_template) avatar = CONFIG.HOST + action.avatar_template.replace("{size}", "64");
        const excerpt = cleanHtml(action.excerpt);
        const link = `${CONFIG.HOST}/t/${action.topic_id}/${action.post_number}`;

        // 弹幕
        if (State.enableDanmaku && shadowRoot) {
            const layer = shadowRoot.getElementById('dm-container');
            if (layer) {
                const isLR = action.action_type === 1 || typeof action.action_type === 'string';
                const isSelf = State.selfUser && action.acting_username?.toLowerCase() === State.selfUser.toLowerCase();
                if (isLR && isSelf) {
                    const pop = document.createElement('div');
                    pop.className = 'dm-icon-pop';
                    pop.style.cssText = `left:${10+Math.random()*70}vw;top:${10+Math.random()*60}vh`;
                    pop.innerHTML = getActionIcon(action.action_type);
                    layer.appendChild(pop);
                    setTimeout(() => pop.remove(), 3000);
                }
                const item = document.createElement('div');
                item.className = 'dm-item';
                item.style.cssText = `top:${5+Math.random()*80}vh;animation-duration:${8+Math.random()*4}s`;
                item.onclick = () => window.open(link, '_blank');
                const ai = formatActionInfo(action);
                const ec = (action.action_type === 4 || action.action_type === 5) ? 'dm-excerpt' : 'dm-excerpt-cited';
                item.innerHTML = `<div class="dm-top"><img src="${avatar}" class="dm-avatar"><div class="dm-info"><div class="dm-user">${ai.html}</div><div class="dm-title">${action.title}</div></div></div>${excerpt ? `<div class="${ec}">${excerpt}</div>` : ''}`;
                layer.appendChild(item);
                setTimeout(() => item.remove(), 16000);
            }
        }
        // 系统通知
        if (State.enableSysNotify && State.users.indexOf(action.username) === 0) {
            GM_notification({ title: action.username, text: `${action.title}\n${excerpt.substring(0, 50)}`, image: avatar, timeout: 3000, onclick: () => { window.focus(); window.open(link, '_blank'); } });
        }
    }

    // ═══════════════════════════════════════
    //  任务调度
    // ═══════════════════════════════════════
    async function processUser(user, isInitial = false) {
        const result = await fetchUser(user, isInitial);
        if (result === 'SKIPPED') return false;
        if (result === 'NOT_FOUND') { showToast(`用户 "${user}" 不存在`, 'error'); return 'ERROR'; }
        if (result === 'RATE_LIMIT') { showToast('请求超限，已自动降速', 'warning'); return 'RATE_LIMIT'; }
        if (result === 'ERROR') return 'ERROR';
        const actions = result;
        if (!actions || actions.length === 0) return false;

        const latestId = getUniqueId(actions[0]);
        const lastSavedId = State.lastIds[user];
        let hasUpdates = false;

        if (!lastSavedId) {
            State.lastIds[user] = latestId;
            hasUpdates = true;
        } else if (latestId !== lastSavedId && !isInitial) {
            const diff = [];
            for (const act of actions) { if (getUniqueId(act) === lastSavedId) break; diff.push(act); }
            if (diff.length > 0) {
                diff.reverse().forEach((act, i) => setTimeout(() => { sendNotification(act); broadcastNewAction(act); }, i * 1000));
                State.lastIds[user] = latestId;
                hasUpdates = true;
                if (!State.panelOpen) { State.unreadCount += diff.length; updateBadge(); }
            }
        }
        State.data[user] = actions;
        return hasUpdates;
    }

    async function tickAll() {
        if (!State.isLeader) { channel.postMessage({ type: 'cmd_refresh_all' }); return; }
        if (State.isProcessing) return;
        State.isProcessing = true;
        updateStatusDot('loading');
        const now = Date.now();
        let hasUpdates = false;
        for (const user of State.users) {
            const r = await processUser(user, true);
            if (r === true) hasUpdates = true;
            let d = getUserCycleDuration(user) + Math.random() * 10000;
            if (r === 'RATE_LIMIT') d = CONFIG.ERROR_BACKOFF_MS * 2;
            else if (r === 'ERROR') d = CONFIG.ERROR_BACKOFF_MS;
            State.nextFetchTime[user] = now + d;
            await wait(CONFIG.THROTTLE_MS);
        }
        if (hasUpdates) saveConfig();
        renderFeed(); broadcastState(); updateStatusDot();
        State.isProcessing = false;
    }

    async function scheduler() {
        if (!State.isLeader || State.isProcessing || State.users.length === 0) return;
        const now = Date.now();
        const due = State.users.filter(u => !State.nextFetchTime[u] || now >= State.nextFetchTime[u]);
        if (due.length === 0) return;
        State.isProcessing = true;
        updateStatusDot('loading');
        const user = due[0];
        const r = await processUser(user, false);
        let d = getUserCycleDuration(user) + Math.random() * 10000;
        if (r === 'RATE_LIMIT') d = CONFIG.ERROR_BACKOFF_MS * 2;
        else if (r === 'ERROR') d = CONFIG.ERROR_BACKOFF_MS;
        State.nextFetchTime[user] = Date.now() + d;
        if (r === true) saveConfig();
        renderFeed(); broadcastState(); updateStatusDot();
        State.isProcessing = false;
    }

    async function refreshSingleUser(username) {
        if (!State.isLeader) { channel.postMessage({ type: 'cmd_refresh_user', username }); return; }
        if (State.isProcessing) return;
        State.isProcessing = true; updateStatusDot('loading');
        const r = await processUser(username, false);
        let d = getUserCycleDuration(username) + Math.random() * 10000;
        if (r === 'RATE_LIMIT') d = CONFIG.ERROR_BACKOFF_MS * 2;
        else if (r === 'ERROR') d = CONFIG.ERROR_BACKOFF_MS;
        State.nextFetchTime[username] = Date.now() + d;
        if (r === true) saveConfig();
        renderFeed(); broadcastState(); updateStatusDot();
        State.isProcessing = false;
    }

    function updateStatusDot(override) {
        const dot = shadowRoot?.getElementById('status-dot');
        if (dot) dot.className = `status-dot ${override || (State.isLeader ? 'leader' : 'follower')}`;
    }

    function broadcastNewAction(action) { channel.postMessage({ type: 'new_action', action }); }

    // ═══════════════════════════════════════
    //  跨 Tab Leader 选举
    // ═══════════════════════════════════════
    function takeLeadership() {
        if (State.isLeader) return;
        if (leaderCheckTimeout) { clearTimeout(leaderCheckTimeout); leaderCheckTimeout = null; }
        State.isLeader = true; updateStatusDot();
        channel.postMessage({ type: 'leader_takeover' });
        scheduler();
    }
    function handleWindowFocus() { if (!State.isLeader) pendingLeadershipTimer = setTimeout(() => { takeLeadership(); pendingLeadershipTimer = null; }, 120000); }
    function handleWindowBlur() { if (pendingLeadershipTimer) { clearTimeout(pendingLeadershipTimer); pendingLeadershipTimer = null; } }

    channel.onmessage = (event) => {
        const m = event.data;
        if (m.type === 'leader_check') { if (State.isLeader) channel.postMessage({ type: 'leader_here' }); }
        else if (m.type === 'leader_here') { if (leaderCheckTimeout) { clearTimeout(leaderCheckTimeout); leaderCheckTimeout = null; } State.isLeader = false; updateStatusDot(); channel.postMessage({ type: 'data_request' }); }
        else if (m.type === 'data_request') { if (State.isLeader) broadcastState(); }
        else if (m.type === 'leader_resign') { setTimeout(() => attemptLeadership(), Math.random() * 300); }
        else if (m.type === 'leader_takeover') { if (State.isLeader) { State.isLeader = false; if (leaderCheckTimeout) clearTimeout(leaderCheckTimeout); broadcastState(); updateStatusDot(); } }
        else if (m.type === 'data_update' && !State.isLeader) {
            if (m.users && JSON.stringify(m.users) !== JSON.stringify(State.users)) { State.users = m.users; renderUserRows(); }
            State.data = m.data; State.lastIds = m.lastIds;
            if (m.hiddenUsers) State.hiddenUsers = new Set(m.hiddenUsers);
            if (m.nextFetchTime) State.nextFetchTime = m.nextFetchTime;
            if (m.multipliers) State.multipliers = m.multipliers;
            if (m.userProfiles) State.userProfiles = m.userProfiles;
            renderFeed();
        }
        else if (m.type === 'new_action' && !State.isLeader) {
            if (State.enableDanmaku) sendNotification(m.action);
            if (!State.panelOpen) { State.unreadCount++; updateBadge(); }
        }
        else if (m.type === 'cmd_refresh_all') { if (State.isLeader) tickAll(); }
        else if (m.type === 'cmd_refresh_user') { if (State.isLeader) refreshSingleUser(m.username); }
        else if (m.type === 'cmd_config_sync') {
            if (m.key === 'enableDanmaku') State.enableDanmaku = m.value;
            if (m.key === 'enableSysNotify') State.enableSysNotify = m.value;
            saveConfig(); updateSettingButtons();
        }
        else if (m.type === 'cmd_add_user') {
            if (State.isLeader && !State.users.includes(m.username) && State.users.length < CONFIG.MAX_USERS) {
                fetchUser(m.username, true).then(r => {
                    if (r && !['SKIPPED','RATE_LIMIT','ERROR','NOT_FOUND'].includes(r)) { State.users.push(m.username); saveConfig(); renderUserRows(); tickAll(); }
                });
            }
        }
        else if (m.type === 'cmd_remove_user') { if (State.isLeader) removeUser(m.username); }
    };

    function attemptLeadership() {
        channel.postMessage({ type: 'leader_check' });
        leaderCheckTimeout = setTimeout(() => { State.isLeader = true; leaderCheckTimeout = null; tickAll(); }, 200);
    }
    window.addEventListener('beforeunload', () => { if (State.isLeader) channel.postMessage({ type: 'leader_resign' }); });

    // ═══════════════════════════════════════
    //  用户管理
    // ═══════════════════════════════════════
    function removeUser(name) {
        if (!State.isLeader) { channel.postMessage({ type: 'cmd_remove_user', username: name }); return; }
        State.users = State.users.filter(u => u !== name);
        delete State.lastIds[name]; delete State.multipliers[name]; delete State.data[name]; delete State.nextFetchTime[name]; delete State.userProfiles[name];
        saveConfig(); renderUserRows(); renderFeed(); broadcastState();
    }

    function toggleUserVisibility(name) {
        State.hiddenUsers.has(name) ? State.hiddenUsers.delete(name) : State.hiddenUsers.add(name);
        saveConfig(); renderUserRows(); renderFeed(); broadcastState();
    }

    // ═══════════════════════════════════════
    //  样式
    // ═══════════════════════════════════════
    const panelCSS = `
        :host { all: initial; font-family: system-ui, -apple-system, sans-serif; font-size: 13px; z-index: 2147483647; position: fixed; top: 0; left: 0; pointer-events: none; width: 0; height: 0; }

        /* 面板 */
        #ld-panel { position: fixed; width: ${CONFIG.PANEL_WIDTH}; max-height: ${CONFIG.PANEL_MAX_HEIGHT}; background: rgba(18,18,18,0.96); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,0.5); display: none; flex-direction: column; color: #eee; pointer-events: auto; overflow: hidden; }
        #ld-panel.open { display: flex; }

        /* 面板头 */
        .p-header { padding: 10px 12px 8px; border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; }
        .p-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
        .p-title { font-weight: 700; font-size: 13px; color: #fff; display: flex; align-items: center; gap: 6px; }
        .status-dot { width: 7px; height: 7px; border-radius: 50%; background: #666; transition: 0.3s; flex-shrink: 0; }
        .status-dot.leader { background: #00ff88; box-shadow: 0 0 6px #00ff88; }
        .status-dot.follower { background: #00d4ff; box-shadow: 0 0 6px #00d4ff; }
        .status-dot.loading { background: #ffd700; animation: pulse 1s infinite; }

        .p-tools { display: flex; gap: 2px; }
        .t-btn { background: transparent; border: none; color: #666; cursor: pointer; font-size: 13px; padding: 3px 5px; border-radius: 4px; transition: 0.15s; line-height: 1; }
        .t-btn:hover { color: #fff; background: rgba(255,255,255,0.1); }
        .t-btn.active { color: #ffd700; }

        /* 输入 */
        .p-input-row { display: flex; gap: 5px; }
        .p-input { flex: 1; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 4px 10px; border-radius: 6px; outline: none; font-size: 12px; }
        .p-input:focus { border-color: #ffd700; }
        .p-input::placeholder { color: #555; }
        .p-btn-add { background: #ffd700; color: #000; border: none; border-radius: 6px; width: 28px; cursor: pointer; font-weight: bold; font-size: 14px; }
        .p-btn-add:hover { background: #ffe44d; }
        .p-btn-add:disabled { opacity: 0.4; cursor: not-allowed; }

        /* 用户行 */
        .p-users { border-top: 1px solid rgba(255,255,255,0.06); margin-top: 8px; }
        .u-row { display: flex; align-items: center; gap: 4px; padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,0.04); cursor: pointer; border-left: 3px solid transparent; padding-left: 4px; transition: 0.15s; }
        .u-row:last-child { border-bottom: none; }
        .u-row:hover { background: rgba(255,255,255,0.06); }
        .u-row.on { border-left-color: #ffd700; background: rgba(255,215,0,0.06); }
        .u-del { font-size: 11px; color: #555; cursor: pointer; line-height: 1; flex-shrink: 0; }
        .u-del:hover { color: #ff5555; }
        .u-name { font-size: 11px; color: #999; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .u-row.on .u-name { font-weight: 600; }
        .u-activity { font-size: 9px; color: #666; display: flex; gap: 3px; flex-shrink: 0; font-family: monospace; }
        .u-activity span { width: 34px; text-align: right; }
        .u-timer { flex-shrink: 0; cursor: pointer; }

        /* 动态列表 */
        .p-feed { flex: 1; overflow-y: auto; padding: 6px 10px; scrollbar-width: thin; scrollbar-color: #444 transparent; min-height: 60px; max-height: calc(${CONFIG.PANEL_MAX_HEIGHT} - 180px); }
        .p-feed::-webkit-scrollbar { width: 3px; }
        .p-feed::-webkit-scrollbar-thumb { background: #444; border-radius: 2px; }

        .card { display: flex; flex-direction: column; gap: 2px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; padding: 8px; margin-bottom: 5px; text-decoration: none; color: inherit; transition: 0.15s; }
        .card:hover { background: rgba(255,255,255,0.06); border-color: #ffd700; transform: translateX(2px); }
        .card-head { display: flex; align-items: flex-start; gap: 7px; font-size: 11px; }
        .avatar { width: 32px; height: 32px; border-radius: 50%; background: #333; object-fit: cover; flex-shrink: 0; }
        .avatar-sm { width: 16px; height: 16px; border-radius: 50%; background: #333; object-fit: cover; }
        .card-info { display: flex; flex-direction: column; gap: 1px; overflow: hidden; flex: 1; }
        .card-user { display: flex; align-items: center; gap: 2px; color: #ccc; font-weight: 600; font-size: 11px; white-space: nowrap; line-height: 1; }
        .card-user .svg-icon, .dm-user .svg-icon { width: 11px; height: 11px; fill: #888; margin: 0 3px; }
        .card-user .act-emoji, .dm-user .act-emoji { width: 13px; height: 13px; margin: 0 3px; }
        .card-title { font-size: 11.5px; font-weight: 600; color: #eee; line-height: 1.35; }
        .card-excerpt { font-size: 10px; color: #888; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-top: 1px; }
        .card-excerpt-q { font-size: 10px; color: #888; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; border-left: 2px solid #333; padding-left: 5px; margin-top: 1px; }
        .card-img { width: 100%; height: 80px; object-fit: cover; border-radius: 4px; margin-top: 3px; border: 1px solid #333; }
        .card-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 3px; }
        .badge { font-size: 9px; padding: 1px 5px; border-radius: 3px; }
        .time { font-size: 9px; color: #555; }

        .p-empty { text-align: center; color: #555; padding: 30px 0; font-size: 12px; }

        /* Toast */
        .toast-layer { position: absolute; top: 8px; left: 8px; right: 8px; display: flex; flex-direction: column; gap: 4px; pointer-events: none; z-index: 10; }
        .toast { padding: 6px 12px; border-radius: 6px; font-size: 11px; pointer-events: auto; animation: toast-in 0.2s ease-out; }
        .toast-error { background: rgba(255,80,80,0.9); color: #fff; }
        .toast-warning { background: rgba(255,180,50,0.9); color: #000; }
        .toast-info { background: rgba(0,180,255,0.85); color: #fff; }

        /* 弹幕 */
        .dm-container { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; pointer-events: none; overflow: hidden; z-index: 10; }
        .dm-item { position: absolute; left: 100vw; display: flex; flex-direction: column; gap: 4px; background: rgba(30,30,30,0.9); border: 1px solid #444; padding: 10px 15px; border-radius: 30px; color: #fff; box-shadow: 0 4px 15px rgba(0,0,0,0.5); max-width: 500px; min-width: 260px; pointer-events: auto; cursor: pointer; will-change: transform; animation: dm-fly 12s linear forwards; backdrop-filter: blur(5px); overflow: hidden; }
        .dm-item:hover { z-index: 20; background: #222; border-color: #ffd700; animation-play-state: paused; }
        .dm-top { display: flex; align-items: flex-start; gap: 8px; }
        .dm-avatar { width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0; background: #333; }
        .dm-info { display: flex; flex-direction: column; overflow: hidden; flex: 1; }
        .dm-user { font-size: 12px; color: #ccc; font-weight: 600; display: flex; align-items: center; gap: 2px; white-space: nowrap; }
        .dm-title { font-size: 13px; font-weight: 600; color: #eee; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .dm-excerpt { font-size: 11px; color: #888; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .dm-excerpt-cited { font-size: 11px; color: #888; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; border-left: 2px solid #333; padding-left: 6px; }
        .dm-icon-pop { position: absolute; pointer-events: none; animation: dm-pop 3s ease-out forwards; }
        .dm-icon-pop .svg-icon { width: 80px; height: 80px; fill: #fa6c8d; filter: drop-shadow(0 4px 15px rgba(250,108,141,0.5)); }
        .dm-icon-pop .act-emoji { width: 80px; height: 80px; }

        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes dm-fly { from{transform:translateX(0)} to{transform:translateX(-140vw)} }
        @keyframes dm-pop { 0%{opacity:1;transform:scale(1.2)} 100%{opacity:0;transform:scale(0.8) translateY(-30px)} }
        @keyframes toast-in { from{opacity:0;transform:translateY(-8px)} to{opacity:1;transform:translateY(0)} }
    `;

    // 注入到 Discourse header 的样式（非 Shadow DOM）
    const headerCSS = `
        .ld-seeking-toggle { position: relative; }
        .ld-seeking-toggle .ld-icon-btn { background: transparent; border: none; cursor: pointer; font-size: 18px; padding: 6px 8px; border-radius: 4px; transition: 0.15s; position: relative; line-height: 1; }
        .ld-seeking-toggle .ld-icon-btn:hover { background: rgba(128,128,128,0.15); }
        .ld-badge { position: absolute; top: 2px; right: 2px; background: #e45735; color: #fff; font-size: 10px; font-weight: 700; min-width: 16px; height: 16px; border-radius: 8px; display: flex; align-items: center; justify-content: center; padding: 0 4px; font-family: system-ui; line-height: 1; pointer-events: none; }
    `;

    // ═══════════════════════════════════════
    //  UI 构建
    // ═══════════════════════════════════════
    let shadowRoot;

    function showToast(msg, type = 'error') {
        if (!shadowRoot) return;
        const layer = shadowRoot.getElementById('toast-layer');
        if (!layer) return;
        const t = document.createElement('div');
        t.className = `toast toast-${type}`;
        t.textContent = msg;
        layer.appendChild(t);
        setTimeout(() => t.remove(), CONFIG.TOAST_DURATION_MS);
    }

    function updateBadge() {
        const el = document.getElementById('ld-badge');
        if (!el) return;
        if (State.unreadCount > 0) {
            el.textContent = State.unreadCount > 99 ? '99+' : State.unreadCount;
            el.style.display = 'flex';
        } else {
            el.style.display = 'none';
        }
    }

    function updateSettingButtons() {
        if (!shadowRoot) return;
        const bd = shadowRoot.getElementById('btn-dm');
        const bs = shadowRoot.getElementById('btn-sys');
        if (bd) bd.className = `t-btn ${State.enableDanmaku ? 'active' : ''}`;
        if (bs) bs.className = `t-btn ${State.enableSysNotify ? 'active' : ''}`;
    }

    function positionPanel() {
        const icon = document.querySelector('.ld-seeking-toggle');
        const panel = shadowRoot?.getElementById('ld-panel');
        if (!icon || !panel) return;
        const r = icon.getBoundingClientRect();
        panel.style.top = `${r.bottom + 6}px`;
        // 尽量右对齐到图标，但不超出屏幕左边
        const rightPos = window.innerWidth - r.right;
        const panelW = parseInt(CONFIG.PANEL_WIDTH);
        if (r.right - panelW < 0) {
            panel.style.left = '8px';
            panel.style.right = 'auto';
        } else {
            panel.style.right = `${rightPos}px`;
            panel.style.left = 'auto';
        }
    }

    function togglePanel() {
        State.panelOpen = !State.panelOpen;
        const panel = shadowRoot?.getElementById('ld-panel');
        if (!panel) return;
        if (State.panelOpen) {
            positionPanel();
            panel.classList.add('open');
            State.unreadCount = 0;
            updateBadge();
            renderFeed();
        } else {
            panel.classList.remove('open');
        }
    }

    function closePanel() {
        if (!State.panelOpen) return;
        State.panelOpen = false;
        shadowRoot?.getElementById('ld-panel')?.classList.remove('open');
    }

    function injectHeaderIcon() {
        if (document.querySelector('.ld-seeking-toggle')) return true;
        const icons = document.querySelector('.d-header-icons');
        if (!icons) return false;

        // 注入样式
        if (!document.getElementById('ld-seeking-header-css')) {
            const s = document.createElement('style');
            s.id = 'ld-seeking-header-css';
            s.textContent = headerCSS;
            document.head.appendChild(s);
        }

        const li = document.createElement('li');
        li.className = 'header-dropdown-toggle ld-seeking-toggle';
        li.innerHTML = `<button class="ld-icon-btn" title="追觅 · Seeking">👀<span id="ld-badge" class="ld-badge" style="display:none">0</span></button>`;
        icons.prepend(li);
        li.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); togglePanel(); });
        return true;
    }

    function createPanel() {
        const host = document.createElement('div');
        host.id = 'ld-seeking-host';
        document.body.appendChild(host);
        shadowRoot = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = panelCSS;
        shadowRoot.appendChild(style);

        const wrap = document.createElement('div');
        wrap.innerHTML = `
            <div id="dm-container" class="dm-container"></div>
            <div id="ld-panel">
                <div id="toast-layer" class="toast-layer"></div>
                <div class="p-header">
                    <div class="p-title-row">
                        <div class="p-title"><div id="status-dot" class="status-dot"></div>追觅 · Seeking</div>
                        <div class="p-tools">
                            <button id="btn-dm" class="t-btn ${State.enableDanmaku?'active':''}" title="弹幕">💬</button>
                            <button id="btn-sys" class="t-btn ${State.enableSysNotify?'active':''}" title="通知">🔔</button>
                            <button id="btn-refresh" class="t-btn" title="刷新全部">🔄</button>
                        </div>
                    </div>
                    <div class="p-input-row">
                        <input id="inp-user" class="p-input" placeholder="添加用户名..." maxlength="30">
                        <button id="btn-add" class="p-btn-add">＋</button>
                    </div>
                    <div id="user-rows" class="p-users"></div>
                </div>
                <div id="feed" class="p-feed"><div class="p-empty">暂无数据</div></div>
            </div>`;
        shadowRoot.appendChild(wrap);

        // 事件
        shadowRoot.getElementById('btn-dm').onclick = function () {
            State.enableDanmaku = !State.enableDanmaku; this.className = `t-btn ${State.enableDanmaku?'active':''}`;
            saveConfig(); channel.postMessage({ type: 'cmd_config_sync', key: 'enableDanmaku', value: State.enableDanmaku });
        };
        shadowRoot.getElementById('btn-sys').onclick = function () {
            State.enableSysNotify = !State.enableSysNotify; this.className = `t-btn ${State.enableSysNotify?'active':''}`;
            if (State.enableSysNotify && Notification.permission !== 'granted') Notification.requestPermission();
            saveConfig(); channel.postMessage({ type: 'cmd_config_sync', key: 'enableSysNotify', value: State.enableSysNotify });
        };
        shadowRoot.getElementById('btn-refresh').onclick = () => tickAll();

        const handleAdd = async () => {
            const inp = shadowRoot.getElementById('inp-user');
            const name = inp.value.trim();
            if (!name) return;
            if (State.users.includes(name)) { showToast('用户已在列表中', 'warning'); return; }
            if (State.users.length >= CONFIG.MAX_USERS) { showToast(`最多监控 ${CONFIG.MAX_USERS} 个用户`, 'error'); return; }

            const btn = shadowRoot.getElementById('btn-add');
            btn.disabled = true; btn.textContent = '…';

            if (!State.isLeader) {
                channel.postMessage({ type: 'cmd_add_user', username: name });
                btn.disabled = false; btn.textContent = '＋'; inp.value = '';
                return;
            }

            const test = await fetchUser(name, true);
            if (test === 'NOT_FOUND') { showToast(`用户 "${name}" 不存在`, 'error'); }
            else if (test === 'RATE_LIMIT') { showToast('请求超限，请稍后重试', 'warning'); }
            else if (test === 'ERROR') { showToast('网络错误', 'error'); }
            else if (test && test.length >= 0) {
                State.users.push(name);
                State.data[name] = test;
                saveConfig(); renderUserRows(); renderFeed(); broadcastState();
                // 启动持续追踪
                State.nextFetchTime[name] = Date.now() + getUserCycleDuration(name);
                inp.value = '';
            }
            btn.disabled = false; btn.textContent = '＋';
        };
        shadowRoot.getElementById('btn-add').onclick = handleAdd;
        shadowRoot.getElementById('inp-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } });

        // 点击外部关闭
        document.addEventListener('click', (e) => {
            if (!State.panelOpen) return;
            const toggle = document.querySelector('.ld-seeking-toggle');
            const host2 = document.getElementById('ld-seeking-host');
            if (toggle?.contains(e.target)) return;
            if (host2?.contains(e.target)) return;
            closePanel();
        });
        // 面板内点击不冒泡关闭
        shadowRoot.getElementById('ld-panel').addEventListener('click', (e) => e.stopPropagation());

        // 窗口 resize 时重新定位
        window.addEventListener('resize', () => { if (State.panelOpen) positionPanel(); });

        renderUserRows();
        startVisualLoops();
    }

    // ═══════════════════════════════════════
    //  渲染：用户行
    // ═══════════════════════════════════════
    function renderUserRows() {
        if (!shadowRoot) return;
        const container = shadowRoot.getElementById('user-rows');
        if (!container) return;
        container.innerHTML = '';
        if (State.users.length === 0) return;

        State.users.forEach(u => {
            const hidden = State.hiddenUsers.has(u);
            const color = getUserColor(u);
            const row = document.createElement('div');
            row.className = `u-row ${hidden ? '' : 'on'}`;
            row.id = `row-${u}`;

            // 删除
            const del = document.createElement('span');
            del.className = 'u-del'; del.textContent = '×'; del.title = '移除';
            del.onclick = (e) => { e.stopPropagation(); removeUser(u); };

            // 计时器
            const ts = 10, tw = 2, tr = (ts - tw) / 2, tc = 2 * Math.PI * tr;
            const timer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            timer.setAttribute('width', ts); timer.setAttribute('height', ts);
            timer.className.baseVal = 'u-timer'; timer.id = `timer-${u}`;
            timer.setAttribute('data-c', tc);
            timer.innerHTML = `<title>刷新</title><circle cx="${ts/2}" cy="${ts/2}" r="${tr}" fill="none" stroke="#333" stroke-width="${tw}"/><circle class="tp" cx="${ts/2}" cy="${ts/2}" r="${tr}" fill="none" stroke="${hidden?'#666':color}" stroke-width="${tw}" stroke-dasharray="${tc}" stroke-dashoffset="${tc}" transform="rotate(-90 ${ts/2} ${ts/2})"/>`;
            timer.onclick = (e) => { e.stopPropagation(); refreshSingleUser(u); };

            // 名字
            const name = document.createElement('span');
            name.className = 'u-name'; name.textContent = u;
            if (!hidden) name.style.color = color;

            // 活跃度
            const act = document.createElement('div');
            act.className = 'u-activity'; act.id = `act-${u}`;
            act.innerHTML = `<span title="发帖">--</span><span title="动态">--</span><span title="在线">--</span>`;

            row.append(del, timer, name, act);
            row.onclick = () => toggleUserVisibility(u);
            container.appendChild(row);
        });
    }

    // ═══════════════════════════════════════
    //  渲染：动态列表
    // ═══════════════════════════════════════
    function renderFeed() {
        if (!shadowRoot) return;
        const div = shadowRoot.getElementById('feed');
        if (!div) return;
        let all = [];
        Object.entries(State.data).forEach(([u, arr]) => { if (!State.hiddenUsers.has(u)) all.push(...arr); });
        all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        if (all.length === 0) { div.innerHTML = '<div class="p-empty">暂无数据</div>'; return; }

        div.innerHTML = all.map(item => {
            let avatar = CONFIG.HOST + "/uploads/default/original/3X/9/d/9dd4973138ccd78e8907865261d7b14d45a96d1c.png";
            if (item.avatar_template) avatar = CONFIG.HOST + item.avatar_template.replace("{size}", "48");
            const d = new Date(item.created_at), now = new Date();
            const ts = d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : d.toLocaleString('en-US', { month: 'short', day: '2-digit' });
            const cat = categoryMap.get(item.category_id) || (item.category_id >= 110 ? "虫洞广场" : "未分区");
            const cc = categoryColors[cat] || '#9e9e9e';
            const excerpt = cleanHtml(item.excerpt);
            const img = extractImg(item.excerpt);
            const link = `${CONFIG.HOST}/t/${item.topic_id}/${item.post_number}`;
            const ai = formatActionInfo(item);
            const ec = (item.action_type === 4 || item.action_type === 5) ? 'card-excerpt' : 'card-excerpt-q';
            return `<a href="${link}" target="_blank" class="card"><div class="card-head"><img src="${avatar}" class="avatar"><div class="card-info"><div class="card-user">${ai.html}</div><div class="card-title">${item.title}</div></div></div>${excerpt?`<div class="${ec}">${excerpt}</div>`:''}${img?`<img src="${img}" class="card-img" loading="lazy">`:''}< div class="card-foot"><span class="badge" style="color:${cc};background:${cc}15">${cat}</span><span class="time">${ts}</span></div></a>`;
        }).join('');
    }

    // ═══════════════════════════════════════
    //  视觉循环
    // ═══════════════════════════════════════
    function startVisualLoops() {
        // 计时器圆环动画
        const updateTimers = () => {
            if (!shadowRoot) return;
            const now = Date.now();
            State.users.forEach(u => {
                const el = shadowRoot.getElementById(`timer-${u}`);
                if (!el) return;
                const p = el.querySelector('.tp');
                if (!p) return;
                const c = parseFloat(el.getAttribute('data-c'));
                const next = State.nextFetchTime[u];
                const total = getUserCycleDuration(u);
                if (next) {
                    const rem = Math.max(0, next - now);
                    p.style.strokeDashoffset = c * (1 - Math.min(1, rem / total));
                } else p.style.strokeDashoffset = 0;
            });
            requestAnimationFrame(updateTimers);
        };
        requestAnimationFrame(updateTimers);

        // 活跃度文本更新
        setInterval(() => {
            if (!shadowRoot) return;
            State.users.forEach(u => {
                const el = shadowRoot.getElementById(`act-${u}`);
                if (!el) return;
                const hidden = State.hiddenUsers.has(u), color = getUserColor(u);
                const profile = State.userProfiles[u], data = State.data[u];
                if (!profile) return;
                const spans = el.querySelectorAll('span');
                if (spans.length < 3) return;

                const p = profile.last_posted_at, a = data?.[0]?.created_at, s = profile.last_seen_at;
                spans[0].textContent = p ? formatTimeAgo(p) : '--';
                spans[0].style.color = hidden ? '#666' : getTimeAgoColor(p, color);
                spans[1].textContent = a ? formatTimeAgo(a) : '--';
                spans[1].style.color = hidden ? '#666' : getTimeAgoColor(a, color);
                spans[2].textContent = s ? formatTimeAgo(s) : '--';
                spans[2].style.color = hidden ? '#666' : getTimeAgoColor(s, color);
            });
        }, 1000);
    }

    // ═══════════════════════════════════════
    //  初始化
    // ═══════════════════════════════════════
    function init() {
        createPanel();

        // 注入 header 图标（Discourse 动态渲染，需要轮询/监听）
        if (!injectHeaderIcon()) {
            const obs = new MutationObserver(() => {
                if (injectHeaderIcon()) obs.disconnect();
            });
            obs.observe(document.body, { childList: true, subtree: true });
        }

        // 防止 Discourse 重新渲染时图标丢失
        setInterval(() => injectHeaderIcon(), 3000);

        window.addEventListener('focus', handleWindowFocus);
        window.addEventListener('blur', handleWindowBlur);
        attemptLeadership();
        setInterval(() => scheduler(), 1000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
