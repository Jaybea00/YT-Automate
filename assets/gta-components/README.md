# gta-components (vendored subset)

Three Shorts components copied from https://github.com/echris6/gta-components
(commit 81181fda29c98b53a0d14659d8d1dafd62d84060, 2026-11-21), MIT licence (see LICENSE);
the fonts in shared/fonts are under the SIL Open Font License.

- shorts/09-wasted-stamp: the WASTED / BUSTED sting
- shorts/12-location-card: a place name over the shot
- shorts/33-social-frame: a clip shown as an in-world social post

They are rendered by src/pipeline/guide/motion.ts: each page's GSAP timeline is stepped frame by
frame in a headless browser with a transparent background (`bg: "none"`), and the frames become an
overlay for the guide Short. GSAP comes from the app's own `gsap` package, not the CDN the pages name.
Only the content (CONFIG) is changed, from the guide; the files here are kept as they were.
