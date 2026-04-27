# Step 2 — Install the browser extension

The browser extension streams `console.*`, `fetch` / `xhr`, and DOM state to
your local server. It's a Chrome / Edge MV3 extension and only sends data
to `http://127.0.0.1:3000–3010`.

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `extension/` folder of the Mergen
   repo
4. Pin the Mergen icon to your toolbar so you can mute capture per tab

Once loaded, every tab you refresh will produce a baseline diagnosis in the
Mergen sidebar — even when nothing crashes.
