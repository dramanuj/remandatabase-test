/* ==========================
   Config
========================== */
const EXCEL_URL = "data/companies.xlsx";
const SHEET_NAME = null; // null => first sheet
const REQUIRED = ["Company Name", "Company Type", "Country", "City"];

// Nominatim (OpenStreetMap) geocoding endpoint.
// Note: be mindful of rate limits; this app caches results in localStorage.
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

/* ==========================
   State
========================== */
let map;
let markersLayer;
let allRows = [];
let filteredRows = [];
let columnNames = [];
let filtersState = {}; // { colName: selectedValue }
let globalSearchTerm = "";

const geocodeCacheKey = "companyMap_geocodeCache_v1";
let geocodeCache = loadGeocodeCache();

/* ==========================
   Helpers
========================== */
function toast(msg, ms = 3500) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  window.clearTimeout(toast._t);
  toast._t = window.setTimeout(() => el.classList.add("hidden"), ms);
}

function normalize(v) {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function saveGeocodeCache() {
  try {
    localStorage.setItem(geocodeCacheKey, JSON.stringify(geocodeCache));
  } catch (e) {
    console.warn("Could not save cache:", e);
  }
}

function loadGeocodeCache() {
  try {
    const raw = localStorage.getItem(geocodeCacheKey);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function colorForType(type) {
  // Deterministic color assignment by hashing the type string
  const s = normalize(type) || "Unknown";
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 85% 45%)`;
}

/* ==========================
   Leaflet init (Canvas renderer for smoother zoom)
========================== */
function initMap() {
  map = L.map("map", {
    worldCopyJump: true,
    preferCanvas: true
  }).setView([20, 0], 2);

  // Canvas renderer for vector layers (circle markers)
  const canvasRenderer = L.canvas({ padding: 0.5 });
  initMap._renderer = canvasRenderer;

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    updateWhenZooming: false,
    updateWhenIdle: true,
    keepBuffer: 2
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);
}

/* ==========================
   Excel loading
========================== */
async function fetchExcelArrayBuffer(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch Excel: ${res.status} ${res.statusText}`);
  return await res.arrayBuffer();
}

function parseExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetName = SHEET_NAME || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

/* ==========================
   Geocoding (cached)
========================== */
function makeGeocodeKey(city, country) {
  return `${normalize(city).toLowerCase()}|${normalize(country).toLowerCase()}`;
}

async function geocodeCityCountry(city, country) {
  const key = makeGeocodeKey(city, country);
  if (geocodeCache[key]) return geocodeCache[key];
  if (geocodeCache[key] === null) return null;

  const q = `${normalize(city)}, ${normalize(country)}`;
  const params = new URLSearchParams({ q, format: "json", limit: "1" });

  const res = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "company-map-github-pages (static demo)"
    }
  });

  if (!res.ok) throw new Error(`Geocode failed for "${q}" (${res.status})`);
  const data = await res.json();

  if (!Array.isArray(data) || data.length === 0) {
    geocodeCache[key] = null;
    saveGeocodeCache();
    return null;
  }

  const result = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  geocodeCache[key] = result;
  saveGeocodeCache();
  return result;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ==========================
   UI: filters
========================== */
function buildFilters(rows) {
  const filtersEl = document.getElementById("filters");
  filtersEl.innerHTML = "";
  filtersState = {};

  const cols = new Set();
  for (const r of rows) Object.keys(r).forEach((k) => cols.add(k));
  columnNames = Array.from(cols);

  const MAX_UNIQUES_FOR_DROPDOWN = 200;

  for (const col of columnNames) {
    const uniques = new Set();
    for (const r of rows) {
      const v = normalize(r[col]);
      if (v) uniques.add(v);
      if (uniques.size > MAX_UNIQUES_FOR_DROPDOWN) break;
    }
    if (uniques.size === 0) continue;
    if (uniques.size > MAX_UNIQUES_FOR_DROPDOWN) continue;

    const wrapper = document.createElement("div");
    wrapper.className = "filter";

    const label = document.createElement("label");
    label.innerHTML = `<span>${escapeHtml(col)}</span><span class="pill">${uniques.size}</span>`;
    wrapper.appendChild(label);

    const select = document.createElement("select");
    select.className = "select";
    select.dataset.col = col;

    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "All";
    select.appendChild(opt0);

    const sorted = Array.from(uniques).sort((a, b) => a.localeCompare(b));
    for (const v of sorted) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      select.appendChild(opt);
    }

    select.addEventListener("change", () => {
      const c = select.dataset.col;
      const val = select.value;
      if (val) filtersState[c] = val;
      else delete filtersState[c];
      applyFilters();
    });

    wrapper.appendChild(select);
    filtersEl.appendChild(wrapper);
  }
}

function rowMatchesFilters(row) {
  for (const [col, val] of Object.entries(filtersState)) {
    if (normalize(row[col]) !== val) return false;
  }

  if (globalSearchTerm) {
    const hay = columnNames.map((c) => normalize(row[c]).toLowerCase()).join(" | ");
    if (!hay.includes(globalSearchTerm)) return false;
  }

  return true;
}

