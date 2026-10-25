// ============================================================
// floorplan.js — 平面圖（功能⑧）
//   ‧讀平面圖檔：v3.3 的 tools/dxf-to-floorplan.py 從 DXF 轉出來的檔（例：2F_2.js）
//   ‧存資料庫前後的轉換：floorPlans/{樓層代號} 的 planData（整張圖存成一段文字）
//   ‧畫平面圖：牆、通道、消防、設施細節、區域名稱＋照實際位置的機台（畫法照 v3.3）
//     看板（board.html）畫即時狀態，主檔維護（master.html）匯入前預覽，兩頁共用這個檔
//   注意：這個檔案不 import common.js（跟 history.js、status-panel.js 一樣），
//         每台機要畫什麼顏色、寫什麼字，由頁面傳進來的 nodeInfo() 決定
// ============================================================

const NS = 'http://www.w3.org/2000/svg';

// 存進資料庫的上限：planData 最多 80 萬字（安全規則也檢查這個數字）；資料庫一筆最多 1 MB
export const PLAN_TEXT_MAX = 800000;
export const PLAN_BYTES_MAX = 1000000;

// 線條分類（v3.3 轉檔程式依 DXF 圖層分的）：牆、通道、消防、電控箱、其他設施
const LINE_KEYS = ['misc', 'ctrl', 'fire', 'aisle', 'wall'];   // 也是畫的順序：牆最後畫，壓在最上面
const PATH_OK = /^[MLHVCSQTAZmlhvcsqtaz0-9 .,eE+-]*$/;           // 線條資料只能有座標和畫線指令
const ID_OK = /^[A-Z0-9][A-Z0-9-]{1,11}$/;                       // 跟設備編號的規則一樣

// 畫法的數字（照 v3.3 調好的值）
const LIFT_FLAT = 5, LIFT_3D = 12;   // 機台「高度」：平面模式淡淡的立體感，立體模式明顯一點
const PLAN_UNIT = 2.6;               // DXF 圖面單位（公分）的放大倍率：陰影、圓角跟著放大
const PLAN_INSET = 6;                // 機台色塊比 DXF 外框內縮一點
const PLAN_GAP = 16;                 // 相鄰機台之間至少留的縫（公分），才不會黏在一起
const PLAN_TEXT = 2.9;               // 機台上文字的倍率（太窄的機台會自動縮小）
const ZOOMS = [1, 1.5, 2, 3, 4, 6];  // 縮放：相對於「適合寬度」的倍率
const LINE_SPEC = { 't-id': [16, 18], 't-pn': [11, 13.5], 't-sub': [10.5, 13], 't-note': [10, 13.5] };   // [字大小, 行高]

let viewCount = 0;   // 同一頁有好幾張圖時，漸層的編號才不會重複

// ============================================================
// 讀平面圖檔、檢查內容
// ============================================================

// 讀 v3.3 轉出來的平面圖檔（.js），也接受直接是 JSON 的檔案
//   回傳 { key: 檔案裡寫的樓層代碼（v3.3 的，例 2F_2；沒有就是 ''）, plan: 檢查過的平面圖 }
//   注意：只把裡面的資料當文字解析，不會執行檔案裡的程式
export function parsePlanFile(text) {
  const clean = String(text ?? '').replace(/^\uFEFF/, '').trim();
  let key = '';
  let jsonText = clean;
  const head = clean.match(/FLOORPLANS\s*\[\s*["']([^"']{1,40})["']\s*\]\s*=\s*/);
  if (head) {
    key = head[1];
    jsonText = clean.slice(head.index + head[0].length);
  }
  const start = jsonText.indexOf('{');
  const end = jsonText.lastIndexOf('}');
  let raw = null;
  try {
    raw = JSON.parse(jsonText.slice(start, end + 1));
  } catch {
    throw new Error('看不懂這個檔案：請選 v3.3 轉出來的平面圖檔（例：floorplans 資料夾裡的 2F_2.js）');
  }
  return { key, plan: normalizePlan(raw) };
}

