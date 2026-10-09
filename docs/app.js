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

  function renderResult(tx, receipt, finalizedNumber, tokenInfos) {
    var box = $("result");
    box.innerHTML = "";
    box.hidden = false;

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
    var shareBtn = el("button", { type: "button", text: "Copy receipt link" });
    shareBtn.addEventListener("click", function () {
      var url = location.origin + location.pathname + "?tx=" + tx.hash;
      navigator.clipboard.writeText(url).then(function () {
        shareBtn.textContent = "Link copied!";
        setTimeout(function () { shareBtn.textContent = "Copy receipt link"; }, 1500);
      });
    });
    actions.appendChild(shareBtn);
    box.appendChild(actions);
  }

  function lookup(rawHash) {
    var hash = (rawHash || "").trim();
    $("result").hidden = true;

    if (!isValidHash(hash)) {
      setStatus("That doesn't look like a transaction hash. It should be 0x followed by 64 hex characters.", "error");
      return;
    }

    setStatus("Fetching from Tempo Moderato testnet…", "loading");
    history.replaceState(null, "", location.pathname + "?tx=" + hash);

    Promise.all([
      rpc("eth_getTransactionByHash", [hash]),
      rpc("eth_getTransactionReceipt", [hash]),
      rpc("eth_getBlockByNumber", ["finalized", false]).catch(function () { return null; })
    ]).then(function (res) {
      var tx = res[0], receipt = res[1], finalizedBlock = res[2];
      if (!tx || !receipt) {
        setStatus("No transaction found with that hash on Tempo Moderato testnet (chain id 42431). Check the hash and make sure it's from this network.", "error");
        return;
      }
      var finalizedNumber = finalizedBlock ? parseInt(finalizedBlock.number, 16) : null;

      var tokenAddrs = {};
      if (receipt.feeToken) tokenAddrs[receipt.feeToken.toLowerCase()] = true;
      receipt.logs.forEach(function (l) {
        if (l.topics[0] === TRANSFER_TOPIC) tokenAddrs[l.address.toLowerCase()] = true;
      });

      Promise.all(Object.keys(tokenAddrs).map(function (addr) {
        return getTokenInfo(addr).then(function (info) { return [addr, info]; });
      })).then(function (pairs) {
        var tokenInfos = {};
        pairs.forEach(function (p) { tokenInfos[p[0]] = p[1]; });
        clearStatus();
        renderResult(tx, receipt, finalizedNumber, tokenInfos);
      });
    }).catch(function (err) {
      setStatus("Couldn't reach the Tempo RPC: " + err.message + ". Try again in a moment.", "error");
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    renderExamples();
    $("lookup-form").addEventListener("submit", function (e) {
      e.preventDefault();
      lookup($("tx-input").value);
    });

    var params = new URLSearchParams(location.search);
    var fromUrl = params.get("tx");
    if (fromUrl) {
      $("tx-input").value = fromUrl;
      lookup(fromUrl);
    }
  });
})();
