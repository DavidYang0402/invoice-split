// ========== 設定:記住 GAS 網址 ==========
const gasUrlInput = document.getElementById("gasUrl");
gasUrlInput.value = localStorage.getItem("gasUrl") || "";
gasUrlInput.addEventListener("change", () =>
  localStorage.setItem("gasUrl", gasUrlInput.value.trim()),
);

function getGasUrl() {
  return gasUrlInput.value.trim();
}

// ========== LIFF 設定與初始化 ==========
const liffIdInput = document.getElementById("liffId");
const DEFAULT_LIFF_ID = "2010566863-J17n9GqL"; // 你的 LIFF App,已內建,不用手動輸入
liffIdInput.value = localStorage.getItem("liffId") || DEFAULT_LIFF_ID;
liffIdInput.addEventListener("change", () => {
  localStorage.setItem("liffId", liffIdInput.value.trim());
  initLiff();
});

async function initLiff() {
  const liffId = liffIdInput.value.trim();
  const statusEl = document.getElementById("liffStatus");
  if (!liffId) {
    statusEl.textContent = "";
    return;
  }
  try {
    await liff.init({ liffId });
    if (liff.isInClient()) {
      statusEl.innerHTML =
        '<span style="color:var(--good)">✓ 已在 LINE 內開啟,可使用 LINE 掃描器</span>';
      document.getElementById("liffScanRow").style.display = "flex";
    } else {
      statusEl.textContent =
        "（目前是一般瀏覽器開啟,LINE 掃描器僅在 LINE App 內可用)";
    }
  } catch (err) {
    statusEl.innerHTML =
      '<span style="color:var(--accent)">LIFF 初始化失敗:' +
      escapeHtml(err.message) +
      "</span>";
  }
}
window.addEventListener("load", initLiff);

document.getElementById("liffScanBtn").addEventListener("click", async () => {
  try {
    const result = await liff.scanCodeV2();
    if (result && result.value) {
      handleDecodedText(result.value);
    } else {
      showStatus("沒有掃描到內容,請再試一次", "warn");
    }
  } catch (err) {
    showStatus("LINE 掃描器啟動失敗:" + err.message, "warn");
  }
});

// ========== Tabs ==========
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document
      .querySelectorAll(".tab")
      .forEach((t) => t.classList.remove("active"));
    document
      .querySelectorAll(".panel")
      .forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("panel-" + tab.dataset.tab).classList.add("active");
    if (tab.dataset.tab !== "scan") stopCamera();
  });
});

// ========== 左方 QR Code 解析 ==========
// 規格來源:財政部《電子發票證明聯一維及二維條碼規格說明》v1.9
// 固定 77 碼: 發票號碼(10) + 發票日期(7,民國年) + 隨機碼(4) + 銷售額hex(8) + 總計額hex(8)
//            + 買方統編(8) + 賣方統編(8) + 加密驗證資訊(24)
// 之後以 ":" 分隔: 營業人自用區(10) : 條碼內品目筆數 : 該發票品目總筆數 : 中文編碼參數 : 品名:數量:單價 (重複)
// 若原始位元組是 Big5,但解碼器(jsQR / LINE 掃描器)可能誤判編碼而產生亂碼,實測發現
// 至少三種可能的誤判路徑,依可靠度排序依序嘗試:
// 路徑1(實測確認最常見):位元組被誤當成日文 Shift-JIS 解碼,產生「英數字+半形片假名」
//        混合的亂碼(例如 "Cat.6ｰｪｳtｶW")。這個特徵很難巧合出現,一旦符合就直接採用。
// 路徑2:位元組被誤當 UTF-8,剛好合法解出多位元組 Unicode 字元(碼位超過 0xFF)
// 路徑3:位元組被逐一當成 0-255 的碼位直接印出(類似 Latin1)
let _sjisMap = null;
function getShiftJisSingleByteMap() {
  if (_sjisMap) return _sjisMap;
  _sjisMap = {};
  for (let b = 0; b <= 0xff; b++) {
    try {
      const ch = new TextDecoder("shift-jis", { fatal: true }).decode(
        new Uint8Array([b]),
      );
      if (ch.length === 1) _sjisMap[ch] = b;
    } catch (e) {
      /* 該位元組在 SJIS 屬雙位元組前導碼,略過 */
    }
  }
  return _sjisMap;
}

