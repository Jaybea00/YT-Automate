# KitMotion: the library's motion language

`motion.js` exposes `window.KitMotion`. It holds one set of motion tokens and about 40 helpers. Each helper **adds seekable tweens to the paused GSAP timeline you pass it**, at an absolute time. Every UI motion in the library (menus, swaps, typing, streaming, the cursor) should come from here, so all 50 components move the same way.

The values come from **transitions.dev** (the free tier, read with `npx transitions-dev add --free`, Oct 2026). Every duration, cubic-bezier, distance, blur, scale and stagger is the live transitions.dev tuning. The CSS-transition and class-toggle mechanics were rewritten as frame-seekable GSAP.

> **Licence.** transitions.dev snippets may be used *inside this project*. Do not redistribute them as a pack. Keep `motion.js`, its tokens and this README inside this repo: don't publish them, don't put them in a public package or gist, and don't hand them out as a "transitions kit". Rendered videos are fine.

## The rule

**Default to less motion. State changes stay under ~250ms. One thing leads at a time.**

- A UI state change (swap, open, close, toggle, check) uses the transitions.dev clocks: 150ms out, 250ms in. Don't slow them down to make them "readable". Hold the *result* longer instead.
- Only entrances and emphasis (reveal, number pop, success check, panel) get 400–500ms.
- Let one element move while everything else is still. Stagger the next action until the current one has landed (≥ its duration). Never fire two helpers on unrelated elements at the same instant.
- If a moment works without a helper, leave it static.

## Use it in a component

```html
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/CustomEase.min.js"></script> <!-- optional -->
<script src="assets/kit/motion.js"></script>   <!-- copy of library/_kit/motion/motion.js -->
<script>
  document.fonts.ready.then(function () {
    const K = KitMotion, tl = gsap.timeline({ paused: true });
    const end = K.typeText(tl, '#composer-text', 'Summarize this PR', 0.6, { placeholder: '#ph' });
    const click = K.cursorMoveClick(tl, '#cursor', { x: 1210, y: 640 }, end + 0.3, { target: '#send' });
    K.menuOpen(tl, '#model-menu', click, { origin: 'top-left' });
    window.__timelines['main'] = tl;   // register after the build
    tl.seek(0);
  });
</script>
```

- Copy `motion.js` into each component's `assets/kit/` the same way skins are copied. After you edit the master, re-copy it (`demo/assets/kit/motion.js` is such a copy).
- `at` is always an **absolute time in seconds**. Every helper returns its end time, so you can chain from it (`cursorMoveClick` returns the click time).
- Elements can be passed as nodes or selectors. List helpers (`fadeUp`, `fadeOut`, `avatarLift`) also take arrays or NodeLists.
- Build inside `document.fonts.ready` when a helper measures layout (`tabSlide`, `cardResize`, cursor targets).
- CustomEase is optional. Without it, `motion.js` registers the same curves with its own cubic-bezier solver. The two match to within 0.001, so the eases are exact either way. Named eases (`'kit-out'`, `'kit-pop'`, …) can be used in your own tweens too.

### Seek contract (what the helpers guarantee and what you must do)

- They use only `fromTo` tweens with `immediateRender:false`. The pre-animation state is set once at build time (`gsap.set`). There are no CSS transitions or animations, no class toggles timed by events, no timers, no `Math.random` (typing and streaming use a PRNG seeded from the text), and no `Date`.
- Text, digits, words, the caret and shimmer run through `KitMotion.drive(tl, at, dur, fn)`. It tweens a getter/setter property, which GSAP calls on **every** render. `onUpdate` is deliberately not used, because GSAP skips it when a timeline is seeked with `suppressEvents=true`. The HyperFrames runtime seeks that way on its discover and live-seek paths, while `renderSeek` defaults to `false`. So `onUpdate`-driven text works in final renders but can freeze in Studio or preview seeks. If you write your own per-frame effect, use `drive`: `fn(0)` must equal the state before `at`.
- **For each element, call the helpers in time order.** The text, size, cursor position and tab-pill position of an element are tracked at build time in call order. Don't overlap two text helpers on the same element.
- Don't put a CSS `transform` on an element a helper moves (lint `gsap_css_transform_conflict`). Centre with flex or inset.
- Verified: `test/seektest.cjs` compares the full DOM state of all 481 demo frames when seeked forward, in reverse, in random order, and in random order with events on. **0 frames differ**, with and without CustomEase.

## Tokens

