# 12 · Location card

A place-name reveal for a GTA 6 short that cuts to a new part of Leonida, such as "now we're in Vice City" or "this is the Keys". Use it on the first clip of a new area in a map tour, an "every location in GTA 6" compilation or a "trailer locations explained" short. It runs 6 s, and the graphic clears on its own by about 5.9 s, so it loops or cuts cleanly.

| Variant | Look | Where it sits |
|---|---|---|
| `0` Official wide caps | Rockstar's date-card language at title scale. A small "NOW ENTERING" kicker sits over a big white Archivo wide-caps name, with a justified foot below: region, a light rule, and the coordinates in mono. The name resolves centre-out through blur while its tracking tightens. On the first cut it locks with a flash, a shake and an RGB split that decays into the #EE08F2 magenta edge and bloom. Sample: a 4-shot Vice City montage (highway → skyline skydive → biplane beach → sunset pier). | The sky band, y ≈ 318–620, over a soft top scrim |
| `1` Pin pill | A map pin dropped into the shot. The needle falls with motion blur and plants on a point in the footage: flash, shake, a ground shockwave and a chroma hit. A frosted-glass label then unfurls from the sunset-pink pin head: the name in Inter Display 800 (~97 px) and the coordinates rolling to a lock. Ground rings ping while it holds, and the pin rides the shot through a tracked path. Sample: a held, slowed aerial of a marina. | Floating above the planted point (sample: y ≈ 235–515, x ≈ 144–914) |

## CONFIG fields (top of the `<script>` in `index.html`)
- **`variants["0" | "1"]`**
  - `name`: the place name. v0 sets it in caps and auto-fits it to `layout.heroWidth`; v1 auto-fits it to `layout.nameMaxWidth`.
  - `lat`, `lon`: decimal degrees, where negative means S or W. They roll in like a GPS lock. The demo uses the real-world places each area is modelled on (Miami, Florida Keys), so treat them as flavour.
  - `kicker` (v0 only): the line above the title ("Now entering").
  - `region` (v0 only): the word left of the rule ("Leonida").
- **`layout`**
  - **v0**
    - `lockTop`: y of the lockup.
    - `heroWidth`: the title's locked ink width (760 = 88% of the safe width).
    - `heroSize`: the title's minimum and maximum size in px.
    - `heroTrack`: the tracking in em at the start of the entrance and once locked.
    - `scrimOverlay`: `{height, peak}` for the top scrim on `bg:"none"` renders.
  - **v1**
    - `needle`: the needle length in px.
    - `nameSize`, `nameMaxWidth`: the name's size range and fit width.
    - `track`: `[t, x, y]` points the pin follows.
    - `anchorOffset`: from the tracked feature to the planted tip.
    - `trackZoom`: how much the sample shot zooms. It scales the offset.
- **`timing`**
  - `end`: the total length (6 s).
  - **v0**
    - `cuts`: the cut times. The hit lands on `cuts[0]`; keep these equal to the `data-start` values of the v0 videos.
    - `heroIn`: when the title starts to resolve.
    - `out0`: when the exit starts.
  - **v1**
    - `drop`: when the pin starts to fall.
    - `land`: the plant and the hit.
    - `out1`: when the exit starts.
    - `ringEvery`: the gap between ground-ring pings.

## Render
```bash
# transparent overlay to drop onto your own clip in CapCut / Premiere
npx hyperframes render . --variables '{"variant":"0","bg":"none"}' --format webm -o location-official.webm
npx hyperframes render . --variables '{"variant":"1","bg":"none"}' --format webm -o location-pin.webm

# preview over the sample footage
npx hyperframes render . --variables '{"variant":"0","bg":"plate"}' -q high -o out.mp4
```
- On `bg:"none"`, v0 keeps a lighter, shorter top scrim as part of the graphic.
- On `bg:"none"`, v1's pin stays still at the first track point. Grain, vignette, flashes and shake are off.

## Swap in your own clip
- **Easiest:** render with `bg:"none"` and lay the WebM over your clip.
  - For v1, place the overlay so the pin tip lands on your location. The tip sits at x ≈ 232, y ≈ 791. You can also change `layout.track` to a single point, e.g. `[[0, x, y], [6, x, y]]` with `anchorOffset: [0, 0]`, to plant it wherever you want.
- **In the project, v0:** replace the `src` of the `.v0s` videos (track 0) and keep `timing.cuts` matched to their `data-start` values.
- **In the project, v1:** replace the `src` of `#v1a`.
  - To make the pin follow your shot, track a feature with ffmpeg:
    ```bash
    ffmpeg -i clip.mp4 -vf "format=gray,find_rect=object=tmpl.pgm,metadata=print:file=track.txt" -f null -
    ```
  - Paste the `[t, x, y]` samples into `layout.track`.
  - Pre-slow a short shot with `setpts=PTS/<rate>,minterpolate=fps=30:mi_mode=mci` and keep it in `assets/clips/`.

## Keywords
gta 6 location card, now entering, area reveal, place name title, vice city, leonida keys, rockstar style title, wide caps, magenta offset, map pin, drop pin, pinned label, tracked callout, gps coordinates, location tag, map tour, gta vi locations
