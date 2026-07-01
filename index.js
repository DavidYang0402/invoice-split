// ========== 設定:記住 GAS 網址 ==========
const gasUrlInput = document.getElementById("gasUrl");
gasUrlInput.value = localStorage.getItem("gasUrl") || "";
gasUrlInput.addEventListener("change", () =>
  localStorage.setItem("gasUrl", gasUrlInput.value.trim()),
);

function getGasUrl() {
  return gasUrlInput.value.trim();
}

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
  const parts = rest.split(":").filter((_, i) => i > 0 || rest[0] !== ":"); // 去掉開頭空字串
  const cleanParts = rest.startsWith(":")
    ? rest.slice(1).split(":")
    : rest.split(":");

  // cleanParts: [自用區, 條碼品目筆數, 該發票品目總筆數, 中文編碼參數, 品名, 數量, 單價, 品名, 數量, 單價, ...]
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
  };
}

// 右方 QR Code:前兩碼固定 "**",之後接續品名:數量:單價 三碼一組
function parseRightQR(raw) {
  if (!raw || !raw.startsWith("**"))
    throw new Error("右方 QR Code 應以 ** 開頭,請確認掃到的是右側條碼");
  const rest = raw.slice(2).replace(/^:/, "");
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
  if (!awaitingRight) {
    try {
      const parsed = parseLeftQR(text);
      fillResultFromLeft(parsed);
      showStatus("已讀取左側 QR Code,請核對資料", "ok");
      if (document.getElementById("scanHint")) {
        document.getElementById("scanHint").textContent =
          "若有品項未讀完,可繼續對準右側 QR Code(選填)";
      }
      awaitingRight = true;
      scanning = true;
      requestAnimationFrame(scanLoop);
    } catch (err) {
      showStatus("解析失敗:" + err.message, "warn");
      scanning = true;
      requestAnimationFrame(scanLoop);
    }
  } else {
    try {
      const items = parseRightQR(text);
      appendItems(items);
      showStatus("已補上右側 QR Code 的品項", "ok");
    } catch (err) {
      showStatus("右側解析失敗,略過:" + err.message, "warn");
    }
    stopCamera();
    awaitingRight = false;
  }
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
    const items = parseRightQR(text);
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
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