`KitMotion.tokens` = `{ bezier, dur, transitions }`.

### Duration scale (`tokens.dur`)
| Token | s | transitions.dev uses it for |
|---|---|---|
| `instant` | 0.05 | tooltip out |
| `fast` | 0.15 | text swap, menu/modal close, tooltip in, checkbox fill, thinking swap |
| `base` | 0.25 | menu/modal open, icon swap, page slide, tabs, accordion, toast close |
| `medium` | 0.35 | toast open, streamed-word fade, checkbox draw, toggle, panel close |
| `slow` | 0.40 | panel open, badge fade, skeleton reveal |
| `emphasis` | 0.50 | number pop, success check, texts reveal |
| `reel` | 1.40 | spinning counter (not ported) |

These are odd values, used as-is: badge slide 0.26 and close 0.18, card resize 0.30, avatar 0.32, error revert 0.28, and shake legs of 80, 80, 60 and 60ms. Staggers: digits 70ms, reveal lines 40ms, streamed words 60ms, thinking gap 50ms, check path delay 80ms, tooltip delay 80ms.

### Easing scale (`tokens.bezier`, registered as `kit-<name>`)
| Token | cubic-bezier | Role | Closest built-in (max error ≤ 0.02) |
|---|---|---|---|
| `out` | 0.22, 1, 0.36, 1 | **the house ease** (easeOutQuint): menus, modals, panels, pages, tabs, toasts, stream, checks, reveal, resize | `power4.out` |
| `outExpo` | 0.16, 1, 0.3, 1 | counter reels | `expo.out` |
| `pop` | 0.34, 1.36, 0.64, 1 | badge pop (about 4% overshoot) | `back.out(1.2)` |
| `popDigit` | 0.34, 1.45, 0.64, 1 | number pop-in (about 7% overshoot) | `back.out(1.4)` |
| `bob` | 0.34, 1.35, 0.64, 1 | success-check bob, toggle thumb | `back.out(1)` |
| `popSoft` | 0.34, 1.25, 0.64, 1 | plus-to-menu morph | — |
| `spring` | 0.34, 3.85, 0.64, 1 | avatar release only (overshoots by **100%**) | — |
| `standard` | 0.4, 0, 0.2, 1 | badge close | — |
| `inOut` | 0.42, 0, 0.58, 1 | CSS `ease-in-out`: text, icon and thinking swaps, skeleton | `power1.inOut` |
| `easeOut` | 0, 0, 0.58, 1 | CSS `ease-out`: tooltip, error border and message | — |
| `ease` | 0.25, 0.1, 0.25, 1 | CSS `ease`: reveal exit fade | — |
| `move` | `power2.inOut` | pointer travel (library rule, not transitions.dev) | — |

The overshoot curves (`pop`, `popDigit`, `bob`) settle within 1–7%. They read as crisp, not bouncy. `spring` is the only real bounce. DESIGN.md says "no bouncy springs", so pass `{ ease: 'out' }` to `avatarLift(…, null, …)` unless a tile really needs the bounce.

### Space (CSS px at UI scale 1)
Distances: digit 8, text swap 4, thinking 8, page 8, toast 16, reveal 12, panel 100, check bob 40, badge (−8.2, 12.4), shake 6 with a 4 overshoot, avatar lift −4 (falloff 0.45).
Blur: stream 1, most swaps 2, page and reveal 3, check 10.
Scale: menu 0.97 → 1 (closing 0.99), modal 0.96, toast 0.97, tooltip 0.98, icon 0.25, avatar 1.05, cursor press 0.9 / target 0.97.

### UI scale and tempo
```js
KitMotion.config({ scale: 1, tempo: 1 });   // global defaults
K.textSwap(tl, el, 'Done', 2, { scale: 'auto' });   // per call; 'auto' = font-size / 16
```
- `scale` multiplies every px distance and blur. Skins are drawn at real CSS px and enlarged with `zoom`, which scales transforms and blur too, so **inside a zoomed skin keep `scale: 1`**. For UI drawn natively at video size (e.g. 24px body text, a 1.5× UI), set `scale` to match. The demo uses 1.5.
- `tempo` multiplies the durations. Leave it at 1. It is an escape hatch, not a style knob.

## Helpers

Each signature is `(tl, …, at, opts)`. Each returns its end time.

