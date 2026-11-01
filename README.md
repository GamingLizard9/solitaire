# Clearview Solitaire

An open-hand solitaire for the browser: Klondike's deal with every card face up.

- Stack down in alternating colours; any card or run can go into an empty column.
- Draw three at a time into a single row; only the rightmost card is playable, and there's no redeal.
- Once the deck runs out, its spot becomes a free cell for one card.
- Build each suit from Ace to King on the foundations to win.

Includes undo, hints, auto-finish, and a win counter saved in the browser.

## Running it

It's plain HTML, CSS and JavaScript with no build step. Open `index.html`, or serve the folder:

```bash
python -m http.server 8765
```

`artifact.html` is the entry page for the claude.ai Artifact version. It shares `styles.css` and `game.js`, so keep its markup in sync with `index.html`.