// 檢查平面圖內容，整理成固定的格式；有問題就丟出中文錯誤
export function normalizePlan(raw) {
  const bad = (message) => { throw new Error(`平面圖內容有問題：${message}`); };
  if (!raw || typeof raw !== 'object') bad('不是平面圖資料');
  const W = Number(raw.W);
  const H = Number(raw.H);
  if (!(W > 0 && W <= 100000 && H > 0 && H <= 100000)) bad('圖面大小不對');

  const paths = (group, name) => {
    const out = {};
    for (const k of LINE_KEYS) {
      const v = group?.[k];
      if (v == null || v === '') continue;
      if (typeof v !== 'string' || !PATH_OK.test(v)) bad(`${name}資料（${k}）格式不對`);
      out[k] = v;
    }
    return out;
  };
  const lines = paths(raw.lines, '線條');
  const fills = paths(raw.fills, '色塊');

  if (!Array.isArray(raw.machines)) bad('找不到機台資料');
  const seen = new Set();
  const machines = raw.machines.map((m, i) => {
    const id = String(m?.id ?? '').trim().toUpperCase();
    if (!ID_OK.test(id)) bad(`第 ${i + 1} 台的設備編號不對（${String(m?.id ?? '空白')}）`);
    if (seen.has(id)) bad(`圖上的設備編號重複：${id}`);
    seen.add(id);
    const [x, y, w, h] = ['x', 'y', 'w', 'h'].map((k) => Number(m[k]));
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) bad(`${id} 的位置或大小不對`);
    return { id, model: String(m.model ?? '').slice(0, 40), x, y, w, h };
  });

  const areas = (Array.isArray(raw.areas) ? raw.areas : [])
    .map((a) => ({ text: String(a?.text ?? '').trim().slice(0, 40), x: Number(a?.x), y: Number(a?.y), h: Number(a?.h) }))
    .filter((a) => a.text && [a.x, a.y, a.h].every(Number.isFinite));

  return { source: String(raw.source ?? '').slice(0, 60), W, H, lines, fills, machines, areas };
}

// 平面圖 → 存進資料庫的文字（planData）
export function planToText(plan) {
  const { W, H, lines, fills, machines, areas } = plan;
  return JSON.stringify({ W, H, lines, fills, machines, areas });
}

// 資料庫的文字（planData）→ 平面圖；壞掉的話丟出中文錯誤
export function planFromText(text) {
  let raw = null;
  try { raw = JSON.parse(text); } catch { throw new Error('平面圖資料讀不懂，請管理者到主檔維護重新匯入'); }
  return normalizePlan(raw);
}

// 文字長度（UTF-8 位元組），用來確認存得進資料庫
export function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

// ============================================================
// 畫平面圖
// ============================================================

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// 顏色變暗（機台側面用）
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const m = (c) => Math.round(c * (1 - f));
  return `rgb(${m((n >> 16) & 255)},${m((n >> 8) & 255)},${m(n & 255)})`;
}

// 深灰這類顏色在深色底上看不清楚：要加一圈亮邊（例：狀態「停用」）
function needsEdge(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  return l < 0.45 || (s < 0.2 && l < 0.6);
}