### Entrances, exits, surfaces
| Helper | Motion (transitions.dev source) | Use when |
|---|---|---|
| `fadeUp(tl, els, at, {distance, blur, stagger})` | rises 12px through a 3px blur, 500ms `out`, 40ms stagger (Texts reveal) | the default entrance for any text or card. Headline first, support line 40ms later |
| `fadeOut(tl, els, at)` | one quiet 200ms opacity fade, no Y return | clearing a tile for the loop. Exits never replay the entrance |
| `menuOpen / menuClose(tl, el, at, {origin})` | from scale 0.97 + fade, 250ms; close to 0.99, 150ms. Origin `top-left`… `bottom-right` | dropdowns, model pickers, popovers. Set the origin at the trigger corner |
| `modalOpen / modalClose(tl, el, at, {backdrop})` | from scale 0.96 at the centre, 250ms; close 150ms. The backdrop fades on the same clock *(backdrop is a library addition)* | dialogs and approval gates on top of the page |
| `panelReveal / panelHide(tl, el, at)` | rises 100px through a 2px blur, 400ms; hides in 350ms | sheets, side panels, artifact panels |
| `toastIn / toastOut(tl, el, at)` | rises 16px, scale 0.97, 2px blur, 350ms; out in 250ms | "Copied", "Deployed", short confirmations |
| `tooltipIn / tooltipOut(tl, el, at)` | 80ms delay, then 150ms `easeOut` from scale 0.98 at the bottom-centre; out in 50ms | hover hints after a cursor stops |
| `pageSwap(tl, out, in, at, {dir})` | both pages move 8px sideways through a 3px blur with a cross-fade, 250ms | tab or step content, onboarding steps |
| `cardResize(tl, el, at, {width, height})` | width/height tween, 300ms `out` | compact ↔ expanded cards, a growing reply box (also covers accordions) |
| `skeletonPulse(tl, skel, at, {count})` / `skeletonReveal(tl, skel, content, at)` | bars dim to 0.5 and back, once per 1s; then a 400ms cross-fade with a 2px cross-blur | loading → loaded content in the same slot |

### Text and numbers
| Helper | Motion | Use when |
|---|---|---|
| `typeText(tl, el, text, at, {cps=24, placeholder, caretFrom, caretUntil, prefix, seed})` | **library addition.** Seeded human rhythm (spaces ×1.2, pause after punctuation, an occasional hesitation) at an exact average `cps`. The caret is solid while typing, then blinks 530/530ms. The placeholder hides on the first key | a user typing a prompt. 20–30 cps reads as fast but real |
| `streamText(tl, el, text\|null, at, {wordsPerSec, chunks})` | each word resolves from opacity 0 and a 1px blur, 350ms `out`, one every 60ms (16.7 words/s). The layout is reserved, so nothing reflows. `null` streams the existing markup. `chunks:true` sends 1–3-word token bursts (Streaming text) | model replies. Use `wordsPerSec: 10–12` if viewers must read along |
| `textSwap(tl, el, newText, at)` | the old text exits 4px up through a 2px blur, then the new one enters from 4px below, 150ms + 150ms `inOut` (Text states swap) | status labels: Processing → Done, Save → Saved |
| `thinkingSwap(tl, box, newText, at)` | the same swap with the lines stacked: exit 8px up while the new line rises 50ms later, 150ms each (Thinking states) | agent status lines that change while work runs |
| `shimmer(tl, el, at, until)` | a highlight band sweeps the glyphs every 2s, linear. Rounded to whole cycles. Colours come from `--km-shimmer-base` and `--km-shimmer-hi` (Shimmer text) | "Thinking…", "Generating…". Works on a `thinkingSwap` box. On white the base needs ≤ `#767676` to pass the contrast check |
| `numberPop(tl, el, {from, to, at, format, steps, every, only})` | each character re-enters from 8px below through a 2px blur, 500ms `popDigit`; the last two characters lag by 70ms and 140ms (Number pop-in). `steps>1` ticks through values, re-popping only the changed digits | prices, scores, token counts, any number that updates |

