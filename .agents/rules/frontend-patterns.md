# Frontend Patterns

## File Structure

```text
src/renderer/
├── index.html           Entry HTML (production CSP meta lives here)
├── main.tsx             React root
├── App.tsx              All screen state (settings form, playback, LCD status)
├── components/ui/       shadcn/ui-style atoms: badge, button, card, checkbox,
│                        input, label, separator, slider
├── lib/
│   ├── bridge.ts        Typed IPC wrappers to the main process
│   └── utils.ts         cn() class merger (clsx + tailwind-merge)
└── index.css            Tailwind 4 entry (@import "tailwindcss")
```

Vite root is `src/renderer`; output goes to `dist/renderer`.

## Component Rules

- shadcn/ui atoms live in `src/renderer/components/ui/` — extend or compose them; never fork a duplicate button/input.
- Styling is Tailwind 4 classes only. **Never** use inline `style={{}}` (the one exception would be a dynamically computed value no class can express).
- Import app components with the `@/` alias: `import { Button } from "@/components/ui/button"`.
- UI copy is English. Keep labels short and passive-verb-free; error text must state what the user can do next.
- `class-variance-authority` variants own size/kind axes — don't hand-roll conditional class strings on atoms.

## State Management

- `useState` + `useCallback` in `App.tsx` only — there is no global store (no Redux/Zustand) and none is needed at this scale.
- All data enters the renderer through typed IPC wrappers in `lib/bridge.ts`. Components never call `window.electron` directly.
- Main-process subscriptions (lcdStatus, playback updates) arrive via the preload's `on*` listeners; unsubscribe in `useEffect` cleanup.

## Trust Boundaries

- Renderer validates nothing security-relevant: settings are validated/whitelisted by type in `src/hardening.js` on the main side, and tokens are written only by the main process.
- The renderer may only ever see `{connected, expiresAt}` — if a change would surface tokens or raw settings writes to the renderer, stop and redesign.
- Renderer output (lyrics, titles) is untrusted text: render as text nodes, never via `dangerouslySetInnerHTML`.

## Gotchas

- The dev server's CSP is injected by the `lyricvision-dev-csp` plugin in `vite.config.ts`; production keeps the strict meta from `index.html`.
- `base` switches between `/` (dev) and `./` (build) — never hardcode root-absolute asset URLs.
