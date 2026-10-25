// ============================================================
// status-panel.js — 切換狀態面板（功能③做在看板裡，功能⑥搬成共用檔）
//   看板（board.html）點卡片、機台頁（machine.html）點狀態，都是打開這個面板
//   流程：選狀態 → 選原因（需要的才問）→ 料號、製程、備註（先帶目前的）→ 按「確認」才存
//   寫入：一次寫「目前狀態 machineStatus」＋「事件紀錄 machineEvents」（安全規則會檢查兩筆對得上）
//   誰能切換：頁面傳進來的 canEdit() 決定（管理者全部單位、維護員負責單位；檢視只能看）
//   網路慢：6 秒沒回應先關面板，資料會在連線恢復後自動送出（頁面不能關）
//   注意：這個檔案不 import common.js。資料庫函式和頁面的資料都由頁面用
//         setupStatusPanel() 傳進來（跟 history.js 一樣），避免兩個檔案寫的版本號（?v=）
//         不同，讓 Firebase 被載入兩次而整頁出錯。
//   面板的畫面（HTML）也在這個檔案裡，頁面不用自己寫，改畫面只要改這裡。
// ============================================================

const $ = (id) => document.getElementById(id);
const SLOW_MS = 6000;   // 網路慢：6 秒沒回應先關面板

let deps = null;                          // 頁面傳進來的資料庫函式、資料和小工具
let current = null;                       // 面板正在看的設備編號
let picked = { status: '', reason: '' };  // 面板裡選的狀態、原因

// 面板的畫面：頁面裡沒有的話，setupStatusPanel() 會自動加到頁面最後面
const PANEL_HTML = `
<dialog id="dlg-machine">
  <form id="machine-form" class="dialog-body" novalidate>
    <h2 id="mp-title" class="mp-title"></h2>
    <p id="mp-sub" class="muted"></p>
    <p id="mp-current"></p>

    <div id="mp-edit">
      <fieldset class="field">
        <legend>狀態</legend>
        <div id="mp-statuses" class="status-grid"></div>
      </fieldset>
      <fieldset id="mp-reason-box" class="field" hidden>
        <legend id="mp-reason-legend">原因</legend>
        <div id="mp-reasons" class="reason-grid"></div>
      </fieldset>
      <div class="form-grid">
        <label class="field"><span>料號（可不填）</span><input id="mp-part" type="text" maxlength="40" spellcheck="false"></label>
        <label class="field"><span>製程（可不填）</span><input id="mp-op" type="text" maxlength="20" spellcheck="false" placeholder="例：OP10"></label>
      </div>
      <label class="field"><span>備註（可不填）</span><input id="mp-note" type="text" maxlength="100"></label>
    </div>

    <p id="mp-readonly" class="muted" hidden></p>
    <!-- 錯誤訊息和按鈕固定在面板最下面：手機上不用捲到底才按得到「確認」（功能⑥） -->
    <div class="mp-foot">
      <p id="mp-error" class="form-error" role="alert"></p>
      <div class="row-actions">
        <button id="mp-history" class="btn mp-history" type="button">異動履歷</button>
        <button id="mp-close" class="btn" type="button">關閉</button>
        <button id="mp-save" class="btn primary" type="submit">確認</button>
      </div>
    </div>
  </form>
</dialog>`;

// 這個狀態從什麼時候開始（毫秒）
const sinceMs = (machineId) => deps.getStatus(machineId)?.data?.statusSince?.toMillis?.() ?? Date.now();

// ============================================================
// 給頁面呼叫的函式
// ============================================================

// 頁面讀完主檔後呼叫一次：把要用的函式、資料傳進來，並綁定按鈕
//   d 需要：db, collection, doc, writeBatch, serverTimestamp,
//          myEmpNo, errorMessage, escapeHtml, toast, setBusy, formatTime, formatDuration, prodDateAndShift,
//          machineOf, floorName, statusList(單位) → 全部狀態, statusDef, activeReasons, reasonLabel, colorStyle,
//          getStatus(設備編號) → { data, pending }、getShiftSetting()、getMe()、canEdit(設備)、
//          openHistory(設備編號)：面板的「異動履歷」按鈕要打開什麼
export function setupStatusPanel(d) {
  deps = d;
  if (!$('dlg-machine')) document.body.insertAdjacentHTML('beforeend', PANEL_HTML);

  $('mp-statuses').addEventListener('click', (event) => {
    const button = event.target.closest('.st-btn');
    if (!button) return;
    const machine = deps.machineOf(current);
    if (picked.status !== button.dataset.code) {
      picked = { status: button.dataset.code, reason: '' };   // 換了狀態，原因重選
    }
    renderStatusButtons(machine);
    renderReasonButtons(machine);
    $('mp-error').textContent = '';
  });

  $('mp-reasons').addEventListener('click', (event) => {
    const button = event.target.closest('.rs-btn');
    if (!button) return;
    const machine = deps.machineOf(current);
    const need = deps.statusDef(machine.deptId, picked.status)?.needsReason;
    // 選填的原因再點一次可以取消；必選的只能換別的
    picked.reason = (picked.reason === button.dataset.code && need !== 'required') ? '' : button.dataset.code;
    renderReasonButtons(machine);
    $('mp-error').textContent = '';
  });

  $('mp-close').addEventListener('click', () => $('dlg-machine').close());
  $('dlg-machine').addEventListener('close', () => { current = null; });

  // 「異動履歷」：先關面板，再打開這台的履歷
  $('mp-history').addEventListener('click', () => {
    const machineId = current;            // 關面板時 current 會被清掉，先記下來
    $('dlg-machine').close();
    if (machineId) deps.openHistory(machineId);
  });

  $('machine-form').addEventListener('submit', save);
}