### Icons, status, controls
| Helper | Motion | Use when |
|---|---|---|
| `iconSwap(tl, iconOut, iconIn, at)` | stacked icons cross through scale 0.25 and a 2px blur, 250ms `inOut` (Icon swap) | copy → check, play → pause, send → stop |
| `successCheck(tl, svgOrPath, at)` | the wrapper fades in, unrotates from 80°, unblurs from 10px and bobs up from 40px over 500ms; the path draws after an 80ms delay (Success check) | the "done" moment. Use it once per tile |
| `badgeIn / badgeOut(tl, badge, at, {dot})` | the wrapper slides in from (−8.2, 12.4) over 260ms; the dot pops from scale 0 in 500ms `pop`; out: 180ms `standard` (Notification badge) | unread counts, "new" dots. The trigger never moves |
| `errorShake(tl, el, at, {message, errorColor, border, hold})` | x: +6, −6, +4, 0 over 80/80/60/60ms `out`. The border turns to the error colour (150ms) and the message fades in (280ms), and both revert after `hold`s (Error state shake) | invalid input, a failed check, a "nope" moment |
| `checkboxCheck(tl, box, at, {from, to, checked})` | the box CSS goes `from` → `to` in 150ms, then the mark draws over 350ms; uncheck in 150ms (Checkbox check) | to-do and plan steps completing |
| `toggle(tl, thumb, at, {on, travel, track, onColor, offColor})` | the thumb travels with a 1px overshoot (segments 55/25/20% of 350ms, `bob` on each); the track colour flips instantly (Toggle) | settings and permission switches |
| `tabSlide(tl, pill, tab, at, {from, prev, activeColor, mutedColor})` | the pill moves to the tab's `offsetLeft` and `offsetWidth` over 250ms `out`; the labels cross-fade colour (Tabs sliding) | segmented controls, mode switches |
| `avatarLift(tl, avatars, index\|null, at)` | the hovered avatar lifts 4px and scales to 1.05; its neighbours lift by 0.45^distance, 320ms `out`. `null` releases with `spring` (Avatar group hover) | a pointer passing over a people or agent stack |

### Pointer (library addition)
| Helper | Motion | Use when |
|---|---|---|
| `cursorMoveClick(tl, cursor, {x, y}, at, {from, target, hand, duration, hotspot})` | a macOS pointer moves on a gentle arc (x `power2.inOut`, y `sine.inOut`), taking 0.45–1.0s depending on distance. It settles for 60ms, then presses: scale 0.9 for 60ms, holds 40ms, releases over 120ms. `target` gets a matching 0.97 pressed state. `hand:true` switches on `.is-hand` for the last 15% of the move. Returns the **mouse-up time**, the moment a web UI reacts | every scripted click. Open menus and send messages *at the returned time* |
| `cursorMove(tl, cursor, {x, y}, at)` | the same move without the click; returns the arrival time | hovering, leaving the frame |

Position the cursor element with its **hotspot at its own (0,0)**. The device skin's `.dv-cursor` already does this, with `transform-origin: 3px 2px`. x and y are coordinates in the cursor's offset parent.

### Primitives
- `KitMotion.drive(tl, at, duration, fn, ease?)`: the seek-safe per-frame callback described above.
- `KitMotion.ease('out')` returns the eased function. `KitMotion.easeName('out')` returns `'kit-out'`.

## What was not matched or not ported

- **Not ported.** These depend on hover or pointer input, physics, or a self-running loop: card hover tilt, learn-more hover, like button (particles), input clear with dissolve (per-frame streak envelope), spinning counter (SVG-blurred reels; `numberPop` covers counters), banner stacking, plus-to-menu morph, accordion (`grid-template-rows` 0fr→1fr is not tweenable; use `cardResize` on the height), reasoning stream (cloned looping ticker), and matrix loader. Their tokens are kept in the duration and ease scales above.
- **CSS per-keyframe easing** (shake, toggle, skeleton pulse) is reproduced as sequential fromTo legs, each with the recipe's ease.
- **Overshoot clamping.** CSS clamps negative blur and opacity above 1 during overshoot. The helpers clamp the same way (the badge's blur and opacity use a clamped `pop`).
- **30fps.** Sub-100ms legs (shake 60–80ms, tooltip out 50ms) land on only 1–3 frames at 30fps. That is faithful, and it reads as a snap. Render at 60fps if a shake must look smooth. Don't stretch the tokens.
- **Library additions with no transitions.dev source:** `typeText`, `cursorMoveClick`/`cursorMove` (and the press states), the modal backdrop, and `numberPop` `steps`. They follow DESIGN.md: a believable cadence, a macOS pointer, `power2.inOut` moves.

## Files
| Path | What |
|---|---|
| `motion.js` | the library (master copy) |
| `demo/` | HyperFrames demo, 1920×1080, 16s: every helper on simple elements (`npx hyperframes check` passes clean) |
| `demo/renders/demo.mp4` | the rendered proof |
| `test/seektest.cjs` | seek-order regression test: `node test/seektest.cjs demo [--no-customease]` |