/* ==========================
   Markers (Canvas circle markers)
========================== */
function popupHtml(row) {
  const title = escapeHtml(normalize(row["Company Name"]) || "Company");
  const type = escapeHtml(normalize(row["Company Type"]) || "—");
  const loc = `${escapeHtml(normalize(row["City"]))}, ${escapeHtml(normalize(row["Country"]))}`;

  const keys = Object.keys(row);
  const items = keys
    .filter((k) => normalize(row[k]) !== "")
    .map((k) => {
      const v = escapeHtml(row[k]);
      return `<div class="kv"><div class="k">${escapeHtml(k)}</div><div class="v">${v}</div></div>`;
    })
    .join("");

  return `
    <div style="min-width: 260px; max-width: 360px;">
      <div style="font-weight:950; font-size:14px; margin-bottom:6px;">${title}</div>
      <div style="font-size:12px; opacity:.75; margin-bottom:10px;">
        <span style="font-weight:900;">${type}</span> · ${loc}
      </div>
      <div style="display:flex; flex-direction:column; gap:6px;">
        ${items}
      </div>
      <style>
        .kv{display:flex; gap:10px; align-items:flex-start;}
        .k{min-width: 120px; font-size:11px; opacity:.65;}
        .v{font-size:12px;}
      </style>
    </div>
  `;
}

function clearMarkers() {
  markersLayer.clearLayers();
}

function updateStats() {
  document.getElementById("rowsLoaded").textContent = allRows.length;
  document.getElementById("rowsShown").textContent = filteredRows.length;
}

function rebuildLegend(rows) {
  const el = document.getElementById("legendItems");
  el.innerHTML = "";

  const types = new Set(rows.map((r) => normalize(r["Company Type"]) || "Unknown"));
  const sorted = Array.from(types).sort((a, b) => a.localeCompare(b));
  for (const t of sorted) {
    const color = colorForType(t);
    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = `
      <span class="legend-swatch" style="background:${color}"></span>
      <span>${escapeHtml(t)}</span>
    `;
    el.appendChild(item);
  }
}

async function addMarkersForRows(rows) {
  clearMarkers();

  const GEOCODE_DELAY_MS = 650;

  let added = 0;
  let missing = 0;
  const bounds = L.latLngBounds([]);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const city = normalize(r["City"]);
    const country = normalize(r["Country"]);
    const type = normalize(r["Company Type"]) || "Unknown";

    if (!city || !country) { missing++; continue; }

    const coords = await geocodeCityCountry(city, country);
    if (!coords) { missing++; continue; }

    const color = colorForType(type);

    const marker = L.circleMarker([coords.lat, coords.lon], {
      renderer: initMap._renderer,
      radius: 6,
      weight: 2,
      color: "#ffffff",
      opacity: 0.9,
      fillColor: color,
      fillOpacity: 0.9
    });

    marker.bindPopup(popupHtml(r), { maxWidth: 420 });
    marker.addTo(markersLayer);

    bounds.extend([coords.lat, coords.lon]);
    added++;

    if (i % 4 === 0) await sleep(GEOCODE_DELAY_MS);
  }

  updateStats();

  if (added > 0 && bounds.isValid()) {
    map.fitBounds(bounds.pad(0.2));
  }

  if (missing > 0) toast(`Added ${added} marker(s). ${missing} row(s) missing a location or couldn’t be geocoded.`);
  else toast(`Added ${added} marker(s).`);
}

/* ==========================
   Filtering application
========================== */
function applyFilters() {
  filteredRows = allRows.filter(rowMatchesFilters);
  rebuildLegend(filteredRows);
  updateStats();
  addMarkersForRows(filteredRows);
}

/* ==========================
   Validation
========================== */
function validateColumns(rows) {
  const cols = new Set();
  for (const r of rows) Object.keys(r).forEach((k) => cols.add(k));
  return REQUIRED.filter((c) => !cols.has(c));
}

/* ==========================
   Main load
========================== */
async function loadAndRender() {
  toast("Loading Excel…");
  const buffer = await fetchExcelArrayBuffer(EXCEL_URL);
  const rows = parseExcel(buffer);

  const missing = validateColumns(rows);
  if (missing.length) {
    toast(`Excel missing required columns: ${missing.join(", ")}`, 7000);
    throw new Error(`Missing required columns: ${missing.join(", ")}`);
  }

  allRows = rows;
  filteredRows = rows;

  buildFilters(allRows);
  rebuildLegend(allRows);
  updateStats();

  toast("Placing markers… first load may take a moment.");
  await addMarkersForRows(allRows);
}

/* ==========================
   Events
========================== */
function initEvents() {
  document.getElementById("btnReload").addEventListener("click", async () => {
    try { await loadAndRender(); }
    catch (e) { console.error(e); toast(`Reload failed: ${e.message}`, 6000); }
  });

  document.getElementById("btnClearCache").addEventListener("click", () => {
    geocodeCache = {};
    saveGeocodeCache();
    toast("Geocode cache cleared for this browser.");
  });

  document.getElementById("btnResetFilters").addEventListener("click", () => {
    filtersState = {};
    globalSearchTerm = "";
    document.getElementById("globalSearch").value = "";
    document.querySelectorAll(".filters select").forEach((s) => (s.value = ""));
    applyFilters();
  });

  document.getElementById("globalSearch").addEventListener("input", (e) => {
    globalSearchTerm = normalize(e.target.value).toLowerCase();
    window.clearTimeout(initEvents._t);
    initEvents._t = window.setTimeout(applyFilters, 200);
  });

  const sidebar = document.getElementById("sidebar");
  document.getElementById("btnToggleSidebar").addEventListener("click", () => {
    sidebar.classList.toggle("is-collapsed");
    setTimeout(() => map.invalidateSize(), 150);
  });
}

/* ==========================
   Boot
========================== */
(async function boot() {
  try {
    initMap();
    initEvents();
    await loadAndRender();
  } catch (e) {
    console.error(e);
    toast(`Startup error: ${e.message}`, 8000);
  }
})();
