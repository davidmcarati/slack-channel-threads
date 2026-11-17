/*!
 * Slack Channel Threads
 * https://github.com/davidmcarati/slack-channel-threads
 *
 * Shows your active threads under each channel in the Slack sidebar, with unread / mention
 * badges, a chevron to collapse them per channel and "show N more" after 5. Clicking a thread
 * opens it in Slack's side panel.
 *
 * Normally loaded by slack-threads-watcher.mjs (see README). It can also be pasted into any
 * DevTools console attached to the Slack client page; pasting again replaces the running copy.
 *
 * Console API:
 *   SCT.diag()            what the script found (sidebar rows, API answer shape, errors)
 *   SCT.setDays(n)        active window in days (default 3, 0 = off)
 *   SCT.setMaxVisible(n)  threads shown before "show more" (default 5)
 *   SCT.setOpenMode(m)    "desktop" (default, opens in the side panel) or "reload" (full page load)
 *   SCT.refresh()         re-fetch threads now
 *   SCT.stop()            remove everything this script added
 */
(() => {
  "use strict";

  const VERSION = "0.2.0";
  if (window.SCT && typeof window.SCT.stop === "function") {
    try { window.SCT.stop(); } catch (_) { /* old copy already broken */ }
  }

  // ---------------------------------------------------------------- config & state

  const ROW_ATTR = "data-qa-channel-sidebar-channel-id";
  const ROW_SEL = `[${ROW_ATTR}]`;
  const NAME_SEL = ".p-channel_sidebar__name";

  const ls = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (_) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* storage blocked */ }
    },
  };

  const cfg = {
    days: ls.get("sct.days", 3),
    maxVisible: ls.get("sct.maxVisible", 5),
    openMode: ls.get("sct.openMode", "desktop"),
    pollMs: 30000,
    pageLimit: 50,
    maxPages: 4,
  };

  const S = {
    auth: null,
    apiBase: null,
    items: [],                // every fetched thread, normalized
    byChannel: new Map(),     // channelId -> threads inside the active window, newest first
    collapsed: new Set(ls.get("sct.collapsed", [])),
    expanded: new Set(),      // channels where "show more" is open
    users: new Map(),         // userId -> display name
    readLocally: new Map(),   // thread key -> lastTs we opened it at
    blocks: new Map(),        // channelId -> thread list element
    toggles: new Map(),       // channelId -> chevron button
    shifted: new Map(),       // sidebar element -> its marginTop before we shifted it
    grown: new Map(),         // list container -> its minHeight before we grew it
    observer: null,
    observedRoot: null,
    sheet: null,
    raf: 0,
    timer: 0,
    stopped: false,
    lastError: null,
    lastFetchAt: null,
    lastRaw: null,
    mode: null,
  };

  // ---------------------------------------------------------------- Slack API (own session)

  function readAuth() {
    let conf = null;
    try { conf = JSON.parse(localStorage.getItem("localConfig_v2") || "null"); } catch (_) { /* ignore */ }
    if (!conf || !conf.teams) {
      throw new Error("localConfig_v2 not found: run this in the Slack client's own console");
    }
    const teams = conf.teams;
    const list = Object.values(teams);
    const match = location.pathname.match(/\/client\/([A-Z0-9]+)/);
    const routeId = match ? match[1] : null;
    const team =
      (routeId && teams[routeId]) ||
      (routeId && list.find((t) => t.enterprise_id === routeId)) ||
      teams[conf.lastActiveTeamId] ||
      list[0];
    if (!team || !team.token) throw new Error("No team token in localConfig_v2");
    const teamId = team.id || conf.lastActiveTeamId;
    return { token: team.token, userId: team.user_id, url: team.url, teamId, routeId: routeId || teamId };
  }

  async function api(method, params = {}) {
    const auth = S.auth || (S.auth = readAuth());
    const bases = [];
    if (S.apiBase) bases.push(S.apiBase);
    if (auth.url) bases.push(auth.url.replace(/\/?$/, "/") + "api/");
    bases.push(location.origin + "/api/");

    const errors = [];
    for (const base of [...new Set(bases)]) {
      const body = new FormData();
      body.append("token", auth.token);
      for (const [k, v] of Object.entries(params)) {
        if (v != null) body.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      }
      try {
        const res = await fetch(base + method, { method: "POST", body, credentials: "include" });
        const json = await res.json();
        if (json && json.ok) { S.apiBase = base; return json; }
        errors.push(`${base}: ${(json && json.error) || res.status}`);
        // A base that worked before answered with a real API error: other bases won't help.
        if (base === S.apiBase) break;
      } catch (e) {
        errors.push(`${base}: ${e.message}`);
      }
    }
    throw new Error(`${method} failed → ${errors.join(" | ")}`);
  }

  // ---------------------------------------------------------------- data

  const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g;

  function mentionsMe(text, userId) {
    const s = String(text || "");
    return (userId && s.includes(`<@${userId}`)) || /<!(here|channel|everyone)/.test(s);
  }

  function normalize(raw) {
    const root = raw.root_msg || raw.root || raw.message;
    if (!root) return null;
    const channel = root.channel || raw.channel || raw.channel_id;
    const ts = root.thread_ts || root.ts;
    if (!channel || !ts) return null;

    const latest = Array.isArray(raw.latest_replies) && raw.latest_replies.length
      ? raw.latest_replies[raw.latest_replies.length - 1].ts
      : null;
    const lastTsStr = root.latest_reply || latest || ts;
    const unread = Array.isArray(raw.unread_replies) ? raw.unread_replies : [];

    let hasUnread = unread.length > 0;
    if (!hasUnread && root.last_read && parseFloat(lastTsStr) > parseFloat(root.last_read)) hasUnread = true;
    // Opened here but the server hasn't caught up yet: keep it read until a newer reply arrives.
    const readUpTo = S.readLocally.get(`${channel}-${ts}`);
    const locallyRead = readUpTo != null && parseFloat(lastTsStr) <= readUpTo;
    if (locallyRead) hasUnread = false;

    const file = Array.isArray(root.files) && root.files[0];
    const attachment = Array.isArray(root.attachments) && root.attachments[0];
    return {
      key: `${channel}-${ts}`,
      channel,
      ts,
      lastTs: parseFloat(lastTsStr),
      lastTsStr,
      rootText: root.text || (attachment && (attachment.fallback || attachment.text)) || "",
      fileName: file ? file.title || file.name || "file" : "",
      unreadCount: locallyRead ? 0 : unread.length,
      hasUnread,
      mention: !locallyRead && unread.some((r) => mentionsMe(r.text, S.auth && S.auth.userId)),
    };
  }

  function plain(text) {
    return String(text || "")
      .replace(MENTION_RE, (_, id, name) => "@" + (name || S.users.get(id) || "…"))
      .replace(/<#[CG][A-Z0-9]+(?:\|([^>]*))?>/g, (_, name) => "#" + (name || "channel"))
      .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, name) => name || "@group")
      .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
      .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
      .replace(/<([^>]+)>/g, "$1")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
      .replace(/[*~`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function label(t) {
    return plain(t.rootText) || (t.fileName && "📎 " + t.fileName) || "Thread";
  }

  async function resolveUsers() {
    const missing = new Set();
    for (const t of S.items) {
      for (const m of String(t.rootText).matchAll(MENTION_RE)) {
        if (!m[2] && !S.users.has(m[1])) missing.add(m[1]);
      }
    }
    let resolved = 0;
    for (const id of [...missing].slice(0, 25)) {
      try {
        const res = await api("users.info", { user: id });
        const p = (res.user && res.user.profile) || {};
        S.users.set(id, p.display_name || p.real_name || (res.user && res.user.name) || id);
        resolved++;
      } catch (_) {
        S.users.set(id, "user");
      }
    }
    return resolved;
  }

  function regroup() {
    const map = new Map();
    if (cfg.days > 0) {
      const cutoff = Date.now() / 1000 - cfg.days * 86400;
      for (const t of S.items) {
        if (!(t.lastTs >= cutoff)) continue;
        if (!map.has(t.channel)) map.set(t.channel, []);
        map.get(t.channel).push(t);
      }
      for (const list of map.values()) list.sort((a, b) => b.lastTs - a.lastTs);
    }
    S.byChannel = map;
  }

  let refreshing = null;
  function refresh() {
    if (S.stopped) return Promise.resolve();
    if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function doRefresh() {
    try {
      S.auth = S.auth || readAuth();
      const cutoff = Date.now() / 1000 - cfg.days * 86400;
      const seen = new Map();
      let maxTs;
      for (let page = 0; page < cfg.maxPages; page++) {
        const res = await api("subscriptions.thread.getView", {
          limit: cfg.pageLimit,
          current_ts: (Date.now() / 1000).toFixed(6),
          max_ts: maxTs,
        });
        if (page === 0) S.lastRaw = res;
        let added = 0;
        let oldest = null;
        for (const raw of res.threads || []) {
          const t = normalize(raw);
          if (!t) continue;
          if (!seen.has(t.key)) { seen.set(t.key, t); added++; }
          if (!oldest || t.lastTs < oldest.lastTs) oldest = t;
        }
        if (!res.has_more || !added || !oldest || oldest.lastTs < cutoff) break;
        maxTs = oldest.lastTsStr;
      }
      S.items = [...seen.values()];
      regroup();
      S.lastError = null;
      S.lastFetchAt = new Date();
      resolveUsers().then((n) => { if (n) schedule(); });
    } catch (e) {
      S.lastError = e.message;
      console.warn("[SCT]", e.message);
    }
    schedule();
  }

  // ---------------------------------------------------------------- opening a thread

  // Slack's router ignores URL changes made from outside it. The desktop app opens a message or
  // thread from a notification click through window.desktopDelegates[teamId]
  // .notificationActivationHandler — the same entry point opens the thread in the side panel.
  function openViaDesktop(auth, t) {
    const delegates = window.desktopDelegates;
    if (!delegates) return false;
    const d = delegates[auth.teamId] || delegates[auth.routeId] || Object.values(delegates)[0];
    if (!d || typeof d.notificationActivationHandler !== "function") return false;
    d.notificationActivationHandler({
      teamId: auth.teamId,
      channelId: t.channel,
      messageTs: t.ts,
      threadTs: t.ts,
      id: `sct-${Date.now()}`,
    });
    return true;
  }

  function openThread(t) {
    const auth = S.auth || readAuth();
    let opened = false;
    if (cfg.openMode !== "reload") {
      try {
        opened = openViaDesktop(auth, t);
      } catch (e) {
        console.warn("[SCT] desktop thread open failed, reloading instead", e);
      }
    }
    if (!opened) {
      // Browser Slack, or the desktop hook is gone: a full load of the thread URL opens it.
      location.assign(`/client/${auth.routeId}/${t.channel}/thread/${t.channel}-${t.ts}`);
      return;
    }

    // Clear the badge right away, then let the server confirm.
    const wasUnread = t.hasUnread;
    S.readLocally.set(t.key, t.lastTs);
    t.hasUnread = false;
    t.unreadCount = 0;
    t.mention = false;
    schedule();
    if (wasUnread) {
      api("subscriptions.thread.mark", { channel: t.channel, thread_ts: t.ts, ts: t.lastTsStr })
        .catch((e) => console.debug("[SCT] mark read failed:", e.message));
    }
    setTimeout(refresh, 4000);
  }

  // ---------------------------------------------------------------- rendering

  const CSS = `
.sct-block{position:absolute;left:0;right:0;box-sizing:border-box;padding:0 8px 4px 28px;z-index:1;
  font-size:13px;line-height:22px;color:inherit;pointer-events:auto}
.sct-block.sct-flow{position:relative;left:auto;right:auto;top:auto!important;width:100%}
.sct-thread{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;height:24px;
  padding:0 8px;border-radius:6px;cursor:pointer;color:inherit;opacity:.7;font-size:13px}
.sct-thread:hover,.sct-thread:focus-visible{background:color-mix(in srgb,currentColor 10%,transparent);opacity:1}
.sct-thread.sct-unread{opacity:1;font-weight:700}
.sct-icon{flex:0 0 auto;width:14px;height:14px;opacity:.6;fill:currentColor}
.sct-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sct-badge{flex:0 0 auto;min-width:18px;height:16px;padding:0 5px;box-sizing:border-box;border-radius:9px;
  background:color-mix(in srgb,currentColor 22%,transparent);font-size:11px;font-weight:700;line-height:16px;text-align:center}
.sct-badge.sct-mention{background:#cd2553;color:#fff}
.sct-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:currentColor}
.sct-more{all:unset;box-sizing:border-box;display:block;cursor:pointer;padding:0 8px;height:22px;font-size:12px;opacity:.6}
.sct-more:hover,.sct-more:focus-visible{opacity:1;text-decoration:underline}
.sct-toggle{all:unset;position:relative;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;
  width:16px;height:16px;margin-left:4px;border-radius:4px;cursor:pointer;opacity:.55;vertical-align:middle}
.sct-toggle:hover,.sct-toggle:focus-visible{opacity:1;background:color-mix(in srgb,currentColor 14%,transparent)}
.sct-toggle svg{width:14px;height:14px;fill:currentColor}
.sct-toggle.sct-has-unread::after{content:"";position:absolute;top:0;right:-1px;width:6px;height:6px;border-radius:50%;background:#cd2553}
`;

  function ensureStyle() {
    if (S.sheet) {
      if (S.sheet instanceof CSSStyleSheet && !document.adoptedStyleSheets.includes(S.sheet)) {
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, S.sheet];
      }
      return;
    }
    try {
      // Constructable sheets aren't subject to style-src CSP, unlike an injected <style>.
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      S.sheet = sheet;
    } catch (_) {
      const el = document.createElement("style");
      el.id = "sct-style";
      el.textContent = CSS;
      document.head.append(el);
      S.sheet = el;
    }
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    up: "M7.4 15.4 12 10.8l4.6 4.6L18 14l-6-6-6 6z",
    down: "M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z",
    thread: "M5 3h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-6l-5 4v-4H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm2 5v2h10V8H7zm0 4v2h7v-2H7z",
  };
  function icon(name, cls) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    if (cls) svg.setAttribute("class", cls);
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", ICONS[name]);
    svg.append(path);
    return svg;
  }
  function span(cls, text) {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el;
  }
  function swallow(el, types) {
    for (const type of types) el.addEventListener(type, (e) => e.stopPropagation());
  }

  function schedule() {
    if (!S.raf && !S.stopped) S.raf = requestAnimationFrame(relayout);
  }

  function sidebarRows() {
    const seen = new Set();
    const rows = [];
    for (const el of document.querySelectorAll(ROW_SEL)) {
      if (el.closest(".sct-block")) continue;
      const ch = el.getAttribute(ROW_ATTR);
      if (!ch || seen.has(ch)) continue; // first match is the outermost element for that row
      seen.add(ch);
      rows.push({ row: el, ch });
    }
    return rows;
  }

  // The element the sidebar list positions. Slack's list is virtualized: rows are absolutely
  // positioned, so we can't just insert content after them — later rows must be pushed down.
  function findItem(row) {
    let el = row;
    for (let depth = 0; el && el !== document.body && depth < 8; depth++, el = el.parentElement) {
      if (el.parentElement && getComputedStyle(el).position === "absolute" &&
          el.offsetHeight > 0 && el.offsetHeight < 120) {
        return { el, abs: true };
      }
    }
    const flowItem = row.closest('[role="listitem"],[role="treeitem"],li,.p-channel_sidebar__static_list__item') || row;
    return { el: flowItem, abs: false };
  }

  function basePos(el) {
    let y = el.offsetTop;
    const tf = getComputedStyle(el).transform;
    if (tf && tf !== "none") {
      try { y += new DOMMatrixReadOnly(tf).m42; } catch (_) { /* unparsable transform */ }
    }
    return y;
  }

  function indentFor(row, item) {
    const name = row.querySelector(NAME_SEL);
    if (name) {
      const x = name.getBoundingClientRect().left - item.getBoundingClientRect().left;
      if (x > 8 && x < 160) return Math.round(x) - 8;
    }
    return 28;
  }

  function syncToggle(row, ch, threads) {
    if (!threads.length) return;
    let btn = S.toggles.get(ch);
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sct-toggle";
      swallow(btn, ["pointerdown", "mousedown", "keydown"]);
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleCollapsed(ch);
      });
      S.toggles.set(ch, btn);
    }
    const collapsed = S.collapsed.has(ch);
    btn.classList.toggle("sct-has-unread", collapsed && threads.some((t) => t.hasUnread));
    btn.setAttribute("aria-expanded", String(!collapsed));
    const title = collapsed ? `Show threads (${threads.length})` : "Hide threads";
    if (btn.title !== title) {
      btn.title = title;
      btn.setAttribute("aria-label", title);
    }
    const want = collapsed ? "down" : "up";
    if (btn.dataset.icon !== want) {
      btn.dataset.icon = want;
      btn.replaceChildren(icon(want));
    }
    const name = row.querySelector(NAME_SEL);
    if (name) {
      if (name.nextElementSibling !== btn) name.after(btn);
    } else if (btn.parentElement !== row) {
      row.append(btn);
    }
  }

  function threadRow(t) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sct-thread" + (t.hasUnread ? " sct-unread" : "");
    btn.dataset.key = t.key;
    const text = label(t);
    btn.title = text;
    btn.setAttribute("aria-label", `Open thread: ${text}${t.hasUnread ? " (unread)" : ""}`);
    btn.append(icon("thread", "sct-icon"), span("sct-name", text));
    if (t.mention) btn.append(span("sct-badge sct-mention", String(t.unreadCount || "@")));
    else if (t.unreadCount) btn.append(span("sct-badge", String(t.unreadCount)));
    else if (t.hasUnread) btn.append(span("sct-dot", ""));
    return btn;
  }

  function syncBlock(ch, threads) {
    let block = S.blocks.get(ch);
    if (!block) {
      block = document.createElement("div");
      block.className = "sct-block";
      block.setAttribute("role", "group");
      block.dataset.ch = ch;
      swallow(block, ["pointerdown", "mousedown", "keydown", "contextmenu"]);
      block.addEventListener("click", onBlockClick);
      S.blocks.set(ch, block);
    }
    const expanded = S.expanded.has(ch);
    const canExpand = threads.length > cfg.maxVisible;
    const visible = expanded || !canExpand ? threads : threads.slice(0, cfg.maxVisible);
    const sig = JSON.stringify([expanded, threads.length,
      visible.map((t) => [t.key, label(t), t.unreadCount, t.hasUnread, t.mention])]);
    if (block.dataset.sig !== sig) {
      block.dataset.sig = sig;
      block.replaceChildren(...visible.map(threadRow));
      if (canExpand) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "sct-more";
        more.dataset.action = "more";
        more.textContent = expanded ? "Show less" : `Show ${threads.length - cfg.maxVisible} more`;
        block.append(more);
      }
    }
    return block;
  }

  function onBlockClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const btn = e.target.closest("button");
    if (!btn) return;
    const ch = e.currentTarget.dataset.ch;
    if (btn.dataset.action === "more") {
      if (S.expanded.has(ch)) S.expanded.delete(ch); else S.expanded.add(ch);
      schedule();
      return;
    }
    const t = (S.byChannel.get(ch) || []).find((x) => x.key === btn.dataset.key);
    if (t) openThread(t);
  }

  function toggleCollapsed(ch) {
    if (S.collapsed.has(ch)) S.collapsed.delete(ch); else S.collapsed.add(ch);
    ls.set("sct.collapsed", [...S.collapsed]);
    schedule();
  }

  function layoutGroup(container, anchors) {
    const blockFor = new Map(anchors.map((a) => [a.item, a.block]));
    const kids = [];
    for (const el of container.children) {
      if (el.classList.contains("sct-block")) continue;
      if (getComputedStyle(el).position !== "absolute") continue;
      kids.push({ el, y: basePos(el), h: el.offsetHeight });
    }
    kids.sort((a, b) => a.y - b.y);
    let offset = 0;
    for (const { el, y, h } of kids) {
      if (offset) {
        S.shifted.set(el, el.style.marginTop);
        el.style.marginTop = offset + "px";
      }
      const block = blockFor.get(el);
      if (block) {
        block.style.top = y + h + offset + "px";
        offset += block.offsetHeight;
      }
    }
    // The list sizes its container from its own row heights. Grow it by what we inserted,
    // otherwise the sidebar thinks it is shorter than it is and snaps scrolling back.
    // The base height comes from the list's inline height, never from a re-measure: shrinking
    // the container even for one forced layout makes the browser clamp scrollTop to 0.
    if (!S.grown.has(container)) S.grown.set(container, container.style.minHeight);
    const base = parseFloat(container.style.height) ||
      kids.reduce((max, k) => Math.max(max, k.y + k.h), 0);
    container.style.minHeight = offset ? base + offset + "px" : S.grown.get(container);
  }

  function releaseContainers(keep) {
    for (const [el, prev] of S.grown) {
      if (keep && keep.has(el) && el.isConnected) continue;
      el.style.minHeight = prev;
      S.grown.delete(el);
    }
  }

  // Slack rebuilds the whole sidebar when switching Home / Activity / DMs, which detaches the
  // node we observe. Cheap poll that notices that and re-renders right away.
  function heartbeat() {
    if (S.stopped) return;
    const first = document.querySelector(ROW_SEL);
    if (first && !(S.observedRoot && S.observedRoot.isConnected && S.observedRoot.contains(first))) {
      schedule();
      return;
    }
    for (const block of S.blocks.values()) {
      if (!block.isConnected) { schedule(); return; }
    }
  }

  function watchRoot(row) {
    const root = (row && (row.closest(".p-channel_sidebar") ||
      (row.closest('[role="tree"]') || {}).parentElement)) || document.body;
    if (root === S.observedRoot) return;
    S.observer.disconnect();
    S.observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    S.observedRoot = root;
  }

  function relayout() {
    S.raf = 0;
    if (S.stopped) return;
    ensureStyle();

    // Undo last frame's shifts so positions can be measured from the list's own layout.
    // (Container min-heights stay put — see layoutGroup.)
    for (const [el, prev] of S.shifted) el.style.marginTop = prev;
    S.shifted.clear();

    const rows = sidebarRows();
    watchRoot(rows[0] && rows[0].row);

    const live = new Set();
    const groups = new Map();
    for (const { row, ch } of rows) {
      const threads = S.byChannel.get(ch) || [];
      syncToggle(row, ch, threads);
      if (!threads.length || S.collapsed.has(ch)) continue;

      const { el: item, abs } = findItem(row);
      const block = syncBlock(ch, threads);
      block.style.paddingLeft = indentFor(row, item) + "px";
      live.add(ch);
      if (abs) {
        S.mode = "absolute";
        block.classList.remove("sct-flow");
        const container = item.parentElement;
        if (block.parentElement !== container) container.append(block);
        if (!groups.has(container)) groups.set(container, []);
        groups.get(container).push({ item, block });
      } else {
        S.mode = "flow";
        block.classList.add("sct-flow");
        if (item.nextElementSibling !== block) item.after(block);
      }
    }

    for (const [ch, block] of S.blocks) {
      if (!live.has(ch)) { block.remove(); S.blocks.delete(ch); }
    }
    for (const [ch, btn] of S.toggles) {
      if (!btn.isConnected || !(S.byChannel.get(ch) || []).length) { btn.remove(); S.toggles.delete(ch); }
    }
    for (const [container, anchors] of groups) layoutGroup(container, anchors);
    releaseContainers(new Set(groups.keys()));

    // Drop the mutation records our own writes just produced, so we don't loop.
    if (S.observer) S.observer.takeRecords();
  }

  function isOurs(node) {
    return node.nodeType === 1 && node.closest && !!node.closest(".sct-block,.sct-toggle");
  }

  // ---------------------------------------------------------------- diagnostics

  function ancestry(el) {
    const out = [];
    for (let i = 0; el && el !== document.body && i < 7; i++, el = el.parentElement) {
      const cls = [...el.classList].slice(0, 2).join(".");
      out.push(`${el.tagName.toLowerCase()}${cls ? "." + cls : ""} pos=${getComputedStyle(el).position} h=${el.offsetHeight}`);
    }
    return out;
  }

  function diag() {
    const rows = sidebarRows();
    const first = rows[0];
    const raw = S.lastRaw;
    const t0 = raw && Array.isArray(raw.threads) ? raw.threads[0] : null;
    const info = {
      version: VERSION,
      path: location.pathname,
      auth: S.auth
        ? { teamId: S.auth.teamId, routeId: S.auth.routeId, userId: S.auth.userId, hasToken: !!S.auth.token, teamUrl: S.auth.url }
        : null,
      apiBase: S.apiBase,
      lastFetchAt: S.lastFetchAt && S.lastFetchAt.toISOString(),
      lastError: S.lastError,
      fetchedThreads: S.items.length,
      channelsWithActiveThreads: S.byChannel.size,
      sidebarRows: rows.length,
      layoutMode: S.mode,
      rowAncestry: first ? ancestry(first.row) : null,
      rowSample: first ? first.row.outerHTML.slice(0, 500) : null,
      apiKeys: raw ? Object.keys(raw) : null,
      threadKeys: t0 ? Object.keys(t0) : null,
      rootKeys: t0 && t0.root_msg ? Object.keys(t0.root_msg) : null,
    };
    console.log("[SCT] diag", info);
    return info;
  }

  // ---------------------------------------------------------------- lifecycle

  function onScroll(e) {
    const t = e.target;
    if (t && t.nodeType === 1 && t.querySelector(ROW_SEL)) schedule();
  }
  function onFocus() { refresh(); }

  function stop() {
    S.stopped = true;
    cancelAnimationFrame(S.raf);
    clearInterval(S.timer);
    if (S.observer) S.observer.disconnect();
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("focus", onFocus);
    for (const [el, prev] of S.shifted) el.style.marginTop = prev;
    S.shifted.clear();
    releaseContainers(null);
    clearInterval(S.beat);
    for (const el of S.blocks.values()) el.remove();
    for (const el of S.toggles.values()) el.remove();
    S.blocks.clear();
    S.toggles.clear();
    if (S.sheet instanceof CSSStyleSheet) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== S.sheet);
    } else if (S.sheet) {
      S.sheet.remove();
    }
    if (window.SCT && window.SCT.version === VERSION && window.SCT._state === S) delete window.SCT;
    console.log("[SCT] stopped");
  }

  S.observer = new MutationObserver((records) => {
    for (const r of records) {
      if (isOurs(r.target)) continue;
      if (r.type === "childList" && [...r.addedNodes, ...r.removedNodes].every(isOurs)) continue;
      schedule();
      return;
    }
  });
  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("focus", onFocus);
  S.timer = setInterval(refresh, cfg.pollMs);
  S.beat = setInterval(heartbeat, 500);

  window.SCT = {
    version: VERSION,
    _state: S,
    refresh,
    stop,
    diag,
    setDays(n) {
      cfg.days = Math.max(0, Number(n) || 0);
      ls.set("sct.days", cfg.days);
      regroup();
      schedule();
      if (cfg.days > 0) refresh();
      return cfg.days;
    },
    setMaxVisible(n) {
      cfg.maxVisible = Math.max(1, Number(n) || 5);
      ls.set("sct.maxVisible", cfg.maxVisible);
      schedule();
      return cfg.maxVisible;
    },
    setOpenMode(mode) {
      cfg.openMode = mode === "reload" ? "reload" : "desktop";
      ls.set("sct.openMode", cfg.openMode);
      return cfg.openMode;
    },
  };

  schedule();
  refresh().then(() => {
    const n = S.byChannel.size;
    if (S.lastError) {
      console.warn(`[SCT] ${VERSION} running, but fetching threads failed. Run SCT.diag() and send me the output.`);
    } else {
      console.log(`%c[SCT] ${VERSION} running: ${S.items.length} threads, ${n} channels with active ones. SCT.diag() / SCT.stop()`,
        "color:#e8912d;font-weight:bold");
    }
  });
})();
