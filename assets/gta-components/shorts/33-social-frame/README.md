# 33 · Social video frame

Present a clip as an in-world social video post, like the vertical feed Rockstar shows inside the GTA VI trailers. The clip sits bright and nearly full-bleed in a rounded card over a blurred copy of itself. The card carries an illustrated emblem avatar, a fictional handle, Rockstar's gold-ringed Follow pill, a caption and stepping counts.

Use it in a GTA 6 short when:
- a clip is "something someone in Leonida posted": Florida-Man moments, police chaos, NPC meltdowns;
- you're doing a "GTA 6 social media" bit;
- you're reframing a clip so it reads as a phone video.

Specs: 1080×1920, 30 fps, 5.5 s. It is a full-frame component, so it always shows footage. Each sample plays one continuous shot with no cuts.

## Variants
| `variant` | Name | What it shows |
|---|---|---|
| `0` | Reel post | 3:4 post card: palm emblem avatar, handle, gold Follow ring (held, then tapped to a gold-hairline "Following"), one-line caption, masked rolling like count, Leonida-gradient double-tap heart burst, white-filled like button |
| `1` | Live stream | 2:3 card: gold Follow pill top-left (tapped early, keeps a gold hairline), sunglasses emblem avatar, red LIVE badge by the handle, balanced two-line caption, eye + rolling "watching" count, live comments with neutral avatars rising 3 at a time over a deeper bottom fade |

`bg`: `plate` puts the blurred fill of the same clip behind the card. `none` gives a transparent background around the card; the card still shows the clip.

## CONFIG fields (top of the script in `index.html`)
- `fill`: `blur`, `brightness`, `saturate`, `zoom` and `drift` for the blurred background copy.
- `variants["0" | "1"]`:
  - `clip`: video path. It must match the `src` of that variant's two `<video>` tags (`#fill0`/`#card0` or `#fill1`/`#card1`).
  - `card`: `{ width, aspect, top, focus }`, the card geometry in px. `focus` is the clip's `object-position` inside the card, e.g. `"50% 34%"`.
  - `scrim`: `{ height, mid, midAt, max }`, the bottom fade. `height` is a share of the card (Reel 0.32, Live 0.50); the fade runs from clear to `mid` opacity at `midAt`% and to `max` at the bottom. Keep it low on Reel so the footage stays bright; Live needs more for the chat.
  - `avatar`: `{ emblem, from, to }`, a badge disc. `emblem` is a key of the `EMBLEMS` map below CONFIG (`palm`, `shades`, `user`); `from`/`to` is the disc gradient (default: the Leonida core `#F84FA4` → `#FE8E4E`).
  - `handle`: the account name (keep it fictional or your own).
  - `caption`: the caption text. It wraps balanced inside 700 px; `\n` forces a break.
  - Reel only:
    - `likes: { from, steps, at, every }`: starts at `from` and adds `steps[i]` at `at + i·every` seconds, each with a short digit roll. Keep every value at the same number of digits.
    - `comments`: the comment count, as text.
    - `age`: the post age label, e.g. "2h".
    - `likeAt`: when the double-tap heart fires, in seconds (it is gone 0.5 s later).
    - `followAt`: when Follow is tapped, in seconds.
  - Live only:
    - `viewers: { from, steps, at, every }`: same as `likes`, for "watching".
    - `followAt`: when Follow is tapped, in seconds.
    - `chat`: a list of `{ u, m }` (user, message).
    - `chatStart`: when the first comment arrives, in seconds.
    - `chatEvery`: the gap between comments, in seconds.
- `chatOldest`: the opacity of the oldest of the three visible live comments (default .75).
- `timing`: `in`, `out` (when the UI starts to leave) and `end`.

`EMBLEMS` (just below CONFIG) holds the avatar glyphs as white SVG paths in a 24×24 box. To add your own, add a key with your paths and point `avatar.emblem` at it. Every chat commenter uses the neutral `user` silhouette.

The accent colour is the `--gold` CSS variable (used only on the Follow pill), and the type shadow is `--shadow-type`.

## Render
```bash
# with footage (both variants)
npx hyperframes render . --variables '{"variant":"0","bg":"plate"}' -q high -o reel-post.mp4
npx hyperframes render . --variables '{"variant":"1","bg":"plate"}' -q high -o live-stream.mp4
# card only, transparent around it (drop on your own background in CapCut / Premiere)
npx hyperframes render . --variables '{"variant":"1","bg":"none"}' --format webm -o live-stream.webm
```

## Swap in your own clip
1. Copy your clip into `assets/` (vertical 9:16 works best; any aspect is cover-cropped).
2. In `index.html`, set the `src` of both of that variant's videos to your file (`#fill0` + `#card0` for Reel, `#fill1` + `#card1` for Live), and set the same path in `CONFIG.variants[n].clip`.
3. The samples are slowed so one shot covers the whole 5.5 s:
   - Reel uses `data-playback-rate="0.74"` and Live uses `0.9`.
   - For your own clip, set both of that variant's videos to `1`, or to whatever covers 5.5 s.
   - To start later in the file, set the same `data-media-start` on both.
   - Keep the clip to one shot: in-world posts never cut.
4. If your clip is shorter, lower `data-duration` on the videos and the root, plus `timing.out` and `timing.end`. Then pull `followAt`, the counter `at`/`every` and the chat timing inside the new length.

## Keywords
GTA 6, GTA VI, social post, in-world social media, Lifeinvader-style, reel frame, IG reel, TikTok frame, live stream overlay, LIVE badge, live chat, follow button, gold follow ring, like count, rolling counter, odometer digits, double-tap heart, emblem avatar, blurred background, blur fill, vertical clip frame, Vice City, Leonida, police chase, compilation short.