const safeHex = (hex) => (/^#[0-9a-f]{6}$/i.test(hex || '') ? hex : '#9AA0A6');

// ---------- 文字排版（照 v3.3）：太長先縮小，空間夠就折兩行，最後才加「…」 ----------
const charW = (ch) => (/[\u0000-\u00ff]/.test(ch) ? 0.58 : 1);   // 英數約半個中文字寬
const textW = (str, fs) => [...str].reduce((a, ch) => a + charW(ch), 0) * fs;

function fitText(str, fontPx, maxPx) {
  let w = 0;
  let out = '';
  for (const ch of str) {
    if ((w + charW(ch)) * fontPx > maxPx) return `${out.slice(0, -1)}…`;
    w += charW(ch);
    out += ch;
  }
  return out;
}

function layoutLine(str, fs, lh, maxW, wrap) {
  if (textW(str, fs) <= maxW) return { parts: [str], fs, lh };
  const f2 = fs * 0.85;
  if (textW(str, f2) <= maxW) return { parts: [str], fs: f2, lh: lh * 0.85 };
  if (wrap) {
    const f3 = fs * 0.8;
    const chars = [...str];
    let cut = 0;
    let w = 0;
    while (cut < chars.length && (w + charW(chars[cut])) * f3 <= maxW) { w += charW(chars[cut]); cut += 1; }
    const headChars = chars.slice(0, cut);
    const soft = Math.max(...['/', '-', ' ', '·', '、', ','].map((c) => headChars.lastIndexOf(c)));   // 優先在分隔符號後斷行
    if (soft >= cut * 0.5) cut = soft + 1;
    const a = chars.slice(0, cut).join('');
    const b = chars.slice(cut).join('').trim();
    return { parts: b ? [a, fitText(b, f3, maxW)] : [a], fs: f3, lh: lh * 0.82 };
  }
  return { parts: [fitText(str, f2, maxW)], fs: f2, lh: lh * 0.85 };
}

// DXF 圖面上相鄰機台的外框常會重疊或貼齊：往內收，讓每台之間至少留 PLAN_GAP 的縫（照 v3.3）
function planRects(plan) {
  if (plan._rects) return plan._rects;
  const G = PLAN_GAP;
  const I = PLAN_INSET;
  const r = plan.machines.map((m) => ({ id: m.id, x1: m.x + I, y1: m.y + I, x2: m.x + m.w - I, y2: m.y + m.h - I }));
  for (let pass = 0; pass < 3; pass += 1) {
    for (let i = 0; i < r.length; i += 1) {
      for (let j = i + 1; j < r.length; j += 1) {
        const a = r[i];
        const b = r[j];
        const ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) + G;
        const oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) + G;
        if (ox <= 0 || oy <= 0) continue;
        if (ox <= oy) {
          const [L, R] = a.x1 <= b.x1 ? [a, b] : [b, a];
          const mid = (L.x2 + R.x1) / 2;
          L.x2 = Math.min(L.x2, mid - G / 2);
          R.x1 = Math.max(R.x1, mid + G / 2);
        } else {
          const [T, B] = a.y1 <= b.y1 ? [a, b] : [b, a];
          const mid = (T.y2 + B.y1) / 2;
          T.y2 = Math.min(T.y2, mid - G / 2);
          B.y1 = Math.max(B.y1, mid + G / 2);
        }
      }
    }
  }
  plan._rects = r;
  return r;
}

