# Company Globe Map

This project is a lightweight static web application for visualising company data on an interactive **3D globe**. Data is read from an Excel file (`data/companies.xlsx`) and plotted on the globe with colour‑coded markers according to company type. Users can filter by any column, perform a global search across all fields, and click on markers to reveal detailed information.

## Features

- **3D Globe visualisation** using [Globe.gl](https://globe.gl/) and ThreeJS for smooth zooming and panning.
- **Excel integration** via [SheetJS](https://sheetjs.com/): update the `companies.xlsx` file to change the map data without touching the code.
- **Dynamic filters** automatically generated from the data columns. Filter by any column values using dropdowns, or search across all fields.
- **Accessible modern UI** inspired by DTU colours (red and white), with a collapsible sidebar, clear legend, and responsive design.
- **Client‑side geocoding** using the OpenStreetMap Nominatim API, with localStorage caching to improve subsequent loads. If your Excel file already contains `Latitude` and `Longitude` columns, they will be used directly, bypassing geocoding.

## Getting started

1. **Clone or download** the repository.
2. Place your Excel file at `data/companies.xlsx`. Make sure it includes at least these columns:
   - `Company Name`
   - `Company Type`
   - `Country`
   - `City`
3. Open `index.html` in a browser. The globe will load and plot your data. The first load may take a bit longer due to geocoding; subsequent loads will be faster thanks to caching.

## Deployment on GitHub Pages

1. Create a new GitHub repository and upload the contents of this folder (ensure that `index.html` is at the repository root).
2. Go to your repository settings → **Pages** → **Build and deployment**. Select “Deploy from a branch” → `main` (or your default branch) and the root folder (`/`).
3. Save your settings. GitHub will publish your site at a URL like `https://username.github.io/repo-name/`.

## Notes

- The application geocodes `City, Country` using the public Nominatim API. Please respect its usage limits and policies. For large datasets or faster loading, consider adding `Latitude` and `Longitude` columns to your Excel file.
- All geocode results are stored in your browser’s localStorage. To clear the cache, clear your browser’s storage or open developer tools and remove the `companyGlobe_geocodeCache_v1` key.
- This project is intentionally free of server dependencies and can run entirely on GitHub Pages or any static file hosting service.