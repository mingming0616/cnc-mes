// ============================================================
// qrcode.js — QR code 產生程式（功能⑥：機台 QR 標籤）
//   把一段文字（機台頁網址）變成 QR code 的黑白格子，再畫成 SVG 給標籤列印頁用
//   ‧不連外部網站、不用另外下載套件：整個演算法都在這個檔案裡
//   ‧採用 QR code 國際標準（ISO/IEC 18004）的「位元組模式」
//   ‧容錯等級預設 Q：沾到油、刮到一小塊（約 25%）也掃得到
//   ‧寫法參考 Project Nayuki 的 QR Code generator（MIT 授權）
//   ‧這個檔案不 import 別的檔案，標籤列印頁直接用就好
// ============================================================

// 每個區塊的錯誤更正碼數量 [容錯等級][版本]（索引 0 不用）
const ECC_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
};

// 錯誤更正區塊數 [容錯等級][版本]（索引 0 不用）
const NUM_BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
};

// 格式資訊裡的容錯等級代碼（標準規定的值，不是照順序）
const ECL_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

const getBit = (value, i) => ((value >>> i) & 1) !== 0;

// 這個版本扣掉定位圖形等固定圖案後，能放資料的格子數
function rawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

// 這個版本、容錯等級能放幾個位元組的資料（不含錯誤更正碼）
function dataCodewords(ver, ecl) {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];
}

// ---------- 錯誤更正碼（Reed-Solomon，GF(256)，多項式 0x11D） ----------
function rsMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = rsMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= rsMultiply(coef, factor); });
  }
  return result;
}

// ---------- 文字 → 資料位元組 ----------
function utf8Bytes(text) {
  return Array.from(new TextEncoder().encode(String(text)));
}

// 找出放得下的最小版本，並組成資料位元組（含結尾和填充）
function buildData(bytes, ecl, minVersion) {
  for (let ver = minVersion; ver <= 40; ver++) {
    const countBits = ver <= 9 ? 8 : 16;
    const capacityBits = dataCodewords(ver, ecl) * 8;
    const usedBits = 4 + countBits + bytes.length * 8;
    if (usedBits > capacityBits) continue;
    const bits = [];
    const push = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    push(0x4, 4);                    // 位元組模式
    push(bytes.length, countBits);   // 幾個位元組
    bytes.forEach((b) => push(b, 8));
    push(0, Math.min(4, capacityBits - bits.length));   // 結尾
    push(0, (8 - (bits.length % 8)) % 8);                // 補滿到整個位元組
    for (let pad = 0xEC; bits.length < capacityBits; pad ^= 0xEC ^ 0x11) push(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      data.push(b);
    }
    return { ver, data };
  }
  throw new Error('文字太長，QR code 放不下');
}