function tryShiftJisReverse(str) {
  const map = getShiftJisSingleByteMap();
  const bytes = [];
  for (const ch of str) {
    if (Object.prototype.hasOwnProperty.call(map, ch)) bytes.push(map[ch]);
    else return null; // 有字元不在英數字/半形片假名範圍內,這個假設不成立
  }
  return new Uint8Array(bytes);
}

function fixBig5(str) {
  const sjisBytes = tryShiftJisReverse(str);
  if (sjisBytes) {
    try {
      return new TextDecoder("big5").decode(sjisBytes);
    } catch (e) {
      /* 繼續往下嘗試 */
    }
  }
  if ([...str].some((ch) => ch.codePointAt(0) > 0xff)) {
    try {
      const bytes = new TextEncoder().encode(str);
      return new TextDecoder("big5").decode(bytes);
    } catch (e) {
      /* 繼續往下嘗試 */
    }
  }
  try {
    const bytes = Uint8Array.from(
      [...str].map((ch) => ch.codePointAt(0) & 0xff),
    );
    return new TextDecoder("big5").decode(bytes);
  } catch (e) {
    return str; // 都失敗就原樣返回,不讓程式壞掉
  }
}

function parseLeftQR(raw) {
  if (!raw || raw.length < 77)
    throw new Error("左方 QR Code 內容長度不足,可能掃描到錯誤區塊");

  const invoiceNumber = raw.slice(0, 10);
  const dateROC = raw.slice(10, 17); // 民國年月日 7碼
  const randomCode = raw.slice(17, 21);
  const salesHex = raw.slice(21, 29);
  const totalHex = raw.slice(29, 37);
  const buyerId = raw.slice(37, 45);
  const sellerId = raw.slice(45, 53);
  // const encryptedInfo = raw.slice(53, 77); // 加密驗證用,用不到就不解析

  const rocYear = parseInt(dateROC.slice(0, 3), 10);
  const month = dateROC.slice(3, 5);
  const day = dateROC.slice(5, 7);
  const isoDate = `${rocYear + 1911}-${month}-${day}`;

  const salesAmount = parseInt(salesHex, 16) || 0;
  const totalAmount = parseInt(totalHex, 16) || 0;

  const rest = raw.slice(77); // 從第78碼開始, 以 ":" 起頭
  let cleanParts = rest.startsWith(":")
    ? rest.slice(1).split(":")
    : rest.split(":");

  // cleanParts: [自用區, 條碼品目筆數, 該發票品目總筆數, 中文編碼參數, 品名, 數量, 單價, 品名, 數量, 單價, ...]
  const itemCountInQr = parseInt(cleanParts[1], 10);
  const itemCountTotal = parseInt(cleanParts[2], 10);
  const encoding = cleanParts[3]; // '0'=Big5 '1'=UTF-8 '2'=Base64

  if (encoding === "0") {
    // 品名是 Big5,重新用正確編碼解一次,再重新切分欄位(數字/冒號在 Big5 底下跟 ASCII 完全相容,位置不會跑掉)
    const fixedRest = fixBig5(rest);
    cleanParts = fixedRest.startsWith(":")
      ? fixedRest.slice(1).split(":")
      : fixedRest.split(":");
  }

  const items = [];
  if (cleanParts.length > 4) {
    for (
      let i = 4;
      i + 2 < cleanParts.length + 1 && cleanParts[i] !== undefined;
      i += 3
    ) {
      const name = cleanParts[i];
      const qty = parseFloat(cleanParts[i + 1]);
      const price = parseFloat(cleanParts[i + 2]);
      if (name === undefined || isNaN(qty) || isNaN(price)) break;
      items.push({
        name: name.trim(),
        quantity: qty,
        unitPrice: price,
        amount: Math.round(qty * price * 100) / 100,
      });
    }
  }

  return {
    invoiceNumber,
    randomCode,
    buyerId,
    sellerId,
    date: isoDate,
    salesAmount,
    totalAmount,
    items,
    itemCountInQr: isNaN(itemCountInQr) ? null : itemCountInQr,
    itemCountTotal: isNaN(itemCountTotal) ? null : itemCountTotal,
    encoding,
  };
}

