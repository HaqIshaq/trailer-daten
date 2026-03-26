// ==UserScript==
// @name         YM-DA-YARD
// @namespace    omaivan
// @version      1.1
// @match        https://trans-logistics-eu.amazon.com/yms/shipclerk/*
// @match        https://www.amazonlogistics.eu/gtdr/dashboard/vehicle_history*
// @require      https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @connect      raw.githubusercontent.com
// @connect      www.amazonlogistics.eu
// ==/UserScript==

/* ============================================================================
 *  YM-DA-YARD  v1.1
 *  Changes vs v1.0:
 *    - YardStateAPI: XHR intercept for getYardStateWithPendingMoves
 *    - Hybrid computeCounts(): API primary, DOM fallback
 *    - Dwell time from API unix timestamps (exact, locale-independent)
 *    - Fix: RANGIER badge now correctly shown in GTDR Dock Status
 * ========================================================================== */

(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════════════════════
   *  §8  CONFIG
   * ════════════════════════════════════════════════════════════════════════ */

  const PAGE_YMS  = location.href.includes('trans-logistics-eu.amazon.com/yms/shipclerk');
  const PAGE_GTDR = location.href.includes('amazonlogistics.eu/gtdr/dashboard/vehicle_history');

  // Carrier code → display label
  const CARRIER_CODE_MAP = {
    DAFIX  : 'DAFIX',
    DAFNX  : 'DAFNX',
    DHLFIX : 'DHL',
    DHLNX  : 'DHL',
    GLSFIX : 'GLS',
    GLSNX  : 'GLS',
    UPSFIX : 'UPS',
    UPSNX  : 'UPS',
    DPDFIX : 'DPD',
    DPDNX  : 'DPD',
    TNTFIX : 'TNT',
    TNTNX  : 'TNT',
    FEDFX  : 'FEDEX',
    AMAZON : 'AMZN',
    AMZL   : 'AMZL',
    ATSEU  : 'ATSEU',
    ATSNX  : 'ATSNX',
  };

  // GTDR API status → display text
  const GTDR_STATUS_MAP = {
    'Docking'      : 'Andocken',
    'Docked'       : 'Angedockt',
    'Undocking'    : 'Abdocken',
    'ShuntDriver'  : 'Rangiertransporter',
    'Free'         : 'Nicht angedockt',
    'NotDocked'    : 'Nicht angedockt',
  };

  // Default user settings
  const DEFAULTS = {
    dwellWarnMinutes  : 240,
    dwellAlertMinutes : 480,
    autoRefreshMs     : 0,        // 0 = off
    showCarrierLogo   : true,
    showGtdrBadge     : true,
    debugMode         : false,
  };

  function getSetting(key) {
    const v = GM_getValue('cfg_' + key);
    return v === undefined ? DEFAULTS[key] : v;
  }
  function setSetting(key, val) { GM_setValue('cfg_' + key, val); }

  /* ══════════════════════════════════════════════════════════════════════════
   *  §10  LOGGING
   * ════════════════════════════════════════════════════════════════════════ */

  const log = {
    debug : (...a) => getSetting('debugMode') && console.debug('[YM-DA-YARD]', ...a),
    info  : (...a) => console.log  ('[YM-DA-YARD]', ...a),
    warn  : (...a) => console.warn ('[YM-DA-YARD]', ...a),
    error : (...a) => console.error('[YM-DA-YARD]', ...a),
  };

  /* ══════════════════════════════════════════════════════════════════════════
   *  §12  CSS INJECTION
   * ════════════════════════════════════════════════════════════════════════ */

  function injectCSS(css) {
    const el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  if (PAGE_YMS) {
    injectCSS(`
      /* ── Pill Bar ── */
      #ym-pill-bar {
        position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
        display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 8px;
        background: rgba(35,35,35,0.95); backdrop-filter: blur(4px);
        box-shadow: 0 2px 6px rgba(0,0,0,0.4);
        font-family: 'Amazon Ember', Arial, sans-serif; font-size: 12px;
      }
      .ym-pill {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 2px 8px; border-radius: 12px; cursor: pointer;
        color: #fff; font-weight: 600; transition: opacity .15s;
        border: 1px solid rgba(255,255,255,0.15); white-space: nowrap;
        user-select: none;
      }
      .ym-pill:hover { opacity: 0.85; }
      .ym-pill.active { outline: 2px solid #fff; }
      .ym-pill .ym-count { font-size: 11px; opacity: 0.85; }

      /* ── Pill colours ── */
      .ym-pill--total    { background: #555; }
      .ym-pill--empty    { background: #2e7d32; }
      .ym-pill--full     { background: #c62828; }
      .ym-pill--unavail  { background: #e65100; }
      .ym-pill--ats      { background: #1565c0; }
      .ym-pill--transfer { background: #6a1b9a; }
      .ym-pill--agwr     { background: #4e342e; }
      .ym-pill--dwell    { background: #f9a825; color: #111; }
      .ym-pill--italy    { background: #009246; }
      .ym-pill--spain    { background: #c60b1e; }
      .ym-pill--custom   { background: #37474f; }

      /* ── Row highlight ── */
      tr.ym-highlight { background: rgba(255,235,59,0.25) !important; }
      tr.ym-dim       { opacity: 0.35; }

      /* ── Badges on rows ── */
      .ym-badge {
        display: inline-block; padding: 1px 6px; border-radius: 4px;
        font-size: 10px; font-weight: 700; margin-left: 4px;
        vertical-align: middle; color: #fff;
      }
      .ym-badge--empty    { background: #2e7d32; }
      .ym-badge--full     { background: #c62828; }
      .ym-badge--unavail  { background: #e65100; }
      .ym-badge--seal     { background: #1976d2; }
      .ym-badge--dwell-warn  { background: #f9a825; color: #111; }
      .ym-badge--dwell-alert { background: #b71c1c; }
      .ym-badge--italy    { background: #009246; }
      .ym-badge--spain    { background: #c60b1e; }
      .ym-badge--agwr     { background: #4e342e; }
      .ym-badge--ats      { background: #1565c0; }

      /* ── Carrier logo ── */
      .ym-carrier-logo {
        display: inline-block; padding: 1px 5px; border-radius: 3px;
        font-size: 10px; font-weight: 900; margin-left: 3px;
        vertical-align: middle; background: #263238; color: #eceff1;
        letter-spacing: 0.5px;
      }

      /* ── GTDR dock status badges ── */
      .gtdr-badge {
        display: inline-flex; align-items: center; gap: 3px;
        padding: 1px 7px; border-radius: 4px; font-size: 10px;
        font-weight: 700; color: #fff; margin-left: 4px;
        vertical-align: middle;
      }
      .gtdr-bg--andocken   { background: #b71c1c; }
      .gtdr-bg--angedockt  { background: #b71c1c; }
      .gtdr-bg--rangier    { background: #1a5fa8; }
      .gtdr-bg--frei       { background: #2e7d32; }

      /* ── Settings panel ── */
      #ym-settings-panel {
        position: fixed; top: 40px; right: 10px; z-index: 10000;
        background: #1e1e1e; color: #eee; border-radius: 8px;
        padding: 16px; width: 280px; box-shadow: 0 4px 20px rgba(0,0,0,0.6);
        font-size: 13px; display: none;
      }
      #ym-settings-panel h3 { margin: 0 0 12px; font-size: 14px; color: #fff; }
      #ym-settings-panel label { display: block; margin-bottom: 8px; }
      #ym-settings-panel input[type=number],
      #ym-settings-panel input[type=text] {
        width: 100%; box-sizing: border-box; padding: 4px 6px;
        background: #333; color: #eee; border: 1px solid #555; border-radius: 4px;
      }
      #ym-settings-panel input[type=checkbox] { margin-right: 6px; }
      .ym-btn {
        padding: 4px 12px; border-radius: 4px; cursor: pointer;
        border: 1px solid #555; background: #333; color: #eee;
        font-size: 12px; transition: background .15s;
      }
      .ym-btn:hover { background: #444; }
      .ym-btn-primary { background: #1565c0; border-color: #1565c0; color: #fff; }
      .ym-btn-primary:hover { background: #1976d2; }

      /* ── Context menu ── */
      #ym-context-menu {
        position: fixed; z-index: 10001; background: #1e1e1e;
        border: 1px solid #444; border-radius: 6px; padding: 4px 0;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5); font-size: 12px; min-width: 160px;
        display: none;
      }
      .ym-ctx-item {
        padding: 6px 14px; cursor: pointer; color: #ddd;
        transition: background .1s;
      }
      .ym-ctx-item:hover { background: #333; color: #fff; }
      .ym-ctx-sep { border-top: 1px solid #333; margin: 4px 0; }

      /* ── Dwell export dropdown ── */
      #ym-dwell-export-btn {
        font-size: 11px; padding: 2px 8px;
      }

      /* ── API status indicator ── */
      #ym-api-status {
        font-size: 10px; padding: 1px 6px; border-radius: 3px;
        color: #fff; align-self: center;
      }
      .ym-api--ready   { background: #2e7d32; }
      .ym-api--waiting { background: #555; }
    `);
  }

  if (PAGE_GTDR) {
    injectCSS(`
      .gtdr-badge {
        display: inline-flex; align-items: center; gap: 3px;
        padding: 1px 7px; border-radius: 4px; font-size: 10px;
        font-weight: 700; color: #fff; margin-left: 4px;
        vertical-align: middle;
      }
      .gtdr-bg--andocken   { background: #b71c1c; }
      .gtdr-bg--angedockt  { background: #b71c1c; }
      .gtdr-bg--rangier    { background: #1a5fa8; }
      .gtdr-bg--frei       { background: #2e7d32; }
    `);
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  §18  YARD STATE API  (NEW in v1.1)
   *  Intercepts the getYardStateWithPendingMoves XHR that Angular already
   *  makes and indexes assets by vehicleNumber for fast lookup.
   * ════════════════════════════════════════════════════════════════════════ */

  const YardStateAPI = (() => {
    let _assetMap = new Map();   // vehicleNumber (string) → asset object
    let _ready    = false;
    let _lastUpdate = null;

    const _callbacks = [];

    function _onData(data) {
      const newMap = new Map();
      try {
        const summaries = data.locationsSummaries || [];
        for (const summary of summaries) {
          const locations = summary.locations || [];
          for (const loc of locations) {
            const assets = loc.yardAssets || [];
            for (const asset of assets) {
              if (!asset.vehicleNumber) continue;
            // Merge location info into asset without copying large objects;
            // store location properties alongside a reference to the original.
            const enriched = {
              vehicleNumber : asset.vehicleNumber,
              id            : asset.id,
              visitId       : asset.visitId,
              brokerCode    : asset.brokerCode,
              broker        : asset.broker,
              owner         : asset.owner,
              status        : asset.status,
              unavailable   : asset.unavailable,
              unavailableReason: asset.unavailableReason,
              type          : asset.type,
              annotation    : asset.annotation,
              actualSeals   : asset.actualSeals,
              licensePlateIdentifier: asset.licensePlateIdentifier,
              datetimeOfArrivalAtLocation: asset.datetimeOfArrivalAtLocation,
              datetimeOfArrivalInYard    : asset.datetimeOfArrivalInYard,
              visitReason   : asset.visitReason,
              movesByItself : asset.movesByItself,
              _raw          : asset,   // reference to full object if needed
              _locationCode  : loc.code || loc.name || '',
              _locationName  : loc.shortName || loc.label || loc.name || loc.code || '',
              _locationSummaryCode: summary.yardCode || '',
            };
            newMap.set(String(asset.vehicleNumber), enriched);
            }
          }
        }
        // Also handle assets at exit gate
        const exitAssets = data.yardAssetsAtExitGate || [];
        for (const asset of exitAssets) {
          if (!asset.vehicleNumber) continue;
          newMap.set(String(asset.vehicleNumber), {
            ...asset,
            _locationCode: 'EXIT_GATE',
            _locationName: 'Exit Gate',
          });
        }
      } catch (e) {
        log.error('YardStateAPI parse error:', e);
      }

      _assetMap   = newMap;
      _ready      = true;
      _lastUpdate = Date.now();

      log.info(`YardStateAPI: indexed ${_assetMap.size} assets`);
      _callbacks.forEach(cb => { try { cb(_assetMap); } catch (e) { log.warn('YardStateAPI callback error:', e); } });
    }

    // ── Monkey-patch XHR ──────────────────────────────────────────────────
    const _origOpen = XMLHttpRequest.prototype.open;
    const _origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._ymUrl    = url;
      this._ymMethod = method;
      return _origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (body) {
      if (this._ymUrl && /\/getYardStateWithPendingMoves(?:[/?#]|$)/.test(this._ymUrl)) {
        this.addEventListener('load', function () {
          try {
            const data = JSON.parse(this.responseText);
            _onData(data);
          } catch (e) {
            log.warn('YardStateAPI: JSON parse failed', e);
          }
        });
      }
      return _origSend.call(this, body);
    };

    // ── Public API ────────────────────────────────────────────────────────
    return {
      isReady      ()       { return _ready; },
      getAsset     (vnum)   { return _assetMap.get(String(vnum)); },
      getAllAssets  ()       { return Array.from(_assetMap.values()); },
      getMap       ()       { return _assetMap; },
      getLastUpdate()       { return _lastUpdate; },
      onUpdate     (cb)     { _callbacks.push(cb); },
    };
  })();

  /* ══════════════════════════════════════════════════════════════════════════
   *  §20  UTILITY HELPERS
   * ════════════════════════════════════════════════════════════════════════ */

  /** Exact dwell in minutes from API unix timestamp (seconds). */
  function dwellFromTimestamp(tsSeconds) {
    if (!tsSeconds) return null;
    return (Date.now() - tsSeconds * 1000) / 60000;
  }

  /** Format dwell minutes → "3d 4h" style string. */
  function formatDwell(minutes) {
    if (minutes === null || minutes === undefined || isNaN(minutes) || minutes < 0) return '—';
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    if (h >= 24) {
      const d = Math.floor(h / 24);
      const hh = h % 24;
      return `${d}d ${hh}h`;
    }
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  /** Parse "N Tage", "Nh Nm", "N Monat" etc. → minutes (DOM fallback). */
  function parseDwellString(str) {
    if (!str) return null;
    str = str.trim();
    const monatM = str.match(/(\d+)\s*Monat/i);
    if (monatM) return parseInt(monatM[1]) * 30 * 24 * 60;
    const tageM  = str.match(/(\d+)\s*Tag/i);
    if (tageM)  return parseInt(tageM[1]) * 24 * 60;
    const stundeM= str.match(/(\d+)\s*Stunde/i);
    if (stundeM) return parseInt(stundeM[1]) * 60;
    const hmM    = str.match(/^(\d+):(\d+)$/);
    if (hmM)    return parseInt(hmM[1]) * 60 + parseInt(hmM[2]);
    const minM   = str.match(/(\d+)\s*min/i);
    if (minM)   return parseInt(minM[1]);
    return null;
  }

  /** Get text of a table cell by className or index. */
  function cellText(row, sel) {
    const el = typeof sel === 'number'
      ? row.cells[sel]
      : row.querySelector(sel);
    return el ? el.textContent.trim() : '';
  }

  /** Debounce helper. */
  function debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  §22  CARRIER LOGO OVERLAY
   * ════════════════════════════════════════════════════════════════════════ */

  const CarrierLogoOverlay = (() => {
    function _logoHtml(code) {
      const label = CARRIER_CODE_MAP[code] || code;
      return `<span class="ym-carrier-logo">${label}</span>`;
    }

    function scan(rows) {
      if (!getSetting('showCarrierLogo')) return;
      for (const row of rows) {
        const code = row.dataset.ownerCode;
        if (!code) continue;
        const col7cell = row.querySelector('.col7, td:nth-child(7)');
        if (!col7cell) continue;
        if (col7cell.querySelector('.ym-carrier-logo')) continue;
        col7cell.insertAdjacentHTML('beforeend', _logoHtml(code));
      }
    }

    return { scan };
  })();

  /* ══════════════════════════════════════════════════════════════════════════
   *  §24  BADGE SCANNER  (per-row badges)
   * ════════════════════════════════════════════════════════════════════════ */

  function scanBadges(rowDataList) {
    const dwellWarn  = getSetting('dwellWarnMinutes');
    const dwellAlert = getSetting('dwellAlertMinutes');

    for (const rd of rowDataList) {
      const { row, status, unavailable, hasSeal, dwellMin, countryCode,
              isAGWR, isATSEU } = rd;
      if (!row) continue;

      // Remove old badges injected by this script
      row.querySelectorAll('.ym-badge').forEach(b => b.remove());

      const col7cell = row.querySelector('.col7, td:nth-child(7)');
      if (!col7cell) continue;

      const badges = [];

      // Status badge
      if (unavailable) {
        badges.push('<span class="ym-badge ym-badge--unavail">UNAVAIL</span>');
      } else if (status === 'FULL') {
        badges.push('<span class="ym-badge ym-badge--full">FULL</span>');
      } else if (status === 'EMPTY') {
        badges.push('<span class="ym-badge ym-badge--empty">EMPTY</span>');
      }

      // Seal badge
      if (hasSeal) {
        badges.push('<span class="ym-badge ym-badge--seal">SEAL</span>');
      }

      // Dwell badge
      if (dwellMin !== null && dwellMin !== undefined) {
        if (dwellMin >= dwellAlert) {
          badges.push(`<span class="ym-badge ym-badge--dwell-alert">${formatDwell(dwellMin)}</span>`);
        } else if (dwellMin >= dwellWarn) {
          badges.push(`<span class="ym-badge ym-badge--dwell-warn">${formatDwell(dwellMin)}</span>`);
        }
      }

      // Country badge
      if (countryCode === 'IT') {
        badges.push('<span class="ym-badge ym-badge--italy">🇮🇹 IT</span>');
      } else if (countryCode === 'ES') {
        badges.push('<span class="ym-badge ym-badge--spain">🇪🇸 ES</span>');
      }

      // AGWR badge
      if (isAGWR) {
        badges.push('<span class="ym-badge ym-badge--agwr">AGWR</span>');
      }

      // ATSEU badge
      if (isATSEU) {
        badges.push('<span class="ym-badge ym-badge--ats">ATSEU</span>');
      }

      if (badges.length) {
        col7cell.insertAdjacentHTML('beforeend', badges.join(''));
      }
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  §26  ROW ICONS
   * ════════════════════════════════════════════════════════════════════════ */

  function addRowIcons(rowDataList) {
    for (const rd of rowDataList) {
      if (!rd.row) continue;
      // scroll-to icon already added? skip
      if (rd.row.querySelector('.ym-row-icon')) continue;

      const firstCell = rd.row.cells[0];
      if (!firstCell) continue;

      const icon = document.createElement('span');
      icon.className = 'ym-row-icon';
      icon.title = 'Zum Trailer scrollen';
      icon.style.cssText = 'cursor:pointer;margin-right:4px;font-size:11px;opacity:0.6;';
      icon.textContent = '↗';
      icon.addEventListener('click', (e) => {
        e.stopPropagation();
        rd.row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        rd.row.classList.add('ym-highlight');
        setTimeout(() => rd.row.classList.remove('ym-highlight'), 2000);
      });
      firstCell.prepend(icon);
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  §28  CONTEXT MENU
   * ════════════════════════════════════════════════════════════════════════ */

  let _ctxMenu = null;

  function initContextMenu() {
    _ctxMenu = document.createElement('div');
    _ctxMenu.id = 'ym-context-menu';
    document.body.appendChild(_ctxMenu);

    document.addEventListener('click', () => hideCtxMenu());
    document.addEventListener('contextmenu', onContextMenu);
  }

  function hideCtxMenu() {
    if (_ctxMenu) _ctxMenu.style.display = 'none';
  }

  function onContextMenu(e) {
    const row = e.target.closest('tr[data-vnum]');
    if (!row) return;
    e.preventDefault();

    const vnum = row.dataset.vnum || '';
    const loc  = row.dataset.loc  || '';

    _ctxMenu.innerHTML = `
      <div class="ym-ctx-item" data-action="copy-vnum">📋 Trailer-Nr kopieren (${vnum})</div>
      <div class="ym-ctx-item" data-action="copy-loc">📋 Standort kopieren (${loc})</div>
      <div class="ym-ctx-sep"></div>
      <div class="ym-ctx-item" data-action="open-gtdr">🔗 GTDR öffnen</div>
      <div class="ym-ctx-item" data-action="highlight">🔦 Zeile markieren</div>
    `;

    _ctxMenu.querySelectorAll('.ym-ctx-item').forEach(item => {
      item.addEventListener('click', () => {
        const action = item.dataset.action;
        if (action === 'copy-vnum') {
          navigator.clipboard.writeText(vnum).catch(() => {});
        } else if (action === 'copy-loc') {
          navigator.clipboard.writeText(loc).catch(() => {});
        } else if (action === 'open-gtdr') {
          const url = `https://www.amazonlogistics.eu/gtdr/dashboard/vehicle_history?vehicleId=${encodeURIComponent(vnum)}`;
          GM_openInTab(url, false);
        } else if (action === 'highlight') {
          row.classList.toggle('ym-highlight');
        }
        hideCtxMenu();
      });
    });

    _ctxMenu.style.cssText = `display:block; left:${e.clientX}px; top:${e.clientY}px;`;
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  §30  DATA PROCESSING  —  Hybrid API + DOM
   *
   *  v1.1: When YardStateAPI.isReady(), iterate API assets as primary source
   *        and enrich with DOM data (col9, AGWR, VRID).
   *        Fallback: pure DOM scanning (v1.0 behaviour).
   * ════════════════════════════════════════════════════════════════════════ */

  // Cache of computed row data, keyed by vehicleNumber
  const rowDataCache = new Map();

  /**
   * computeCounts() — scans all trailer rows and returns summary counts.
   * Returns { rowDataList, counts }
   */
  function computeCounts() {
    const rows = Array.from(document.querySelectorAll(
      'table tr[ng-repeat], table tbody tr, .shipclerk-table tr'
    )).filter(r => r.cells && r.cells.length >= 7);

    const rowDataList = [];
    const counts = {
      total      : 0,
      empty      : 0,
      full       : 0,
      unavail    : 0,
      atseu      : 0,
      atsExternal: 0,
      transfers  : 0,
      transfersIP: 0,
      agwr       : 0,
      withSeal   : 0,
      dwellWarn  : 0,
      dwellAlert : 0,
      italy      : 0,
      spain      : 0,
      byCarrier  : {},
    };

    const dwellWarnMin  = getSetting('dwellWarnMinutes');
    const dwellAlertMin = getSetting('dwellAlertMinutes');

    if (YardStateAPI.isReady()) {
      // ── HYBRID PATH: API primary, DOM enrichment ──────────────────────
      const apiAssets = YardStateAPI.getAllAssets();
      // Build a DOM row index keyed by vehicleNumber for fast lookup
      const domRowIndex = _buildDomRowIndex(rows);

      for (const asset of apiAssets) {
        const vnum = String(asset.vehicleNumber || '');
        if (!vnum) continue;

        // Find matching DOM row (may be absent if not yet rendered)
        const row = domRowIndex.get(vnum) || null;

        // brokerCode is the primary owner identifier; owner.code and broker.code
        // are present on some API versions as alternatives.
        const ownerCode   = asset.brokerCode || asset.owner?.code || asset.broker?.code || '';
        const status      = (asset.status || '').toUpperCase();          // EMPTY / FULL
        const unavailable = !!asset.unavailable;
        const annotation  = asset.annotation || '';
        const seals       = asset.actualSeals || [];
        const hasSeal     = seals.length > 0;
        const sealText    = seals.map(s => s.number || '').filter(Boolean).join(', ');
        const countryCode = asset.licensePlateIdentifier?.countryCode || null;
        const locCode     = asset._locationCode || '';
        const locName     = asset._locationName || '';

        // Dwell time — exact from API timestamp (v1.1)
        const arrivalTs   = asset.datetimeOfArrivalAtLocation || asset.datetimeOfArrivalInYard;
        const dwellMin    = dwellFromTimestamp(arrivalTs);

        // ── From DOM (enrichment) ──
        let col9Text      = '';
        let isAGWR        = false;
        let hasVRID       = false;
        let isTransferTote= false;
        let isTransferIP  = false;
        let destination   = '';

        if (row) {
          col9Text  = _col9Text(row);
          isAGWR    = _hasAGWR(row);
          hasVRID   = _hasVRID(row);
          // Store data attrs for context menu
          row.dataset.vnum = vnum;
          row.dataset.loc  = locCode;
          row.dataset.ownerCode = ownerCode;
        }

        // col9 parsing (always from DOM)
        const col9Up = col9Text.toUpperCase();
        const isATSEU    = col9Up.includes('ATSEXTERNAL') ||
                           col9Up.includes('DROP_')       ||
                           col9Up.includes('LOOSE');
        isTransferTote = _linkContains(row, 'TransfersTote');
        isTransferIP   = _linkContains(row, 'TransfersInitialP');
        destination    = _extractDestination(col9Text);

        // Carrier detection from brokerCode
        const carrierLabel = CARRIER_CODE_MAP[ownerCode] || null;

        // Build row data record
        const rd = {
          row, vnum, ownerCode, carrierLabel, locCode, locName,
          status, unavailable, annotation, hasSeal, sealText,
          countryCode, dwellMin, isAGWR, hasVRID,
          isATSEU, isTransferTote, isTransferIP, destination,
          col9Text, asset,
        };
        rowDataList.push(rd);
        rowDataCache.set(vnum, rd);

        // ── Counts ──
        counts.total++;
        if (unavailable)            counts.unavail++;
        else if (status === 'FULL') counts.full++;
        else if (status === 'EMPTY')counts.empty++;

        if (isAGWR)            counts.agwr++;
        if (isATSEU && hasVRID)counts.atseu++;
        if (isATSEU && !hasVRID) counts.atsExternal++;
        if (isTransferTote)    counts.transfers++;
        if (isTransferIP)      counts.transfersIP++;
        if (hasSeal)           counts.withSeal++;
        if (countryCode === 'IT') counts.italy++;
        if (countryCode === 'ES') counts.spain++;

        if (dwellMin !== null) {
          if (dwellMin >= dwellAlertMin)     counts.dwellAlert++;
          else if (dwellMin >= dwellWarnMin) counts.dwellWarn++;
        }

        if (carrierLabel) {
          counts.byCarrier[carrierLabel] = (counts.byCarrier[carrierLabel] || 0) + 1;
        }
      }

    } else {
      // ── DOM FALLBACK PATH (v1.0 behaviour) ───────────────────────────
      for (const row of rows) {
        const vnum      = cellText(row, '.col7, td:nth-child(7)');
        if (!vnum) continue;

        const ownerCode = cellText(row, '.col8, td:nth-child(8)');
        const col9Text  = _col9Text(row);
        const sealText  = cellText(row, '.col10, td:nth-child(10)');
        const hasSeal   = !!sealText;
        const annotation= cellText(row, '.col11, td:nth-child(11)');

        // Status from DOM classes
        const rowCls    = row.className || '';
        let status      = '';
        if (rowCls.includes('empty') || rowCls.includes('EMPTY')) status = 'EMPTY';
        else if (rowCls.includes('full') || rowCls.includes('FULL')) status = 'FULL';

        const unavailable = rowCls.includes('unavail') || rowCls.includes('blocked');

        // Dwell from DOM string (locale-dependent fallback)
        const dwellCell = row.querySelector('.col5, td:nth-child(5), .col-dwell');
        const dwellStr  = dwellCell ? dwellCell.textContent.trim() : '';
        const dwellMin  = parseDwellString(dwellStr);

        // Country code from DOM (complex legacy parsing)
        let countryCode = null;
        const lpCell = row.querySelector('.col7, td:nth-child(7)');
        if (lpCell) {
          const txt = lpCell.textContent;
          if (/\bIT\b/.test(txt) || annotation.includes('Italy')) countryCode = 'IT';
          else if (/\bES\b/.test(txt) || annotation.includes('Spain')) countryCode = 'ES';
        }

        const isAGWR = _hasAGWR(row);
        const hasVRID = _hasVRID(row);
        const col9Up = col9Text.toUpperCase();
        const isATSEU = col9Up.includes('ATSEXTERNAL') || col9Up.includes('DROP_') || col9Up.includes('LOOSE');
        const isTransferTote = _linkContains(row, 'TransfersTote');
        const isTransferIP   = _linkContains(row, 'TransfersInitialP');
        const destination    = _extractDestination(col9Text);
        const carrierLabel   = CARRIER_CODE_MAP[ownerCode] || null;

        row.dataset.vnum = vnum;
        row.dataset.ownerCode = ownerCode;

        const rd = {
          row, vnum, ownerCode, carrierLabel,
          locCode: '', locName: '',
          status, unavailable, annotation, hasSeal, sealText,
          countryCode, dwellMin, isAGWR, hasVRID,
          isATSEU, isTransferTote, isTransferIP, destination,
          col9Text, asset: null,
        };
        rowDataList.push(rd);
        rowDataCache.set(vnum, rd);

        counts.total++;
        if (unavailable)             counts.unavail++;
        else if (status === 'FULL')  counts.full++;
        else if (status === 'EMPTY') counts.empty++;

        if (isAGWR)            counts.agwr++;
        if (isATSEU && hasVRID)counts.atseu++;
        if (isATSEU && !hasVRID)counts.atsExternal++;
        if (isTransferTote)    counts.transfers++;
        if (isTransferIP)      counts.transfersIP++;
        if (hasSeal)           counts.withSeal++;
        if (countryCode === 'IT') counts.italy++;
        if (countryCode === 'ES') counts.spain++;

        if (dwellMin !== null) {
          if (dwellMin >= dwellAlertMin)     counts.dwellAlert++;
          else if (dwellMin >= dwellWarnMin) counts.dwellWarn++;
        }

        if (carrierLabel) {
          counts.byCarrier[carrierLabel] = (counts.byCarrier[carrierLabel] || 0) + 1;
        }
      }
    }

    return { rowDataList, counts };
  }

  // ── DOM helper functions ────────────────────────────────────────────────

  /** Build a Map: vehicleNumber → table row from DOM. */
  function _buildDomRowIndex(rows) {
    const idx = new Map();
    for (const row of rows) {
      const vnum = cellText(row, '.col7, td:nth-child(7)');
      if (vnum) idx.set(vnum, row);
    }
    return idx;
  }

  /** Get col9 text content. */
  function _col9Text(row) {
    if (!row) return '';
    const c = row.querySelector('.col9, td:nth-child(9)');
    return c ? c.textContent.trim() : '';
  }

  /** Check if row contains AGWR bold label. */
  function _hasAGWR(row) {
    if (!row) return false;
    return Array.from(row.querySelectorAll('span.shipclerk-bold-label, .bold-label, strong'))
      .some(el => el.textContent.includes('AGWR'));
  }

  /** Check if row has a VRID link (used for ATSEU empty filter). */
  function _hasVRID(row) {
    if (!row) return false;
    return !!row.querySelector('a[href*="visitId"], a[href*="vrid"], .vrid-link');
  }

  /** Check if col9 of row contains a link matching text. */
  function _linkContains(row, text) {
    if (!row) return false;
    const col9 = row.querySelector('.col9, td:nth-child(9)');
    if (!col9) return false;
    return Array.from(col9.querySelectorAll('a')).some(a =>
      a.href.includes(text) || a.textContent.includes(text)
    );
  }

  /** Extract destination from col9 text. */
  function _extractDestination(col9Text) {
    const m = col9Text.match(/→\s*([A-Z0-9]+)/);
    return m ? m[1] : '';
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  §32  PILL BAR
   * ════════════════════════════════════════════════════════════════════════ */

  let _pillBar       = null;
  let _apiStatusEl   = null;
  let _activeFilter  = null;

  function buildPillBar() {
    if (_pillBar) return;

    _pillBar = document.createElement('div');
    _pillBar.id = 'ym-pill-bar';
    document.body.prepend(_pillBar);

    // Offset page content
    document.body.style.paddingTop = '34px';
  }

  function renderPillBar(counts) {
    if (!_pillBar) buildPillBar();

    const pills = [
      { key: 'total',     cls: 'ym-pill--total',    label: 'Gesamt',    n: counts.total },
      { key: 'empty',     cls: 'ym-pill--empty',    label: 'EMPTY',     n: counts.empty },
      { key: 'full',      cls: 'ym-pill--full',     label: 'FULL',      n: counts.full },
      { key: 'unavail',   cls: 'ym-pill--unavail',  label: 'UNAVAIL',   n: counts.unavail },
      { key: 'atseu',     cls: 'ym-pill--ats',      label: 'ATSEU',     n: counts.atseu },
      { key: 'atsExt',    cls: 'ym-pill--ats',      label: 'ATS-Ext',   n: counts.atsExternal },
      { key: 'transfers', cls: 'ym-pill--transfer', label: 'Transfer',  n: counts.transfers + counts.transfersIP },
      { key: 'agwr',      cls: 'ym-pill--agwr',     label: 'AGWR',      n: counts.agwr },
      { key: 'seal',      cls: 'ym-pill--custom',   label: '🔒 Seal',   n: counts.withSeal },
      { key: 'dwellWarn', cls: 'ym-pill--dwell',    label: '⏱ Dwell↑', n: counts.dwellWarn + counts.dwellAlert },
      { key: 'italy',     cls: 'ym-pill--italy',    label: '🇮🇹 IT',    n: counts.italy },
      { key: 'spain',     cls: 'ym-pill--spain',    label: '🇪🇸 ES',    n: counts.spain },
    ];

    // Carrier pills
    for (const [label, n] of Object.entries(counts.byCarrier)) {
      if (n > 0) pills.push({ key: 'carrier_' + label, cls: 'ym-pill--custom', label, n });
    }

    let html = '';
    for (const p of pills) {
      if (p.n === 0) continue;
      const active = _activeFilter === p.key ? ' active' : '';
      html += `<span class="ym-pill ${p.cls}${active}" data-filter="${p.key}" title="${p.label}: ${p.n}">
        ${p.label} <span class="ym-count">${p.n}</span>
      </span>`;
    }

    // Settings button
    html += `<span class="ym-pill ym-pill--custom" id="ym-settings-btn" title="Einstellungen">⚙</span>`;

    // Dwell export button
    html += `<span class="ym-pill ym-pill--custom" id="ym-dwell-export-btn" title="Dwell exportieren">📥 Export</span>`;

    // API status
    const apiReady = YardStateAPI.isReady();
    const apiCls   = apiReady ? 'ym-api--ready' : 'ym-api--waiting';
    const apiLabel = apiReady ? `API ✓ (${YardStateAPI.getAllAssets().length})` : 'API …';
    html += `<span id="ym-api-status" class="${apiCls}">${apiLabel}</span>`;

    _pillBar.innerHTML = html;

    // Pill click → filter rows
    _pillBar.querySelectorAll('.ym-pill[data-filter]').forEach(p => {
      p.addEventListener('click', () => {
        const key = p.dataset.filter;
        _activeFilter = _activeFilter === key ? null : key;
        applyFilter(_activeFilter);
        renderPillBar(counts); // re-render to update active state
      });
    });

    document.getElementById('ym-settings-btn')?.addEventListener('click', toggleSettingsPanel);
    document.getElementById('ym-dwell-export-btn')?.addEventListener('click', exportDwellXLSX);
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  §34  ROW FILTER
   * ════════════════════════════════════════════════════════════════════════ */

  function applyFilter(filterKey) {
    for (const [, rd] of rowDataCache) {
      if (!rd.row) continue;
      const visible = filterKey === null || matchFilter(rd, filterKey);
      rd.row.classList.toggle('ym-dim', !visible);
    }
  }

  function matchFilter(rd, key) {
    if (key === 'total')     return true;
    if (key === 'empty')     return rd.status === 'EMPTY' && !rd.unavailable;
    if (key === 'full')      return rd.status === 'FULL'  && !rd.unavailable;
    if (key === 'unavail')   return rd.unavailable;
    if (key === 'atseu')     return rd.isATSEU && rd.hasVRID;
    if (key === 'atsExt')    return rd.isATSEU && !rd.hasVRID;
    if (key === 'transfers') return rd.isTransferTote || rd.isTransferIP;
    if (key === 'agwr')      return rd.isAGWR;
    if (key === 'seal')      return rd.hasSeal;
    if (key === 'dwellWarn') return rd.dwellMin !== null && rd.dwellMin >= getSetting('dwellWarnMinutes');
    if (key === 'italy')     return rd.countryCode === 'IT';
    if (key === 'spain')     return rd.countryCode === 'ES';
    if (key.startsWith('carrier_')) {
      const label = key.replace('carrier_', '');
      return rd.carrierLabel === label;
    }
    return true;
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  §36  SETTINGS PANEL
   * ════════════════════════════════════════════════════════════════════════ */

  let _settingsPanel = null;

  function buildSettingsPanel() {
    _settingsPanel = document.createElement('div');
    _settingsPanel.id = 'ym-settings-panel';
    _settingsPanel.innerHTML = `
      <h3>⚙ YM-DA-YARD Einstellungen</h3>
      <label>Dwell Warnung (Minuten):<br>
        <input type="number" id="cfg-dwell-warn" value="${getSetting('dwellWarnMinutes')}">
      </label>
      <label>Dwell Alarm (Minuten):<br>
        <input type="number" id="cfg-dwell-alert" value="${getSetting('dwellAlertMinutes')}">
      </label>
      <label><input type="checkbox" id="cfg-carrier-logo" ${getSetting('showCarrierLogo') ? 'checked' : ''}>
        Carrier-Logo anzeigen
      </label>
      <label><input type="checkbox" id="cfg-gtdr-badge" ${getSetting('showGtdrBadge') ? 'checked' : ''}>
        GTDR-Badge anzeigen
      </label>
      <label><input type="checkbox" id="cfg-debug" ${getSetting('debugMode') ? 'checked' : ''}>
        Debug-Modus
      </label>
      <div style="margin-top:12px;display:flex;gap:8px;">
        <button class="ym-btn ym-btn-primary" id="cfg-save">Speichern</button>
        <button class="ym-btn" id="cfg-close">Schließen</button>
      </div>
      <div style="margin-top:8px;font-size:11px;color:#888;">
        YM-DA-YARD v1.1
        ${YardStateAPI.isReady()
          ? `| API aktiv (${YardStateAPI.getAllAssets().length} Trailer)`
          : '| API wartet…'}
      </div>
    `;
    document.body.appendChild(_settingsPanel);

    document.getElementById('cfg-save').addEventListener('click', () => {
      setSetting('dwellWarnMinutes',  parseInt(document.getElementById('cfg-dwell-warn').value) || 240);
      setSetting('dwellAlertMinutes', parseInt(document.getElementById('cfg-dwell-alert').value) || 480);
      setSetting('showCarrierLogo',   document.getElementById('cfg-carrier-logo').checked);
      setSetting('showGtdrBadge',     document.getElementById('cfg-gtdr-badge').checked);
      setSetting('debugMode',         document.getElementById('cfg-debug').checked);
      _settingsPanel.style.display = 'none';
      runFullScan();
    });

    document.getElementById('cfg-close').addEventListener('click', () => {
      _settingsPanel.style.display = 'none';
    });
  }

  function toggleSettingsPanel() {
    if (!_settingsPanel) buildSettingsPanel();
    const visible = _settingsPanel.style.display === 'block';
    _settingsPanel.style.display = visible ? 'none' : 'block';
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  §38  DWELL EXPORT  (uses API timestamps where available)
   * ════════════════════════════════════════════════════════════════════════ */

  function exportDwellXLSX() {
    if (!rowDataCache.size) {
      alert('Keine Daten zum Exportieren. Bitte warte auf den nächsten Scan.');
      return;
    }

    const rows = [['Trailer-Nr', 'Standort', 'Owner', 'Status', 'Dwell (Min)', 'Dwell (Format)', 'Seal', 'Land']];

    for (const [, rd] of rowDataCache) {
      rows.push([
        rd.vnum,
        rd.locCode || '',
        rd.ownerCode || '',
        rd.unavailable ? 'UNAVAIL' : (rd.status || ''),
        rd.dwellMin !== null ? Math.round(rd.dwellMin) : '',
        rd.dwellMin !== null ? formatDwell(rd.dwellMin) : '',
        rd.sealText || '',
        rd.countryCode || '',
      ]);
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Dwell');

    const ts = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    XLSX.writeFile(wb, `YM-Dwell-${ts}.xlsx`);
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  §40a  POPUP MANAGER
   * ════════════════════════════════════════════════════════════════════════ */

  const PopupManager = (() => {
    let _popup = null;
    let _title = null;
    let _body  = null;

    function _ensure() {
      if (_popup) return;
      _popup = document.createElement('div');
      _popup.style.cssText = `
        position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
        z-index:11000; background:#1e1e1e; color:#eee; border-radius:8px;
        padding:20px; min-width:320px; max-width:80vw; max-height:80vh;
        overflow:auto; box-shadow:0 8px 32px rgba(0,0,0,0.7);
        font-size:13px; display:none;
      `;
      _title = document.createElement('h3');
      _title.style.cssText = 'margin:0 0 12px; font-size:15px;';
      _body  = document.createElement('div');
      const closeBtn = document.createElement('button');
      closeBtn.textContent = '✕';
      closeBtn.className = 'ym-btn';
      closeBtn.style.cssText = 'position:absolute;top:8px;right:8px;';
      closeBtn.addEventListener('click', close);
      _popup.appendChild(closeBtn);
      _popup.appendChild(_title);
      _popup.appendChild(_body);
      document.body.appendChild(_popup);
    }

    function open(title, bodyHtml) {
      _ensure();
      _title.textContent = title;
      _body.innerHTML    = bodyHtml;
      _popup.style.display = 'block';
    }

    function close() {
      if (_popup) _popup.style.display = 'none';
    }

    return { open, close };
  })();

  /* ══════════════════════════════════════════════════════════════════════════
   *  §40b  GTDR DOCK STATUS
   *
   *  v1.1 Fix: 'ShuntDriver' → 'Rangiertransporter' mapping is applied
   *  before the STATUS_BADGE match, so the RANGIER badge correctly shows.
   * ════════════════════════════════════════════════════════════════════════ */

  const GtdrDockStatus = (() => {

    const STATUS_BADGE = [
      { match: 'Andocken',          cls: 'gtdr-bg--andocken',  label: 'Andocken'          },
      { match: 'Angedockt',         cls: 'gtdr-bg--angedockt', label: 'Angedockt'          },
      { match: 'Rangiertransporter',cls: 'gtdr-bg--rangier',   label: 'Rangiertransporter' },
      { match: 'Abdocken',          cls: 'gtdr-bg--andocken',  label: 'Abdocken'           },
      { match: 'Nicht angedockt',   cls: 'gtdr-bg--frei',      label: 'Nicht angedockt'    },
    ];

    /**
     * Map a raw API status string → display status.
     * Applies GTDR_STATUS_MAP first, then returns cleaned string.
     */
    function mapStatus(raw) {
      if (!raw) return '';
      const trimmed = raw.trim();
      // Direct map lookup (e.g. 'ShuntDriver' → 'Rangiertransporter')
      if (GTDR_STATUS_MAP[trimmed]) return GTDR_STATUS_MAP[trimmed];
      return trimmed;
    }

    /**
     * Build a badge HTML string for the given (possibly raw) status.
     * v1.1 Fix: status is first mapped through GTDR_STATUS_MAP before matching.
     */
    function getStatusBadge(rawStatus) {
      const status = mapStatus(rawStatus);
      if (!status) return '';

      for (const s of STATUS_BADGE) {
        if (status.includes(s.match)) {
          return `<span class="gtdr-badge ${s.cls}">${s.label}</span>`;
        }
      }
      // Unknown status — show neutral badge
      return `<span class="gtdr-badge" style="background:#555">${status}</span>`;
    }

    // ── GTDR Vehicle History page ─────────────────────────────────────────

    function scanGtdrPage() {
      if (!PAGE_GTDR) return;
      const rows = document.querySelectorAll('table tr');
      for (const row of rows) {
        if (row.querySelector('.gtdr-badge')) continue;
        const cells = row.cells;
        if (!cells || cells.length < 3) continue;

        // Try to find a cell that looks like a dock status
        for (const cell of cells) {
          const txt = cell.textContent.trim();
          const mapped = mapStatus(txt);
          if (STATUS_BADGE.some(s => mapped.includes(s.match))) {
            cell.insertAdjacentHTML('beforeend', getStatusBadge(txt));
            break;
          }
        }
      }
    }

    // ── YMS: inject GTDR status badges into trailer rows ─────────────────

    let _dockStatusCache = new Map(); // vehicleNumber → dockStatus

    function fetchAndInject(vehicleNumber, targetCell) {
      if (!getSetting('showGtdrBadge')) return;
      if (_dockStatusCache.has(vehicleNumber)) {
        _renderBadge(vehicleNumber, _dockStatusCache.get(vehicleNumber), targetCell);
        return;
      }

      GM_xmlhttpRequest({
        method : 'GET',
        url    : `https://www.amazonlogistics.eu/gtdr/api/vehicle/status?vehicleId=${encodeURIComponent(vehicleNumber)}`,
        onload (resp) {
          try {
            const data    = JSON.parse(resp.responseText);
            const rawStatus = data.dockStatus || data.status || '';
            _dockStatusCache.set(vehicleNumber, rawStatus);
            _renderBadge(vehicleNumber, rawStatus, targetCell);
          } catch (_) {}
        },
        onerror () {},
      });
    }

    function _renderBadge(vehicleNumber, rawStatus, targetCell) {
      if (!targetCell) return;
      const existing = targetCell.querySelector('.gtdr-badge');
      if (existing) existing.remove();
      const html = getStatusBadge(rawStatus);
      if (html) targetCell.insertAdjacentHTML('beforeend', html);
    }

    function reapplyBadges(rowDataList) {
      if (!getSetting('showGtdrBadge')) return;
      for (const rd of rowDataList) {
        if (!rd.row || !rd.vnum) continue;
        const cell = rd.row.querySelector('.col7, td:nth-child(7)');
        if (!cell) continue;
        fetchAndInject(rd.vnum, cell);
      }
    }

    return { scanGtdrPage, reapplyBadges, getStatusBadge, mapStatus };
  })();

  /* ══════════════════════════════════════════════════════════════════════════
   *  §42  GTDR AUTO-PHOTO
   * ════════════════════════════════════════════════════════════════════════ */

  const GtdrAutoPhoto = (() => {
    let _running = false;

    function start() {
      if (!PAGE_GTDR || _running) return;
      _running = true;
      log.info('GtdrAutoPhoto: watching for photo triggers...');
      // Observe DOM for photo action buttons
      const observer = new MutationObserver(() => _checkPhotoButtons());
      observer.observe(document.body, { childList: true, subtree: true });
      _checkPhotoButtons();
    }

    function _checkPhotoButtons() {
      document.querySelectorAll('[data-action="auto-photo"]:not([data-ym-handled])').forEach(btn => {
        btn.dataset.ymHandled = '1';
        btn.addEventListener('click', () => {
          log.info('GtdrAutoPhoto: triggered for', btn.dataset.vehicleId);
        });
      });
    }

    return { start };
  })();

  /* ══════════════════════════════════════════════════════════════════════════
   *  §49  FULL SCAN  —  main entry point
   * ════════════════════════════════════════════════════════════════════════ */

  function runFullScan() {
    log.debug('runFullScan()');

    const { rowDataList, counts } = computeCounts();

    // Render pill bar with counts
    renderPillBar(counts);

    // Per-row enhancements
    scanBadges(rowDataList);
    addRowIcons(rowDataList);
    CarrierLogoOverlay.scan(rowDataList);
    GtdrDockStatus.reapplyBadges(rowDataList);

    // Re-apply active filter if any
    if (_activeFilter) applyFilter(_activeFilter);

    log.debug('Scan complete:', counts);
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  §49  INITIALIZATION
   * ════════════════════════════════════════════════════════════════════════ */

  function initYMS() {
    // Wait for table to appear
    const checkReady = setInterval(() => {
      const rows = document.querySelectorAll('table tr');
      if (rows.length < 2) return;
      clearInterval(checkReady);

      log.info('YM-DA-YARD v1.1 initializing on YMS page...');
      buildPillBar();
      initContextMenu();
      runFullScan();

      // Re-scan when YardStateAPI updates (API data arrived/refreshed)
      YardStateAPI.onUpdate(() => {
        log.info('YardStateAPI updated — re-scanning...');
        runFullScan();
      });

      // Watch for Angular-driven table updates (DOM mutations)
      const observer = new MutationObserver(debounce(() => {
        runFullScan();
      }, 800));
      observer.observe(document.body, { childList: true, subtree: true });

      // Auto-refresh if configured
      const arMs = getSetting('autoRefreshMs');
      if (arMs > 0) {
        setInterval(() => runFullScan(), arMs);
      }
    }, 500);
  }

  function initGTDR() {
    log.info('YM-DA-YARD v1.1 initializing on GTDR page...');
    GtdrDockStatus.scanGtdrPage();
    GtdrAutoPhoto.start();

    // Watch for dynamic content
    const observer = new MutationObserver(debounce(() => {
      GtdrDockStatus.scanGtdrPage();
    }, 500));
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  §50  DEBUG EXPORTS
   * ════════════════════════════════════════════════════════════════════════ */

  window.__YMDA__ = {
    version       : '1.1',
    YardStateAPI,
    rowDataCache,
    computeCounts,
    runFullScan,
    GtdrDockStatus,
    GtdrAutoPhoto,
    CarrierLogoOverlay,
    PopupManager,
    exportDwellXLSX,
    getSetting,
    setSetting,
    formatDwell,
    parseDwellString,
    dwellFromTimestamp,
  };

  /* ── Boot ──────────────────────────────────────────────────────────────── */

  if (PAGE_YMS) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initYMS);
    } else {
      initYMS();
    }
  } else if (PAGE_GTDR) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initGTDR);
    } else {
      initGTDR();
    }
  }

  log.info('YM-DA-YARD v1.1 loaded (XHR intercept active)');

})();
