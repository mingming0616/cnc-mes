# cnc-mes

CNC 精密零件代工廠銑床課自建的工廠製造管理執行系統（MES）。
網址：https://mingming0616.github.io/cnc-mes/

> 這個 repo 是**公開的**。真實資料不要放進來，見最後一節。

## 檔案清單

所有檔案放在同一層（GitHub 網頁上傳不能建資料夾）。

| 檔案 | 用途 |
|---|---|
| `index.html` | 登入＋首頁（依角色顯示功能按鍵） |
| `users.html` | 人員管理 |
| `master.html` | 主檔維護（設備、樓層、匯入設備、匯入 v3.3 狀態、平面圖） |
| `board.html` | 設備看板（深色＋平面圖） |
| `machine.html` | 機台頁（掃 QR 進入） |
| `labels.html` | QR 標籤列印 |
| `list.html` | 設備清單與履歷（搜尋、篩選、匯出 CSV） |
| `status-panel.js` | 切換狀態面板（看板、機台頁共用） |
| `history.js` | 異動履歷＋修正紀錄 |
| `floorplan.js` | 平面圖（看板、主檔共用） |
| `qrcode.js` | 產生 QR code |
| `common.js` | 共用程式（Firebase 連線、登入、工具函式） |
| `config.js` | Firebase 連線設定（公開資訊，不是密碼） |
| `style.css` | 共用樣式 |
| `board.css` | 看板、機台頁樣式 |
| `floorplan.css` | 深色看板＋平面圖樣式 |
| `firestore.rules` | 安全規則（**只是備份**，見下面） |

## 上線步驟

1. 改好的檔案推送到 `main`（或從 https://github.com/mingming0616/cnc-mes/upload/main 上傳）。
2. GitHub Pages 約 1～3 分鐘後更新。
3. 有改 `firestore.rules` 的話：到 Firebase 主控台 → Firestore → 規則，整段貼上並「發布」。**只推送到 GitHub 不會生效。**
4. 照該次交付說明的測試步驟測過。

## 版本號規則

改了 `.css` 或 `.js`，引用它的頁面網址 `?v=數字` 要加 1，瀏覽器才會抓新檔；同一個檔在不同頁面的版本號要一樣。

| 檔案 | 版本號寫在 |
|---|---|
| `common.js`、`history.js`、`status-panel.js`、`board.css` | `board.html`、`machine.html` |
| `floorplan.js`、`floorplan.css` | `board.html`、`master.html` |
| `qrcode.js` | `labels.html` |
| `style.css` | 各頁 |

新的 `.js` 檔不要自己 import `common.js`，資料庫函式由頁面傳進去，避免 Firebase 載入兩次。

## 不能上傳的東西

- 平面圖檔（`floorplans` 資料夾的 `.js`、DXF、預覽圖）
- 設備清單 CSV、`設備清單.xlsx`
- v3.3 匯出的狀態 CSV
- 任何密碼
- 客戶名稱（一律用代號）

這些放在自己電腦 `D:\AI\CNC-MES` 裡、`cnc-mes-main` 以外的地方。
