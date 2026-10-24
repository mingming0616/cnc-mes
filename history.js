// ============================================================
// history.js — 單台機異動履歷（功能④）＋修正紀錄（功能⑤）
//   打開方式：看板點卡片 → 面板「異動履歷」；蓋在看板上面，按「關閉」回到看板
//   讀：machineEvents（這台機的事件紀錄），新到舊，一次 pageSize 筆（平常 30 筆）
//     ‧最新一批用即時監聽：這台機有新異動，自動加到最上面（每筆新異動只多讀 1 次）
//     ‧「載入更早」「跳到日期」用一次性讀取，每按一次讀 pageSize 筆
//     ‧跳到日期時，另外查「這批紀錄有沒有被修正」（每 30 筆多查 1 次）
//   修正紀錄（功能⑤）：履歷上那筆按「修正」→ 改原因、料號、製程、備註 → 確認 → 寫入
//     ‧原本那筆完全不動，另外新增一筆 eventType: 'correction' 的事件紀錄
//     ‧料號、製程、備註：從這筆開始，往後一路改到這個值下次被換掉為止
//       原因：只改到下次換狀態或換原因為止
//     ‧修正範圍包含目前狀態時，同一次寫入也更新 machineStatus（看板跟著變）
//     ‧誰能改：管理者全部單位、不限時間；維護員負責單位、當班內；檢視只能看
//     ‧存檔前一定跟資料庫確認最新內容，所以修正要有網路
//   需要的索引（在 Firebase 主控台建立）：
//     ‧machineEvents ＝ machineId 升序 ＋ createdAt 降序（異動履歷，功能④）
//     ‧machineEvents ＝ machineId 升序 ＋ createdAt 升序（修正時往後找連帶的紀錄，功能⑤）
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
  docs: new Map(),         // 事件編號 → { id, data, pending, snap }（狀態變更和修正紀錄都在這裡）
  extra: new Map(),        // 跳到日期時另外查到的修正紀錄（功能⑤），格式同上
  confirmed: false,        // 已經跟資料庫確認過（不是只有這台裝置上的暫存）
  hasMore: false,          // 還有沒有更早的紀錄
  loading: false,
  error: null,             // 讀取失敗時的錯誤
  unsub: null,             // 停止即時監聽的函式
  gen: 0,                  // 換機台、換模式就加 1；舊的讀取結果晚回來時直接丟掉
  statusKey: ''            // 上次畫的「目前狀態」，沒變就不用重畫
};

// 修正畫面的狀態（功能⑤）
const fix = {
  item: null,              // 要修正的那筆（原本的內容）{ id, data }
  base: null,              // 打開畫面時這筆的內容（已套用之前的修正）{ reasonCode, partNo, opNo, note }
  reason: '',              // 畫面上選的原因
  whyOff: new Set(),       // 自動選好、但被使用者取消的理由
  other: false,            // 理由有沒有選「其他」
  mode: 'edit',            // edit＝修改中；confirm＝確認畫面
  plan: null,              // 按「存檔」後跟資料庫確認過的修正範圍
  busy: false              // 確認中、儲存中
};

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const TW_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

// ---------- 修正紀錄的設定（功能⑤） ----------
const FIX_FIELDS = ['reasonCode', 'partNo', 'opNo', 'note'];   // 能修正的欄位
const FIX_FIELD_NAME = { reasonCode: '原因', partNo: '料號', opNo: '製程', note: '備註' };
const FIX_WHY = { reasonCode: '原因選錯', partNo: '料號打錯', opNo: '製程打錯', note: '備註打錯' };
const FIX_MAX_RECORDS = 50;   // 一次修正最多連帶幾筆（firestore.rules 也寫 50，兩邊要一樣）
const SCAN_PAGE = 50;         // 存檔前往後找連帶的紀錄，一次讀幾筆
const SCAN_MAX_DOCS = 300;    // 往後找最多讀幾筆就停
const SLOW_MS = 6000;         // 網路慢：6 秒沒回應先關畫面（跟看板切狀態一樣）
const SHIFT_MS = 12 * 60 * 60 * 1000;

const ms = (ts) => (ts && typeof ts.toMillis === 'function' ? ts.toMillis() : 0);
const esc = (value) => deps.escapeHtml(value);
const isOpen = () => Boolean(deps) && $('dlg-history').open;
const isFix = (data) => data?.eventType === 'correction';   // 修正紀錄；其他都是狀態變更
const pick4 = (data) => ({
  reasonCode: data?.reasonCode || '', partNo: data?.partNo || '', opNo: data?.opNo || '', note: data?.note || ''
});
const changedFields = (before, after) => FIX_FIELDS.filter((key) => (before[key] || '') !== (after[key] || ''));
const byCreatedAsc = (a, b) => ms(a.data.createdAt) - ms(b.data.createdAt) || (a.id < b.id ? -1 : 1);

