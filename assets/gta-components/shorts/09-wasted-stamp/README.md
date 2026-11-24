# 09 · Wasted stamp

The fail sting for GTA 6 compilation shorts, staged as a death-cam:
- The clip runs at real speed.
- On the hit, the world drops into smooth slow motion that keeps slowing, drains to hard black-and-white and snaps into a cinematic letterbox band (1080×820, closing in to 1080×680, about 1.6:1).
- A dark GTA-style ribbon (a flat .82 core with a short feather, edge to edge) slides in across it. The word slams onto it in wide Archivo caps, lit by its own bloom: a tracking slam, blur, a short RGB split, and an exposure flash and shake on the footage only.
- The top bar carries one line of meta: a time-coded kicker that belongs to the moment ("TIME OF DEATH · 14:32") over WASTED, or the five wanted stars over BUSTED.
- In Busted only the police lights keep their colour: the light bar burns blue and the tail lights red in a crushed black-and-white frame, pulsing with the word's bloom.
- A second beat lands in the hold: a glint sweeps across WASTED, or the wanted stars empty out.
- The type blurs out, the dark band slides away and the letterbox shuts like an eye. The comp ends as it shuts, so you can cut straight to the next clip.

It uses our own type (Archivo), not Pricedown, and no logos.

**When to use it:** at the payoff of a fail, crash, wipe-out or arrest in a "GTA 6 fails", "funniest GTA 6 moments" or "cops in GTA 6" compilation, or as a hard beat to end a clip. The win counterpart is #10 Mission passed.

| Variant | Word | Hit | Style |
|---|---|---|---|
| `0` Wasted | WASTED, lit red, centred in the band on the ribbon; time-of-death kicker in the top bar | Hard cut to the slowed 16:9 master in the band, bars cut in, white flash | Hard black-and-white with a highlight roll-off; a narrow warm glint crosses the word at about 3.7 s |
| `1` Busted | BUSTED, white-hot steel (the blue lives in the lights), on the ribbon in the band's lower third; five wanted stars in the top bar | Speed ramp on the same shot; the bars cut in wide and clamp down; blue flash | Crushed noir mono with only the police lights in colour; the lights and the bloom pulse together; the stars empty right to left |