// 右方 QR Code:前兩碼固定 "**",之後接續品名:數量:單價 三碼一組
// 右方本身不重複記載中文編碼參數,沿用左方 QR 判斷出的編碼方式(呼叫時傳入)
function parseRightQR(raw, encoding) {
  if (!raw || !raw.startsWith("**"))
    throw new Error("右方 QR Code 應以 ** 開頭,請確認掃到的是右側條碼");
  let rest = raw.slice(2).replace(/^:/, "");
  if (encoding === "0") rest = fixBig5(rest);
  const parts = rest.split(":");
  const items = [];
  for (let i = 0; i + 2 < parts.length + 1 && parts[i] !== undefined; i += 3) {
    const name = parts[i];
    const qty = parseFloat(parts[i + 1]);
    const price = parseFloat(parts[i + 2]);
    if (name === undefined || isNaN(qty) || isNaN(price)) break;
    items.push({
      name: name.trim(),
      quantity: qty,
      unitPrice: price,
      amount: Math.round(qty * price * 100) / 100,
    });
  }
  return items;
}

// ========== 相機掃描 ==========
let stream = null,
  scanning = false,
  videoEl,
  canvasEl,
  ctx;
let awaitingRight = false; // 是否正在等待掃描右方 QR(補品項)

function initScanEls() {
  videoEl = document.getElementById("video");
  canvasEl = document.getElementById("scanCanvas");
  ctx = canvasEl.getContext("2d", { willReadFrequently: true });
}

async function startCamera() {
  initScanEls();
  if (stream) {
    // 相機已經開著,這次只是要「繼續掃下一個 QR」
    scanning = true;
    requestAnimationFrame(scanLoop);
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
    videoEl.srcObject = stream;
    await videoEl.play();
    scanning = true;
    requestAnimationFrame(scanLoop);
  } catch (err) {
    showStatus(
      "無法開啟相機:" + err.message + "(桌機請改用「上傳圖片」分頁)",
      "warn",
    );
  }
}

function stopCamera() {
  scanning = false;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}

function scanLoop() {
  if (!scanning) return;
  if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
    canvasEl.width = videoEl.videoWidth;
    canvasEl.height = videoEl.videoHeight;
    ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
    const imageData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height);
    if (code) {
      handleDecodedText(code.data);
      return; // 解到一個就停,交給使用者確認
    }
  }
  requestAnimationFrame(scanLoop);
}

document.getElementById("startCamBtn").addEventListener("click", startCamera);
document.getElementById("stopCamBtn").addEventListener("click", stopCamera);