// 「當班」：台灣 08:00、20:00 換班＝世界標準時間 00:00、12:00，剛好每 12 小時一班，
//   兩個時間除以 12 小時的商一樣＝同一班（firestore.rules 的 sameShift() 用同樣的算法）。
//   班別時間如果改了，這裡和 firestore.rules 都要跟著改。
const shiftBlock = (msValue) => Math.floor(msValue / SHIFT_MS);

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
  // 功能⑤：清單上的「修正」按鈕
  $('h-list').addEventListener('click', (event) => {
    const button = event.target.closest('.hist-fix');
    if (button) openFix(button.dataset.fix);
  });
  setupFix();
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
  state.extra.clear();
  state.confirmed = false;
  state.hasMore = false;
  state.loading = false;
  state.error = null;
}

// 存一筆事件到清單（serverTimestamps: 'estimate'：剛寫入、還沒同步的時間先用估計值）
function entryOf(d) {
  return {
    id: d.id,
    data: d.data({ serverTimestamps: 'estimate' }),
    pending: d.metadata.hasPendingWrites,
    snap: d
  };
}
function keep(d) {
  state.docs.set(d.id, entryOf(d));
}
// 跳到日期時另外查到的修正紀錄（功能⑤）
function keepExtra(d) {
  state.extra.set(d.id, entryOf(d));
}

// 一批讀回來的紀錄裡，狀態變更的編號（拿來查有沒有被修正）
const statusIdsOf = (docs) => docs.filter((d) => !isFix(d.data())).map((d) => d.id);

// 查「這幾筆紀錄有沒有被修正」（功能⑤）
//   修正紀錄的 eventIds 列出它改到的每一筆，用 array-contains-any 查，一次最多 30 筆
//   fromServer = true：一定跟資料庫要（存檔前確認用）
async function fetchFixesFor(ids, fromServer = false) {
  const out = [];
  for (let i = 0; i < ids.length; i += 30) {
    const q = deps.query(eventsRef(), deps.where('eventIds', 'array-contains-any', ids.slice(i, i + 30)));
    const snap = fromServer ? await deps.getDocsFromServer(q) : await deps.getDocs(q);
    if (snap.metadata.fromCache) throw { code: 'unavailable' };   // 沒連到資料庫，結果可能不完整
    out.push(...snap.docs);
  }
  return out;
}

// 最新模式：即時監聽最新 pageSize 筆
//   （修正紀錄一定比它改的那筆新，從最新往回讀，畫面上每筆的修正都已經讀到了，不用另外查）
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
    // 功能⑤：這批紀錄的修正可能比這天還新，不在清單裡，要另外查
    const fixDocs = await fetchFixesFor(statusIdsOf(snap.docs));
    if (gen !== state.gen) return;
    snap.docs.forEach(keep);
    fixDocs.forEach(keepExtra);
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
    // 功能⑤：跳到日期時，這批的修正可能比畫面上的都新，要另外查（最新模式已經讀到了）
    const fixDocs = state.mode === 'date' ? await fetchFixesFor(statusIdsOf(snap.docs)) : [];
    if (gen !== state.gen) return;
    snap.docs.forEach(keep);
    fixDocs.forEach(keepExtra);
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

// 新到舊排序（狀態變更和修正紀錄都在內）
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