// 在 host（一個空的 div）裡畫一張平面圖
//   options：
//     nodeInfo(設備編號) → 這台機要怎麼畫：
//       { kind: 'live' 有狀態 | 'unset' 還沒設定 | 'ghost' 圖上有、這層主檔沒有（灰色虛線框）,
//         color: 狀態顏色, fg: 字色, alert: 要閃爍, alertLong: 閃快一點, other: 別單位（淡淡顯示）,
//         pending: 還在同步, match: 符合目前標示的狀態, lines: { pn, sub, note }: 機台上的字,
//         label: 給讀螢幕軟體的說明, title: 滑鼠停在上面時的說明 }
//     onPick(設備編號, kind)：點了某台機
//     view3d、layers { aisle 通道, detail 設施細節, fire 消防 }、zoom（'fit' 或倍率）
//   回傳：update({ highlight })、set({ view3d, layers, zoom })、zoomStep(±1)、zoomLabel()、destroy()
export function createPlanView(host, plan, options) {
  const opts = { view3d: false, layers: { aisle: true, detail: true, fire: true }, zoom: 'fit', ...options };
  const gradId = `fpTop${(viewCount += 1)}`;
  const nodes = new Map();
  let lastHighlight = false;

  host.classList.add('fp-wrap');
  host.innerHTML = '';
  const svg = svgEl('svg', { class: 'fp-svg', viewBox: `0 0 ${plan.W} ${plan.H}`, role: 'img', 'aria-label': '平面圖' });
  host.appendChild(svg);

  // 牆、通道、消防、設施細節、區域名稱：只畫一次，開關圖層用樣式藏起來，不用重畫
  function drawStatic() {
    const defs = svgEl('defs');
    defs.innerHTML = `<linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">`
      + '<stop offset="0" stop-color="#fff" stop-opacity=".24"/><stop offset=".45" stop-color="#fff" stop-opacity=".05"/>'
      + '<stop offset="1" stop-color="#000" stop-opacity=".1"/></linearGradient>';
    svg.appendChild(defs);
    svg.appendChild(svgEl('rect', { class: 'fp-bg', width: plan.W, height: plan.H }));
    for (const k of LINE_KEYS) {
      if (plan.fills[k]) svg.appendChild(svgEl('path', { class: `fp-fill fp-fill-${k}`, d: plan.fills[k] }));
    }
    for (const k of LINE_KEYS) {
      if (plan.lines[k]) svg.appendChild(svgEl('path', { class: `fp-line fp-line-${k}`, d: plan.lines[k] }));
    }
    for (const a of plan.areas) {
      const dim = /空調|掃地/.test(a.text);   // 小標示（空調進風口、掃地用具）歸在「設施細節」
      const t = svgEl('text', {
        class: `fp-area${dim ? ' is-dim' : ''}`, x: a.x, y: a.y,
        'font-size': dim ? 26 : Math.max(48, Math.min(90, a.h * 1.1)), 'stroke-width': dim ? 6 : 12
      });
      t.textContent = a.text;
      svg.appendChild(t);
    }
  }

  // 一台機：陰影、閃爍外框、側面、本體、光澤、四行字
  function buildNode(id, x, y, w, h, lift, k) {
    const u = PLAN_UNIT;
    const bh = h - lift;
    const ro = 6;   // 閃爍外框往外擴的距離
    const g = svgEl('g', { class: 'fp-node', 'data-id': id, tabindex: 0, role: 'button' });
    g.appendChild(svgEl('title'));
    g.appendChild(svgEl('rect', { class: 'fp-shadow', x: x + 5 * u, y: y + 8 * u, width: w, height: bh + lift - 4 * u, rx: 8 * u }));
    g.appendChild(svgEl('rect', { class: 'fp-ring', x: x - ro, y: y - ro, width: w + 2 * ro, height: bh + lift + 2 * ro, rx: 10 * u }));
    g.appendChild(svgEl('rect', { class: 'fp-side', x, y: y + bh - 8 * u, width: w, height: lift + 8 * u, rx: 7 * u }));
    g.appendChild(svgEl('rect', { class: 'fp-body', x, y, width: w, height: bh, rx: 7 * u }));
    g.appendChild(svgEl('rect', { class: 'fp-gloss', x, y, width: w, height: bh, rx: 7 * u, fill: `url(#${gradId})` }));
    for (const c of Object.keys(LINE_SPEC)) g.appendChild(svgEl('text', { class: c, x: x + w / 2, 'text-anchor': 'middle' }));
    g._geo = { cx: x + w / 2, cy: y + bh / 2, maxW: w - 6 * k, maxH: bh - 6 * k, k };
    return g;
  }

  function drawNodes() {
    svg.querySelector('.fp-nodes')?.remove();
    nodes.clear();
    const lift = (opts.view3d ? LIFT_3D : LIFT_FLAT) * PLAN_UNIT;
    const group = svgEl('g', { class: 'fp-nodes' });
    for (const r of planRects(plan)) {
      const w = r.x2 - r.x1;
      const h = r.y2 - r.y1;
      const k = Math.max(0.6, Math.min(PLAN_TEXT, (w - 8) / 40, (h - lift - 10) / 60));
      const g = buildNode(r.id, r.x1, r.y1, w, h, lift, k);
      nodes.set(r.id, g);
      group.appendChild(g);
    }
    svg.appendChild(group);
  }

  // 依 nodeInfo() 更新一台機的顏色、字、閃爍
  function paint(id, g, highlight) {
    const info = opts.nodeInfo(id) || { kind: 'ghost', lines: {} };
    const live = info.kind === 'live';
    const color = live ? safeHex(info.color) : '';
    g.classList.toggle('is-ghost', info.kind === 'ghost');
    g.classList.toggle('is-unset', info.kind === 'unset');
    g.classList.toggle('is-edge', live && needsEdge(color));
    g.classList.toggle('is-alert', live && info.alert === true);
    g.classList.toggle('is-alert-long', live && info.alert === true && info.alertLong === true);
    g.classList.toggle('is-other', info.other === true);
    g.classList.toggle('is-pending', info.pending === true);
    g.classList.toggle('is-match', highlight && info.match === true);
    g.style.setProperty('--c', live ? color : 'transparent');
    g.style.setProperty('--fg', live ? (info.fg || '#FFFFFF') : '');
    g.querySelector('.fp-side').setAttribute('fill', live ? shade(color, 0.42) : 'transparent');
    g.setAttribute('aria-label', info.label || id);
    g.querySelector('title').textContent = info.title || id;

    // 機台上的字：編號、料號、第三行（製程或持續時間）、原因
    const lines = info.lines || {};
    const content = {
      't-id': id,
      't-pn': String(lines.pn || '').trim(),
      't-sub': String(lines.sub || '').trim(),
      't-note': String(lines.note || '').trim()
    };
    const geo = g._geo;
    const build = (wrap) => Object.keys(LINE_SPEC).filter((k) => content[k]).map((k) => {
      const fs = LINE_SPEC[k][0] * geo.k;
      const lh = LINE_SPEC[k][1] * geo.k;
      return k === 't-id' ? { k, parts: [content[k]], fs, lh } : { k, ...layoutLine(content[k], fs, lh, geo.maxW, wrap) };
    });
    const heightOf = (ls) => ls.reduce((a, l) => a + l.parts.length * l.lh, 0);
    let laid = build(true);
    if (heightOf(laid) > geo.maxH) laid = build(false);   // 高度不夠折行就改回單行
    let y = geo.cy - heightOf(laid) / 2;
    for (const k of Object.keys(LINE_SPEC)) {
      const t = g.querySelector(`.${k}`);
      const l = laid.find((x) => x.k === k);
      if (!l) { t.setAttribute('display', 'none'); continue; }
      t.removeAttribute('display');
      t.style.fontSize = `${l.fs}px`;
      if (k === 't-note') t.style.strokeWidth = `${3 * geo.k}px`;
      t.textContent = '';
      for (const part of l.parts) {
        const ts = svgEl('tspan', { x: geo.cx, y: (y + l.lh / 2 + l.fs * 0.36).toFixed(1) });
        ts.textContent = part;
        t.appendChild(ts);
        y += l.lh;
      }
    }
  }

  function update({ highlight = lastHighlight } = {}) {
    lastHighlight = highlight;
    svg.classList.toggle('is-hl', !!highlight);
    nodes.forEach((g, id) => paint(id, g, !!highlight));
  }

  function applyLayers() {
    const L = opts.layers || {};
    svg.classList.toggle('no-aisle', L.aisle === false);
    svg.classList.toggle('no-detail', L.detail === false);
    svg.classList.toggle('no-fire', L.fire === false);
  }

  const fitWidth = () => Math.max(200, (host.clientWidth || window.innerWidth - 40) - 16);
  function applyZoom() {
    svg.style.width = opts.zoom === 'fit' ? '100%' : `${Math.round(fitWidth() * opts.zoom)}px`;
  }

  function set(change = {}) {
    const redraw = 'view3d' in change && change.view3d !== opts.view3d;
    Object.assign(opts, change);
    host.classList.toggle('is3d', !!opts.view3d);
    applyLayers();
    applyZoom();
    if (redraw) { drawNodes(); update(); }
  }

  function zoomStep(dir) {
    const cur = opts.zoom === 'fit' ? 1 : opts.zoom;
    const next = dir > 0
      ? (ZOOMS.find((z) => z > cur + 0.01) ?? ZOOMS[ZOOMS.length - 1])
      : ([...ZOOMS].reverse().find((z) => z < cur - 0.01) ?? ZOOMS[0]);
    set({ zoom: next === 1 ? 'fit' : next });
  }

  const zoomLabel = () => (opts.zoom === 'fit' ? '適合' : `${Math.round(opts.zoom * 100)}%`);

  // 點機台、鍵盤 Enter／空白鍵
  const pick = (event) => {
    const g = event.target.closest?.('.fp-node');
    if (!g || !host.contains(g)) return;
    const info = opts.nodeInfo(g.dataset.id) || { kind: 'ghost' };
    opts.onPick?.(g.dataset.id, info.kind);
  };
  const onKey = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!event.target.closest?.('.fp-node')) return;
    event.preventDefault();
    pick(event);
  };
  host.addEventListener('click', pick);
  host.addEventListener('keydown', onKey);
  const onResize = () => applyZoom();
  window.addEventListener('resize', onResize);

  drawStatic();
  drawNodes();
  set({});
  update();

  return {
    update,
    set,
    zoomStep,
    zoomLabel,
    get options() { return { view3d: opts.view3d, layers: { ...opts.layers }, zoom: opts.zoom }; },
    has: (id) => nodes.has(id),
    destroy() {
      host.removeEventListener('click', pick);
      host.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      host.innerHTML = '';
      host.classList.remove('fp-wrap', 'is3d');
    }
  };
}