// 打開某台機的面板
//   status：機台頁點了哪個狀態按鈕，面板打開時先幫他選好（看板點卡片時不帶，預設選目前的狀態）
export function openStatusPanel(machineId, { status = '' } = {}) {
  if (!deps) return;
  const machine = deps.machineOf(machineId);
  if (!machine) return;
  current = machineId;
  const s = deps.getStatus(machineId)?.data;
  const editable = deps.canEdit(machine);
  const preset = status && deps.statusDef(machine.deptId, status) ? status : '';
  if (preset && preset !== s?.status) {
    picked = { status: preset, reason: '' };          // 選了別的狀態：原因重選
  } else {
    picked = { status: s?.status || preset, reason: s?.reasonCode || '' };
  }

  $('mp-title').textContent = machine.machineId;
  $('mp-sub').textContent = `${machine.category}，${machine.brand} ${machine.model}，${deps.floorName(machine.floorId)}`;
  renderCurrent(machine);

  $('mp-edit').hidden = !editable;
  $('mp-save').hidden = !editable;
  $('mp-readonly').hidden = editable;
  $('mp-readonly').textContent = deps.getMe()?.role === 'viewer' ? '檢視帳號只能查看。' : '你不負責這個單位，只能查看。';
  if (editable) {
    renderStatusButtons(machine);
    renderReasonButtons(machine);
    $('mp-part').value = s?.partNo || '';
    $('mp-op').value = s?.opNo || '';
    $('mp-note').value = s?.note || '';
  }
  $('mp-error').textContent = '';
  $('dlg-machine').showModal();
}

// 頁面收到新的機台狀態時呼叫：面板開著才更新「目前」那一行
export function refreshStatusPanel() {
  if (!deps || !current) return;
  renderCurrent(deps.machineOf(current));
}

// ============================================================
// 畫面
// ============================================================

function renderCurrent(machine) {
  if (!machine) return;
  const esc = deps.escapeHtml;
  const entry = deps.getStatus(machine.machineId);
  if (!entry) {
    $('mp-current').textContent = '目前：未設定';
    return;
  }
  const s = entry.data;
  const def = deps.statusDef(machine.deptId, s.status);
  const reason = deps.reasonLabel(machine.deptId, s.status, s.reasonCode);
  const since = sinceMs(machine.machineId);
  $('mp-current').innerHTML =
    `目前：<b>${esc(def?.label || s.status)}</b>${reason ? `（${esc(reason)}）` : ''}，`
    + `已經 <span class="js-dur" data-since="${since}">${deps.formatDuration(Date.now() - since)}</span><br>`
    + `<span class="muted">${esc(s.updatedByName || '')}（${esc(s.updatedByEmpNo || '')}）${esc(deps.formatTime(s.updatedAt))} 更新`
    + `${entry.pending ? '，同步中…' : ''}</span>`;
}

function renderStatusButtons(machine) {
  const esc = deps.escapeHtml;
  const defs = deps.statusList(machine.deptId);   // 這個單位的全部狀態（依單位設定的順序）
  $('mp-statuses').innerHTML = defs.map((d) =>
    `<button type="button" class="st-btn" data-code="${esc(d.code)}" aria-pressed="${picked.status === d.code}" style="${deps.colorStyle(d.color)}">${esc(d.label)}</button>`
  ).join('');
}

function renderReasonButtons(machine) {
  const esc = deps.escapeHtml;
  const need = deps.statusDef(machine.deptId, picked.status)?.needsReason || 'none';
  const list = deps.activeReasons(machine.deptId, picked.status);
  const show = need !== 'none' && list.length > 0;
  $('mp-reason-box').hidden = !show;
  if (!show) {
    picked.reason = '';
    $('mp-reasons').innerHTML = '';
    return;
  }
  $('mp-reason-legend').textContent = need === 'required' ? '原因（必選）' : '原因（可不選）';
  $('mp-reasons').innerHTML = list.map((r) =>
    `<button type="button" class="rs-btn" data-code="${esc(r.code)}" aria-pressed="${picked.reason === r.code}">${esc(r.label)}</button>`
  ).join('');
}