// 毫秒 → 「10/24 09:10」（台灣時間）
function timeText(msValue) {
  if (!msValue) return '—';
  const t = twParts(msValue);
  return `${Number(t.month)}/${Number(t.day)} ${t.hour}:${t.minute}`;
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

// 修正前後的值給人看：原因顯示名稱，其他空白顯示「（空白）」
function fieldText(key, value, deptId, status) {
  if (key === 'reasonCode') return reasonName(deptId, status, value) || '（無）';
  return value || '（空白）';
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
// 修正紀錄怎麼套用到每一筆（功能⑤）
// ============================================================

// 畫面上讀到的修正紀錄（最新模式在 state.docs；跳到日期另外查的在 state.extra），舊到新
function fixList() {
  const map = new Map();
  for (const item of state.docs.values()) if (isFix(item.data)) map.set(item.id, item);
  for (const item of state.extra.values()) if (!map.has(item.id)) map.set(item.id, item);
  return [...map.values()].sort(byCreatedAsc);
}

// 一筆狀態變更套用修正後的內容
//   修正紀錄的 changes.欄位.eventIds 有列到這筆，就用修正後的值；後面的修正蓋過前面的
//   保險：別台機的、或比修正起點還早的紀錄不套用（避免被亂寫的資料影響）
//   回傳 { data: 修正後的內容, fixes: 套用到這筆的修正紀錄（舊到新） }
function applyFixes(item, fixes) {
  const data = { ...item.data };
  const used = [];
  for (const f of fixes) {
    const c = f.data;
    if (c.machineId !== data.machineId) continue;
    if (ms(data.createdAt) < ms(c.correctsEventAt)) continue;
    let hit = false;
    FIX_FIELDS.forEach((key) => {
      const change = c.changes?.[key];
      if (change && Array.isArray(change.eventIds) && change.eventIds.includes(item.id)) {
        data[key] = String(change.to ?? '');
        hit = true;
      }
    });
    if (hit) used.push(f);
  }
  return { data, fixes: used };
}

// 清單上的狀態變更（新到舊），每筆都套用過修正：{ item: 原本的, data: 修正後的內容, fixes }
function rowList() {
  const fixes = fixList();
  return sortedList()
    .filter((item) => !isFix(item.data))
    .map((item) => ({ item, ...applyFixes(item, fixes) }));
}

// 目前狀態是根據哪一筆狀態變更（lastEventId 指到修正紀錄時，看它記的 baseEventId）
function baseIdOf(status) {
  const id = status?.lastEventId || '';
  const last = state.docs.get(id) || state.extra.get(id);
  return last && isFix(last.data) ? (last.data.baseEventId || '') : id;
}

// 這筆能不能修正：管理者全部；維護員負責單位、當班內；檢視不行；還在同步的不行
function canFix(row) {
  if (row.item.pending) return false;
  const me = deps.getMe();
  const machine = deps.machineOf(state.machineId);
  if (!me || !machine || !deps.canEdit(machine)) return false;
  if (me.role === 'admin') return true;
  return shiftBlock(ms(row.item.data.createdAt)) === shiftBlock(Date.now());
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

// 「已修正」：點開看原本內容、誰、何時、理由（功能⑤）
function fixedHtml(row, deptId) {
  const status = row.data.toStatus;
  const blocks = row.fixes.map((f) => {
    const c = f.data;
    const changes = FIX_FIELDS
      .filter((key) => c.changes?.[key]?.eventIds?.includes(row.item.id))
      .map((key) => `<div>${FIX_FIELD_NAME[key]}：${esc(fieldText(key, c.changes[key].from, deptId, status))}`
        + ` → ${esc(fieldText(key, c.changes[key].to, deptId, status))}</div>`)
      .join('');
    const total = Array.isArray(c.eventIds) ? c.eventIds.length : 1;
    let scope = '';
    if (c.correctsEventId !== row.item.id) scope = `從 ${timeText(ms(c.correctsEventAt))} 那筆開始，一起修正 ${total} 筆`;
    else if (total > 1) scope = `這筆和後面 ${total - 1} 筆一起修正`;
    return '<div class="hist-fix-item">'
      + `<div class="hist-fix-who">${esc(timeText(ms(c.createdAt)))} ${esc(c.createdByName || '')}（${esc(c.createdByEmpNo || '')}）修正</div>`
      + changes
      + `<div>理由：${esc(c.correctionReason || '')}</div>`
      + (scope ? `<div class="hist-fix-scope">${esc(scope)}</div>` : '')
      + '</div>';
  });
  const times = row.fixes.length > 1 ? `（${row.fixes.length} 次）` : '';
  // 修正還沒送到資料庫：收起來的時候也要看得到「同步中」
  const syncing = row.fixes.some((f) => f.pending) ? '<span class="tag tag-off">同步中</span>' : '';
  return `<details class="hist-fixed" data-row="${esc(row.item.id)}"><summary>`
    + `<span class="tag hist-fixed-tag">已修正${times}</span>${syncing}`
    + '<span class="hist-fixed-open">點開看原本內容</span><span class="hist-fixed-close">收起</span>'
    + `</summary>${blocks.join('')}</details>`;
}

// 一筆異動（row.data 是套用過修正的內容）
function rowHtml(row, i, rows, status) {
  const { item } = row;
  const e = row.data;
  const older = rows[i + 1] || null;   // 緊接著的前一筆（更早）
  const newer = rows[i - 1] || null;   // 緊接著的後一筆（更晚）
  const deptId = e.deptId || machineDept();
  // 這筆存完之後的「狀態開始時間」：記在後一筆的 fromStatusSince；最新一筆看目前狀態
  const nextSince = newer
    ? newer.data.fromStatusSince
    : (status && baseIdOf(status) === item.id ? status.statusSince : null);
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

  // 功能⑤：有權限才看得到「修正」
  const fixButton = canFix(row)
    ? `<button type="button" class="btn hist-fix" data-fix="${esc(item.id)}">修正</button>` : '';

  return '<li class="hist-row">'
    + `<div class="hist-when">${dateTag}<span class="hist-time">${t.hour}:${t.minute}</span>`
    + `<span class="hist-shift">${esc(shiftName(e.shiftId))}</span></div>`
    + '<div class="hist-what">'
    + `<div class="hist-change">${change}</div>`
    + (dur ? `<div class="hist-dur">${esc(dur)}</div>` : '')
    + lines.map((line) => `<div class="hist-meta">${esc(line)}</div>`).join('')
    + (row.fixes.length ? fixedHtml(row, deptId) : '')
    + `<div class="hist-who"><span>${esc(e.createdByName || '')}（${esc(e.createdByEmpNo || '')}）`
    + `${item.pending ? '<span class="tag tag-off">同步中</span>' : ''}</span>${fixButton}</div>`
    + '</div></li>';
}

// Firebase 缺索引時，錯誤訊息裡會附上建立索引的網址
function indexUrlOf(err) {
  return (String(err?.message || '').match(/https:\/\/console\.firebase\.google\.com\/\S+/) || [''])[0];
}

// 讀取失敗的說明
function errorHtml(err) {
  if (err?.code === 'failed-precondition') {
    const url = indexUrlOf(err);
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
  const rows = rowList();
  const status = state.mode === 'latest' ? deps.getStatus(state.machineId)?.data : null;

  // 跳到日期時，說明現在看的是哪一天以前
  $('h-latest').hidden = state.mode !== 'date';
  $('h-mode').hidden = state.mode !== 'date';
  if (state.mode === 'date') {
    $('h-mode').textContent = `目前顯示：${dayLabel(state.dateValue)}生產日和更早的紀錄`;
  }

  let html = state.error ? errorHtml(state.error) : '';
  let day = null;
  rows.forEach((row, i) => {
    const prodDate = row.data.prodDate || '';
    if (prodDate !== day) {
      if (day !== null) html += '</ol></section>';
      day = prodDate;
      html += '<section class="hist-day">'
        + `<h3 class="hist-day-title">${prodDate ? `生產日 ${esc(dayLabel(prodDate))}` : '生產日不明'}</h3>`
        + '<ol class="hist-rows">';
    }
    html += rowHtml(row, i, rows, status);
  });
  if (day !== null) html += '</ol></section>';

  if (!rows.length && state.loading) {
    html += '<p class="hist-empty">讀取中…</p>';
  } else if (!rows.length && state.confirmed && !state.error) {
    html += `<p class="hist-empty">${state.mode === 'date' ? '這天以前沒有紀錄。' : '這台還沒有異動紀錄。'}</p>`;
  } else if (rows.length && !state.confirmed && !state.error) {
    html += '<p class="muted hist-end">連線中，還在跟資料庫確認…</p>';
  }
  // 「已修正」點開的那幾筆，重畫後保持打開（即時更新時才不會自己收起來）
  const openIds = new Set([...$('h-list').querySelectorAll('details.hist-fixed[open]')].map((el) => el.dataset.row));
  $('h-list').innerHTML = html;
  $('h-list').querySelectorAll('details.hist-fixed').forEach((el) => {
    if (openIds.has(el.dataset.row)) el.open = true;
  });

  // 下方：載入更早／到底了
  $('h-more').hidden = !(state.confirmed && state.hasMore);
  $('h-more').disabled = state.loading;
  $('h-more').textContent = state.loading && rows.length ? '讀取中…' : `載入更早的 ${deps.pageSize} 筆`;
  $('h-end').hidden = !(state.confirmed && !state.hasMore && rows.length > 0);
}

// ============================================================
// 修正紀錄畫面（功能⑤）
// ============================================================

// 綁定修正畫面的按鈕（setupHistory 呼叫一次）
function setupFix() {
  // 原因：選填的再點一次可以取消；必選的只能換別的
  $('fx-reasons').addEventListener('click', (event) => {
    const button = event.target.closest('.rs-btn');
    if (!button || fix.mode !== 'edit' || fix.busy) return;
    const need = fixNeed();
    fix.reason = (fix.reason === button.dataset.code && need !== 'required') ? '' : button.dataset.code;
    renderFixReasons();
    renderWhy();
    $('fx-error').textContent = '';
  });
  ['fx-part', 'fx-op', 'fx-note'].forEach((id) => {
    $(id).addEventListener('input', () => {
      renderWhy();
      $('fx-error').textContent = '';
    });
  });
  $('fx-detail').addEventListener('input', () => { $('fx-error').textContent = ''; });
  // 理由：點一下取消／選回來；「其他」要寫說明
  $('fx-why').addEventListener('click', (event) => {
    const button = event.target.closest('.rs-btn');
    if (!button || fix.mode !== 'edit' || fix.busy) return;
    const key = button.dataset.why;
    if (key === 'other') fix.other = !fix.other;
    else if (fix.whyOff.has(key)) fix.whyOff.delete(key);
    else fix.whyOff.add(key);
    renderWhy();
    $('fx-error').textContent = '';
  });
  // 取消：確認畫面時回到修改；修改畫面時關掉
  $('fx-cancel').addEventListener('click', () => {
    if (fix.busy) return;
    if (fix.mode === 'confirm') showFixMode('edit');
    else $('dlg-fix').close();
  });
  $('dlg-fix').addEventListener('cancel', (event) => {
    if (fix.busy) event.preventDefault();   // 確認中、儲存中不能用 Esc 關掉
  });
  $('dlg-fix').addEventListener('close', () => {
    fix.item = null;
    fix.plan = null;
  });
  $('fix-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (fix.busy || !fix.item) return;
    if (fix.mode === 'confirm') saveFix();
    else checkFix();
  });
}

// 修正的這筆是哪個單位（狀態、原因清單用）
function fixDept() {
  return fix.item?.data?.deptId || machineDept();
}
// 這筆的狀態要不要選原因：required 必選／optional 選填／none 不用
function fixNeed() {
  return defFor(fixDept(), fix.item?.data?.toStatus)?.needsReason || 'none';
}

// 打開修正畫面
function openFix(eventId) {
  const row = rowList().find((r) => r.item.id === eventId);
  if (!row || !canFix(row)) return;
  if (deps.getStatus(state.machineId)?.pending) {
    deps.toast('這台還有資料在同步，請等幾秒再修正', 'error');
    return;
  }
  fix.item = { id: row.item.id, data: row.item.data };
  fix.base = pick4(row.data);
  fix.whyOff = new Set();
  fix.other = false;
  fix.plan = null;
  fix.busy = false;
  $('fx-target').innerHTML = targetHtml(row);
  $('fx-detail').value = '';
  fillFixInputs(fix.base);
  showFixMode('edit');
  setFixBusy(false);
  $('dlg-fix').showModal();
}

// 上方：要修正的是哪一筆
function targetHtml(row) {
  const e = row.data;
  const deptId = e.deptId || machineDept();
  const day = e.prodDate ? `生產日 ${dayLabel(e.prodDate)}` : '';
  const status = e.fromStatus != null && e.fromStatus !== e.toStatus
    ? `${chip(deptId, e.fromStatus)}<span class="hist-arrow" aria-label="改成">→</span>${chip(deptId, e.toStatus)}`
    : chip(deptId, e.toStatus);
  return `<div class="fx-when"><span class="fx-time">${esc(timeText(ms(e.createdAt)))}</span>`
    + `<span>${esc([day, shiftName(e.shiftId)].filter(Boolean).join(' '))}</span></div>`
    + `<div class="hist-change">${status}</div>`
    + `<div class="muted">${esc(e.createdByName || '')}（${esc(e.createdByEmpNo || '')}）記錄</div>`;
}

// 把內容填進輸入框（打開時、或這筆剛被別人修正時）
function fillFixInputs(values) {
  $('fx-part').value = values.partNo;
  $('fx-op').value = values.opNo;
  $('fx-note').value = values.note;
  fix.reason = values.reasonCode;
  renderFixReasons();
  renderWhy();
}

// 原因按鈕：用這筆當時的狀態；原本選的原因如果已經停用，也列出來
function renderFixReasons() {
  const e = fix.item.data;
  const deptId = fixDept();
  const need = fixNeed();
  let list = deps.activeReasons(deptId, e.toStatus);
  if (!list.length && deptId !== machineDept()) list = deps.activeReasons(machineDept(), e.toStatus);
  if (fix.base.reasonCode && !list.some((r) => r.code === fix.base.reasonCode)) {
    list = [...list, { code: fix.base.reasonCode, label: `${reasonName(deptId, e.toStatus, fix.base.reasonCode)}（已停用）` }];
  }
  const show = need !== 'none' && list.length > 0;
  $('fx-reason-box').hidden = !show;
  if (!show) {
    $('fx-reasons').innerHTML = '';
    return;
  }
  $('fx-reason-legend').textContent = need === 'required' ? '原因（必選）' : '原因（可不選）';
  $('fx-reasons').innerHTML = list.map((r) =>
    `<button type="button" class="rs-btn" data-code="${esc(r.code)}" aria-pressed="${fix.reason === r.code}">${esc(r.label)}</button>`
  ).join('');
}

// 畫面上的新內容
function fixValues() {
  return {
    reasonCode: $('fx-reason-box').hidden ? fix.base.reasonCode : fix.reason,
    partNo: $('fx-part').value.trim(),
    opNo: $('fx-op').value.trim(),
    note: $('fx-note').value.trim()
  };
}

// 理由：依改了哪些欄位自動選好（原因選錯、料號打錯…），可以取消；另有「其他」
function renderWhy() {
  const changed = changedFields(fix.base, fixValues());
  if (!changed.length) {
    $('fx-why').innerHTML = '<span class="muted">改了上面的欄位後，這裡會自動選好理由。</span>';
  } else {
    $('fx-why').innerHTML = changed.map((key) =>
      `<button type="button" class="rs-btn" data-why="${key}" aria-pressed="${!fix.whyOff.has(key)}">${FIX_WHY[key]}</button>`
    ).join('') + `<button type="button" class="rs-btn" data-why="other" aria-pressed="${fix.other}">其他</button>`;
  }
  $('fx-detail-label').textContent = fix.other && changed.length ? '說明（選「其他」一定要寫）' : '補充說明（可不填）';
}

// 理由文字，例：「料號打錯」「原因選錯、其他：現場回報是待刀具」
function whyOf(changed) {
  const labels = changed.filter((key) => !fix.whyOff.has(key)).map((key) => FIX_WHY[key]);
  if (fix.other) labels.push('其他');
  const detail = $('fx-detail').value.trim();
  return { labels, detail, text: labels.join('、') + (detail ? `：${detail}` : '') };
}

// 修改畫面／確認畫面切換
function showFixMode(mode) {
  fix.mode = mode;
  $('fx-edit').hidden = mode !== 'edit';
  $('fx-confirm').hidden = mode !== 'confirm';
  $('fx-cancel').textContent = mode === 'confirm' ? '返回修改' : '取消';
  $('fx-save').textContent = mode === 'confirm' ? '確定修正' : '存檔';
  $('fx-error').textContent = '';
  $('fx-index').hidden = true;
}

// 確認中、儲存中：鎖住按鈕
function setFixBusy(busy, text = '') {
  fix.busy = busy;
  $('fx-save').disabled = busy;
  $('fx-cancel').disabled = busy;
  $('fx-save').textContent = busy ? text : (fix.mode === 'confirm' ? '確定修正' : '存檔');
}

// 「存檔」：檢查畫面 → 跟資料庫確認範圍 → 顯示確認畫面
async function checkFix() {
  const values = fixValues();
  const changed = changedFields(fix.base, values);
  const fail = (message) => { $('fx-error').textContent = message; };
  if (!changed.length) return fail('沒有改任何內容');
  if (!$('fx-reason-box').hidden && fixNeed() === 'required' && !values.reasonCode) return fail('這個狀態要選原因');
  const why = whyOf(changed);
  if (!why.labels.length) return fail('請點選修正理由');
  if (fix.other && why.detail.length < 2) return fail('選「其他」要寫說明（至少 2 個字）');
  if (!deps.getShiftSetting()) return fail('找不到班別設定，請管理者回首頁按「建立預設資料」');
  fail('');
  $('fx-index').hidden = true;
  const item = fix.item;
  setFixBusy(true, '確認中…');
  try {
    const plan = await planFix(item, values);
    if (fix.item !== item) return;           // 等待中畫面被關掉了
    plan.why = why.text;
    fix.plan = plan;
    renderConfirm(plan);
    showFixMode('confirm');
    setFixBusy(false);
  } catch (err) {
    if (fix.item !== item) return;
    setFixBusy(false);
    showPlanError(err);
  }
}

// 存檔前跟資料庫確認（一定讀資料庫最新的，連不上就停）：
//   讀目前狀態、這筆之後的紀錄和修正，算出每個欄位要連帶改到哪一筆
async function planFix(item, values) {
  const machineId = state.machineId;
  const tAt = item.data.createdAt;

  // 1. 目前狀態
  const statusSnap = await deps.getDocFromServer(deps.doc(deps.db, 'machineStatus', machineId));
  if (!statusSnap.exists()) throw { planKind: 'stale' };
  const st = statusSnap.data();

  // 2. 往後找：這筆之後的紀錄，舊到新（要 machineId 升序＋createdAt 升序的索引）
  const after = [];          // 之後的狀態變更
  const found = new Map();   // 之後的修正紀錄
  let reachedEnd = false;    // 有沒有讀到最新一筆
  let cursor = null;
  let read = 0;
  for (;;) {
    const parts = [
      eventsRef(),
      deps.where('machineId', '==', machineId),
      deps.where('createdAt', '>', tAt),
      deps.orderBy('createdAt', 'asc')
    ];
    if (cursor) parts.push(deps.startAfter(cursor));
    parts.push(deps.limit(SCAN_PAGE));
    const snap = await deps.getDocsFromServer(deps.query(...parts));
    snap.docs.forEach((d) => {
      const x = { id: d.id, data: d.data() };
      if (isFix(x.data)) found.set(x.id, x);
      else after.push(x);
    });
    read += snap.size;
    if (snap.size < SCAN_PAGE) {
      reachedEnd = true;
      break;
    }
    if (after.length >= FIX_MAX_RECORDS || read >= SCAN_MAX_DOCS) break;   // 已經夠判斷了
    cursor = snap.docs[snap.docs.length - 1];
  }

  // 3. 修正紀錄：讀到最新的話，之後的修正都在裡面；沒讀到底，另外查這幾筆有沒有被修正
  if (!reachedEnd) {
    (await fetchFixesFor([item.id, ...after.map((x) => x.id)], true))
      .forEach((d) => found.set(d.id, { id: d.id, data: d.data() }));
  }
  const fixes = [...found.values()].sort(byCreatedAsc);
  const effective = (x) => applyFixes(x, fixes).data;

  // 4. 目前狀態是根據哪一筆狀態變更；讀到最新時要對得上（有人剛切換狀態就停）
  let base = st.lastEventId || '';
  if (!base) throw { planKind: 'stale' };
  if (found.has(base)) {
    base = found.get(base).data.baseEventId || '';
  } else if (base !== item.id && !after.some((x) => x.id === base)) {
    const lastSnap = await deps.getDocFromServer(deps.doc(deps.db, 'machineEvents', base));
    if (lastSnap.exists() && isFix(lastSnap.data())) base = lastSnap.data().baseEventId || '';
  }
  if (reachedEnd && base !== (after.length ? after[after.length - 1].id : item.id)) {
    throw { planKind: 'stale' };
  }

  // 5. 這筆現在的內容（套用過之前的修正）要跟打開畫面時一樣，不然是剛被別人修正過
  const before = pick4(effective(item));
  if (changedFields(before, fix.base).length) throw { planKind: 'changed', extra: before };
  const changed = changedFields(before, values);
  if (!changed.length) throw { planKind: 'nochange' };

  // 6. 每個欄位往後連帶改到哪裡
  //   料號、製程、備註：一路改到這個值下次被換掉為止
  //   原因：只改到下次換狀態或換原因為止（換了狀態，原因本來就會重選）
  const seq = [item, ...after];
  const ranges = {};
  for (const key of changed) {
    const ids = [item.id];
    let i = 1;
    for (; i < seq.length; i += 1) {
      const e = seq[i].data;
      if (key === 'reasonCode' && (e.fromStatus !== e.toStatus || e.toStatus !== item.data.toStatus)) break;
      if ((effective(seq[i])[key] || '') !== before[key]) break;
      ids.push(seq[i].id);
    }
    // 超過上限，或讀到的都還在範圍裡、後面還有沒讀的 → 一次改不完
    if (ids.length > FIX_MAX_RECORDS || (i >= seq.length && !reachedEnd)) {
      throw { planKind: 'toomany', extra: seq[FIX_MAX_RECORDS] || null };
    }
    ranges[key] = ids;
  }

  // 7. 修正範圍包含目前狀態根據的那筆 → 看板（machineStatus）一起改
  const boardKeys = reachedEnd ? changed.filter((key) => ranges[key].includes(base)) : [];
  return { item, before, values, changed, ranges, seq, base, st, boardKeys };
}

// 確認畫面：改前 → 改後、連帶幾筆、看板會不會跟著變
function renderConfirm(plan) {
  const deptId = plan.item.data.deptId || machineDept();
  const status = plan.item.data.toStatus;
  const rows = plan.changed.map((key) => {
    const ids = plan.ranges[key];
    const scope = ids.length === 1 ? '只改這一筆' : `連帶 ${ids.length} 筆（${rangeText(plan.seq, ids.length)}）`;
    return `<li><span class="fx-field">${FIX_FIELD_NAME[key]}</span>`
      + `<span>${esc(fieldText(key, plan.before[key], deptId, status))} → <b>${esc(fieldText(key, plan.values[key], deptId, status))}</b></span>`
      + `<span class="fx-scope">${esc(scope)}</span></li>`;
  }).join('');
  const board = plan.boardKeys.length
    ? `<p class="fx-board">看板目前的${plan.boardKeys.map((key) => FIX_FIELD_NAME[key]).join('、')}也會一起改。</p>` : '';
  $('fx-confirm').innerHTML = `<p class="fx-lead">從 ${esc(timeText(ms(plan.item.data.createdAt)))} 那筆開始修正：</p>`
    + `<ul class="fx-changes">${rows}</ul>${board}`
    + `<p>理由：${esc(plan.why)}</p>`;
}

// 連帶範圍的時間：「10/24 09:10～11:45」（不同天就兩邊都寫日期）
function rangeText(seq, count) {
  const first = ms(seq[0].data.createdAt);
  const last = ms(seq[count - 1].data.createdAt);
  const a = twParts(first);
  const b = twParts(last);
  const sameDay = a.year === b.year && a.month === b.month && a.day === b.day;
  return `${timeText(first)}～${sameDay ? `${b.hour}:${b.minute}` : timeText(last)}`;
}

// 跟資料庫確認時出問題的說明
function showPlanError(err) {
  const fail = (message) => { $('fx-error').textContent = message; };
  if (err?.planKind === 'stale') {
    return fail('這台機剛剛有人切換狀態或修正，請關掉履歷重新打開，再修正一次。');
  }
  if (err?.planKind === 'changed') {
    fix.base = err.extra;
    fillFixInputs(fix.base);
    return fail('這筆剛剛被別人修正過，已換成最新內容，請重新確認。');
  }
  if (err?.planKind === 'nochange') return fail('沒有改任何內容');
  if (err?.planKind === 'toomany') {
    return fail(`這次會連帶超過 ${FIX_MAX_RECORDS} 筆紀錄，一次改不完。`
      + (err.extra ? `請先修正 ${timeText(ms(err.extra.data.createdAt))} 那筆，再回來修正這筆。` : ''));
  }
  if (err?.code === 'failed-precondition') {
    // 缺「machineId 升序＋createdAt 升序」索引：管理者直接點連結建立
    const url = indexUrlOf(err);
    const admin = deps.isAdmin();
    $('fx-index').innerHTML = '<p>資料庫還缺修正用的索引；剛建立的話，要等幾分鐘才能用。'
      + (admin ? '' : '請通知管理者。') + '</p>'
      + (admin && url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">打開 Firebase 建立索引</a>` : '');
    $('fx-index').hidden = false;
    return;
  }
  if (err?.code === 'unavailable' || err?.code === 'deadline-exceeded') {
    return fail('連不上資料庫，請確認網路後再試（修正一定要有網路）。');
  }
  return fail(deps.errorMessage(err));
}

// 「確定修正」：新增一筆修正紀錄；範圍包含目前狀態時，同一次寫入也更新 machineStatus
async function saveFix() {
  const plan = fix.plan;
  const machine = deps.machineOf(state.machineId);
  const me = deps.getMe();
  const fail = (message) => { $('fx-error').textContent = message; };
  if (!plan || !machine || !me) return;
  const shiftSetting = deps.getShiftSetting();
  if (!shiftSetting) return fail('找不到班別設定，請管理者回首頁按「建立預設資料」');
  const { prodDate, shiftId } = deps.prodDateAndShift(new Date(), shiftSetting);
  if (!shiftId) return fail('現在的時間不在任何班別裡，請檢查班別設定');

  const empNo = deps.myEmpNo();
  const changes = {};
  plan.changed.forEach((key) => {
    changes[key] = { from: plan.before[key], to: plan.values[key], eventIds: plan.ranges[key] };
  });
  // 每個欄位的範圍都從這筆開始往後，最長的那個就是全部受影響的紀錄
  const eventIds = plan.changed.map((key) => plan.ranges[key]).reduce((a, b) => (b.length > a.length ? b : a));
  const batch = deps.writeBatch(deps.db);   // 修正紀錄和目前狀態一起寫，不會只寫一半
  const fixRef = deps.doc(deps.collection(deps.db, 'machineEvents'));
  batch.set(fixRef, {
    eventType: 'correction',
    machineId: machine.machineId,
    deptId: machine.deptId,
    correctsEventId: plan.item.id,                 // 從哪一筆開始修正
    correctsEventAt: plan.item.data.createdAt,     // 那一筆的時間（規則會檢查）
    baseEventId: plan.base,                        // 修正當下，目前狀態根據的那筆（有人剛切換就存不進去）
    changes,                                       // 改了哪些欄位：改前、改後、連帶哪些紀錄
    eventIds,                                      // 這次修正影響的全部紀錄（查詢用）
    correctionReason: plan.why,
    prodDate, shiftId,                             // 修正當下的生產日、班別
    createdAt: deps.serverTimestamp(),
    createdByEmpNo: empNo,
    createdByName: me.name
  });
  if (plan.boardKeys.length) {
    const next = pick4(plan.st);
    plan.boardKeys.forEach((key) => { next[key] = plan.values[key]; });
    batch.set(deps.doc(deps.db, 'machineStatus', machine.machineId), {
      machineId: machine.machineId,
      deptId: machine.deptId,
      status: plan.st.status,                      // 狀態不變
      reasonCode: next.reasonCode, note: next.note, partNo: next.partNo, opNo: next.opNo,
      statusSince: plan.st.statusSince,            // 開始時間不變
      lastEventId: fixRef.id,                      // 指向這筆修正紀錄（規則會檢查）
      updatedAt: deps.serverTimestamp(),
      updatedByEmpNo: empNo,
      updatedByName: me.name
    });
  }

  const done = `${machine.machineId} 的紀錄已修正（共 ${eventIds.length} 筆）`;
  setFixBusy(true, '儲存中…');
  try {
    // 網路慢的時候：6 秒後先關畫面，資料會在連線恢復後自動送出
    const commit = batch.commit();
    const slow = new Promise((resolve) => { setTimeout(() => resolve('slow'), SLOW_MS); });
    const result = await Promise.race([commit.then(() => 'ok'), slow]);
    setFixBusy(false);
    $('dlg-fix').close();
    if (result === 'ok') {
      deps.toast(done);
      fixSaved(fixRef.id);
    } else {
      deps.toast('網路不穩：修正已先記在這台裝置，連線恢復後會自動送出（這個頁面先不要關）', 'error');
      commit
        .then(() => {
          deps.toast(done);
          fixSaved(fixRef.id);
        })
        .catch((err) => deps.toast(`修正沒有存進去：${saveErrorText(err)}`, 'error'));
    }
  } catch (err) {
    setFixBusy(false);
    fail(saveErrorText(err));
  }
}

function saveErrorText(err) {
  return err?.code === 'permission-denied'
    ? '存不進去：可能這台剛剛有人改過、已經換班，或你沒有權限。請關掉履歷重新打開再試。'
    : deps.errorMessage(err);
}

// 修正存好之後：最新模式靠即時監聽自動出現；跳到日期時沒有監聽，讀回來放進清單
async function fixSaved(fixId) {
  if (!isOpen() || state.mode !== 'date') return;
  const gen = state.gen;
  try {
    const snap = await deps.getDocFromServer(deps.doc(deps.db, 'machineEvents', fixId));
    if (gen !== state.gen || !snap.exists()) return;
    keepExtra(snap);
    render();
  } catch {
    // 讀不到就算了：重新查詢一次就會看到
  }
}
