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

## How the cut-out works (no AI model, no API, no outside code)
`engine.js` is original code. It works in three steps:
1. **Backdrop first.** It floods outwards from the photo's border while following the local backdrop colour (soft gradients are followed, sudden jumps such as a subject's edge stop it), recognises seams between two backdrop tones, and estimates what the backdrop looks like behind the subject.
2. **Colour-difference matte.** How far each pixel is from that backdrop gives the transparency. Edge pixels are measured against their nearest solid subject colour, so soft edges, hair strands and ink lines get true partial transparency. Watermark strips along an edge are dropped.
3. **Fallback.** When no usable backdrop can be found, it learns backdrop and subject colours separately and smooths the result along real edges.

It is a classical method, not a trained neural network. The brush in the editor is the fix for whatever it gets wrong.

## What was measured
A benchmark of 100 synthetic photos (flat, gradient, vignette, wall-and-floor, blobby and textured backdrops; people-like, product, hair-like and line-art subjects; JPEG artefacts) was used. 60 images were used to choose settings; 40 fresh ones were never used for any decision.

| | Original engine | Now |
|---|---|---|
| Fresh images, overlap with the true shape | 0.727 | 0.855 |
| Fresh images, average transparency error | 0.052 | 0.012 |
| The signature-with-watermark case | 0.81 | 0.99 |

Setting-tuning on only 36 images made results worse on unseen images (overfitting) and was rejected; tuning on 60 helped, and one setting was reverted after a noisy-image check. With heavy camera noise results drop (overlap about 0.79 at moderate noise, 0.73 at heavy noise). Real photographs have not been benchmarked, because none were available.
