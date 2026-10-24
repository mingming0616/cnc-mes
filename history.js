// ============================================================
// history.js — 單台機異動履歷（功能④）
//   打開方式：看板點卡片 → 面板「異動履歷」；蓋在看板上面，按「關閉」回到看板
//   讀：machineEvents（這台機的事件紀錄），新到舊，一次 pageSize 筆（平常 30 筆）
//     ‧最新一批用即時監聽：這台機有新異動，自動加到最上面（每筆新異動只多讀 1 次）
//     ‧「載入更早」「跳到日期」用一次性讀取，每按一次讀 pageSize 筆
//   需要的索引：machineEvents ＝ machineId 升序 ＋ createdAt 降序（在 Firebase 主控台建立）
//   注意：這個檔案不 import common.js。資料庫函式和看板的資料都由 board.html
//         用 setupHistory() 傳進來，避免兩個檔案寫的版本號（?v=）不同，
//         讓 Firebase 被載入兩次而整頁出錯。
// ============================================================

const $ = (id) => document.getElementById(id);
let deps = null;   // board.html 傳進來的資料庫函式、看板資料和小工具

const state = {
  machineId: '',
  mode: 'latest',          // latest＝最新（即時更新）；date＝跳到某個生產日
  dateValue: '',           // 跳到的生產日 YYYY-MM-DD
  docs: new Map(),         // 事件編號 → { id, data, pending, snap }
  confirmed: false,        // 已經跟資料庫確認過（不是只有這台裝置上的暫存）
  hasMore: false,          // 還有沒有更早的紀錄
  loading: false,
  error: null,             // 讀取失敗時的錯誤
  unsub: null,             // 停止即時監聽的函式
  gen: 0,                  // 換機台、換模式就加 1；舊的讀取結果晚回來時直接丟掉
  statusKey: ''            // 上次畫的「目前狀態」，沒變就不用重畫
};

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const TW_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

const ms = (ts) => (ts && typeof ts.toMillis === 'function' ? ts.toMillis() : 0);
const esc = (value) => deps.escapeHtml(value);
const isOpen = () => Boolean(deps) && $('dlg-history').open;

// ============================================================
// 給 board.html 呼叫的三個函式
// ============================================================

// 看板讀完主檔後呼叫一次：把要用的函式、資料傳進來，並綁定按鈕
export function setupHistory(d) {
  deps = d;
  $('h-close').addEventListener('click', () => $('dlg-history').close());
  $('dlg-history').addEventListener('close', stop);   // 關掉時停止監聽，不再讀資料庫
  $('h-more').addEventListener('click', loadMore);
  $('h-go').addEventListener('click', () => {
    const value = $('h-date').value;
    if (!value) {
      $('h-mode').hidden = false;
      $('h-mode').textContent = '先選一個生產日，再按「查詢」。';
      return;
    }
    startDate(value);
  });
  $('h-latest').addEventListener('click', () => {
    $('h-date').value = '';
    startLatest();
  });
}

// 打開某台機的履歷
export function openHistory(machineId) {
  if (!deps) return;
  const machine = deps.machineOf(machineId);
  if (!machine) return;
  stop();
  state.machineId = machineId;
  state.statusKey = '';
  $('h-title').textContent = machine.machineId;
  $('h-sub').textContent = `${machine.category}，${machine.brand} ${machine.model}，${deps.floorName(machine.floorId)}`;
  $('h-date').value = '';
  const today = todayProdDate();
  if (today) $('h-date').max = today;
  $('dlg-history').showModal();
  renderCurrent();
  startLatest();
}

// 看板收到新的機台狀態時呼叫：履歷開著才重畫，而且這台的狀態有變才畫
export function refreshHistory() {
  if (!isOpen()) return;
  const entry = deps.getStatus(state.machineId);
  const key = `${entry?.data?.lastEventId || ''}|${entry?.pending ? 1 : 0}`;
  if (key === state.statusKey) return;
  renderCurrent();
  render();
}