function handleDecodedText(text) {
  logDebug(text);
  // 右方 QR Code 固定以 "**" 開頭,不管目前是不是在等右方,只要看到這個開頭就當品項補充處理
  const looksLikeRightQr = text.startsWith("**");

  if (!awaitingRight && !looksLikeRightQr) {
    try {
      const parsed = parseLeftQR(text);
      fillResultFromLeft(parsed);
      logDebug(
        text,
        `品目筆數(左右合計)=${parsed.itemCountInQr} / 發票交易總品目筆數=${parsed.itemCountTotal} / 本次解出品項數=${parsed.items.length} / 中文編碼=${parsed.encoding}(0=Big5 1=UTF-8 2=Base64)`,
      );
      if (parsed.itemCountTotal === 0 || parsed.itemCountTotal === null) {
        showStatus(
          "已讀取發票基本資料(號碼/日期/金額),這張發票的 QR Code 未編碼品項明細,請在下方手動新增品項",
          "ok",
        );
      } else if (parsed.items.length < parsed.itemCountTotal) {
        showStatus(
          `已讀取左側 QR Code,共 ${parsed.itemCountTotal} 項品項,目前解出 ${parsed.items.length} 項,請掃右側 QR Code 補齊`,
          "ok",
        );
      } else {
        showStatus("已讀取左側 QR Code,品項已完整,請核對資料", "ok");
      }
      document.getElementById("scanHint").textContent =
        "若有品項未讀完,可繼續對準右側 QR Code(選填)";
      awaitingRight = true;
    } catch (err) {
      showStatus("解析失敗:" + err.message, "warn");
    }
  } else {
    try {
      const items = parseRightQR(
        text,
        currentResult ? currentResult.encoding : undefined,
      );
      appendItems(items);
      showStatus("已補上右側 QR Code 的品項", "ok");
    } catch (err) {
      showStatus("右側解析失敗,略過:" + err.message, "warn");
    }
    awaitingRight = false;
    document.getElementById("scanHint").textContent = "對準發票左側 QR Code";
  }
  // 若是網頁相機在跑,掃到一筆後先暫停,交給使用者確認再決定下一步(按按鈕繼續)
  scanning = false;
}

// ========== 上傳圖片解析 ==========
const uploadCanvas = document.getElementById("uploadCanvas");
function decodeImageFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      uploadCanvas.width = img.width;
      uploadCanvas.height = img.height;
      const c = uploadCanvas.getContext("2d");
      c.drawImage(img, 0, 0);
      const imageData = c.getImageData(0, 0, img.width, img.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      if (code) resolve(code.data);
      else
        reject(
          new Error("圖片中找不到 QR Code,請確認照片清晰且只包含條碼區域"),
        );
    };
    img.onerror = () => reject(new Error("圖片讀取失敗"));
    img.src = URL.createObjectURL(file);
  });
}

document.getElementById("uploadLeft").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await decodeImageFile(file);
    const parsed = parseLeftQR(text);
    fillResultFromLeft(parsed);
    showStatus("已讀取左側 QR Code,請核對資料", "ok");
  } catch (err) {
    showStatus(err.message, "warn");
  }
});

document.getElementById("uploadRight").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await decodeImageFile(file);
    const items = parseRightQR(
      text,
      currentResult ? currentResult.encoding : undefined,
    );
    appendItems(items);
    showStatus("已補上右側 QR Code 的品項", "ok");
  } catch (err) {
    showStatus(err.message, "warn");
  }
});

// ========== 手動輸入 ==========
document.getElementById("manualStartBtn").addEventListener("click", () => {
  const seller = document.getElementById("manualSeller").value.trim();
  const date =
    document.getElementById("manualDate").value ||
    new Date().toISOString().slice(0, 10);
  let invoiceNumber = document
    .getElementById("manualInvoiceNumber")
    .value.trim();
  if (!invoiceNumber)
    invoiceNumber = "MANUAL-" + Date.now().toString(36).toUpperCase();

  currentResult = {
    invoiceNumber,
    date,
    seller,
    totalAmount: 0,
    salesAmount: 0,
    items: [],
    source: "Manual",
  };
  renderResult();
  showStatus("請在下方新增品項", "ok");
});

// ========== 結果區塊渲染 ==========
let currentResult = null;

function fillResultFromLeft(parsed) {
  currentResult = {
    invoiceNumber: parsed.invoiceNumber,
    date: parsed.date,
    seller: "",
    totalAmount: parsed.totalAmount,
    salesAmount: parsed.salesAmount,
    items: parsed.items,
    source: "QrScan",
    itemCountInQr: parsed.itemCountInQr,
    itemCountTotal: parsed.itemCountTotal,
    encoding: parsed.encoding,
  };
  renderResult();
}

function appendItems(items) {
  if (!currentResult) return;
  currentResult.items = currentResult.items.concat(items);
  renderResult();
}

