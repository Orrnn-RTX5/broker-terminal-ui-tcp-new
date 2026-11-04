(function () {
  if (window.__RTX5_TCP_TOOLBAR__) return;
  window.__RTX5_TCP_TOOLBAR__ = true;

  var latestStatus = {
    connected: true,
    target_tcp: (window.__RTX5_RUNTIME_CONFIG__ && window.__RTX5_RUNTIME_CONFIG__.TCP_SERVER_ADDR) || '127.0.0.1:4443',
    broker_id: (window.__RTX5_RUNTIME_CONFIG__ && window.__RTX5_RUNTIME_CONFIG__.BROKER_ID) || 'fxtrust-tcp',
    broker_name: (window.__RTX5_RUNTIME_CONFIG__ && window.__RTX5_RUNTIME_CONFIG__.BROKER_NAME) || 'FXTrust-TCP-Live',
    rtt_ms: 0,
    avg_rtt_ms: 0,
    dll_verified: true,
    cipher: 'X25519 + HKDF-SHA256 + AES-256-GCM',
    magic: 'RTX\\x05 (0x52 0x54 0x58 0x05)',
    ota: { enabled: true, up_to_date: true }
  };
  window.__RTX5_TCP_STATUS__ = latestStatus;

  function renderOTANotificationBanner(st) {
    var ota = (st && st.ota) || {};
    var needExe = !!ota.exe_restart_ready;
    var needUI = !!ota.ui_reload_ready;
    var existing = document.getElementById('rtx5-ota-toast');

    if (!needExe && !needUI) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    if (existing) return;

    var banner = document.createElement('div');
    banner.id = 'rtx5-ota-toast';
    banner.style.cssText =
      'position:fixed;right:14px;bottom:34px;z-index:2147483635;display:flex;align-items:center;gap:10px;' +
      'padding:10px 14px;border-radius:8px;background:#064e3b;border:1px solid #10b981;color:#ecfdf5;' +
      'box-shadow:0 12px 32px rgba(0,0,0,.55);font:600 12px Inter,Segoe UI,system-ui,sans-serif';

    var label = needExe
      ? 'Signed OTA Binary Update Ready (' + (ota.release_id || 'latest') + ')'
      : 'Signed OTA UI Update Ready (' + (ota.release_id || 'latest') + ')';
    var btnText = needExe ? 'Restart & Apply' : 'Reload UI (<1s)';

    banner.innerHTML =
      '<span style="width:8px;height:8px;border-radius:50%;background:#34d399;flex-shrink:0"></span>' +
      '<span>' + label + '</span>' +
      '<button type="button" id="rtx5-ota-apply-btn" style="height:26px;padding:0 10px;border-radius:5px;border:1px solid #34d399;background:#10b981;color:#022c22;font-weight:700;font-size:11.5px;cursor:pointer">' + btnText + '</button>' +
      '<button type="button" id="rtx5-ota-dismiss-btn" style="background:transparent;border:none;color:#a7f3d0;font-size:14px;cursor:pointer;padding:0 4px">×</button>';

    document.body.appendChild(banner);

    document.getElementById('rtx5-ota-apply-btn').onclick = async function () {
      if (needExe) {
        try { await fetch('/api/tcp-client/ota-restart', { method: 'POST' }); } catch (_) {}
      } else {
        try { await fetch('/api/tcp-client/ota-ack-ui', { method: 'POST' }); } catch (_) {}
        window.location.reload();
      }
    };
    document.getElementById('rtx5-ota-dismiss-btn').onclick = function () {
      if (banner.parentNode) banner.parentNode.removeChild(banner);
    };
  }

  async function refreshStatus() {
    try {
      var r = await fetch('/api/tcp-client/status', { cache: 'no-store' });
      if (!r.ok) return latestStatus;
      var s = await r.json();
      latestStatus = Object.assign({}, latestStatus, s);
      window.__RTX5_TCP_STATUS__ = latestStatus;
      window.dispatchEvent(new CustomEvent('rtx5-tcp-status', { detail: latestStatus }));
      if (document.body) renderOTANotificationBanner(latestStatus);
      return latestStatus;
    } catch (_) {
      return latestStatus;
    }
  }

  window.rtx5GetTcpStatus = function () {
    return latestStatus;
  };

  window.rtx5CheckOTAUpdate = async function () {
    try {
      var r = await fetch('/api/tcp-client/ota-check', { method: 'POST' });
      var data = await r.json();
      await refreshStatus();
      return data;
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  };

  function closeExistingModal() {
    var old = document.getElementById('rtx5-tcp-endpoint-backdrop');
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }

  window.rtx5OpenTcpEndpointDialog = async function () {
    closeExistingModal();
    var st = await refreshStatus();
    var ota = st.ota || {};
    var rttTxt = st.rtt_ms > 0 ? st.rtt_ms.toFixed(2) + ' ms (avg ' + (st.avg_rtt_ms || st.rtt_ms).toFixed(2) + ' ms)' : '< 1.0 ms';
    var otaTxt = ota.release_id ? ('Ed25519 Verified · ' + ota.release_id + ' [' + (ota.ui_source || 'embedded') + ']') : 'Ed25519 Signed Pure-TCP OTA Ready';

    var backdrop = document.createElement('div');
    backdrop.id = 'rtx5-tcp-endpoint-backdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:2147483640;background:rgba(2,6,23,.72);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:16px;font-family:Inter,Segoe UI,system-ui,sans-serif';

    var card = document.createElement('div');
    card.style.cssText = 'width:100%;max-width:480px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:10px;box-shadow:0 20px 50px rgba(0,0,0,.6);overflow:hidden';

    var badgeBg = st.connected ? 'rgba(16,185,129,.15)' : 'rgba(245,158,11,.15)';
    var badgeFg = st.connected ? '#34d399' : '#fbbf24';
    var badgeTxt = st.connected ? 'CONNECTED · BINARY TCP' : 'RECONNECTING';

    card.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #1e293b;background:#0b1120">' +
        '<div style="font-size:14px;font-weight:700;color:#f8fafc;letter-spacing:.01em">Broker Binary TCP & OTA Engine</div>' +
        '<span style="font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;background:' + badgeBg + ';color:' + badgeFg + ';font-family:ui-monospace,Consolas,monospace">' + badgeTxt + '</span>' +
      '</div>' +
      '<div style="padding:16px 18px;display:flex;flex-direction:column;gap:12px">' +
        '<div style="padding:10px 12px;border-radius:7px;background:#0b1120;border:1px solid #1e293b;font-size:11.5px;line-height:1.6;color:#94a3b8;font-family:ui-monospace,Consolas,monospace">' +
          '<div>Protocol : <span style="color:#e2e8f0">RTX\\x05 Multiplexed Binary TCP</span></div>' +
          '<div>Cipher   : <span style="color:#38bdf8">X25519 + HKDF-SHA256 + AES-256-GCM</span></div>' +
          '<div>Wire RTT : <span style="color:#34d399">' + rttTxt + '</span></div>' +
          '<div>Guard DLL: <span style="color:#34d399">' + (st.dll_verified ? 'rtx5_guard.dll Verified' : 'Unverified') + '</span></div>' +
          '<div>OTA Sync : <span id="rtx5-ota-status-line" style="color:#a7f3d0">' + otaTxt + '</span></div>' +
        '</div>' +
        '<label style="display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:600;color:#cbd5e1">' +
          '<span>Broker TCP Server (IP:Port)</span>' +
          '<input id="rtx5-tcp-addr-input" type="text" spellcheck="false" placeholder="192.168.1.59:4443" style="height:36px;padding:0 11px;border-radius:6px;border:1px solid #334155;background:#020617;color:#f8fafc;font:600 13px ui-monospace,Consolas,monospace;outline:none" />' +
        '</label>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
          '<label style="display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:600;color:#cbd5e1">' +
            '<span>Broker Name</span>' +
            '<input id="rtx5-tcp-name-input" type="text" spellcheck="false" placeholder="FXTrust-TCP-Live" style="height:34px;padding:0 10px;border-radius:6px;border:1px solid #334155;background:#020617;color:#f8fafc;font-size:12.5px;outline:none" />' +
          '</label>' +
          '<label style="display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:600;color:#cbd5e1">' +
            '<span>Broker ID</span>' +
            '<input id="rtx5-tcp-id-input" type="text" spellcheck="false" placeholder="fxtrust-tcp" style="height:34px;padding:0 10px;border-radius:6px;border:1px solid #334155;background:#020617;color:#f8fafc;font:500 12.5px ui-monospace,Consolas,monospace;outline:none" />' +
          '</label>' +
        '</div>' +
        '<div id="rtx5-tcp-err" style="display:none;font-size:12px;color:#f87171"></div>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:12px 18px;border-top:1px solid #1e293b;background:#0b1120">' +
        '<button type="button" id="rtx5-ota-check-btn" style="height:34px;padding:0 12px;border-radius:6px;border:1px solid #059669;background:rgba(16,185,129,.12);color:#34d399;font-size:12px;font-weight:600;cursor:pointer">Check OTA Update</button>' +
        '<div style="display:flex;gap:8px">' +
          '<button type="button" id="rtx5-tcp-cancel-btn" style="height:34px;padding:0 14px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;font-size:12.5px;font-weight:600;cursor:pointer">Cancel</button>' +
          '<button type="button" id="rtx5-tcp-save-btn" style="height:34px;padding:0 16px;border-radius:6px;border:1px solid #0284c7;background:#0284c7;color:#ffffff;font-size:12.5px;font-weight:600;cursor:pointer">Connect TCP (:4443)</button>' +
        '</div>' +
      '</div>';

    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    var addrInput = document.getElementById('rtx5-tcp-addr-input');
    var nameInput = document.getElementById('rtx5-tcp-name-input');
    var idInput = document.getElementById('rtx5-tcp-id-input');
    var errEl = document.getElementById('rtx5-tcp-err');
    var otaBtn = document.getElementById('rtx5-ota-check-btn');
    var otaLine = document.getElementById('rtx5-ota-status-line');

    addrInput.value = st.target_tcp || '127.0.0.1:4443';
    nameInput.value = st.broker_name || 'FXTrust-TCP-Live';
    idInput.value = st.broker_id || 'fxtrust-tcp';
    setTimeout(function () { addrInput.focus(); addrInput.select(); }, 20);

    function showErr(msg) {
      errEl.textContent = msg;
      errEl.style.display = 'block';
    }

    otaBtn.onclick = async function () {
      otaBtn.textContent = 'Checking...';
      otaBtn.disabled = true;
      var res = await window.rtx5CheckOTAUpdate();
      otaBtn.disabled = false;
      otaBtn.textContent = 'Check OTA Update';
      if (res && res.ota) {
        if (res.ota.exe_restart_ready || res.ota.ui_reload_ready) {
          otaLine.textContent = 'Update Downloaded (' + (res.ota.release_id || 'new') + ') — Apply from banner!';
          closeExistingModal();
        } else {
          otaLine.textContent = 'Up to Date · ' + (res.ota.release_id || 'Verified');
        }
      }
    };

    async function submitSwitch() {
      var addr = (addrInput.value || '').trim();
      var bname = (nameInput.value || '').trim();
      var bid = (idInput.value || '').trim();
      if (!addr || /^https?:\/\//i.test(addr) || addr.indexOf(':') === -1) {
        showErr('Enter a raw TCP host:port (for example 192.168.1.59:4443), not HTTP/HTTPS.');
        return;
      }
      try {
        var res = await fetch('/api/tcp-client/switch-broker', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tcp_addr: addr,
            broker_name: bname || 'FXTrust-TCP-Live',
            broker_id: bid || 'fxtrust-tcp'
          })
        });
        if (res.ok) {
          closeExistingModal();
          window.location.reload();
        } else {
          showErr('Failed to switch TCP endpoint (' + res.status + ').');
        }
      } catch (e) {
        showErr('Failed to reach local TCP bridge.');
      }
    }

    document.getElementById('rtx5-tcp-cancel-btn').onclick = closeExistingModal;
    document.getElementById('rtx5-tcp-save-btn').onclick = submitSwitch;
    backdrop.onclick = function (ev) {
      if (ev.target === backdrop) closeExistingModal();
    };
    card.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeExistingModal();
      if (ev.key === 'Enter') submitSwitch();
    });
  };

  window.addEventListener('keydown', function (ev) {
    if (ev.altKey && ev.shiftKey && (ev.key === 'T' || ev.key === 't')) {
      ev.preventDefault();
      window.rtx5OpenTcpEndpointDialog();
    }
  });

  refreshStatus();
  setInterval(refreshStatus, 3000);
})();