// ============================================================
// 讀取
// ============================================================

const eventsRef = () => deps.collection(deps.db, 'machineEvents');

// 停止監聽、清空清單（關閉、換機台、換模式時）
function stop() {
  state.gen += 1;
  if (state.unsub) {
    state.unsub();
    state.unsub = null;
  }
  state.docs.clear();
  state.confirmed = false;
  state.hasMore = false;
  state.loading = false;
  state.error = null;
}

// 存一筆事件到清單（serverTimestamps: 'estimate'：剛寫入、還沒同步的時間先用估計值）
function keep(d) {
  state.docs.set(d.id, {
    id: d.id,
    data: d.data({ serverTimestamps: 'estimate' }),
    pending: d.metadata.hasPendingWrites,
    snap: d
  });
}

// 最新模式：即時監聽最新 pageSize 筆
function startLatest() {
  stop();
  const gen = state.gen;
  state.mode = 'latest';
  state.dateValue = '';
  state.loading = true;
  render();
  $('dlg-history').scrollTop = 0;
  const q = deps.query(
    eventsRef(),
    deps.where('machineId', '==', state.machineId),
    deps.orderBy('createdAt', 'desc'),
    deps.limit(deps.pageSize)
  );
  state.unsub = deps.onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    if (gen !== state.gen) return;
    if (!snap.metadata.fromCache && !state.confirmed) {
      // 第一次拿到資料庫確認過的結果：以它為準重建清單
      // （之前顯示的可能只是這台裝置上的暫存，中間可能有缺）
      state.docs.clear();
      state.confirmed = true;
      state.hasMore = snap.size >= deps.pageSize;
    } else {
      // 這台裝置剛寫、但被資料庫退回的紀錄，從清單拿掉
      // （其他筆只是被擠出最新那一批，畫面上照樣保留）
      snap.docChanges().forEach((change) => {
        if (change.type === 'removed' && state.docs.get(change.doc.id)?.pending) {
          state.docs.delete(change.doc.id);
        }
      });
    }
    snap.docs.forEach(keep);
    state.loading = !state.confirmed;
    state.error = null;
    render();
  }, (err) => {
    if (gen !== state.gen) return;
    state.loading = false;
    state.error = err;
    render();
  });
}

// 跳到日期：讀「那個生產日結束（隔天 08:00）以前」最新的 pageSize 筆
async function startDate(value) {
  const end = prodDayEndMs(value);
  if (!end) return;
  stop();
  const gen = state.gen;
  state.mode = 'date';
  state.dateValue = value;
  state.loading = true;
  render();
  $('dlg-history').scrollTop = 0;
  try {
    const q = deps.query(
      eventsRef(),
      deps.where('machineId', '==', state.machineId),
      deps.where('createdAt', '<', deps.Timestamp.fromMillis(end)),
      deps.orderBy('createdAt', 'desc'),
      deps.limit(deps.pageSize)
    );
    const snap = await deps.getDocs(q);
    if (gen !== state.gen) return;
    if (snap.metadata.fromCache) throw { code: 'unavailable' };   // 沒連到資料庫，結果可能不完整
    snap.docs.forEach(keep);
    state.confirmed = true;
    state.hasMore = snap.size >= deps.pageSize;
  } catch (err) {
    if (gen !== state.gen) return;
    state.error = err;
  }
  state.loading = false;
  render();
}

// 載入更早：從畫面上最舊的那一筆再往前讀 pageSize 筆
async function loadMore() {
  if (state.loading) return;
  const oldest = sortedList().filter((item) => !item.pending).pop();
  if (!oldest) return;
  const gen = state.gen;
  state.loading = true;
  state.error = null;
  render();
  try {
    const q = deps.query(
      eventsRef(),
      deps.where('machineId', '==', state.machineId),
      deps.orderBy('createdAt', 'desc'),
      deps.startAfter(oldest.snap),
      deps.limit(deps.pageSize)
    );
    const snap = await deps.getDocs(q);
    if (gen !== state.gen) return;
    if (snap.metadata.fromCache) throw { code: 'unavailable' };
    snap.docs.forEach(keep);
    state.hasMore = snap.size >= deps.pageSize;
  } catch (err) {
    if (gen !== state.gen) return;
    state.error = err;   // 已經顯示的紀錄留著，可以再按一次重試
  }
  state.loading = false;
  render();
}

