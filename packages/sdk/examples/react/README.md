# React Example (ISS Panel)

Copy these files into your React project:

- `useSuperHub.ts`
- `IssPanel.tsx`

Then render:

```tsx
import { IssPanel } from "./IssPanel";

export default function App() {
  return <IssPanel />;
}
```

Expected env vars (Vite):

```bash
VITE_HUB_HTTP_URL=https://macbook-pro-de-olivier.local
VITE_HUB_TOKEN=CHANGE_ME_SUPERHUB_TOKEN
```