// ============================================================
// 切換狀態：目前狀態＋事件紀錄一次寫入（跟功能③看板的寫法完全一樣）
// ============================================================
async function save(event) {
  event.preventDefault();
  const machine = deps.machineOf(current);
  if (!machine || !deps.canEdit(machine)) return;
  const me = deps.getMe();
  const entry = deps.getStatus(machine.machineId);
  const prev = entry?.data || null;
  const fail = (message) => { $('mp-error').textContent = message; };

  if (entry?.pending) return fail('上一筆還在同步，請等幾秒再存');
  const def = deps.statusDef(machine.deptId, picked.status);
  if (!def) return fail('請選擇狀態');
  if (def.needsReason === 'required' && deps.activeReasons(machine.deptId, picked.status).length && !picked.reason) {
    $('mp-reason-box').scrollIntoView({ block: 'center', behavior: 'smooth' });   // 捲到原因那裡
    return fail('這個狀態要選原因');
  }
  const reasonCode = picked.reason || '';
  const partNo = $('mp-part').value.trim();
  const opNo = $('mp-op').value.trim();
  const note = $('mp-note').value.trim();
  const sameAsNow = prev && prev.status === picked.status && (prev.reasonCode || '') === reasonCode
    && (prev.partNo || '') === partNo && (prev.opNo || '') === opNo && (prev.note || '') === note;
  if (sameAsNow) {
    $('dlg-machine').close();
    deps.toast('沒有變更');
    return;
  }
  const shiftSetting = deps.getShiftSetting();
  if (!shiftSetting) return fail('找不到班別設定，請管理者回首頁按「建立預設資料」');
  const { prodDate, shiftId } = deps.prodDateAndShift(new Date(), shiftSetting);
  if (!shiftId) return fail('現在的時間不在任何班別裡，請檢查班別設定');
  // 狀態或原因有變 → 重新計時；只改料號、製程、備註 → 沿用原本的開始時間
  const restart = !prev || prev.status !== picked.status || (prev.reasonCode || '') !== reasonCode;
  fail('');

  const { db, collection, doc, writeBatch, serverTimestamp } = deps;
  deps.setBusy($('mp-save'), true, '儲存中…');
  try {
    const empNo = deps.myEmpNo();
    const batch = writeBatch(db);   // 兩筆一起寫，不會只寫一半
    const eventRef = doc(collection(db, 'machineEvents'));   // 事件紀錄用自動編號
    batch.set(eventRef, {
      eventType: 'statusChange',
      machineId: machine.machineId,
      deptId: machine.deptId,
      fromStatus: prev ? prev.status : null,            // 第一次設定時是 null
      fromStatusSince: prev ? prev.statusSince : null,
      toStatus: picked.status,
      reasonCode, note, partNo, opNo,
      prodDate, shiftId,                                // 生產日、班別在寫入當下算好
      createdAt: serverTimestamp(),
      createdByEmpNo: empNo,
      createdByName: me.name
    });
    batch.set(doc(db, 'machineStatus', machine.machineId), {
      machineId: machine.machineId,
      deptId: machine.deptId,
      status: picked.status,
      reasonCode, note, partNo, opNo,
      statusSince: restart ? serverTimestamp() : prev.statusSince,
      lastEventId: eventRef.id,                         // 指向這次的事件紀錄（規則會檢查）
      updatedAt: serverTimestamp(),
      updatedByEmpNo: empNo,
      updatedByName: me.name
    });

    // 網路慢的時候：6 秒後先關面板，資料會在連線恢復後自動送出
    const commit = batch.commit();
    const slow = new Promise((resolve) => { setTimeout(() => resolve('slow'), SLOW_MS); });
    const result = await Promise.race([commit.then(() => 'ok'), slow]);
    $('dlg-machine').close();
    if (result === 'ok') {
      deps.toast(`${machine.machineId} 已改成${def.label}`);
    } else {
      deps.toast('網路不穩：已先記在這台裝置，連線恢復後會自動送出（這個頁面先不要關）', 'error');
      commit
        .then(() => deps.toast(`${machine.machineId} 已送出`))
        .catch((err) => deps.toast(`${machine.machineId} 沒有存進去：${deps.errorMessage(err)}`, 'error'));
    }
  } catch (err) {
    fail(err?.code === 'permission-denied'
      ? '存不進去：這台可能剛被別人改過，或你沒有權限。請關掉面板，重新打開再試一次。'
      : deps.errorMessage(err));
  } finally {
    deps.setBusy($('mp-save'), false);
  }
}