// 切成區塊、算錯誤更正碼、交錯排列
function addEccAndInterleave(data, ver, ecl) {
  const numBlocks = NUM_BLOCKS[ecl][ver];
  const blockEccLen = ECC_PER_BLOCK[ecl][ver];
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

// ---------- 畫格子 ----------
function alignmentPositions(ver, size) {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function makeGrid(ver) {
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { modules[y][x] = dark; isFunction[y][x] = true; };

  // 計時圖形
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // 三個角的定位圖形（含白邊）
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  // 對齊圖形
  const pos = alignmentPositions(ver, size);
  const n = pos.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  // 版本資訊（版本 7 以上才有）
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  return { size, modules, isFunction, set };
}

// 格式資訊（容錯等級＋遮罩編號），兩份
function drawFormat(grid, ecl, mask) {
  const { size, set } = grid;
  const data = (ECL_FORMAT_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  for (let i = 0; i <= 5; i++) set(8, i, getBit(bits, i));
  set(8, 7, getBit(bits, 6));
  set(8, 8, getBit(bits, 7));
  set(7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, getBit(bits, i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, getBit(bits, i));
  set(8, size - 8, true);   // 固定的黑格
}

// 資料位元依「之」字形從右下往上放
function drawCodewords(grid, codewords) {
  const { size, modules, isFunction } = grid;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < codewords.length * 8) {
          modules[y][x] = getBit(codewords[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

// 8 種遮罩：讓黑白分布平均，比較好掃
function maskHit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(grid, mask) {
  const { size, modules, isFunction } = grid;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFunction[y][x] && maskHit(mask, x, y)) modules[y][x] = !modules[y][x];
    }
  }
}

// 扣分：連續同色、2×2 同色、像定位圖形的樣子、黑白比例（分數越低越好掃）
function penalty(m) {
  const n = m.length;
  let score = 0;
  const line = (get) => {
    let run = 1;
    for (let i = 1; i < n; i++) {
      if (get(i) === get(i - 1)) {
        run += 1;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  };
  for (let y = 0; y < n; y++) line((x) => m[y][x]);
  for (let x = 0; x < n; x++) line((y) => m[y][x]);
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
    }
  }
  const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const match = (get, start, pattern) => pattern.every((v, k) => (get(start + k) ? 1 : 0) === v);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x + 11 <= n; x++) {
      const get = (i) => m[y][i];
      if (match(get, x, p1) || match(get, x, p2)) score += 40;
    }
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y + 11 <= n; y++) {
      const get = (i) => m[i][x];
      if (match(get, y, p1) || match(get, y, p2)) score += 40;
    }
  }
  let dark = 0;
  m.forEach((row) => row.forEach((c) => { if (c) dark += 1; }));
  const total = n * n;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

// ============================================================
// 給頁面用的兩個函式
// ============================================================

// 文字 → QR 格子：回傳 { version, size, modules }（modules[y][x] 為 true＝黑格）
//   ecl：容錯等級 L、M、Q、H；mask：-1＝自動挑最好掃的遮罩（測試時才指定 0～7）
export function qrMatrix(text, { ecl = 'Q', minVersion = 1, mask = -1 } = {}) {
  if (!ECC_PER_BLOCK[ecl]) throw new Error(`容錯等級要是 L、M、Q、H：${ecl}`);
  const { ver, data } = buildData(utf8Bytes(text), ecl, Math.max(1, Math.min(40, minVersion)));
  const codewords = addEccAndInterleave(data, ver, ecl);
  const base = makeGrid(ver);
  drawFormat(base, ecl, 0);   // 先佔位置，放資料時才會跳過
  drawCodewords(base, codewords);

  let best = null;
  const masks = mask >= 0 && mask <= 7 ? [mask] : [0, 1, 2, 3, 4, 5, 6, 7];
  for (const k of masks) {
    const grid = {
      size: base.size,
      modules: base.modules.map((row) => row.slice()),
      isFunction: base.isFunction.map((row) => row.slice())
    };
    grid.set = (x, y, dark) => { grid.modules[y][x] = dark; grid.isFunction[y][x] = true; };
    applyMask(grid, k);
    drawFormat(grid, ecl, k);
    const score = masks.length > 1 ? penalty(grid.modules) : 0;
    if (!best || score < best.score) best = { score, grid, mask: k };
  }
  return { version: ver, size: best.grid.size, mask: best.mask, modules: best.grid.modules };
}

// 文字 → SVG（四周留 4 格白邊，掃描器才認得出來）
//   回傳的 SVG 沒有固定大小，由頁面用 CSS 設定印出來的公釐數
export function qrSvg(text, { ecl = 'Q', border = 4, title = '' } = {}) {
  const { size, modules } = qrMatrix(text, { ecl });
  const full = size + border * 2;
  // 同一列連續的黑格合成一段長方形，SVG 才不會太大（一次印很多張時比較順）
  let path = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!modules[y][x]) continue;
      let run = 1;
      while (x + run < size && modules[y][x + run]) run += 1;
      path += `M${x + border} ${y + border}h${run}v1h-${run}z`;
      x += run - 1;
    }
  }
  const safeTitle = String(title).replace(/[&<>"']/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges" role="img"`
    + `${safeTitle ? ` aria-label="${safeTitle}"` : ''}>`
    + `<rect width="${full}" height="${full}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
