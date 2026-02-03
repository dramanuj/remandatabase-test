/*
 * AngularJS version of the Company Globe Map
 *
 * This module loads Excel data, geocodes locations, renders them
 * on a 3D globe with Globe.gl and provides dynamic filtering
 * via Angular bindings. The UI is intentionally minimalist and
 * pastel‑coloured, inspired by wind maps aesthetics. The sidebar
 * remains collapsed until explicitly opened, keeping focus on
 * the globe. Legend entries live inside the sidebar rather than
 * overlaying the map.
 */

// Utility functions and variables shared outside the Angular context

const EXCEL_URL = "data/companies.xlsx";
const REQUIRED = ["Company Name", "Company Type", "Country", "City"];
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

// Geocode cache management
const geocodeCacheKey = "companyGlobe_geocodeCache_v1";
function loadGeocodeCache() {
  try {
    const raw = localStorage.getItem(geocodeCacheKey);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function saveGeocodeCache() {
  try {
    localStorage.setItem(geocodeCacheKey, JSON.stringify(geocodeCache));
  } catch (e) {
    console.warn("Could not save geocode cache", e);
  }
}
let geocodeCache = loadGeocodeCache();

function makeGeocodeKey(city, country) {
  return `${normalize(city).toLowerCase()}|${normalize(country).toLowerCase()}`;
}

async function geocodeCityCountry(city, country) {
  const key = makeGeocodeKey(city, country);
  if (geocodeCache[key] !== undefined) {
    return geocodeCache[key];
  }
  const q = `${normalize(city)}, ${normalize(country)}`;
  const params = new URLSearchParams({ q, format: "json", limit: "1" });
  try {
    const res = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "company-globe-map-angular (static demo)"
      }
    });
    if (!res.ok) throw new Error(`Geocode failed: ${res.status}`);
    const data = await res.json();
    let result = null;
    if (Array.isArray(data) && data.length > 0) {
      result = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
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

// Normalisation and colour helpers
function normalize(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function colorForType(type) {
  const s = normalize(type) || "Unknown";
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  // Pastel colours have high lightness and moderate saturation
  return `hsl(${hue}, 65%, 60%)`;
}

// Toast helper (outside Angular for convenience)
function toast(msg, ms = 3500) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), ms);
}

