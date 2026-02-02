/*
 * Interactive Company Globe Map
 *
 * This script loads an Excel file containing company information, geocodes
 * locations to latitude/longitude coordinates if necessary, renders them on
 * an interactive 3D globe using Globe.gl, and provides dynamic filtering
 * controls. The UI is kept minimal and modern, with a collapsible sidebar
 * and accessible colour palette inspired by DTU (red & white).
 */

/* ==========================
   Configuration
========================== */
const EXCEL_URL = "data/companies.xlsx";
const REQUIRED = ["Company Name", "Company Type", "Country", "City"];
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

/* ==========================
   State
========================== */
let globe; // Globe.gl instance
let allRows = [];
let filteredRows = [];
let filtersState = {}; // { columnName: selectedValue }
let globalSearchTerm = "";
let columnNames = [];
let pointsData = []; // points for globe

// Load geocode cache from localStorage
const geocodeCacheKey = "companyGlobe_geocodeCache_v1";
let geocodeCache = loadGeocodeCache();

/* ==========================
   Helpers
========================== */

// Normalise a value to a trimmed string
function normalize(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

// Escape HTML for insertion into attributes/innerHTML
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Create a deterministic colour for a company type
function colorForType(type) {
  const s = normalize(type) || "Unknown";
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

// Toast notification
function toast(msg, ms = 3500) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), ms);
}

// Save geocode cache to localStorage
function saveGeocodeCache() {
  try {
    localStorage.setItem(geocodeCacheKey, JSON.stringify(geocodeCache));
  } catch (e) {
    console.warn("Geocode cache save failed", e);
  }
}

