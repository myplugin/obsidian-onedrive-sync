# Replacing `!important` with selector specificity

## Why avoid `!important`

Linters (including the Obsidian community directory scanner) flag `!important` as a CSS anti-pattern. It breaks the cascade — once used, the only way to override it is another `!important`, leading to an arms race.

## Specificity basics

CSS specificity is a 4-tuple: `(inline, id, class, element)`. Higher tuples win:

| Selector | Specificity |
|---|---|
| `button` | (0,0,0,1) |
| `.cls` | (0,0,1,0) |
| `div .cls` | (0,0,1,1) |
| `#id` | (0,1,0,0) |
| `.a .b` | (0,0,2,0) |
| `.a .b.cls` | (0,0,3,0) |

When specificity is EQUAL, **source order** wins — the later rule in the CSS file (or the stylesheet loaded later) takes precedence.

## Techniques to increase specificity without `!important`

### 1. Add element type

```css
/* Before: (0,0,2,0) — may lose to app rules with element selectors */
.rs-mobile .chip-delete { width: 20px; }

/* After: (0,0,2,1) — adds element specificity */
.rs-mobile button.chip-delete { width: 20px; }
```

### 2. Double the class (repeat the selector)

A class repeated in the selector still matches (the element only needs the class once), but each repetition adds +1 to the class column:

```css
/* (0,0,3,1) — beats (0,0,2,1) app rules */
.rs-mobile button.chip-delete.chip-delete { width: 20px; }
```

This is valid CSS — `[class~="chip-delete"]` matches once, the doubled selector just increases specificity. It's a well-known technique for overriding framework styles without `!important`.

### 3. Use attribute selectors

```css
/* (0,0,3,1) — attribute selector adds class-level specificity */
.rs-mobile button[type="button"].chip-delete { width: 20px; }
```

### 4. Source order as a tiebreaker

If your specificity EQUALS the rule you're overriding, and your CSS loads AFTER the app's CSS (plugins load after core), you win by source order. This is less robust than beating specificity outright, but works for ties.

## When `!important` is truly unavoidable

If the rule you're overriding ALSO uses `!important`, no amount of specificity will beat it — only another `!important` can. In that case, `!important` is the only option. But most frameworks (including Obsidian) don't use `!important` on their layout rules, so higher specificity suffices.