function renderResult() {
  document.getElementById("resultBox").style.display = "block";
  document.getElementById("resSeller").value = currentResult.seller || "";
  document.getElementById("resDate").value = currentResult.date || "";
  document.getElementById("resInvoiceNumber").value =
    currentResult.invoiceNumber || "";
  document.getElementById("resTotal").value = currentResult.totalAmount || 0;
  renderItems();
}

function renderItems() {
  const list = document.getElementById("itemsList");
  list.innerHTML = "";
  currentResult.items.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = "item-row";
    row.innerHTML = `
      <span class="item-name">${escapeHtml(item.name)}</span>
      <span class="item-qty">x${item.quantity}</span>
      <span class="item-amt">$${item.amount}</span>
      <span class="item-del" data-idx="${idx}">✕</span>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll(".item-del").forEach((el) => {
    el.addEventListener("click", () => {
      currentResult.items.splice(Number(el.dataset.idx), 1);
      renderItems();
    });
  });
  const subtotal = currentResult.items.reduce(
    (s, i) => s + Number(i.amount || 0),
    0,
  );
  document.getElementById("itemsSubtotal").textContent =
    "$" + Math.round(subtotal * 100) / 100;
}

document.getElementById("addItemBtn").addEventListener("click", () => {
  if (!currentResult) return;
  const name = document.getElementById("newItemName").value.trim();
  const qty = parseFloat(document.getElementById("newItemQty").value) || 1;
  const price = parseFloat(document.getElementById("newItemPrice").value) || 0;
  if (!name) {
    showStatus("請輸入品名", "warn");
    return;
  }
  currentResult.items.push({
    name,
    quantity: qty,
    unitPrice: price,
    amount: Math.round(qty * price * 100) / 100,
  });
  document.getElementById("newItemName").value = "";
  document.getElementById("newItemPrice").value = "";
  renderItems();
});

// resSeller / resDate / resTotal 手動修正時同步回 currentResult
["resSeller", "resDate", "resTotal"].forEach((id) => {
  document.getElementById(id).addEventListener("change", (e) => {
    if (!currentResult) return;
    if (id === "resSeller") currentResult.seller = e.target.value;
    if (id === "resDate") currentResult.date = e.target.value;
    if (id === "resTotal")
      currentResult.totalAmount = parseFloat(e.target.value) || 0;
  });
});

// ========== 儲存到 GAS ==========
document.getElementById("saveBtn").addEventListener("click", async () => {
  const url = getGasUrl();
  if (!url) {
    showStatus("請先在最上方填入後端網址", "warn");
    return;
  }
  if (!currentResult) {
    showStatus("沒有可儲存的資料", "warn");
    return;
  }

  const payload = {
    action: "saveInvoice",
    invoiceNumber: currentResult.invoiceNumber,
    invoiceDate: currentResult.date,
    totalAmount: currentResult.totalAmount,
    salesAmount: currentResult.salesAmount,
    seller: currentResult.seller,
    source: currentResult.source,
    items: currentResult.items,
  };

  showStatus("儲存中...", "ok");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" }, // 避免觸發 GAS 的 CORS preflight
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    showStatus(
      "已儲存發票 " + data.invoiceNumber + "(分帳功能之後接續開發)",
      "ok",
    );
  } catch (err) {
    showStatus("儲存失敗:" + err.message, "warn");
  }
});

function showStatus(msg, type) {
  const box = document.getElementById("statusBox");
  box.innerHTML = `<div class="status ${type}">${escapeHtml(msg)}</div>`;
}

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

let debugLog = [];
function logDebug(text, extra) {
  const time = new Date().toLocaleTimeString();
  let entry = `[${time}] 原始字串(${text.length}碼):\n${text}`;
  if (extra) entry += `\n→ ${extra}`;
  debugLog.unshift(entry);
  debugLog = debugLog.slice(0, 5);
  document.getElementById("debugContent").textContent = debugLog.join("\n\n");
  document.getElementById("debugPanel").open = true;
}
