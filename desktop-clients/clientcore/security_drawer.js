(function () {
  if (window.__RTX5_TCP_SECURITY_DRAWER__) return;
  window.__RTX5_TCP_SECURITY_DRAWER__ = true;

  var open = false;
  var state = null;
  var localChannel = 'production';
  var localOtaSnap = null;

  var style = document.createElement('style');
  style.textContent = [
    '#rtx5-sec-fab{position:fixed;right:18px;bottom:18px;z-index:2147483640;display:flex;align-items:center;gap:8px;padding:9px 14px;border-radius:999px;background:linear-gradient(135deg,#0f172a,#1e293b);color:#f8fafc;border:1px solid #38bdf8;box-shadow:0 8px 24px rgba(0,0,0,.45);cursor:pointer;font:600 12px/1.2 system-ui,-apple-system,sans-serif;user-select:none}',
    '#rtx5-sec-fab.has-alert{border-color:#ef4444;background:linear-gradient(135deg,#450a0a,#7f1d1d);animation:rtx5pulse 1.6s infinite}',
    '@keyframes rtx5pulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.55)}50%{box-shadow:0 0 0 10px rgba(239,68,68,0)}}',
    '#rtx5-sec-drawer{position:fixed;top:0;right:0;bottom:0;width:560px;max-width:96vw;z-index:2147483641;background:#0b1120;color:#e2e8f0;border-left:1px solid #1e293b;box-shadow:-12px 0 36px rgba(0,0,0,.6);transform:translateX(102%);transition:transform .22s ease;display:flex;flex-direction:column;font:12px/1.45 system-ui,-apple-system,sans-serif}',
    '#rtx5-sec-drawer.open{transform:translateX(0)}',
    '.rtx5-shdr{padding:14px 16px;background:#0f172a;border-bottom:1px solid #1e293b;display:flex;justify-content:space-between;align-items:center}',
    '.rtx5-sbody{padding:14px 16px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:14px}',
    '.rtx5-scard{background:#111827;border:1px solid #1f2937;border-radius:10px;padding:12px}',
    '.rtx5-scard.alert{border-color:#dc2626;background:#1f0a0d}',
    '.rtx5-srow{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}',
    '.rtx5-sbadge{padding:2px 8px;border-radius:999px;font-weight:700;font-size:10px;letter-spacing:.4px}',
    '.rtx5-sbadge.ok{background:#064e3b;color:#34d399;border:1px solid #059669}',
    '.rtx5-sbadge.off{background:#1e293b;color:#94a3b8;border:1px solid #334155}',
    '.rtx5-sbadge.err{background:#7f1d1d;color:#fca5a5;border:1px solid #dc2626}',
    '.rtx5-sbtn{padding:5px 10px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#f8fafc;cursor:pointer;font:600 11px system-ui}',
    '.rtx5-sbtn:hover{background:#334155}',
    '.rtx5-sbtn.pri{background:#0284c7;border-color:#0ea5e9}',
    '.rtx5-sbtn.dng{background:#991b1b;border-color:#dc2626}',
    '.rtx5-smono{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#93c5fd;word-break:break-all}',
    '.rtx5-sinp{background:#0b1120;border:1px solid #334155;color:#f8fafc;border-radius:6px;padding:5px 8px;font-size:11px;width:100%}'
  ].join('\n');
  document.head.appendChild(style);

  var fab = document.createElement('div');
  fab.id = 'rtx5-sec-fab';
  fab.innerHTML = '<span>6-Layer TCP Security & LP Hub</span><span id="rtx5-sec-pill" class="rtx5-sbadge ok">LIVE</span>';
  fab.onclick = function () {
    open = !open;
    drawer.classList.toggle('open', open);
    if (open) refresh();
  };

  var drawer = document.createElement('div');
  drawer.id = 'rtx5-sec-drawer';
  drawer.innerHTML = [
    '<div class="rtx5-shdr">',
    '  <div><div style="font-weight:700;font-size:14px;color:#38bdf8">6-Layer Anti-Cloning & Binary TCP Hub (:9100)</div>',
    '  <div style="font-size:11px;color:#94a3b8">Magic: RTX\\x05 | X25519+AES-256-GCM | 32B Nonce | HWID+DPAPI | DLL Attestation</div></div>',
    '  <button class="rtx5-sbtn" id="rtx5-sec-close">Close</button>',
    '</div>',
    '<div class="rtx5-sbody" id="rtx5-sec-content">Loading live telemetry...</div>'
  ].join('');

  function mount() {
    if (!document.body) { setTimeout(mount, 100); return; }
    document.body.appendChild(fab);
    document.body.appendChild(drawer);
    document.getElementById('rtx5-sec-close').onclick = function () {
      open = false;
      drawer.classList.remove('open');
    };
    refresh();
    setInterval(refresh, 4000);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  async function apiPost(path, body) {
    var r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    return r.json().catch(function () { return {}; });
  }

  window.__rtx5SecAction = async function (act, brokerId) {
    if (act === 'lp-connect') {
      await apiPost('/api/tcp-security/lp-feed/control', { action: 'connect' });
    } else if (act === 'lp-disconnect') {
      await apiPost('/api/tcp-security/lp-feed/control', { action: 'disconnect' });
    } else if (act === 'reset-hwid') {
      if (!confirm('Reset Hardware Lock (HWID + DPAPI Device Key) for ' + brokerId + ' so it can activate on new server hardware?')) return;
      await apiPost('/api/tcp-security/brokers/action', { broker_id: brokerId, action: 'reset_hwid' });
    } else if (act === 'kill') {
      await apiPost('/api/tcp-security/brokers/action', { broker_id: brokerId, action: 'suspend' });
    } else if (act === 'activate') {
      await apiPost('/api/tcp-security/brokers/action', { broker_id: brokerId, action: 'activate' });
    } else if (act === 'update-ip') {
      var ip = prompt('Enter licensed AllowedServerIP (comma-separated IPs/CIDRs) for ' + brokerId + ':', '127.0.0.1');
      if (!ip) return;
      await apiPost('/api/tcp-security/brokers/action', { broker_id: brokerId, action: 'update_ip', allowed_server_ip: ip });
    } else if (act === 'clear-alerts') {
      await apiPost('/api/tcp-security/alerts/clear', {});
    } else if (act === 'ota-promote-beta') {
      await apiPost('/api/tcp-security/ota/promote', { from_channel: 'alpha', to_channel: 'beta' });
    } else if (act === 'ota-promote-prod') {
      await apiPost('/api/tcp-security/ota/promote', { from_channel: 'beta', to_channel: 'production' });
    } else if (act === 'ota-local-channel') {
      var ch = String(brokerId || 'production').toLowerCase();
      var cRes = await apiPost('/api/tcp-client/ota-channel', { channel: ch });
      if (cRes && cRes.channel) localChannel = cRes.channel;
      if (cRes && cRes.ota) localOtaSnap = cRes.ota;
    } else if (act === 'issue') {
      var bid = document.getElementById('rtx5-iss-id').value.trim();
      var bnm = document.getElementById('rtx5-iss-name').value.trim();
      var aip = document.getElementById('rtx5-iss-ip').value.trim();
      var btcp = document.getElementById('rtx5-iss-tcp').value.trim();
      if (!bid || !aip) { alert('Broker ID and Allowed Server IP are required'); return; }
      var res = await apiPost('/api/tcp-security/brokers/issue', {
        broker_id: bid, broker_name: bnm || bid, plan: 'ENT_TCP',
        allowed_server_ip: aip, broker_public_tcp: btcp || (aip.split(',')[0].trim() + ':4443'),
        max_accounts: 50000, max_symbols: 2500, max_managers: 100
      });
      if (res && res.certificate) {
        var blob = new Blob([JSON.stringify(res.certificate, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = bid + '-broker.lic';
        a.click();
      }
    }
    refresh();
  };

  async function refresh() {
    try {
      fetch('/api/tcp-client/status').then(function (cr) {
        return cr.ok ? cr.json() : null;
      }).then(function (cs) {
        if (cs && cs.ota) {
          localOtaSnap = cs.ota;
          if (cs.ota.channel) localChannel = cs.ota.channel;
        }
      }).catch(function () {});

      var r = await fetch('/api/tcp-security/overview');
      if (!r.ok) {
        var pill = document.getElementById('rtx5-sec-pill');
        if (pill) {
          pill.className = 'rtx5-sbadge err';
          pill.textContent = 'OFFLINE';
        }
        return;
      }
      state = await r.json();
      render();
    } catch {
      var pill2 = document.getElementById('rtx5-sec-pill');
      if (pill2) {
        pill2.className = 'rtx5-sbadge err';
        pill2.textContent = 'OFFLINE';
      }
    }
  }

  function fmtOtaChan(info) {
    if (!info) return 'No Release';
    if (typeof info === 'string') return info;
    var ver = info.version ? ('v' + String(info.version).replace(/^v/i, '')) : '';
    var rel = info.release_id || info.id || '';
    if (ver && rel) return ver + ' · ' + rel;
    return rel || ver || 'Active';
  }

  function render() {
    if (!state) return;
    var alerts = (state.alerts || []).filter(function (a) { return a.severity === 'CRITICAL' || a.severity === 'HIGH'; });
    var onlineCount = (state.brokers || []).filter(function (b) { return b.online; }).length;
    fab.classList.toggle('has-alert', alerts.length > 0);
    var pill = document.getElementById('rtx5-sec-pill');
    if (pill) {
      pill.className = 'rtx5-sbadge ' + (alerts.length > 0 ? 'err' : 'ok');
      pill.textContent = alerts.length > 0 ? (alerts.length + ' ALERT') : (onlineCount + ' ONLINE');
    }
    if (!open) return;

    var lp = state.lp_feed || {};
    var lpOk = Boolean(lp.bridge_connected);
    var html = [];

    html.push('<div class="rtx5-scard"><div class="rtx5-srow"><strong>Central LP Feed — IC Markets UK cServer (FIX 4.4 / 6157214)</strong>');
    html.push('<span class="rtx5-sbadge ' + (lpOk ? 'ok' : 'off') + '">' + (lpOk ? 'STREAMING LIVE' : 'IDLE') + '</span></div>');
    html.push('<div style="margin-top:6px;color:#94a3b8">Quotes Broadcasted: <strong style="color:#f8fafc">' + esc(lp.quotes_relayed || 0) + '</strong> | Active Symbols: <strong style="color:#f8fafc">' + esc(lp.streaming_symbols || 0) + '</strong> | Last Symbol: <span class="rtx5-smono">' + esc(lp.last_symbol || '-') + '</span></div>');
    html.push('<div style="margin-top:8px;display:flex;gap:8px"><button class="rtx5-sbtn pri" onclick="__rtx5SecAction(\'lp-connect\')">Connect IC Markets 6157214</button><button class="rtx5-sbtn" onclick="__rtx5SecAction(\'lp-disconnect\')">Disconnect LP</button></div></div>');

    var otaChans = state.ota_channels || {};
    var alphaInfo = fmtOtaChan(otaChans.alpha);
    var betaInfo = fmtOtaChan(otaChans.beta);
    var prodInfo = fmtOtaChan(otaChans.production);
    var curLocalCh = String((localOtaSnap && localOtaSnap.channel) || localChannel || 'production').toLowerCase();

    html.push('<div class="rtx5-scard"><div class="rtx5-srow"><strong>Multi-Platform OTA Release Pipeline (Alpha → Beta → Production)</strong>');
    html.push('<span class="rtx5-sbadge ok">ED25519 SIGNED</span></div>');
    html.push('<div style="margin-top:8px;display:grid;grid-template-columns:repeat(3,1fr);gap:8px">');
    html.push('  <div style="background:#0b1120;border:1px solid #1e293b;border-radius:7px;padding:7px 9px"><div style="font-size:10px;font-weight:700;color:#fbbf24">ALPHA (DEV)</div><div class="rtx5-smono" style="margin-top:3px;color:#f8fafc">' + esc(alphaInfo) + '</div></div>');
    html.push('  <div style="background:#0b1120;border:1px solid #1e293b;border-radius:7px;padding:7px 9px"><div style="font-size:10px;font-weight:700;color:#38bdf8">BETA (TESTERS)</div><div class="rtx5-smono" style="margin-top:3px;color:#f8fafc">' + esc(betaInfo) + '</div></div>');
    html.push('  <div style="background:#0b1120;border:1px solid #1e293b;border-radius:7px;padding:7px 9px"><div style="font-size:10px;font-weight:700;color:#34d399">PRODUCTION</div><div class="rtx5-smono" style="margin-top:3px;color:#f8fafc">' + esc(prodInfo) + '</div></div>');
    html.push('</div>');
    html.push('<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">');
    html.push('  <button class="rtx5-sbtn pri" onclick="__rtx5SecAction(\'ota-promote-beta\')">Promote Alpha → Beta (Testers)</button>');
    html.push('  <button class="rtx5-sbtn pri" style="background:#059669;border-color:#10b981" onclick="__rtx5SecAction(\'ota-promote-prod\')">Promote Beta → Production (All Brokers & Users)</button>');
    html.push('</div>');
    html.push('<div style="margin-top:8px;padding-top:8px;border-top:1px solid #1f2937;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">');
    html.push('  <span style="color:#94a3b8;font-size:11px">Local Client OTA Channel: <strong style="color:#f8fafc;text-transform:uppercase">' + esc(curLocalCh) + '</strong></span>');
    html.push('  <div style="display:flex;gap:5px">');
    html.push('    <button class="rtx5-sbtn' + (curLocalCh === 'alpha' ? ' pri' : '') + '" onclick="__rtx5SecAction(\'ota-local-channel\',\'alpha\')">Alpha</button>');
    html.push('    <button class="rtx5-sbtn' + (curLocalCh === 'beta' ? ' pri' : '') + '" onclick="__rtx5SecAction(\'ota-local-channel\',\'beta\')">Beta</button>');
    html.push('    <button class="rtx5-sbtn' + (curLocalCh === 'production' ? ' pri' : '') + '" onclick="__rtx5SecAction(\'ota-local-channel\',\'production\')">Production</button>');
    html.push('  </div>');
    html.push('</div></div>');

    if (alerts.length > 0) {
      html.push('<div class="rtx5-scard alert"><div class="rtx5-srow"><strong style="color:#fca5a5">RED ANTI-CLONE & TAMPER ALERTS (' + alerts.length + ')</strong><button class="rtx5-sbtn" onclick="__rtx5SecAction(\'clear-alerts\')">Clear</button></div>');
      alerts.slice(0, 6).forEach(function (a) {
        html.push('<div style="margin-top:8px;padding-top:8px;border-top:1px solid #450a0a">');
        html.push('<div class="rtx5-srow"><span class="rtx5-sbadge err">' + esc(a.code) + '</span><span style="color:#fca5a5;font-size:11px">Broker: ' + esc(a.broker_id) + ' | Attempted IP: ' + esc(a.attempted_ip || '-') + '</span></div>');
        html.push('<div style="color:#fecaca;margin-top:3px">' + esc(a.message) + '</div>');
        if (a.attempted_hwid) html.push('<div class="rtx5-smono" style="margin-top:2px">Attempted HWID: ' + esc(a.attempted_hwid.slice(0, 32)) + '...</div>');
        html.push('</div>');
      });
      html.push('</div>');
    }

    html.push('<div class="rtx5-scard"><div style="font-weight:700;margin-bottom:8px">Licensed Broker Binary TCP Tunnels (' + (state.brokers || []).length + ')</div>');
    (state.brokers || []).forEach(function (b) {
      var rem = Math.max(0, (b.lease_expires_unix || 0) - Math.floor(Date.now() / 1000));
      html.push('<div style="padding:10px 0;border-top:1px solid #1f2937">');
      html.push('<div class="rtx5-srow"><strong>' + esc(b.broker_name) + ' (' + esc(b.broker_id) + ')</strong>');
      html.push('<span class="rtx5-sbadge ' + (b.online ? 'ok' : (b.status === 'active' ? 'off' : 'err')) + '">' + (b.online ? ('ONLINE · Lease ' + rem + 's') : esc(b.status).toUpperCase()) + '</span></div>');
      html.push('<div style="margin-top:4px;color:#94a3b8">Allowed IP: <span class="rtx5-smono">' + esc(b.allowed_server_ip) + '</span> | Observed IP: <span class="rtx5-smono">' + esc(b.last_observed_ip || '-') + '</span> | Nonce RTT: <strong>' + Number(b.last_nonce_rtt_ms || 0).toFixed(2) + 'ms</strong></div>');
      html.push('<div style="margin-top:3px;color:#94a3b8">Locked HWID: <span class="rtx5-smono">' + esc(b.locked_hwid ? (b.locked_hwid.slice(0, 28) + '...') : 'AWAITING FIRST ACTIVATION') + '</span></div>');
      html.push('<div style="margin-top:3px;color:#94a3b8">DPAPI: <strong>' + esc(b.dpapi_status || '-') + '</strong> | DLL Integrity: <strong style="color:#34d399">' + esc(b.binary_integrity || '-') + '</strong> | Public TCP: <span class="rtx5-smono">' + esc(b.broker_public_tcp) + '</span></div>');
      if (b.hardware_summary) html.push('<div style="margin-top:2px;font-size:11px;color:#64748b">' + esc(b.hardware_summary) + '</div>');
      html.push('<div style="margin-top:7px;display:flex;gap:6px;flex-wrap:wrap">');
      html.push('<button class="rtx5-sbtn" onclick="__rtx5SecAction(\'reset-hwid\',\'' + esc(b.broker_id) + '\')">Reset HWID Lock</button>');
      html.push('<button class="rtx5-sbtn" onclick="__rtx5SecAction(\'update-ip\',\'' + esc(b.broker_id) + '\')">Update Allowed IP</button>');
      if (b.status === 'active') {
        html.push('<button class="rtx5-sbtn dng" onclick="__rtx5SecAction(\'kill\',\'' + esc(b.broker_id) + '\')">1-Click Kill / Suspend</button>');
      } else {
        html.push('<button class="rtx5-sbtn pri" onclick="__rtx5SecAction(\'activate\',\'' + esc(b.broker_id) + '\')">Reactivate</button>');
      }
      html.push('</div></div>');
    });
    html.push('</div>');

    html.push('<div class="rtx5-scard"><div style="font-weight:700;margin-bottom:8px">Issue Hardware-Locked Signed broker.lic (Zero Domains / Zero SSL)</div>');
    html.push('<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">');
    html.push('<input id="rtx5-iss-id" class="rtx5-sinp" placeholder="Broker ID (e.g. alpha-fx)" />');
    html.push('<input id="rtx5-iss-name" class="rtx5-sinp" placeholder="Broker Name (e.g. Alpha FX)" />');
    html.push('<input id="rtx5-iss-ip" class="rtx5-sinp" placeholder="Licensed Server IP (e.g. 203.0.113.10)" />');
    html.push('<input id="rtx5-iss-tcp" class="rtx5-sinp" placeholder="Broker Public TCP (e.g. 203.0.113.10:4443)" />');
    html.push('</div><button style="margin-top:8px" class="rtx5-sbtn pri" onclick="__rtx5SecAction(\'issue\')">Sign & Download broker.lic</button></div>');

    var el = document.getElementById('rtx5-sec-content');
    if (el) el.innerHTML = html.join('');
  }

  mount();
})();