// ============================================================
// 時間、名稱的小工具
// ============================================================

// 新到舊排序
function sortedList() {
  return [...state.docs.values()].sort((a, b) =>
    ms(b.data.createdAt) - ms(a.data.createdAt) || (a.id < b.id ? 1 : -1));
}

// 生產日 YYYY-MM-DD 結束的時間（隔天 08:00 台灣時間）→ 毫秒
function prodDayEndMs(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m) return 0;
  const [h, mi] = String(deps.getShiftSetting()?.dayStartTime || '08:00').split(':').map(Number);
  // 台灣是 UTC+8、沒有日光節約時間：台灣的 h 點＝世界標準時間的 h-8 點
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1, (h || 0) - 8, mi || 0);
}

// 今天的生產日（日期選單最多選到今天）
function todayProdDate() {
  return deps.prodDateAndShift(new Date(), deps.getShiftSetting()).prodDate;
}

// 毫秒 → 台灣時間的年月日時分
function twParts(msValue) {
  const parts = {};
  TW_PARTS.formatToParts(new Date(msValue)).forEach((p) => { parts[p.type] = p.value; });
  return parts;
}

// 生產日 → 「10/24（六）」
function dayLabel(prodDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(prodDate || '');
  if (!m) return '';
  const weekday = WEEKDAYS[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()];
  return `${Number(m[2])}/${Number(m[3])}（${weekday}）`;
}

// 班別代碼 → 班別設定裡的名稱（例：D → 早班）
function shiftName(shiftId) {
  return deps.getShiftSetting()?.shifts?.find((s) => s.id === shiftId)?.name || shiftId || '';
}

// 狀態、原因的名稱和顏色：先用事件當時的單位，找不到再用設備目前的單位
function machineDept() {
  return deps.machineOf(state.machineId)?.deptId || '';
}
function defFor(deptId, code) {
  return deps.statusDef(deptId, code) || deps.statusDef(machineDept(), code);
}
function statusName(deptId, code) {
  return defFor(deptId, code)?.label || code || '—';
}
function reasonName(deptId, status, code) {
  if (!code) return '';
  const label = deps.reasonLabel(deptId, status, code);
  return label && label !== code ? label : (deps.reasonLabel(machineDept(), status, code) || code);
}
function chip(deptId, code) {
  return `<span class="hist-chip" style="${deps.colorStyle(defFor(deptId, code)?.color)}">${esc(statusName(deptId, code))}</span>`;
}
const reasonSpan = (text) => (text ? `<span class="hist-reason">${esc(text)}</span>` : '');

// 料號、製程合成一行
function partText(e) {
  return [e.partNo && `料號 ${e.partNo}`, e.opNo && `製程 ${e.opNo}`].filter(Boolean).join('，');
}

// 一般的明細：料號／製程、備註
function valueLines(e) {
  return [partText(e), e.note ? `備註：${e.note}` : ''].filter(Boolean);
}

// 資料更新：跟前一筆比，列出改了什麼
function diffLines(before, e) {
  const fields = [['partNo', '料號'], ['opNo', '製程'], ['note', '備註']];
  const lines = fields
    .filter(([key]) => (before[key] || '') !== (e[key] || ''))
    .map(([key, name]) => `${name}：${before[key] || '（空白）'} → ${e[key] || '（空白）'}`);
  return lines.length ? lines : valueLines(e);
}

