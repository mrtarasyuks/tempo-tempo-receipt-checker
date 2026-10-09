(function () {
  "use strict";

  var RPC_URL = "https://rpc.moderato.tempo.xyz";
  var EXPLORER_TX = "https://explore.testnet.tempo.xyz/tx/";
  var EXPLORER_ADDR = "https://explore.testnet.tempo.xyz/address/";
  var CHAIN_ID_HEX = "0xa5bf"; // 42431

  var ZERO_ADDR = "0x0000000000000000000000000000000000000000".slice(0, 42);
  var FEE_COLLECTOR = "0xfeec000000000000000000000000000000000000";

  var TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  var TRANSFER_WITH_MEMO_TOPIC = "0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0";
  var MINT_TOPIC = "0x0f6798a560793a54c3bcfe86a93cde1e73087d944c0ea20544137d4121396885";

  var METHOD_SELECTORS = {
    "0x95777d59": "transferWithMemo",
    "0x929c2539": "transferFromWithMemo",
    "0xe44f0b12": "mintWithMemo",
    "0x38f23b0b": "burnWithMemo",
    "0xa9059cbb": "transfer",
    "0x23b872dd": "transferFrom",
    "0x095ea7b3": "approve"
  };

  // Confirmed live on Moderato testnet (checked via eth_getLogs + symbol()/decimals() eth_call).
  var KNOWN_TOKENS = {
    "0x20c0000000000000000000000000000000000000": { symbol: "PathUSD", decimals: 6 },
    "0x20c0000000000000000000000000000000000001": { symbol: "AlphaUSD", decimals: 6 },
    "0x20c0000000000000000000000000000000000002": { symbol: "BetaUSD", decimals: 6 },
    "0x20c0000000000000000000000000000000000003": { symbol: "ThetaUSD", decimals: 6 },
    "0x20c0000000000000000000006a37da5c996874be": { symbol: "OUSD", decimals: 6 }
  };

  var EXAMPLES = [
    { label: "Payment + memo (PathUSD)", hash: "0x413b6983673912c1e6e70b33387451298b18e38741457dffbffcc4c31d8f1107" },
    { label: "Payment + memo (BetaUSD)", hash: "0x8778baa6f9fce7616206007776ce04274c95d887624cc10f8144cf29de1a7a92" },
    { label: "Faucet mint", hash: "0x0e43d353cd80202490486737d5676af1aceae857f44753565464dc47f57a9d75" },
    { label: "DEX order (no token transfer)", hash: "0xf26f45ac69a0d3d0e057ee787c664c76ef48755a9d8331c2b90c13b1f428c01e" },
    { label: "Contract call, no payment", hash: "0x47c1cfdd69bedad9998f0f16d05c62491017eb0e3cb622332fb8792550f00d43" }
  ];

  var tokenInfoCache = {};
  var MAX_SELECTOR = { "symbol()": "0x95d89b41", "decimals()": "0x313ce567" };

  // Receipt cards can opt into live confirmation updates; the live block poll
  // (started once, see startLiveIndicator) notifies every subscribed card.
  var liveConfirmSubscribers = [];
  var latestKnownBlock = null;

  function notifyLiveConfirmSubscribers(blockNum) {
    latestKnownBlock = blockNum;
    liveConfirmSubscribers.slice().forEach(function (fn) { fn(blockNum); });
  }

  function $(id) { return document.getElementById(id); }

  function rpc(method, params) {
    return fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params || [] })
    }).then(function (res) { return res.json(); }).then(function (json) {
      if (json.error) throw new Error(json.error.message || "RPC error");
      return json.result;
    });
  }

  function topicToAddress(topic) {
    return "0x" + topic.slice(-40);
  }

  function shortAddr(addr) {
    return addr.slice(0, 6) + "…" + addr.slice(-4);
  }

  function decodeAbiString(hexData) {
    try {
      var data = hexData.slice(2);
      if (data.length < 128) return null;
      var len = parseInt(data.slice(64, 128), 16);
      var strHex = data.slice(128, 128 + len * 2);
      var bytes = [];
      for (var i = 0; i < strHex.length; i += 2) bytes.push(parseInt(strHex.substr(i, 2), 16));
      return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
    } catch (e) { return null; }
  }

  function getTokenInfo(address) {
    var addr = address.toLowerCase();
    if (KNOWN_TOKENS[addr]) return Promise.resolve(KNOWN_TOKENS[addr]);
    if (tokenInfoCache[addr]) return tokenInfoCache[addr];
    tokenInfoCache[addr] = Promise.all([
      rpc("eth_call", [{ to: addr, data: MAX_SELECTOR["symbol()"] }, "latest"]).catch(function () { return null; }),
      rpc("eth_call", [{ to: addr, data: MAX_SELECTOR["decimals()"] }, "latest"]).catch(function () { return null; })
    ]).then(function (res) {
      var symbol = res[0] ? decodeAbiString(res[0]) : null;
      var decimals = res[1] ? parseInt(res[1], 16) : null;
      return {
        symbol: symbol || ("token " + shortAddr(addr)),
        decimals: (decimals === null || isNaN(decimals)) ? 18 : decimals,
        unverified: true
      };
    });
    return tokenInfoCache[addr];
  }

  function formatAmount(valueHex, decimals) {
    var value = BigInt(valueHex);
    var base = BigInt(10) ** BigInt(decimals);
    var whole = value / base;
    var frac = value % base;
    var wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    if (frac === BigInt(0)) return wholeStr;
    var fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    return fracStr.length ? wholeStr + "." + fracStr : wholeStr;
  }

  function decodeMemo(memoTopic) {
    var hex = memoTopic;
    var isZero = /^0x0+$/.test(hex);
    if (isZero) return { hex: hex, text: null, empty: true };
    var bytes = [];
    for (var i = 2; i < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
    // trim trailing null bytes before checking printability
    while (bytes.length && bytes[bytes.length - 1] === 0) bytes.pop();
    var printable = bytes.length > 0 && bytes.every(function (b) { return b >= 0x20 && b <= 0x7e; });
    var text = null;
    if (printable) {
      text = bytes.map(function (b) { return String.fromCharCode(b); }).join("");
    }
    return { hex: hex, text: text, empty: false };
  }

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") e.textContent = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  function addrChip(addr) {
    return el("a", { "class": "addr-chip", href: EXPLORER_ADDR + addr, target: "_blank", rel: "noopener", text: shortAddr(addr), title: addr });
  }

  function setStatus(msg, type) {
    var line = $("status-line");
    line.hidden = false;
    line.className = "status-line" + (type ? " " + type : "");
    line.innerHTML = "";
    if (type === "loading") line.appendChild(el("span", { "class": "spinner" }));
    line.appendChild(document.createTextNode(msg));
  }

  function clearStatus() {
    $("status-line").hidden = true;
  }

  function renderExamples() {
    var box = $("example-buttons");
    EXAMPLES.forEach(function (ex) {
      var btn = el("button", { "class": "example-btn", type: "button", text: ex.label });
      btn.addEventListener("click", function () {
        $("tx-input").value = ex.hash;
        lookup(ex.hash);
      });
      box.appendChild(btn);
    });
  }

  function isValidHash(h) {
    return /^0x[0-9a-fA-F]{64}$/.test(h);
  }

  function methodNameFor(tx) {
    var input = null;
    var multiCall = false;
    if (tx.calls && tx.calls.length) {
      input = tx.calls[0].input;
      multiCall = tx.calls.length > 1;
    } else if (tx.input && tx.input !== "0x") {
      input = tx.input;
    }
    if (!input || input.length < 10) return null;
    var selector = input.slice(0, 10);
    var name = METHOD_SELECTORS[selector] || ("unrecognized method " + selector);
    return { name: name, multiCall: multiCall, callCount: tx.calls ? tx.calls.length : 1 };
  }

  function buildPaymentView(receipt) {
    var feeToken = receipt.feeToken ? receipt.feeToken.toLowerCase() : null;
    var transferLogs = receipt.logs.filter(function (l) { return l.topics[0] === TRANSFER_TOPIC; });
    var memoLogs = receipt.logs.filter(function (l) { return l.topics[0] === TRANSFER_WITH_MEMO_TOPIC; });
    var mintLogs = receipt.logs.filter(function (l) { return l.topics[0] === MINT_TOPIC; });

    var feeLogIndex = -1;
    var feeEntry = null;
    if (feeToken) {
      for (var i = 0; i < transferLogs.length; i++) {
        var l = transferLogs[i];
        var to = topicToAddress(l.topics[2]).toLowerCase();
        if (l.address.toLowerCase() === feeToken && to === FEE_COLLECTOR) {
          feeLogIndex = i;
          feeEntry = { token: l.address.toLowerCase(), value: l.data, payer: topicToAddress(l.topics[1]) };
          break;
        }
      }
    }

    var remaining = transferLogs.filter(function (_, idx) { return idx !== feeLogIndex; });

    var payments = remaining.map(function (l) {
      var from = topicToAddress(l.topics[1]);
      var to = topicToAddress(l.topics[2]);
      var token = l.address.toLowerCase();
      var value = l.data;
      var isMint = from.toLowerCase() === ZERO_ADDR;
      var matchedMemo = memoLogs.find(function (m) {
        return m.address.toLowerCase() === token &&
          topicToAddress(m.topics[1]).toLowerCase() === from.toLowerCase() &&
          topicToAddress(m.topics[2]).toLowerCase() === to.toLowerCase() &&
          m.data === value;
      });
      return {
        from: from,
        to: to,
        token: token,
        value: value,
        isMint: isMint,
        memo: matchedMemo ? decodeMemo(matchedMemo.topics[3]) : null
      };
    });

    return { fee: feeEntry, payments: payments, hadMint: mintLogs.length > 0 };
  }

  function qrImgUrl(data) {
    return "https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=4&data=" + encodeURIComponent(data);
  }

  function buildReceiptCard(tx, receipt, finalizedNumber, tokenInfos, label) {
    var box = el("div", { "class": "receipt-card" });

    var printHeader = el("div", { "class": "print-only print-header" }, [
      el("h2", { text: "🧾 Tempo Payment Receipt" }),
      el("span", { text: "Checked " + new Date().toLocaleString() + " · explore.testnet.tempo.xyz" })
    ]);
    box.appendChild(printHeader);

    if (label) box.appendChild(el("p", { "class": "receipt-card-label", text: label }));

    var status = receipt.status === "0x1";
    var txBlock = parseInt(receipt.blockNumber, 16);
    var isFinal = finalizedNumber !== null && txBlock <= finalizedNumber;
    var confirmations = finalizedNumber !== null ? Math.max(0, finalizedNumber - txBlock) : null;

    var badges = el("div", { "class": "badges" }, [
      el("span", { "class": "badge " + (status ? "good" : "bad"), text: status ? "✓ Success" : "✗ Failed" }),
      el("span", { "class": "badge " + (isFinal ? "good" : "warn"), text: isFinal ? "Finalized" : "Pending finality" }),
      el("span", { "class": "badge neutral", text: "tx type " + receipt.type })
    ]);
    box.appendChild(badges);

    // Optional live confirmations — opt-in per card, driven by the same block
    // poll as the header's live indicator (see notifyLiveConfirmSubscribers).
    var liveConfText = el("span", { "class": "live-conf-text", text: "watch confirmations update live" });
    var liveConfCheckbox = el("input", { type: "checkbox" });
    var liveConfUnsub = null;
    function renderLiveConf(blockNum) {
      if (blockNum === null || blockNum === undefined) {
        liveConfText.textContent = "waiting for the next live block…";
        return;
      }
      var diff = blockNum - txBlock;
      if (diff < 0) diff = 0;
      liveConfText.textContent = diff + " confirmation" + (diff === 1 ? "" : "s") + " since block " + txBlock + " · updating live";
    }
    liveConfCheckbox.addEventListener("change", function () {
      if (liveConfCheckbox.checked) {
        renderLiveConf(latestKnownBlock);
        var handler = function (blockNum) { renderLiveConf(blockNum); };
        liveConfirmSubscribers.push(handler);
        liveConfUnsub = function () {
          var idx = liveConfirmSubscribers.indexOf(handler);
          if (idx !== -1) liveConfirmSubscribers.splice(idx, 1);
        };
      } else {
        if (liveConfUnsub) { liveConfUnsub(); liveConfUnsub = null; }
        liveConfText.textContent = "watch confirmations update live";
      }
    });
    var liveConfLabel = el("label", { "class": "live-conf-toggle" }, [liveConfCheckbox, liveConfText]);
    box.appendChild(liveConfLabel);

    var view = buildPaymentView(receipt);

    // Payment section
    var paySection = el("div", { "class": "section" });
    paySection.appendChild(el("h2", { text: "Payment" }));

    if (view.payments.length === 0) {
      paySection.appendChild(el("p", { "class": "note", text: "No recognized stablecoin transfer in this transaction — just a contract call that paid a network fee." }));
    } else {
      view.payments.forEach(function (p) {
        var info = tokenInfos[p.token] || { symbol: shortAddr(p.token), decimals: 18 };
        var flow = el("div", { "class": "payment-flow" }, [
          p.isMint ? el("span", { "class": "addr-chip", text: "faucet / mint" }) : addrChip(p.from),
          el("span", { "class": "arrow", text: "→" }),
          addrChip(p.to)
        ]);
        paySection.appendChild(flow);
        paySection.appendChild(el("div", { "class": "amount" }, [
          document.createTextNode(formatAmount(p.value, info.decimals)),
          el("span", { "class": "token", text: info.symbol + (info.unverified ? " (unverified token)" : "") })
        ]));
        if (p.memo) {
          var memoBox = el("div", { "class": "memo-box" });
          if (!p.memo.empty && p.memo.text) {
            memoBox.appendChild(el("div", { "class": "memo-text", text: "As text: “" + p.memo.text + "”" }));
          } else if (!p.memo.empty) {
            memoBox.appendChild(el("div", { "class": "memo-text", text: "Memo is binary — not human-readable text, shown as hex below." }));
          }
          if (!p.memo.empty) memoBox.appendChild(document.createTextNode(p.memo.hex));
          paySection.appendChild(memoBox);
        } else if (!p.isMint) {
          paySection.appendChild(el("p", { "class": "note", text: "No memo attached to this transfer." }));
        }
        paySection.appendChild(el("div", { style: "height:6px" }));
      });
      if (view.payments.length > 1) {
        paySection.appendChild(el("p", { "class": "note", text: "This transaction moved " + view.payments.length + " token transfers — could be a swap or batched operation, not a single clean payment." }));
      }
    }
    box.appendChild(paySection);

    // Fee section
    var feeSection = el("div", { "class": "section" });
    feeSection.appendChild(el("h2", { text: "Network fee" }));
    if (view.fee) {
      var feeInfo = tokenInfos[view.fee.token] || { symbol: shortAddr(view.fee.token), decimals: 18 };
      var feeRow = el("div", { "class": "kv-grid" });
      feeRow.appendChild(el("dt", { text: "Amount" }));
      feeRow.appendChild(el("dd", { text: formatAmount(view.fee.value, feeInfo.decimals) + " " + feeInfo.symbol }));
      feeRow.appendChild(el("dt", { text: "Paid by" }));
      var feePayerDd = el("dd", {});
      feePayerDd.appendChild(addrChip(receipt.feePayer || view.fee.payer));
      feeRow.appendChild(feePayerDd);
      feeSection.appendChild(feeRow);
      if (receipt.feePayer && tx.from && receipt.feePayer.toLowerCase() !== tx.from.toLowerCase()) {
        feeSection.appendChild(el("p", { "class": "note", text: "Fee was sponsored — the fee payer is a different address than the transaction sender. Tempo has no native gas token; fees are paid directly in a stablecoin." }));
      } else {
        feeSection.appendChild(el("p", { "class": "note", text: "Tempo has no native gas token — the fee was paid directly in this stablecoin." }));
      }
    } else {
      feeSection.appendChild(el("p", { "class": "note", text: "Could not identify a separate fee transfer for this transaction." }));
    }
    box.appendChild(feeSection);

    // Details section
    var detailsSection = el("div", { "class": "section" });
    detailsSection.appendChild(el("h2", { text: "Details" }));
    var grid = el("dl", { "class": "kv-grid" });
    function row(label, value, isAddr) {
      grid.appendChild(el("dt", { text: label }));
      var dd = el("dd", {});
      if (isAddr && value) dd.appendChild(addrChip(value));
      else dd.textContent = value;
      grid.appendChild(dd);
    }
    row("Block", String(txBlock) + (confirmations !== null ? " (" + confirmations + " blocks since)" : ""));
    if (tx.blockTimestamp) {
      var ts = parseInt(tx.blockTimestamp, 16) * 1000;
      row("Time", new Date(ts).toLocaleString());
    }
    row("From", tx.from, true);
    row("To", tx.to, true);
    var method = methodNameFor(tx);
    if (method) {
      row("Method", method.name + (method.multiCall ? " (+" + (method.callCount - 1) + " more call" + (method.callCount > 2 ? "s" : "") + " bundled)" : ""));
    }
    detailsSection.appendChild(grid);
    box.appendChild(detailsSection);

    // Actions
    var actions = el("div", { "class": "actions" }, [
      el("a", { "class": "explorer-link", href: EXPLORER_TX + tx.hash, target: "_blank", rel: "noopener", text: "View on explorer ↗" })
    ]);
    var shareBtn = el("button", { type: "button", "class": "share-btn", text: "Copy receipt link" });
    var receiptUrl = location.origin + location.pathname + "?tx=" + tx.hash;
    shareBtn.addEventListener("click", function () {
      navigator.clipboard.writeText(receiptUrl).then(function () {
        shareBtn.textContent = "Link copied!";
        setTimeout(function () { shareBtn.textContent = "Copy receipt link"; }, 1500);
      });
    });
    actions.appendChild(shareBtn);
    var printBtn = el("button", { type: "button", "class": "print-btn", text: "🖨 Print / save as PDF" });
    printBtn.addEventListener("click", function () { window.print(); });
    actions.appendChild(printBtn);
    box.appendChild(actions);

    // Footer: QR code pointing back at this exact receipt, for a printed hand-off to a customer
    var qrImg = el("img", { src: qrImgUrl(receiptUrl), alt: "QR code linking to this receipt", loading: "lazy" });
    qrImg.addEventListener("error", function () { qrBox.hidden = true; });
    var qrBox = el("div", { "class": "qr-box" }, [
      qrImg,
      el("span", { text: "Scan to re-check this receipt" })
    ]);
    box.appendChild(el("div", { "class": "receipt-foot" }, [
      el("div", { "class": "note", text: "Source: rpc.moderato.tempo.xyz, block " + txBlock + ", checked " + new Date().toLocaleString() + "." }),
      qrBox
    ]));

    return { el: box, view: view, status: status, tokenInfos: tokenInfos, tx: tx, block: txBlock };
  }

  function errorCard(label, message) {
    var box = el("div", { "class": "receipt-card" });
    if (label) box.appendChild(el("p", { "class": "receipt-card-label", text: label }));
    box.appendChild(el("p", { "class": "note", text: message }));
    return box;
  }

  function lookupOne(hash, label) {
    if (!isValidHash(hash)) {
      return Promise.resolve({
        ok: false,
        hash: hash,
        el: errorCard(label, "“" + hash + "” doesn't look like a transaction hash — it should be 0x followed by 64 hex characters.")
      });
    }

    return Promise.all([
      rpc("eth_getTransactionByHash", [hash]),
      rpc("eth_getTransactionReceipt", [hash]),
      rpc("eth_getBlockByNumber", ["finalized", false]).catch(function () { return null; })
    ]).then(function (res) {
      var tx = res[0], receipt = res[1], finalizedBlock = res[2];
      if (!tx || !receipt) {
        return {
          ok: false,
          hash: hash,
          el: errorCard(label, "No transaction found for " + hash + " on Tempo Moderato testnet (chain id 42431).")
        };
      }
      var finalizedNumber = finalizedBlock ? parseInt(finalizedBlock.number, 16) : null;

      var tokenAddrs = {};
      if (receipt.feeToken) tokenAddrs[receipt.feeToken.toLowerCase()] = true;
      receipt.logs.forEach(function (l) {
        if (l.topics[0] === TRANSFER_TOPIC) tokenAddrs[l.address.toLowerCase()] = true;
      });

      return Promise.all(Object.keys(tokenAddrs).map(function (addr) {
        return getTokenInfo(addr).then(function (info) { return [addr, info]; });
      })).then(function (pairs) {
        var tokenInfos = {};
        pairs.forEach(function (p) { tokenInfos[p[0]] = p[1]; });
        return { ok: true, hash: hash, card: buildReceiptCard(tx, receipt, finalizedNumber, tokenInfos, label) };
      });
    }).catch(function (err) {
      return {
        ok: false,
        hash: hash,
        el: errorCard(label, "Couldn't reach the Tempo RPC for " + hash + ": " + err.message + ".")
      };
    });
  }

  // Batch state persists across a filter/sort change so we don't refetch from the RPC.
  var batchState = { results: [], filterAddr: "", sort: "default" };

  function collectRecipients(results) {
    var counts = {};
    results.forEach(function (r) {
      if (!r.ok) return;
      r.card.view.payments.forEach(function (p) {
        if (p.isMint) return;
        var addr = p.to.toLowerCase();
        counts[addr] = (counts[addr] || 0) + 1;
      });
    });
    return Object.keys(counts)
      .map(function (addr) { return { addr: addr, count: counts[addr] }; })
      .sort(function (a, b) { return b.count - a.count; });
  }

  function resultMatchesRecipient(r, filterAddr) {
    if (!filterAddr) return true;
    if (!r.ok) return false; // can't tell who an unresolved tx paid, so it drops out of a merchant filter
    return r.card.view.payments.some(function (p) {
      return !p.isMint && p.to.toLowerCase() === filterAddr;
    });
  }

  function paymentTotalValue(r) {
    if (!r.ok) return BigInt(0);
    return r.card.view.payments
      .filter(function (p) { return !p.isMint; })
      .reduce(function (acc, p) { return acc + BigInt(p.value); }, BigInt(0));
  }

  function sortResults(results, sort) {
    var sorted = results.slice();
    if (sort === "amount-desc" || sort === "amount-asc") {
      sorted.sort(function (a, b) {
        var diff = paymentTotalValue(a) - paymentTotalValue(b);
        var d = diff > BigInt(0) ? 1 : (diff < BigInt(0) ? -1 : 0);
        return sort === "amount-desc" ? -d : d;
      });
    } else if (sort === "block-desc" || sort === "block-asc") {
      sorted.sort(function (a, b) {
        var ba = a.ok ? a.card.block : -1;
        var bb = b.ok ? b.card.block : -1;
        return sort === "block-desc" ? bb - ba : ba - bb;
      });
    }
    return sorted;
  }

  function csvEscape(v) {
    v = v === null || v === undefined ? "" : String(v);
    if (/[",\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
    return v;
  }

  function buildCsvRows(results) {
    var rows = [["hash", "from", "to", "token", "amount", "memo"]];
    results.forEach(function (r) {
      if (!r.ok) {
        rows.push([r.hash, "", "", "", "", "ERROR: could not resolve this transaction"]);
        return;
      }
      var view = r.card.view;
      var infos = r.card.tokenInfos;
      if (!view.payments.length) {
        rows.push([r.hash, r.card.tx.from, "", "", "", "no recognized stablecoin transfer"]);
        return;
      }
      view.payments.forEach(function (p) {
        var info = infos[p.token] || { symbol: shortAddr(p.token), decimals: 18 };
        var memo = p.memo && !p.memo.empty ? (p.memo.text || p.memo.hex) : "";
        rows.push([
          r.hash,
          p.isMint ? "faucet / mint" : p.from,
          p.to,
          info.symbol,
          formatAmount(p.value, info.decimals),
          memo
        ]);
      });
    });
    return rows;
  }

  function downloadCsv(results) {
    var rows = buildCsvRows(results);
    var csv = rows.map(function (row) { return row.map(csvEscape).join(","); }).join("\r\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = el("a", { href: url, download: "tempo-receipts-" + Date.now() + ".csv" });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function renderBatchSummary(allResults, visibleResults) {
    var box = $("batch-summary");
    box.innerHTML = "";
    if (allResults.length < 2) { box.hidden = true; return; }
    box.hidden = false;

    var recipients = collectRecipients(allResults);

    var controls = el("div", { "class": "batch-controls" });

    var filterSelect = el("select", { "class": "batch-filter", "aria-label": "Filter by recipient address" });
    filterSelect.appendChild(el("option", { value: "", text: "All recipients (" + allResults.length + " tx)" }));
    recipients.forEach(function (r) {
      var opt = el("option", { value: r.addr, text: shortAddr(r.addr) + " — " + r.count + " payment" + (r.count === 1 ? "" : "s") });
      if (r.addr === batchState.filterAddr) opt.setAttribute("selected", "selected");
      filterSelect.appendChild(opt);
    });
    filterSelect.addEventListener("change", function () {
      batchState.filterAddr = filterSelect.value;
      renderBatchList();
    });
    controls.appendChild(filterSelect);

    var sortSelect = el("select", { "class": "batch-sort", "aria-label": "Sort transactions" });
    [
      ["default", "Default order"],
      ["amount-desc", "Amount: high → low"],
      ["amount-asc", "Amount: low → high"],
      ["block-desc", "Block: newest first"],
      ["block-asc", "Block: oldest first"]
    ].forEach(function (pair) {
      var opt = el("option", { value: pair[0], text: pair[1] });
      if (pair[0] === batchState.sort) opt.setAttribute("selected", "selected");
      sortSelect.appendChild(opt);
    });
    sortSelect.addEventListener("change", function () {
      batchState.sort = sortSelect.value;
      renderBatchList();
    });
    controls.appendChild(sortSelect);

    var csvBtn = el("button", { type: "button", "class": "csv-btn", text: "⬇ Export CSV (" + visibleResults.length + ")" });
    csvBtn.addEventListener("click", function () { downloadCsv(visibleResults); });
    controls.appendChild(csvBtn);

    box.appendChild(controls);

    var filterNote = batchState.filterAddr
      ? el("p", { "class": "note batch-note", text: "Showing only payments to " + shortAddr(batchState.filterAddr) + " — " + visibleResults.length + " of " + allResults.length + " transactions." })
      : null;

    var okVisible = visibleResults.filter(function (r) { return r.ok; });
    var failVisible = visibleResults.length - okVisible.length;

    var paymentTotals = {}; // token addr -> { symbol, decimals, total: BigInt }
    var feeTotals = {};
    var paidCount = 0;

    okVisible.forEach(function (r) {
      var view = r.card.view;
      var infos = r.card.tokenInfos;
      if (view.payments.length) paidCount++;
      view.payments.forEach(function (p) {
        if (p.isMint) return; // faucet mints aren't a merchant payment total
        if (batchState.filterAddr && p.to.toLowerCase() !== batchState.filterAddr) return;
        var info = infos[p.token] || { symbol: shortAddr(p.token), decimals: 18 };
        if (!paymentTotals[p.token]) paymentTotals[p.token] = { symbol: info.symbol, decimals: info.decimals, total: BigInt(0) };
        paymentTotals[p.token].total += BigInt(p.value);
      });
      if (view.fee) {
        var feeInfo = infos[view.fee.token] || { symbol: shortAddr(view.fee.token), decimals: 18 };
        if (!feeTotals[view.fee.token]) feeTotals[view.fee.token] = { symbol: feeInfo.symbol, decimals: feeInfo.decimals, total: BigInt(0) };
        feeTotals[view.fee.token].total += BigInt(view.fee.value);
      }
    });

    box.appendChild(el("h2", { text: "Batch summary — " + visibleResults.length + " transactions" }));
    if (filterNote) box.appendChild(filterNote);
    var stats = el("div", { "class": "batch-stats" }, [
      el("span", {}, [document.createTextNode("Checked: "), el("b", { text: String(visibleResults.length) })]),
      el("span", {}, [document.createTextNode("With a payment: "), el("b", { text: String(paidCount) })]),
      el("span", {}, [document.createTextNode("Failed to resolve: "), el("b", { text: String(failVisible) })])
    ]);
    box.appendChild(stats);

    var totalsBox = el("div", { "class": "batch-totals" });
    Object.keys(paymentTotals).forEach(function (addr) {
      var t = paymentTotals[addr];
      totalsBox.appendChild(el("div", { "class": "batch-total-row" }, [
        el("span", { text: "Total received, " + t.symbol }),
        el("span", { "class": "amt", text: formatAmount("0x" + t.total.toString(16), t.decimals) + " " + t.symbol })
      ]));
    });
    Object.keys(feeTotals).forEach(function (addr) {
      var t = feeTotals[addr];
      totalsBox.appendChild(el("div", { "class": "batch-total-row" }, [
        el("span", { text: "Total fees paid, " + t.symbol }),
        el("span", { "class": "amt", text: formatAmount("0x" + t.total.toString(16), t.decimals) + " " + t.symbol })
      ]));
    });
    if (!Object.keys(paymentTotals).length) {
      totalsBox.appendChild(el("p", { "class": "note batch-note", text: "None of these transactions carried a recognized stablecoin payment." }));
    }
    box.appendChild(totalsBox);
  }

  function renderBatchList() {
    // Re-filters/sorts the already-built card elements from the last fetch —
    // no refetch, and a card's live-confirmation toggle keeps its state even
    // if the card is temporarily filtered out and shown again later.
    var resultBox = $("result");
    resultBox.innerHTML = "";

    var visible = batchState.results.filter(function (r) { return resultMatchesRecipient(r, batchState.filterAddr); });
    visible = sortResults(visible, batchState.sort);
    visible.forEach(function (r) { resultBox.appendChild(r.ok ? r.card.el : r.el); });

    renderBatchSummary(batchState.results, visible);
  }

  function lookup(rawInput) {
    var hashes = (rawInput || "")
      .split(",")
      .map(function (h) { return h.trim(); })
      .filter(function (h) { return h.length > 0; });

    var resultBox = $("result");
    resultBox.innerHTML = "";
    $("batch-summary").hidden = true;
    liveConfirmSubscribers = [];
    batchState = { results: [], filterAddr: "", sort: "default" };

    if (!hashes.length) {
      setStatus("Paste a transaction hash (or several, comma-separated) to check a receipt.", "error");
      return;
    }

    setStatus(
      hashes.length === 1
        ? "Fetching from Tempo Moderato testnet…"
        : "Fetching " + hashes.length + " transactions from Tempo Moderato testnet…",
      "loading"
    );
    history.replaceState(null, "", location.pathname + "?tx=" + hashes.join(","));

    var multi = hashes.length > 1;
    Promise.all(hashes.map(function (h, idx) {
      var label = multi ? "Transaction " + (idx + 1) + " of " + hashes.length : null;
      return lookupOne(h, label);
    })).then(function (results) {
      clearStatus();
      batchState.results = results;
      renderBatchList();
      if (results.every(function (r) { return !r.ok; })) {
        setStatus("Couldn't resolve any of the given hashes on Tempo Moderato testnet. Check them and try again.", "error");
      }
    });
  }

  var LIVE_POLL_MS = 8000;

  function startLiveIndicator() {
    var box = $("live-indicator");
    var text = $("live-text");
    box.hidden = false;
    var misses = 0;

    function poll() {
      rpc("eth_blockNumber", []).then(function (hex) {
        misses = 0;
        box.classList.remove("stale");
        var num = parseInt(hex, 16);
        text.textContent = "live · block #" + num;
        notifyLiveConfirmSubscribers(num);
      }).catch(function () {
        misses++;
        if (misses >= 2) {
          box.classList.add("stale");
          text.textContent = "live data unavailable";
        }
      });
    }

    poll();
    setInterval(poll, LIVE_POLL_MS);
  }

  document.addEventListener("DOMContentLoaded", function () {
    renderExamples();
    startLiveIndicator();
    $("lookup-form").addEventListener("submit", function (e) {
      e.preventDefault();
      lookup($("tx-input").value);
    });
    $("batch-example-btn").addEventListener("click", function () {
      var batch = EXAMPLES.slice(0, 2).map(function (ex) { return ex.hash; }).join(",");
      $("tx-input").value = batch;
      lookup(batch);
    });

    var params = new URLSearchParams(location.search);
    var fromUrl = params.get("tx");
    if (fromUrl) {
      $("tx-input").value = fromUrl;
      lookup(fromUrl);
    }
  });
})();
