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

## What the editor does
- Upload -> the background is removed automatically -> the result appears in the editor.
- One shared editing session: the original photo, the automatic mask, the edited mask, the background choice and the undo history are all kept separately. Brush, Background and Export never rebuild the editor from the upload.
- Brush: Erase and Restore edit the transparency mask (Restore reveals your original pixels). Size, softness, zoom, pan, undo, redo and reset.
- Background: transparent, solid colour, gradient or your own image.
- Export: transparent PNG, PNG with background, or JPG; optionally at the original photo size.

## How the cut-out works (no AI model, no API)
`engine.js` is original code. For a flat backdrop it builds a colour-difference matte (each edge pixel's transparency comes from how far it lies between the backdrop colour and the nearest solid subject colour); for other backgrounds it learns backdrop and subject colours, scores every pixel, and snaps the outline to real edges. It is a classical algorithm, not a trained neural network, so busy or similar-coloured backgrounds need the brush.

## Tests
`/tests` is not included in the site, but the engine and editor were checked with synthetic images (signature on white with a watermark strip, a multicolour subject on black, white, grey, green and blue, a textured wall, a logo, a 12 MP photo) and an automated run of the full workflow: upload, tool switching, erase, restore, undo, redo, reset, backgrounds, PNG/JPG/original-size export.
