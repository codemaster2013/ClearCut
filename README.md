# Clearcut

A free, private background remover that runs entirely in the browser. The cut-out engine (`engine.js`) is original code with no third-party libraries and no pretrained model.

## Put it online (GitHub Pages)
1. Create a new repository (for example `clearcut`) and upload everything in this folder to its top level.
2. Settings -> Pages -> deploy from the `main` branch, root.
3. Your address will look like `https://YOUR-NAME.github.io/clearcut`.
4. Replace `__SITE_URL__` with that address (no trailing slash) in `index.html`, `robots.txt` and `sitemap.xml`.
   Quick way on a computer: `sed -i 's#__SITE_URL__#https://YOUR-NAME.github.io/clearcut#g' index.html robots.txt sitemap.xml`
5. In Google Search Console add the site (URL prefix), then submit `sitemap.xml`.

## Rename the site
Change "Clearcut" in `index.html`, `manifest.webmanifest`, `404.html` and `og-image.png`.

## Files
- `index.html` page, `app.js` interface, `engine.js` cut-out engine, `worker.js` background thread
- `sw.js` + `manifest.webmanifest` offline/installable app
- icons, `og-image.png` social preview, `robots.txt`, `sitemap.xml`, `404.html`
