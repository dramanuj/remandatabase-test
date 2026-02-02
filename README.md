# Company Map (Leaflet + Excel)

A lightweight static web app you can host on **GitHub Pages**.

## What it does
- Loads `data/companies.xlsx` directly in the browser (no backend)
- Geocodes `City + Country` to coordinates (and caches results in the browser)
- Places colored markers by `Company Type`
- Click a marker to see *all columns* from the Excel row
- Auto-builds filter dropdowns for any columns (when unique values are reasonable)

## Update the map data
1. Edit `data/companies.xlsx`
2. Commit/push to GitHub
3. Refresh your GitHub Pages site

## Notes
- First load can be slower because of geocoding.
- For larger datasets, add `Latitude` and `Longitude` columns and update the JS to use them directly.
