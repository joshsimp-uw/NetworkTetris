/* Networking Tetris — Rebuild (IPv4 + IPv6, 64-cell grid, VLSM-aware snapping) */

(() => {
  'use strict';

  const ONE = 1n;
  function pow2(n){ return ONE << BigInt(n); }
  function maskBits(totalBits, prefix){
    if(prefix === 0) return 0n;
    const hostBits = totalBits - prefix;
    return ((~0n) << BigInt(hostBits)) & (pow2(totalBits) - 1n);
  }

  function parseIPv4(str){
    const parts = str.trim().split('.');
    if(parts.length !== 4) throw new Error('Invalid IPv4 address');
    let v = 0n;
    for(const p of parts){
      if(!/^\d+$/.test(p)) throw new Error('Invalid IPv4 address');
      const n = Number(p);
      if(n < 0 || n > 255) throw new Error('Invalid IPv4 address');
      v = (v << 8n) + BigInt(n);
    }
    return v;
  }
  function formatIPv4(v){
    return [24n,16n,8n,0n].map(shift => Number((v >> shift) & 255n)).join('.');
  }

  function parseIPv6(str){
    let s = str.trim().toLowerCase();
    if(!s) throw new Error('Invalid IPv6 address');
    if(s.includes('.')){
      const idx = s.lastIndexOf(':');
      if(idx === -1) throw new Error('Invalid IPv6 address');
      const v4 = parseIPv4(s.slice(idx + 1));
      const hi = Number((v4 >> 16n) & 0xffffn).toString(16);
      const lo = Number(v4 & 0xffffn).toString(16);
      s = s.slice(0, idx) + ':' + hi + ':' + lo;
    }
    const hasDouble = s.includes('::');
    let left = [], right = [];
    if(hasDouble){
      const parts = s.split('::');
      if(parts.length !== 2) throw new Error('Invalid IPv6 address');
      left = parts[0] ? parts[0].split(':').filter(Boolean) : [];
      right = parts[1] ? parts[1].split(':').filter(Boolean) : [];
    } else {
      left = s.split(':').filter(Boolean);
    }
    const vals = [];
    for(const h of left){
      if(!/^[0-9a-f]{1,4}$/.test(h)) throw new Error('Invalid IPv6 address');
      vals.push(parseInt(h,16));
    }
    if(hasDouble){
      const rightVals = [];
      for(const h of right){
        if(!/^[0-9a-f]{1,4}$/.test(h)) throw new Error('Invalid IPv6 address');
        rightVals.push(parseInt(h,16));
      }
      const zeroCount = 8 - (vals.length + rightVals.length);
      if(zeroCount < 0) throw new Error('Invalid IPv6 address');
      while(vals.length < 8 - rightVals.length) vals.push(0);
      vals.push(...rightVals);
    }
    if(vals.length !== 8) throw new Error('Invalid IPv6 address');
    let v = 0n;
    for(const part of vals) v = (v << 16n) + BigInt(part);
    return v;
  }
  function formatIPv6(v){
    const hextets = [];
    for(let i=0;i<8;i++) hextets.push(Number((v >> BigInt(112 - i*16)) & 0xffffn));
    let bestStart = -1, bestLen = 0;
    for(let i=0;i<8;){
      if(hextets[i] !== 0){ i++; continue; }
      let j = i;
      while(j < 8 && hextets[j] === 0) j++;
      const len = j - i;
      if(len > bestLen && len >= 2){ bestStart = i; bestLen = len; }
      i = j;
    }
    const out = [];
    for(let i=0;i<8;i++){
      if(i === bestStart){
        out.push('');
        i += bestLen - 1;
        if(i === 7) out.push('');
      } else {
        out.push(hextets[i].toString(16));
      }
    }
    let s = out.join(':');
    if(s.startsWith(':')) s = ':' + s;
    if(s.endsWith(':')) s += ':';
    return s.replace(/:{3,}/g, '::') || '::';
  }

  function parseCIDR(input){
    const s = input.trim();
    const slash = s.lastIndexOf('/');
    if(slash === -1) throw new Error('CIDR must include /prefix');
    const addrStr = s.slice(0, slash).trim();
    const prefix = Number(s.slice(slash + 1).trim());
    if(!Number.isInteger(prefix)) throw new Error('Invalid prefix length');
    if(addrStr.includes(':')){
      if(prefix < 0 || prefix > 128) throw new Error('IPv6 prefix must be 0–128');
      const addr = parseIPv6(addrStr);
      const base = addr & maskBits(128, prefix);
      return { version: 6, totalBits: 128, prefix, addr, base };
    }
    if(prefix < 0 || prefix > 32) throw new Error('IPv4 prefix must be 0–32');
    const addr = parseIPv4(addrStr);
    const base = addr & maskBits(32, prefix);
    return { version: 4, totalBits: 32, prefix, addr, base };
  }

  function fmtIP(version, v){ return version === 6 ? formatIPv6(v) : formatIPv4(v); }
  function addrCountStr(totalBits, prefix){
    const hostBits = totalBits - prefix;
    if(hostBits >= 64) return `2^${hostBits}`;
    return (ONE << BigInt(hostBits)).toString();
  }
  function usableHostsStr(version, totalBits, prefix){
    const hostBits = totalBits - prefix;
    if(version === 6) return addrCountStr(totalBits, prefix);
    if(prefix === 32) return '1';
    if(prefix === 31) return '2';
    if(hostBits >= 63) return `2^${hostBits} - 2`;
    return ((ONE << BigInt(hostBits)) - 2n).toString();
  }

  const state = {
    cidr: null,
    pixelPrefix: null,
    totalCells: 64,
    cols: 8,
    used: new Array(64).fill(null),
    allocations: [],
    nextId: 1,
    dragging: null,
    selectedPrefix: null,
    preview: null,
    moveHandler: null,
    upHandler: null,
    cancelHandler: null,
    sortKey: 'startCell',
    sortDir: 'asc',
  };

  function choosePixelPrefix(totalBits, basePrefix){
    const cap = totalBits - 2;
    return Math.max(basePrefix, Math.min(basePrefix + 6, cap));
  }
  function blockCellCount(pixelPrefix, blockPrefix){ return 1 << (pixelPrefix - blockPrefix); }
  function colorForId(id){ return `hsl(${(id * 137) % 360} 70% 55% / 0.32)`; }
  function snappedStart(cellIndex, cellCount){ return Math.floor(cellIndex / cellCount) * cellCount; }
  function canPlace(startCell, cellCount){
    if(startCell < 0 || startCell + cellCount > state.totalCells) return false;
    for(let i=0;i<cellCount;i++) if(state.used[startCell + i] !== null) return false;
    return true;
  }
  function remainingBlocksForPrefix(prefix){
    const cellCount = blockCellCount(state.pixelPrefix, prefix);
    let free = 0;
    for(let start = 0; start < state.totalCells; start += cellCount){
      if(canPlace(start, cellCount)) free++;
    }
    return free;
  }

  function setStatus(msg, kind){
    const el = document.getElementById('status');
    el.textContent = msg || '';
    el.classList.remove('error','ok');
    if(kind) el.classList.add(kind);
  }
  function clearPreviewClasses(){
    const grid = document.getElementById('grid');
    [...grid.children].forEach(cell => cell.classList.remove('previewOk', 'previewBad'));
  }
  function clearPlacementHints(){
    const grid = document.getElementById('grid');
    [...grid.children].forEach(cell => cell.classList.remove('validRange','validStart'));
  }
  function clearCellMarks(cell){
    cell.classList.remove('occupied','startMark','endMark');
    cell.querySelectorAll('.mark').forEach(mark => mark.remove());
  }
  function applyPlacementHints(){
    clearPlacementHints();
    if(!state.cidr) return;
    const prefix = state.dragging?.prefix ?? state.selectedPrefix;
    if(prefix === null) return;
    const grid = document.getElementById('grid');
    const cellCount = blockCellCount(state.pixelPrefix, prefix);
    for(let start = 0; start < state.totalCells; start += cellCount){
      if(!canPlace(start, cellCount)) continue;
      for(let i=0;i<cellCount;i++) grid.children[start + i]?.classList.add('validRange');
      grid.children[start]?.classList.add('validStart');
    }
  }
  function applyPreview(startCell, cellCount, ok){
    clearPreviewClasses();
    const grid = document.getElementById('grid');
    for(let i=0;i<cellCount;i++){
      const cell = grid.children[startCell + i];
      if(cell) cell.classList.add(ok ? 'previewOk' : 'previewBad');
    }
  }
  function getGridRect(){ return document.getElementById('grid').getBoundingClientRect(); }
  function cellFromPoint(x, y){
    const grid = document.getElementById('grid');
    const rect = getGridRect();
    if(x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
    const el = document.elementFromPoint(x, y);
    const cell = el && (el.classList?.contains('cell') ? el : el.closest?.('.cell'));
    if(!cell || !grid.contains(cell)) return null;
    const idx = Number(cell.dataset.idx);
    return Number.isFinite(idx) ? idx : null;
  }

  function buildGrid(){
    const grid = document.getElementById('grid');
    grid.innerHTML = '';
    for(let i=0;i<state.totalCells;i++){
      const d = document.createElement('div');
      d.className = 'cell';
      d.dataset.idx = String(i);
      d.innerHTML = '<div class="mark"></div>';
      d.addEventListener('click', () => {
        if(state.selectedPrefix === null) return;
        addAllocation(state.selectedPrefix, i);
      });
      grid.appendChild(d);
    }
    renderGrid();
  }

  function renderGrid(){
    const grid = document.getElementById('grid');
    clearPlacementHints();
    for(let i=0;i<state.totalCells;i++){
      const cell = grid.children[i];
      if(!cell) continue;
      cell.style.background = '';
      cell.title = '';
      clearCellMarks(cell);
    }
    for(const a of state.allocations){
      for(let i=0;i<a.cellCount;i++){
        const cell = grid.children[a.startCell + i];
        if(!cell) continue;
        cell.classList.add('occupied');
        cell.style.background = a.color;
        cell.title = a.cidr;
      }
      const startCell = grid.children[a.startCell];
      const endCell = grid.children[a.startCell + a.cellCount - 1];

      if(startCell){
        startCell.classList.add('startMark');
        const startDot = document.createElement('div');
        startDot.className = 'mark';
        startDot.style.background = 'var(--ok)';
        startDot.style.position = 'absolute';
        startDot.style.top = '6px';
        startDot.style.left = '6px';
        startCell.appendChild(startDot);
      }
      if(endCell){
        endCell.classList.add('endMark');
        const endDot = document.createElement('div');
        endDot.className = 'mark';
        endDot.style.background = 'var(--danger)';
        endDot.style.position = 'absolute';
        endDot.style.right = '6px';
        endDot.style.bottom = '6px';
        endCell.appendChild(endDot);
      }
    }
    applyPlacementHints();
  }

  function renderPalette(){
    const pal = document.getElementById('palette');
    pal.innerHTML = '';
    if(!state.cidr) return;
    const basePrefix = state.cidr.prefix;
    const pp = state.pixelPrefix;
    for(let p = basePrefix; p <= pp; p++){
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'blockBtn';
      const remain = remainingBlocksForPrefix(p);
      const cellCount = blockCellCount(pp, p);
      btn.textContent = `/${p} (${remain})`;
      btn.dataset.prefix = String(p);
      btn.dataset.cells = String(cellCount);
      btn.title = `+${p - basePrefix} bit(s), ${cellCount} pixel(s)`;
      if(remain === 0) btn.classList.add('disabled');
      if(state.selectedPrefix === p) btn.classList.add('selected');
      btn.addEventListener('click', () => {
        if(btn.classList.contains('disabled')) return;
        state.selectedPrefix = p;
        renderPalette();
        renderGrid();
        setStatus(`Selected /${p}. Highlighted cells show every valid aligned placement.`, 'ok');
      });
      btn.addEventListener('pointerdown', (ev) => {
        if(btn.classList.contains('disabled')) return;
        ev.preventDefault();
        startDrag(ev, p, cellCount);
      }, { passive: false });
      pal.appendChild(btn);
    }
  }

  function sortAllocations(items){
    const arr = [...items];
    const key = state.sortKey;
    const dir = state.sortDir === 'desc' ? -1 : 1;
    arr.sort((a,b) => {
      let av, bv;
      switch(key){
        case 'label': av = a.label; bv = b.label; break;
        case 'cidr': av = a.cidr; bv = b.cidr; break;
        case 'cellCount': av = a.cellCount; bv = b.cellCount; break;
        case 'addresses': av = pow2(state.cidr.totalBits - a.prefix); bv = pow2(state.cidr.totalBits - b.prefix); break;
        case 'usable':
          if(state.cidr.version === 6){
            av = pow2(state.cidr.totalBits - a.prefix);
            bv = pow2(state.cidr.totalBits - b.prefix);
          } else {
            const ah = state.cidr.totalBits - a.prefix;
            const bh = state.cidr.totalBits - b.prefix;
            av = a.prefix === 32 ? 1n : a.prefix === 31 ? 2n : pow2(ah) - 2n;
            bv = b.prefix === 32 ? 1n : b.prefix === 31 ? 2n : pow2(bh) - 2n;
          }
          break;
        case 'firstStr': av = a.first; bv = b.first; break;
        case 'lastStr': av = a.last; bv = b.last; break;
        default: av = a.startCell; bv = b.startCell;
      }
      if(typeof av === 'string' && typeof bv === 'string'){
        return av.localeCompare(bv, undefined, {numeric:true, sensitivity:'base'}) * dir;
      }
      if(av < bv) return -1 * dir;
      if(av > bv) return 1 * dir;
      return (a.startCell - b.startCell) * dir;
    });
    return arr;
  }

  function updateSortHeaders(){
    document.querySelectorAll('th[data-sort]').forEach(th => {
      th.classList.remove('sortedAsc','sortedDesc');
      if(th.dataset.sort === state.sortKey){
        th.classList.add(state.sortDir === 'desc' ? 'sortedDesc' : 'sortedAsc');
      }
    });
  }

  function renderTable(){
    const body = document.getElementById('allocBody');
    body.innerHTML = '';
    const sorted = sortAllocations(state.allocations);
    for(const a of sorted){
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${a.label}</td>
        <td>${a.cidr}</td>
        <td>${a.cellCount}</td>
        <td>${addrCountStr(state.cidr.totalBits, a.prefix)}</td>
        <td>${usableHostsStr(state.cidr.version, state.cidr.totalBits, a.prefix)}</td>
        <td>${a.firstStr}</td>
        <td>${a.lastStr}</td>
        <td><button type="button" class="smallBtn">Remove</button></td>`;
      tr.querySelector('.smallBtn').addEventListener('click', () => removeAllocation(a.id));
      body.appendChild(tr);
    }
    updateSortHeaders();
  }

  function addAllocation(prefix, dropCellIndex){
    const cellCount = blockCellCount(state.pixelPrefix, prefix);
    const start = snappedStart(dropCellIndex, cellCount);
    if(!canPlace(start, cellCount)){
      setStatus('That placement overlaps an existing block or violates alignment.', 'error');
      return false;
    }
    const id = state.nextId++;
    const pixelSize = pow2(state.cidr.totalBits - state.pixelPrefix);
    const blockSize = pow2(state.cidr.totalBits - prefix);
    const net = state.cidr.base + BigInt(start) * pixelSize;
    const last = net + blockSize - 1n;
    const alloc = {
      id,
      label: `Block ${id}`,
      prefix,
      startCell: start,
      cellCount,
      cidr: `${fmtIP(state.cidr.version, net)}/${prefix}`,
      first: net,
      last,
      firstStr: fmtIP(state.cidr.version, net),
      lastStr: fmtIP(state.cidr.version, last),
      color: colorForId(id),
    };
    for(let i=0;i<cellCount;i++) state.used[start + i] = id;
    state.allocations.push(alloc);
    renderGrid();
    renderTable();
    renderPalette();
    setStatus(`Placed ${alloc.cidr}`, 'ok');
    return true;
  }

  function removeAllocation(id){
    const idx = state.allocations.findIndex(a => a.id === id);
    if(idx === -1) return;
    const a = state.allocations[idx];
    for(let i=0;i<a.cellCount;i++) state.used[a.startCell + i] = null;
    state.allocations.splice(idx, 1);
    renderGrid();
    renderTable();
    renderPalette();
    setStatus(`Removed ${a.cidr}`, 'ok');
  }
  function clearAllocations(){
    state.used = new Array(state.totalCells).fill(null);
    state.allocations = [];
    state.nextId = 1;
    renderGrid();
    renderTable();
    renderPalette();
    setStatus('Cleared all blocks.', 'ok');
  }

  function updatePreviewAtPoint(clientX, clientY){
    if(!state.dragging) return;
    const idx = cellFromPoint(clientX, clientY);
    if(idx === null){
      state.preview = null;
      clearPreviewClasses();
      return;
    }
    const start = snappedStart(idx, state.dragging.cellCount);
    const ok = canPlace(start, state.dragging.cellCount);
    state.preview = { startCell: start, cellCount: state.dragging.cellCount, ok, idx };
    applyPreview(start, state.dragging.cellCount, ok);
  }

  function stopDrag(commit, clientX, clientY){
    if(!state.dragging) return;
    document.removeEventListener('pointermove', state.moveHandler);
    document.removeEventListener('pointerup', state.upHandler);
    document.removeEventListener('pointercancel', state.cancelHandler);
    const drag = state.dragging;
    state.dragging = null;
    state.moveHandler = state.upHandler = state.cancelHandler = null;
    if(commit){
      const idx = cellFromPoint(clientX, clientY);
      if(idx !== null) addAllocation(drag.prefix, idx);
      else setStatus('Drop the block onto the grid.', 'error');
    }
    state.preview = null;
    clearPreviewClasses();
    renderGrid();
  }

  function startDrag(ev, prefix, cellCount){
    state.selectedPrefix = prefix;
    state.dragging = { prefix, cellCount, pointerId: ev.pointerId };
    renderPalette();
    renderGrid();
    state.moveHandler = (moveEv) => updatePreviewAtPoint(moveEv.clientX, moveEv.clientY);
    state.upHandler = (upEv) => stopDrag(true, upEv.clientX, upEv.clientY);
    state.cancelHandler = () => stopDrag(false, 0, 0);
    document.addEventListener('pointermove', state.moveHandler, { passive: true });
    document.addEventListener('pointerup', state.upHandler, { passive: true, once: true });
    document.addEventListener('pointercancel', state.cancelHandler, { passive: true, once: true });
    updatePreviewAtPoint(ev.clientX, ev.clientY);
    setStatus(`Dragging /${prefix}. Highlighted zones show valid aligned placements.`, 'ok');
  }

  function applyBase(){
    try{
      const cidr = parseCIDR(document.getElementById('cidr').value);
      state.cidr = cidr;
      state.pixelPrefix = choosePixelPrefix(cidr.totalBits, cidr.prefix);
      state.used = new Array(state.totalCells).fill(null);
      state.allocations = [];
      state.nextId = 1;
      state.selectedPrefix = null;
      const baseLabel = `${fmtIP(cidr.version, cidr.base)}/${cidr.prefix}`;
      document.getElementById('baseLabel').textContent = baseLabel;
      document.getElementById('pixelLabel').textContent = `/${state.pixelPrefix} (each cell = 2^${cidr.totalBits - state.pixelPrefix} address(es))`;
      buildGrid();
      renderPalette();
      renderTable();
      setStatus(`Loaded ${baseLabel}`, 'ok');
    } catch(err){
      setStatus(err.message || 'Invalid CIDR', 'error');
    }
  }

  function fitGridToViewport(){
    const root = document.documentElement;
    const width = window.innerWidth;
    const height = window.innerHeight;
    let size;
    if(width <= 760){
      size = Math.min(width - 40, height * 0.7, 560);
    } else if(width <= 1150){
      size = Math.min(width - 290, height * 0.62, 700);
    } else {
      size = Math.min(width - 640, height * 0.68, 760);
    }
    root.style.setProperty('--gridSize', `${Math.max(260, Math.floor(size))}px`);
  }

  function boot(){
    document.getElementById('applyBtn').addEventListener('click', applyBase);
    document.getElementById('clearBtn').addEventListener('click', clearAllocations);
    document.getElementById('cidr').addEventListener('keydown', (ev) => { if(ev.key === 'Enter') applyBase(); });
    document.querySelectorAll('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if(state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.sortKey = key; state.sortDir = 'asc'; }
        renderTable();
      });
    });
    window.addEventListener('resize', fitGridToViewport, { passive: true });
    fitGridToViewport();
    applyBase();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
