// ============================================================
// common.js — 所有頁面共用的程式
//   ‧Firebase 初始化（SDK 版本只寫在這個檔案，升級只改下面三行網址）
//   ‧登入、登出、讀取本人的人員資料、頁面權限檢查
//   ‧修改密碼、錯誤訊息翻成中文、畫面小工具
// ============================================================
import { firebaseConfig } from './config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  setPersistence, browserLocalPersistence, browserSessionPersistence,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, getDocs, setDoc, collection, writeBatch, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// 各頁面從這裡取用資料庫函式，SDK 版本才不會散在各檔案
export { doc, getDoc, getDocs, setDoc, collection, writeBatch, serverTimestamp };

// 角色代碼 → 畫面顯示名稱
export const ROLE_LABELS = { admin: '管理者', maintainer: '維護員', viewer: '檢視' };

// 工號格式：英文大寫或數字，2～10 碼
export const EMPNO_PATTERN = /^[A-Z0-9]{2,10}$/;

// ---------- 工號與登入帳號 ----------

// 去掉前後空白並轉大寫（輸入工號不分大小寫）
export function normalizeEmpNo(value) {
  return String(value ?? '').trim().toUpperCase();
}

// 工號 → 登入帳號，例：T001 → t001@cnc-mes.firebaseapp.com
export function empNoToEmail(empNo) {
  return `${normalizeEmpNo(empNo).toLowerCase()}@${firebaseConfig.authDomain}`;
}

// 登入帳號 → 工號（Firebase 存的是小寫，這裡轉回大寫）
export function emailToEmpNo(email) {
  return normalizeEmpNo(String(email ?? '').split('@')[0]);
}

// 目前登入者的工號
export function myEmpNo() {
  return emailToEmpNo(auth.currentUser?.email);
}

// ---------- 登入、登出 ----------

// keep = true：保持登入（關掉瀏覽器也記得）；false：關掉這個分頁就登出
export async function login(empNo, password, keep) {
  await setPersistence(auth, keep ? browserLocalPersistence : browserSessionPersistence);
  return signInWithEmailAndPassword(auth, empNoToEmail(empNo), password);
}

export function logout() {
  return signOut(auth);
}

// 監聽登入狀態：開網頁、登入、登出時都會呼叫 callback(user)
export function watchAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

// 讀取本人的人員資料 users/{工號}；沒有這筆就回傳 null
export async function loadProfile(user) {
  const snap = await getDoc(doc(db, 'users', emailToEmpNo(user.email)));
  return snap.exists() ? { ...snap.data(), empNo: snap.id } : null;
}

// 頁面守門員（登入頁以外的頁面一開始呼叫）
//   沒登入               → 回登入頁
//   沒有人員資料或已停用 → 登出，回登入頁並顯示「帳號未啟用」
//   要管理者但不是       → 回傳 forbidden: true，由頁面顯示「沒有權限」
//   讀取失敗（多半是網路）→ 回傳 error，由頁面顯示錯誤
export function requireUser({ adminOnly = false } = {}) {
  return new Promise((resolve) => {
    const stop = onAuthStateChanged(auth, async (user) => {
      stop();
      if (!user) {
        location.replace('index.html');
        return;
      }
      try {
        const profile = await loadProfile(user);
        if (!profile || profile.active !== true) {
          await signOut(auth);
          location.replace('index.html?msg=inactive');
          return;
        }
        resolve({ user, profile, forbidden: adminOnly && profile.role !== 'admin' });
      } catch (error) {
        resolve({ user, profile: null, forbidden: false, error });
      }
    });
  });
}

// ---------- 修改密碼 ----------
// 先用目前密碼重新驗證身分，再換成新密碼
export async function changePassword(currentPassword, newPassword) {
  const user = auth.currentUser;
  const credential = EmailAuthProvider.credential(user.email, currentPassword);
  await reauthenticateWithCredential(user, credential);
  await updatePassword(user, newPassword);
}

// ---------- 錯誤訊息 ----------
// 把 Firebase 的錯誤代碼翻成現場看得懂、知道怎麼處理的中文
const ERROR_TEXT = {
  'auth/invalid-credential': '工號或密碼錯誤',
  'auth/wrong-password': '工號或密碼錯誤',
  'auth/user-not-found': '工號或密碼錯誤',
  'auth/invalid-email': '工號格式不對',
  'auth/missing-password': '請輸入密碼',
  'auth/user-disabled': '帳號已被停用，請找管理者',
  'auth/too-many-requests': '嘗試太多次，請過幾分鐘再試',
  'auth/network-request-failed': '網路連不上，請確認網路後再試',
  'auth/weak-password': '新密碼至少要 8 碼',
  'auth/requires-recent-login': '請登出再重新登入，然後再修改密碼',
  'permission-denied': '沒有權限做這個動作',
  'unavailable': '網路連不上，請確認網路後再試'
};

export function errorMessage(error) {
  const code = error?.code || '';
  return ERROR_TEXT[code] || `發生錯誤（${code || error?.message || '原因不明'}），請截圖給管理者`;
}

// ---------- 畫面小工具 ----------

// 顯示使用者輸入的文字前先轉義，避免被插入程式碼（XSS）
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// 按鈕處理中：鎖住按鈕並換文字；結束後恢復原本的文字
export function setBusy(button, busy, busyText = '處理中…') {
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    if (button.dataset.label) button.textContent = button.dataset.label;
    button.disabled = false;
  }
}

// 畫面下方的短暫提示；type = 'error' 時是紅底
export function toast(message, type = 'ok') {
  let box = document.getElementById('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    box.setAttribute('role', 'status');
    document.body.appendChild(box);
  }
  box.textContent = message;
  box.className = `toast show ${type}`;
  clearTimeout(box.hideTimer);
  box.hideTimer = setTimeout(() => { box.className = 'toast'; }, 3500);
}

// 複製文字到剪貼簿
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已複製');
  } catch {
    toast('無法自動複製，請長按文字自行複製', 'error');
  }
}

// Firestore 時間 → 台灣時間文字，例：2026/10/24 04:30
export function formatTime(timestamp) {
  if (!timestamp || typeof timestamp.toDate !== 'function') return '—';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(timestamp.toDate());
}