// 這一筆是哪一種異動
//   first＝第一次設定；status＝狀態變了；reason＝狀態一樣、原因變了（重新計時）；
//   data＝只改料號、製程、備註；unknown＝前後筆都沒載入，分不出來
function kindOf(e, older, nextSince) {
  if (e.fromStatus == null) return 'first';
  if (e.fromStatus !== e.toStatus) return 'status';
  if (older) return (older.data.reasonCode || '') !== (e.reasonCode || '') ? 'reason' : 'data';
  // 前一筆沒載入：看「這筆存完後的狀態開始時間」是不是就是這筆的時間（是＝重新計時過）
  if (nextSince) return ms(nextSince) === ms(e.createdAt) ? 'reason' : 'data';
  return 'unknown';
}

// ============================================================
// 畫面
// ============================================================

// 上方「目前」這一行（資料來自看板的即時監聽，不另外讀）
function renderCurrent() {
  if (!isOpen()) return;
  const machine = deps.machineOf(state.machineId);
  if (!machine) return;
  const entry = deps.getStatus(state.machineId);
  state.statusKey = `${entry?.data?.lastEventId || ''}|${entry?.pending ? 1 : 0}`;
  if (!entry) {
    $('h-current').innerHTML = '<span class="hist-current-label">目前</span><span>未設定</span>';
    return;
  }
  const s = entry.data;
  const since = ms(s.statusSince) || Date.now();
  const part = partText(s);
  $('h-current').innerHTML = '<span class="hist-current-label">目前</span>'
    + chip(machine.deptId, s.status)
    + reasonSpan(reasonName(machine.deptId, s.status, s.reasonCode))
    + `<span>已經 <span class="js-dur" data-since="${since}">${deps.formatDuration(Date.now() - since)}</span></span>`
    + (part ? `<span class="hist-current-part">${esc(part)}</span>` : '')
    + (entry.pending ? '<span class="tag tag-off">同步中</span>' : '');
}

// 一筆異動
function rowHtml(item, i, list, status) {
  const e = item.data;
  const older = list[i + 1] || null;   // 緊接著的前一筆（更早）
  const newer = list[i - 1] || null;   // 緊接著的後一筆（更晚）
  const deptId = e.deptId || machineDept();
  // 這筆存完之後的「狀態開始時間」：記在後一筆的 fromStatusSince；最新一筆看目前狀態
  const nextSince = newer
    ? newer.data.fromStatusSince
    : (status && status.lastEventId === item.id ? status.statusSince : null);
  const kind = kindOf(e, older, nextSince);
  const toReason = reasonName(deptId, e.toStatus, e.reasonCode);
  const prevReason = older ? reasonName(deptId, e.fromStatus, older.data.reasonCode) : '';
  const lasted = `${statusName(deptId, e.fromStatus)}${prevReason ? `（${prevReason}）` : ''}持續 `
    + deps.formatDuration(ms(e.createdAt) - ms(e.fromStatusSince));

  let change = '';
  let dur = '';
  let lines = valueLines(e);
  if (kind === 'first') {
    change = `<span class="tag">第一次設定</span>${chip(deptId, e.toStatus)}${reasonSpan(toReason)}`;
  } else if (kind === 'status') {
    change = `${chip(deptId, e.fromStatus)}<span class="hist-arrow" aria-label="改成">→</span>`
      + `${chip(deptId, e.toStatus)}${reasonSpan(toReason)}`;
    dur = lasted;
  } else if (kind === 'reason') {
    const from = older ? `${prevReason || '（無）'} → ` : '改成 ';
    change = `${chip(deptId, e.toStatus)}<span class="hist-reason">原因 ${esc(from)}${esc(toReason || '（無）')}</span>`;
    dur = lasted;
  } else if (kind === 'data') {
    change = `<span class="tag">資料更新</span>${chip(deptId, e.toStatus)}${reasonSpan(toReason)}`;
    lines = older ? diffLines(older.data, e) : valueLines(e);
  } else {
    change = `${chip(deptId, e.toStatus)}${reasonSpan(toReason)}<span class="tag">更新</span>`;
  }

  // 時間：夜班過了午夜（日曆日期和生產日不同），在時間上面多標日期
  const t = twParts(ms(e.createdAt));
  const calendarDate = `${t.year}-${t.month}-${t.day}`;
  const dateTag = e.prodDate && calendarDate !== e.prodDate
    ? `<span class="hist-cal">${Number(t.month)}/${Number(t.day)}</span>` : '';

  return '<li class="hist-row">'
    + `<div class="hist-when">${dateTag}<span class="hist-time">${t.hour}:${t.minute}</span>`
    + `<span class="hist-shift">${esc(shiftName(e.shiftId))}</span></div>`
    + '<div class="hist-what">'
    + `<div class="hist-change">${change}</div>`
    + (dur ? `<div class="hist-dur">${esc(dur)}</div>` : '')
    + lines.map((line) => `<div class="hist-meta">${esc(line)}</div>`).join('')
    + `<div class="hist-who">${esc(e.createdByName || '')}（${esc(e.createdByEmpNo || '')}）`
    + `${item.pending ? '<span class="tag tag-off">同步中</span>' : ''}</div>`
    + '</div></li>';
}