// Excel parsing
async function loadExcel() {
  const res = await fetch(EXCEL_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch Excel: ${res.status} ${res.statusText}`);
  const buffer = await res.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

function validateColumns(rows) {
  const cols = new Set();
  rows.forEach(r => Object.keys(r).forEach(k => cols.add(k)));
  return REQUIRED.filter(c => !cols.has(c));
}

// Angular module and controller
(function() {
  const app = angular.module('companyMapApp', []);
  app.controller('MapController', ['$scope', function($scope) {
    const vm = this;

    // State variables
    vm.sidebarCollapsed = true;
    vm.allRows = [];
    vm.filteredRows = [];
    vm.filters = {};
    vm.filterDefs = [];
    vm.globalSearch = '';
    vm.selectedRow = null;
    vm.legendEntries = [];

    // Internal variables
    let pointsData = [];
    let globe; // Globe instance

    // Toggle sidebar collapsed state
    vm.toggleSidebar = function() {
      vm.sidebarCollapsed = !vm.sidebarCollapsed;
    };

    // Reset all filters and search
    vm.resetFilters = function() {
      vm.filters = {};
      vm.globalSearch = '';
      vm.applyFilters();
    };

    // Apply current filter settings to data
    vm.applyFilters = async function() {
      vm.selectedRow = null;
      vm.filteredRows = vm.allRows.filter(rowMatchesFilters);
      updateLegend();
      await buildPointsData(vm.filteredRows);
      updateGlobe();
      // update Angular view
      $scope.$applyAsync();
    };

    // Row filter helper
    function rowMatchesFilters(row) {
      // column filters
      for (const col in vm.filters) {
        const val = vm.filters[col];
        if (val && normalize(row[col]) !== val) return false;
      }
      // global search
      if (vm.globalSearch) {
        const search = vm.globalSearch.toLowerCase();
        const haystack = Object.keys(row).map(k => normalize(row[k]).toLowerCase()).join(' | ');
        if (!haystack.includes(search)) return false;
      }
      return true;
    }

    // Build definitions for filter dropdowns
    function buildFilterDefs(rows) {
      vm.filterDefs = [];
      const cols = new Set();
      rows.forEach(r => Object.keys(r).forEach(k => cols.add(k)));
      const MAX_UNIQUES = 150;
      cols.forEach(col => {
        const uniques = new Set();
        for (const r of rows) {
          const v = normalize(r[col]);
          if (v) uniques.add(v);
          if (uniques.size > MAX_UNIQUES) break;
        }
        if (uniques.size === 0 || uniques.size > MAX_UNIQUES) return;
        vm.filterDefs.push({ name: col, values: Array.from(uniques).sort((a,b) => a.localeCompare(b)) });
      });
    }

    // Update legend entries based on current filtered data
    function updateLegend() {
      const types = new Set(vm.filteredRows.map(r => normalize(r['Company Type']) || 'Unknown'));
      vm.legendEntries = Array.from(types).sort((a,b) => a.localeCompare(b)).map(t => ({ type: t, color: colorForType(t) }));
    }

    // Build points data for the globe
    async function buildPointsData(rows) {
      const pts = [];
      let missing = 0;
      let added = 0;
      for (const row of rows) {
        let lat = row.Latitude !== undefined && row.Latitude !== '' ? parseFloat(row.Latitude) : null;
        let lng = row.Longitude !== undefined && row.Longitude !== '' ? parseFloat(row.Longitude) : null;
        const city = normalize(row['City']);
        const country = normalize(row['Country']);
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
        const type = normalize(row['Company Type']) || 'Unknown';
        const color = colorForType(type);
        pts.push({ lat, lng, row, color });
        added++;
      }
      pointsData = pts;
      if (missing > 0) {
        toast(`${added} marker(s) added. ${missing} row(s) missing location or could not be geocoded.`);
      } else {
        toast(`${added} marker(s) added.`);
      }
    }

    // Render points on the globe
    function updateGlobe() {
      if (!globe) return;
      // Render markers as HTML pins instead of 3D cylinders. Each point in pointsData
      // has lat, lng, row (data) and color fields. Globe.gl will use the lat/lng
      // properties to position the DOM element on the globe. The htmlElement callback
      // creates a button element representing a pin. A click handler updates
      // the selectedRow on the Angular view model.
      globe.htmlElementsData(pointsData)
        .htmlElement(p => {
          const el = document.createElement('button');
          el.className = "pin";
          el.type = "button";
          const companyName = normalize(p.row['Company Name']) || "Company";
          el.setAttribute("aria-label", `View details for ${companyName}`);
          el.innerHTML = `
            <span class="pin__stem"></span>
            <span class="pin__head"></span>
          `;
          el.style.setProperty('--pin-color', p.color || "#c5101a");
          el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            $scope.$applyAsync(() => {
              vm.selectedRow = p.row;
            });
          });
          return el;
        });
    }

    // Initialisation routine
    async function init() {
      // Initialise globe
         globe = Globe()(document.getElementById('globeViz'))
        .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-dark.jpg')
        .backgroundColor(getComputedStyle(document.documentElement).getPropertyValue('--background').trim())
        .pointOfView({ lat: 20, lng: 0, altitude: 2 });
      const controls = globe.controls();
      controls.enableDamping = true;
      controls.dampingFactor = 0.05;
      controls.rotateSpeed = 0.5;
      controls.zoomSpeed = 0.7;
      try {
        vm.allRows = await loadExcel();
        const missingCols = validateColumns(vm.allRows);
        if (missingCols.length) {
          toast(`Excel missing required columns: ${missingCols.join(', ')}`, 6000);
          return;
        }
        vm.filteredRows = vm.allRows;
        buildFilterDefs(vm.allRows);
        updateLegend();
        await buildPointsData(vm.filteredRows);
        updateGlobe();
        // inform Angular of changes
        $scope.$applyAsync();
      } catch (e) {
        console.error(e);
        toast(`Error loading data: ${e.message}`, 8000);
      }
    }
    // Kick off the app
    init();
  }]);
})();