// Load geocode cache from localStorage
function loadGeocodeCache() {
  try {
    const raw = localStorage.getItem(geocodeCacheKey);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// Generate a cache key for geocoding
function makeGeocodeKey(city, country) {
  return `${normalize(city).toLowerCase()}|${normalize(country).toLowerCase()}`;
}

// Geocode city/country to lat/lng using Nominatim; returns { lat, lng } or null
async function geocodeCityCountry(city, country) {
  const key = makeGeocodeKey(city, country);
  if (geocodeCache[key] !== undefined) {
    return geocodeCache[key];
  }
  // Build query
  const q = `${normalize(city)}, ${normalize(country)}`;
  const params = new URLSearchParams({ q, format: "json", limit: "1" });
  try {
    const res = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
      headers: {
        "Accept": "application/json",
        // Identify the application politely per Nominatim usage policy
        "User-Agent": "company-globe-map (static demo)"
      }
    });
    if (!res.ok) throw new Error(`Geocode failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    let result = null;
    if (Array.isArray(data) && data.length > 0) {
      const lat = parseFloat(data[0].lat);
      const lon = parseFloat(data[0].lon);
      result = { lat, lng: lon };
    }
    geocodeCache[key] = result;
    saveGeocodeCache();
    return result;
  } catch (e) {
    console.warn(`Geocode error for ${q}`, e);
    geocodeCache[key] = null;
    saveGeocodeCache();
    return null;
  }
}

// Update statistics counters in the UI
function updateStats() {
  document.getElementById("rowsLoaded").textContent = allRows.length;
  document.getElementById("rowsShown").textContent = filteredRows.length;
}

// Build dynamic filter controls based on the data columns and values
function buildFilters(rows) {
  const filtersEl = document.getElementById("filters");
  filtersEl.innerHTML = "";
  filtersState = {};
  // Collect column names across rows
  const cols = new Set();
  rows.forEach(r => Object.keys(r).forEach(k => cols.add(k)));
  columnNames = Array.from(cols);

  // Build a dropdown for columns with a moderate number of unique values
  const MAX_UNIQUES = 150;
  columnNames.forEach(col => {
    // Determine unique values; skip empty strings
    const uniques = new Set();
    for (const r of rows) {
      const v = normalize(r[col]);
      if (v) uniques.add(v);
      if (uniques.size > MAX_UNIQUES) break;
    }
    if (uniques.size === 0 || uniques.size > MAX_UNIQUES) return;
    const wrapper = document.createElement("div");
    wrapper.className = "filter";
    const label = document.createElement("label");
    label.innerHTML = `<span>${escapeHtml(col)}</span><span class="pill">${uniques.size}</span>`;
    wrapper.appendChild(label);
    const select = document.createElement("select");
    select.className = "select";
    select.dataset.col = col;
    // Default option
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "All";
    select.appendChild(opt0);
    // Sorted options
    const sorted = Array.from(uniques).sort((a, b) => a.localeCompare(b));
    sorted.forEach(v => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      select.appendChild(opt);
    });
    select.addEventListener("change", () => {
      const c = select.dataset.col;
      const val = select.value;
      if (val) filtersState[c] = val; else delete filtersState[c];
      applyFilters();
    });
    wrapper.appendChild(select);
    filtersEl.appendChild(wrapper);
  });
}

// Determine if a row matches all active filters and global search
function rowMatchesFilters(row) {
  // Check per-column filters
  for (const [col, val] of Object.entries(filtersState)) {
    if (normalize(row[col]) !== val) return false;
  }
  // Check global search
  if (globalSearchTerm) {
    const haystack = columnNames.map(c => normalize(row[c]).toLowerCase()).join(" | ");
    if (!haystack.includes(globalSearchTerm)) return false;
  }
  return true;
}

// Apply filters and update UI
async function applyFilters() {
  filteredRows = allRows.filter(rowMatchesFilters);
  updateStats();
  updateLegend(filteredRows);
  // Rebuild points and render
  await buildPointsData(filteredRows);
  renderPoints();
}

// Build the legend from the filtered data
function updateLegend(rows) {
  const legendEl = document.getElementById("legend");
  legendEl.innerHTML = "";
  if (!rows || rows.length === 0) return;
  const types = new Set(rows.map(r => normalize(r["Company Type"]) || "Unknown"));
  const sorted = Array.from(types).sort((a, b) => a.localeCompare(b));
  const title = document.createElement("div");
  title.className = "legend-title";
  title.textContent = "Legend";
  legendEl.appendChild(title);
  const itemsEl = document.createElement("div");
  itemsEl.className = "legend-items";
  sorted.forEach(t => {
    const color = colorForType(t);
    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = `
      <span class="legend-swatch" style="background:${color}"></span>
      <span>${escapeHtml(t)}</span>
    `;
    itemsEl.appendChild(item);
  });
  legendEl.appendChild(itemsEl);
}

// Build the infobox for a selected company
function showInfo(row) {
  const box = document.getElementById("infobox");
  if (!row) {
    box.classList.add("hidden");
    return;
  }
  box.innerHTML = "";
  box.classList.remove("hidden");
  const title = document.createElement("div");
  title.className = "infobox-title";
  title.textContent = normalize(row["Company Name"]) || "Company";
  box.appendChild(title);
  // Create entries for each non-empty field
  Object.keys(row).forEach(key => {
    const v = normalize(row[key]);
    if (!v) return;
    const entry = document.createElement("div");
    entry.className = "infobox-entry";
    const kEl = document.createElement("div");
    kEl.className = "key";
    kEl.textContent = key;
    const vEl = document.createElement("div");
    vEl.className = "value";
    vEl.textContent = v;
    entry.appendChild(kEl);
    entry.appendChild(vEl);
    box.appendChild(entry);
  });
}

// Fetch Excel file and parse JSON
async function loadExcel() {
  toast("Loading data…");
  const res = await fetch(EXCEL_URL, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to fetch Excel: ${res.status} ${res.statusText}`);
  }
  const buffer = await res.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  return rows;
}

// Validate that required columns are present
function validateColumns(rows) {
  const cols = new Set();
  rows.forEach(r => Object.keys(r).forEach(k => cols.add(k)));
  const missing = REQUIRED.filter(c => !cols.has(c));
  return missing;
}

