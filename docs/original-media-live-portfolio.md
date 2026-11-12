# Original media: live portfolio checks

Date: 2026-11-11

These checks used the already-built `dist/extension` copied into isolated Chromium profiles. Alt+right click sent bytes to a fake local desktop receiver. Sharp checked every captured image. The anonymous live-page attempts and the Pinterest captured-DOM replay are reported separately; the replay is not counted as an anonymous page-load pass.

Temporary page HTML and media were written only inside `test-results/live-portfolio/<run-id>` and removed by the runner's `finally` cleanup. The `test-results/` tree is locally git-ignored.

| Site | Public page(s) attempted | Result |
| --- | --- | --- |
| Pinterest | [Pin 344314334016546758](https://www.pinterest.com/pin/344314334016546758/) | Anonymous page returned HTTP 200 but did not expose a visible, loaded artwork image in the isolated browser. A separate captured-DOM replay used the public Pin's observed `236x` JPEG, `4x` `originals` PNG candidate, and PWS original field. Alt+right click caused the extension to fetch the real CDN file to the fake desktop. Sharp verified **811×460 PNG, 584,139 bytes**. Final URL: [`i.pinimg.com/originals/...png`](https://i.pinimg.com/originals/84/9f/6e/849f6e995823741352f3e61d9bd5f613.png). **Captured-DOM replay; not an anonymous live-page pass.** |
| Huaban | [Pin 3154231487](https://huaban.com/pins/3154231487/), [homepage](https://huaban.com/) | Both returned HTTP 405 in direct and proxy modes. No public artwork candidate reached the extension; no download. |
| Behance | [Illustration Portfolio 2026](https://www.behance.net/gallery/242373217/Illustration-Portfolio-2026) | Isolated browser returned HTTP 403. A separate check in the existing Chrome session reached an Adobe identity reverification step for this same public page. No credentials were entered and no download was attempted. |
| ZCOOL | [Work sample 1](https://www.zcool.com.cn/work/ZNTY2Mzg4NDA=.html), [work sample 2](https://www.zcool.com.cn/work/ZNjE2MjQwOTI%3D.html) | Both returned HTTP 200 but only a minimal 117-character document with one loaded image and no artwork candidate, in direct and proxy checks. No download. |
| Dribbble | [Illustration](https://dribbble.com/shots/26052539-Illustration), [Isometric Ramen](https://dribbble.com/shots/26089505-Isometric-Ramen) | The first page returned HTTP 202 and navigated away during inspection. The second initially saved a resized variant: **752×752 JPEG, 295,133 bytes**, URL query `resize=752x`, below its 1024×1024 `currentSrc` and 1200×1200 `srcset` entry. A same-file URL probe without resize parameters returned HTTP 200 and **1200×1200 WebP, 128,440 bytes**. **Targeted extension rerun after the fix:** the first page remained inaccessible (HTTP 202); the second was saved from the same asset URL without resize parameters as **1200×1200 JPEG, 588,086 bytes**, larger than its displayed 1024×1024 current source. The extension classified it as `higher_quality_candidate`; this confirms an unscaled higher-resolution variant, not a publisher-declared original. |
| ArtStation | [CHARGE!](https://www.artstation.com/artwork/vz2GGO), [Environment design](https://www.artstation.com/artwork/1abEq) | The isolated browser received HTTP 403 on the first page. The existing Chrome session showed a security-check page on the second. No challenge was completed and no image was downloaded. |

**Huaban follow-up (2026-11-11):** The existing Chrome image viewer loaded the first board Pin's declared `file.url` and displayed **1080×1350**; its image bytes could not be exported from that viewer. A minimal captured-`__NEXT_DATA__` extension replay sent the fixture preview, not the declared original, to the isolated receiver. A diagnostic rerun with the same URL and no Playwright-forced proxy observed HTTP 567 `text/html` for both the top-level image request and extension fetch, with no redirect; the extension request had no `Referer`, `Origin`, `Sec-Fetch-Site`, or `Cookie` header. The top-level request also returned 567, so this does not establish that a missing referrer caused the rejection. A separate HTTP client GET with the temporary proxy also returned HTTP 567 HTML. No signature, cookie, or response HTML was retained, and no alternate URL or challenge flow was attempted. These checks do not change the HTTP 405 page-load result above or establish a real extension download of the original.

## ArtStation targeted follow-up

The original page-level result above remains unchanged: anonymous navigation returned HTTP 403, and the existing Chrome page showed a security check. No challenge was completed. A separate read-only DOM inspection found ArtStation image paths with three numeric asset-ID folders, an optional 14-digit dated folder, and size folders such as `small_square`, `smaller_square`, `large`, `4k`, and `8k`.

A bounded CDN probe of one same-asset `large` image returned HTTP 200 for `/8k/` and `/4k/`, but both responses were **1920×1074 JPEG, 680,680 bytes**, matching the displayed image's natural dimensions. `/original/` and the project's `.json` endpoint returned HTTP 403 in this environment. This sample does not support claiming a pixel upgrade or original-file recovery.

A second same-asset `small_square` sample was **800×800** in the captured DOM. Its timestamp-preserving `/8k/` URL returned **5246×2503 JPEG, 3,192,541 bytes**. The rebuilt extension's batch panel then saved that real CDN response from a minimal captured-DOM replay to the isolated receiver, and reported it as a candidate. This verifies the extension's same-asset URL transformation and download path; it is not an ArtStation page-load or account-state pass, and the 8k rendition is not described as the artist's original file.

The local browser fixture additionally exercised `small_square`, `smaller_square`, a dated folder, and a page already displaying `large`: three items saved a higher-ranked rendition, while an item whose 8k and 4k candidates both failed fell back to its exact preview. Candidate URLs retained their query strings. Fixture IDs and filenames are synthetic.

## Outcome categories

- **Original confirmed:** Pinterest replay final URL used the explicit `/originals/` path and Sharp dimensions matched the captured public page's declared original dimensions.
- **Resized variant / follow-up:** The first Dribbble run's final URL retained `resize=752x` and was smaller than the page's 1024×1024 displayed source. After the fix, the targeted rerun fetched the same asset with no resize parameter and uploaded a 1200×1200 JPEG. The original-suffix page remained inaccessible.
- **Source inaccessible or no artwork DOM:** Huaban, Behance, ZCOOL, and ArtStation did not provide a selectable public artwork image in the tested browser environment. ArtStation's separate captured-DOM/CDN replay is recorded above and does not change that page-load result. Dribbble's first page was also inaccessible, while its alternate public page was selectable.

The runner is [test-original-media-live-portfolio.mjs](../scripts/test-original-media-live-portfolio.mjs). It supports one bounded alternate public URL for selected sites, direct-mode checks, the Pinterest captured-DOM replay, and the single Dribbble same-file URL probe. Temporary profiles and captured media were removed by the runner after both targeted attempts.

## Validation

- `node --check scripts/test-original-media-live-portfolio.mjs` — passed.
- `npx eslint scripts/test-original-media-live-portfolio.mjs` — passed.
- No rebuild was run; the current built extension was copied by the live harness.