Timeline (5.0 s, 30 fps):
- **0–1.2 s:** real speed.
- **1.12 s:** the dark band starts sliding in from the left, motion-blurred.
- **1.2 s, the hit (frame 36):** the cut or speed ramp, the letterbox (an 820 px band; Busted's cuts in at 880 and clamps to 820 over 0.3 s), the flash, the shake, and the word slam with an 8 px RGB split. The colour drains over 0.45 s; in Busted the police lights fade back in as colour.
- **1.5 s:** the kicker rises in char by char (Wasted) or the stars pop in (Busted), in the top bar.
- **1.8–4.5 s:** the band closes in 820 → 680 px (Wasted y 620–1300; Busted y 540–1220), with a slow push on the footage and a slow drift of the word's scale and tracking. Wasted's slow motion eases from 0.32x to 0.20x as the SUV goes over.
- **3.2–4.2 s:** the glint sweeps across WASTED (Wasted). **3.2–4.0 s:** the stars empty (Busted).
- **4.3 s:** the type blurs out, then the dark band slides off to the right.
- **4.5–5.0 s:** the letterbox shuts. The comp ends on the last sliver, with no black tail.

## CONFIG fields
All content is in `const CONFIG` at the top of the script in `index.html`.

- `variants["0" | "1"]`
  - `word`: the stamp word. It is set in caps and auto-fits to `layout.wordWidth`, so "CLAPPED" or "FAILED" also fit.
  - `fill`: the word's gradient (CSS `linear-gradient`). Put the stops at about 24–82%, because the word box is 1.16em tall and the ramp has to span the cap height.
  - `glow`: the bloom colour (hex).
  - `bloom`: the bloom strength, as a number (steady) or `{base, swing, hz}` (a police light-bar pulse).
  - `kicker`: one tracked line in the top bar that belongs to the moment, e.g. `"Time of death · 14:32"` (26 px Archivo wide, 70% white; `null` hides it). Stars take this slot if `stars` is set.
  - `stars`: the number of wanted stars in the top bar, which empty out (0 = none).
  - `rule`: optional `{color, width}` for a short drawn rule under the word (`null` hides it; off by default).
  - `label`: an optional tracked line under the word; it replaces the rule (`null` hides it). The dark band grows to hold it.
  - `sheen`: `{color, peak, width}` sweeps one narrow glint across the word in the hold. `width` is a fraction of the word's width (0.09) and `peak` is its maximum opacity (0.45). `null` turns it off.
  - `flash`: `{color, amount}` for the exposure flash on the footage at the hit.
  - `grade`: the plate-mode grade after the drain:
    - `curve` is an optional tone curve: 11 output values for inputs 0, .1 … 1. Wasted's `[0,.06,.16,.28,.40,.52,.63,.73,.82,.89,.94]` is a highlight shoulder, so sunlit road paint and smoke keep their texture instead of clipping to flat white. Busted's `[0,.14,.33,.52,.66,.77,.86,.92,.96,.99,1]` crushes the shadows of a dark dusk plate to true black and lifts the upper mids;
    - then `contrast`, `brightness`, `tint` (hex or `null`) and `tintOpacity`.
  - `lights` (optional, Busted): `{id, src, amount, swing}`, a baked selective-colour layer (see `lights.py` below), multiplied over the mono slow clip. Its opacity is `amount ± swing`, pulsing with the bloom.
  - `leadGrade` (optional): `{brightness, contrast}` for the real-speed lead, e.g. to lift a dim clip. The drain starts from it. Keep contrast near 1 on dark plates, because contrast pulls their mids down.
  - `lockupY` (optional): the y the word is centred on (default: the band centre). The ribbon centres on the word. Busted uses 1070, the band's lower third, so the arrest plays above the ribbon.
  - `bandCenter` (optional): moves this variant's letterbox band off-centre to frame its footage. Busted uses 880, so the band's bottom edge lands on the bumper and the POV dashboard stays behind the bottom bar.
  - `bars`: `"cut"` (the letterbox arrives on the hit frame) or `"clamp"` (it cuts in at `layout.bandClamp` on the hit frame, then clamps to `bandOpen` over 0.3 s). `bg:none` always slams in over 0.34 s.
  - `lead`: the real-speed shot(s) before the hit. Each takes `{id, src, start, dur, in, y}`: `in` is the source in-point and `y` a vertical offset in px.
  - `slow`: the pre-baked slow-motion file played from the hit, `{id, src, rate, box:{x, y, w, h}}`. `box` places it on the canvas.
    - For a 16:9 source, use about `w: 1560, h: 878` and shift it so the action fills the 680–820 px band and any game HUD falls outside the visible columns.
    - For a speed ramp on a vertical clip, use the same framing as the lead (`x: 0, y: 0, w: 1080, h: 1920`) so the ramp is seamless.
  - `push`: `{lead:[from,to], slow:[from,to]}`, the slow camera pushes. For a speed ramp, start `slow` where `lead` ends.
- `layout`:
  - `bandCenter`, `bandOpen`, `bandHold`, `bandClamp`: the band centre and heights (960; 820 → 680 px; the clamp starts at 880).
  - `wordSize`, `wordWidth`: the start size and the fit width (keep the width ≤ 760).
  - `capRatio`: cap height ÷ font size, used for optical centring.
  - `tracking`, `trackingIn`, `trackingHold`: settled, slam-in and hold tracking, in em.
  - `metaGap`: the gap from the caps to an optional rule or label.
  - `stripH`, `stripPadMin`: the ribbon's height (210 px: a flat 82% black core, a short 10% feather, no hairlines) and the minimum space it leaves above and below the word.
  - `barMetaGap`: how far above the band's held top edge the kicker or stars are centred (76 px).
- `timing`: `hit`, `stripLead`, `drain`, `meta`, `rule`, `sheen`, `sheenDur`, `starsClear`, `out`, `close`, `closeDur`, `end` (seconds). Keep `end = close + closeDur`.

## Render
```bash
# with the sample footage (4K-sourced shots, graded + slowed)
npx hyperframes render . --variables '{"variant":"0","bg":"plate"}' -o wasted.mp4
npx hyperframes render . --variables '{"variant":"1","bg":"plate"}' -o busted.mp4

# transparent overlay for CapCut / Premiere: bars, dark band, word, kicker / stars
npx hyperframes render . --variables '{"variant":"1","bg":"none"}' --format webm -o busted-overlay.webm
```

The overlay can't slow or grade your footage. Line its **1.2 s** mark up with the moment of the fail, then in your editor, from that mark:
- drop the clip to about 30% speed with optical flow on (CapCut: "Smooth slow-mo"; Premiere: Time Interpolation → Optical Flow);
- take saturation to 0, add about +15% contrast and pull the highlights down so whites keep texture (for Busted, crush the shadows and keep the police lights in colour with a colour key);
- optionally add a slow 1.0 → 1.07 zoom.

The overlay ends as the band shuts at 5.0 s, so cut to your next clip there.

## Use your own clip
In plate mode the clip plays in two parts: the real-speed lead-in (`lead`), then a separate slow-motion file (`slow`) from the hit. Playing a 30 fps clip at a low rate only repeats frames and stutters, so bake the slow part once:

```bash
# start = the source second of the fail; rate = slow speed; keep start + 4.0 x rate before the next cut in your clip
bash bake-slow.sh assets/my-fail.mp4 4.2 0.3 assets/clips/my-fail-slow.mp4
# optional 6th argument: paint out a fixed game-HUD mark (x:y:w:h in source pixels)
bash bake-slow.sh assets/my-fail.mp4 4.2 0.3 assets/clips/my-fail-slow.mp4 4.0 938:522:39:39
# optional 7th argument: fix an uneven capture cadence (rows to measure in, as fractions of the height)
bash bake-slow.sh assets/my-fail.mp4 4.2 0.3 assets/clips/my-fail-slow.mp4 4.0 "" 0.3:0.68
# optional 8th argument: ease the rate down over the bake (end-rate:power), the death-cam slowing to a crawl
# optional 9th argument: motion-adaptive pacing (strength), so a whip pan plays through fast instead of tearing
bash bake-slow.sh assets/my-fail.mp4 4.2 0.32 assets/clips/my-fail-slow.mp4 4.0 "" "" 0.2:2 2
```

Use the 8th argument to stop the slow part before stretches of heavy game motion blur. A smeared frame stretched 3x reads as a double image, and no interpolator can un-smear it, so pick a window of sharp source frames and let the ramp fill the time. Use the 9th argument when the camera whips: big-motion pairs get fewer in-betweens and calm ones get more, at the same overall rate.

Use the 7th argument if the slow motion steps or judders even though no frame repeats. Some game captures advance unevenly (Busted's `s014` runs about 1.1, 0.7, 1.3, 0.5 … frames of motion per frame). The bake measures each step's real motion and re-times the in-betweens so the motion advances evenly.

Then, in `CONFIG.variants[v]`:
- `lead: [{ id: "w0a", src: "assets/my-fail.mp4", start: 0, dur: 1.2, in: 3.0, y: 0 }]`, so that `in + timing.hit` (3.0 + 1.2 = 4.2) is the moment of the fail;
- `slow: { id: "w0s", src: "assets/clips/my-fail-slow.mp4", rate: 0.3, box: { x: 0, y: 0, w: 1080, h: 1920 } }` for a vertical clip (or a 16:9 box as above).

Mirror the values in the matching `<video>` tags' `src` / `data-start` / `data-duration` / `data-media-start` so `hyperframes check` and Studio see them too:
- Wasted uses `w0a` and `w0s`;
- Busted uses `b1a`, `b1s` and the light layer `b1l`.

`bake-slow.sh` needs ffmpeg and, for the clean bake, Python 3 with OpenCV (`pip install opencv-python numpy`). It runs `slowflow.py`, which builds every in-between from dense optical flow:
- it warps both neighbouring frames to the in-between time;
- where they disagree (occlusions, a car turning over), the nearer, more consistent warp wins outright, with a soft seam;
- a camera layer (a homography fitted on the ground rows) takes over where camera-only warps line the frames up better, so road paint under moving shadows and smoke doesn't tear.

Fast action never doubles or ghosts, and no frame is a repeat or a cross-fade. A 4 s bake takes about 40 s. Without OpenCV (or with `SLOW_ENGINE=ffmpeg`), it falls back to ffmpeg `minterpolate`. That is fine for gentle motion but tears on very fast action at a 3x stretch.

Two more helper scripts (Python 3 + OpenCV):
- **`paintout.py`** removes a game aim reticle (a thin ring) from a real-speed lead. It tracks the ring on every frame, even as it drifts and grows while the gun fires, and inpaints only the ring:
  `python3 paintout.py <clip.mp4> <start> <seconds> <out.mp4> <x> <y> [search-px] [scale]` (x, y = roughly where the ring sits; `scale` 0.62 for the same HUD on a 1920×1080 master).
- **`lights.py`** bakes Busted's selective-colour layer from a baked slow clip. Blue passes only inside a tight box around each blue emitter's white-hot line (the roof bar, the rear-deck light: ±14 px, so the capture's lens flare and the flare ghosts on people stay mono); red keys the tail lights. It adds a tight halo and writes white everywhere else:
  `python3 lights.py assets/clips/my-slow.mp4 assets/clips/my-lights.mp4`.
  Set `lights.src` to the output. Set `lights: null` if your clip has no police lights.

The sample shots are cut from official trailers and are for local preview only:
- Wasted lead: `s119` vertical from 0.5 s, with the aim reticle painted out:
  `/usr/bin/python3 paintout.py assets/shots/s119-gameplay-shootout-v.mp4 0.5 1.4 assets/clips/w0-s119-lead.mp4 810 937`
- Wasted slow: `s119` (gameplay: the police SUV takes fire and flips) on the 16:9 master. The reticle is painted out first, then it is slowed (optical flow) from 1.7 s, 0.32x easing to 0.20x with adaptive pacing, ending at source 2.62 s, before the game's motion blur on the tumble:
  `/usr/bin/python3 paintout.py assets/shots/s119-gameplay-shootout-h.mp4 1.6 1.3 assets/clips/w0-s119-master-clean.mp4 958 532 28 0.62`
  `bash bake-slow.sh assets/clips/w0-s119-master-clean.mp4 0.1 0.32 assets/clips/w0-s119-slow.mp4 4.0 "" "" 0.2:2 2`
- Busted slow: `s014` (drive-by past an arrest at the mural), slowed (optical flow, cadence-corrected) from 1.2 s at 0.30x:
  `bash bake-slow.sh assets/shots/s014-driveby-police-v.mp4 1.2 0.3 assets/clips/b1-s014-slow.mp4 4.0 "" 0.3:0.68`
- Busted lights: `/usr/bin/python3 lights.py assets/clips/b1-s014-slow.mp4 assets/clips/b1-s014-lights.mp4`

## Keywords
wasted, busted, death screen, death cam, time of death, fail sting, fail compilation, GTA moments, slow motion, smooth slow-mo, optical flow, cadence fix, speed ramp, motion-adaptive slow motion, highlight roll-off, black and white, desaturate, selective colour, police lights, letterbox, cinematic bars, kicker, dark band, GTA band, bloom, sheen, glint, RGB split, impact, police, arrest, wanted stars, GTA 6 fails, funny moments, cut to black