// 讀取失敗的說明
function errorHtml(err) {
  if (err?.code === 'failed-precondition') {
    // 缺索引時，Firebase 的錯誤訊息裡會附上建立索引的網址，管理者可以直接點
    const url = (String(err.message || '').match(/https:\/\/console\.firebase\.google\.com\/\S+/) || [''])[0];
    const admin = deps.isAdmin();
    return '<div class="hist-error"><p>資料庫還缺異動履歷用的索引；剛建立的話，要等幾分鐘才能用。'
      + (admin ? '' : '請通知管理者。') + '</p>'
      + (admin && url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">打開 Firebase 建立索引</a>` : '')
      + '</div>';
  }
  return `<div class="hist-error"><p>${esc(deps.errorMessage(err))}</p></div>`;
}

// 清單：依生產日分組，最新的在最上面
function render() {
  if (!isOpen()) return;
  if (!deps.machineOf(state.machineId)) return;
  const list = sortedList();
  const status = state.mode === 'latest' ? deps.getStatus(state.machineId)?.data : null;

  // 跳到日期時，說明現在看的是哪一天以前
  $('h-latest').hidden = state.mode !== 'date';
  $('h-mode').hidden = state.mode !== 'date';
  if (state.mode === 'date') {
    $('h-mode').textContent = `目前顯示：${dayLabel(state.dateValue)}生產日和更早的紀錄`;
  }

  let html = state.error ? errorHtml(state.error) : '';
  let day = null;
  list.forEach((item, i) => {
    const prodDate = item.data.prodDate || '';
    if (prodDate !== day) {
      if (day !== null) html += '</ol></section>';
      day = prodDate;
      html += '<section class="hist-day">'
        + `<h3 class="hist-day-title">${prodDate ? `生產日 ${esc(dayLabel(prodDate))}` : '生產日不明'}</h3>`
        + '<ol class="hist-rows">';
    }
    html += rowHtml(item, i, list, status);
  });
  if (day !== null) html += '</ol></section>';

  if (!list.length && state.loading) {
    html += '<p class="hist-empty">讀取中…</p>';
  } else if (!list.length && state.confirmed && !state.error) {
    html += `<p class="hist-empty">${state.mode === 'date' ? '這天以前沒有紀錄。' : '這台還沒有異動紀錄。'}</p>`;
  } else if (list.length && !state.confirmed && !state.error) {
    html += '<p class="muted hist-end">連線中，還在跟資料庫確認…</p>';
  }
  $('h-list').innerHTML = html;

  // 下方：載入更早／到底了
  $('h-more').hidden = !(state.confirmed && state.hasMore);
  $('h-more').disabled = state.loading;
  $('h-more').textContent = state.loading && list.length ? '讀取中…' : `載入更早的 ${deps.pageSize} 筆`;
  $('h-end').hidden = !(state.confirmed && !state.hasMore && list.length > 0);
}