// Build pointsData from rows: geocode if necessary
async function buildPointsData(rows) {
  const newPoints = [];
  let missing = 0;
  let added = 0;
  for (const row of rows) {
    const city = normalize(row["City"]);
    const country = normalize(row["Country"]);
    // Use latitude/longitude columns if present
    let lat = row.Latitude !== undefined ? parseFloat(row.Latitude) : null;
    let lng = row.Longitude !== undefined ? parseFloat(row.Longitude) : null;
    if ((lat === null || isNaN(lat)) || (lng === null || isNaN(lng))) {
      if (!city || !country) {
        missing++;
        continue;
      }
      const coords = await geocodeCityCountry(city, country);
      if (!coords) {
        missing++;
        continue;
      }
      lat = coords.lat;
      lng = coords.lng;
    }
    const type = normalize(row["Company Type"]) || "Unknown";
    const color = colorForType(type);
    newPoints.push({ lat, lng, row, color });
    added++;
  }
  pointsData = newPoints;
  if (missing > 0) {
    toast(`${added} marker(s) added. ${missing} row(s) missing location or could not be geocoded.`);
  } else {
    toast(`${added} marker(s) added.`);
  }
}

// Render points onto the globe
function renderPoints() {
  if (!globe) return;
  globe.pointsData(pointsData)
    .pointLat(p => p.lat)
    .pointLng(p => p.lng)
    .pointColor(p => p.color)
    .pointAltitude(() => 0.02)
    .pointRadius(() => 0.22)
    .pointLabel(p => {
      // Build tooltip content (HTML)
      const name = escapeHtml(normalize(p.row["Company Name"]) || "Company");
      const type = escapeHtml(normalize(p.row["Company Type"]) || "—");
      const loc = `${escapeHtml(normalize(p.row["City"]))}, ${escapeHtml(normalize(p.row["Country"]))}`;
      return `<div style="font-weight:600; margin-bottom:4px;">${name}</div><div style="font-size:11px; color:#555;">${type} · ${loc}</div>`;
    })
    .pointsMerge(false) // disable merge so we can click individual markers
    .onPointClick((p) => {
      showInfo(p.row);
    });
}

/* ==========================
   Event wiring and initialisation
========================== */

async function init() {
  // Initialise sidebar toggle
  const sidebar = document.getElementById("sidebar");
  document.getElementById("menuToggle").addEventListener("click", () => {
    sidebar.classList.toggle("collapsed");
  });
  // Reset filters button
  document.getElementById("btnResetFilters").addEventListener("click", () => {
    filtersState = {};
    globalSearchTerm = "";
    document.getElementById("globalSearch").value = "";
    // Reset dropdown selections
    document.querySelectorAll("#filters select").forEach(sel => sel.value = "");
    applyFilters();
  });
  // Global search input (debounced)
  const searchInput = document.getElementById("globalSearch");
  searchInput.addEventListener("input", () => {
    globalSearchTerm = normalize(searchInput.value).toLowerCase();
    clearTimeout(searchInput._debounce);
    searchInput._debounce = setTimeout(applyFilters, 200);
  });
  // Initialise globe instance
  globe = Globe()(document.getElementById("globeViz"))
    .globeImageUrl("https://unpkg.com/three-globe/example/img/earth-dark.jpg")
    .backgroundColor("#f7f7f7")
    .pointOfView({ lat: 20, lng: 0, altitude: 2 });
  // Use low auto-rotation speed for subtle movement
  const controls = globe.controls();
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.rotateSpeed = 0.6;
  controls.zoomSpeed = 0.6;
  // Load and render the data
  try {
    allRows = await loadExcel();
    const missingCols = validateColumns(allRows);
    if (missingCols.length) {
      toast(`Excel missing required columns: ${missingCols.join(", ")}`, 6000);
      throw new Error(`Missing columns: ${missingCols.join(", ")}`);
    }
    filteredRows = allRows;
    buildFilters(allRows);
    updateLegend(allRows);
    updateStats();
    await buildPointsData(allRows);
    renderPoints();
  } catch (e) {
    console.error(e);
    toast(`Error loading data: ${e.message}`, 8000);
  }
}

// Launch the app when the DOM is ready
window.addEventListener('DOMContentLoaded', init);