# `@deepseek-ai/dsh-desktop`

The dsh desktop shell: an Electron window over the existing web surface. The Electron
main process boots the web host **in process** through the same `runProfile` entry the
`dsh web` CLI uses (`@deepseek-ai/dsh/profile-boot`), picks a free loopback port,
waits for the HTTP surface to answer, then opens a `BrowserWindow` pointed at it. The
renderer keeps `nodeIntegration: false` / `sandbox: true` — it talks to the host over
the ordinary `/api` transport, exactly as the browser does.

## Run (development)

```sh
# from the repository root, after `pnpm run build` (host lib + frontend dist)
pnpm --filter @deepseek-ai/dsh-desktop run dev    # compile main.ts, launch Electron
pnpm --filter @deepseek-ai/dsh-desktop run smoke  # boot + HTTP check, then exit (no window)
```

## Package

electron-builder downloads Electron + its helper binaries from GitHub, which can stall on
some networks. In China, set the npmmirror mirrors first:

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
```

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dist:dir     # unpacked build (fast smoke of packaging)
pnpm --filter @deepseek-ai/dsh-desktop run dist:win     # NSIS installer for Windows x64
# output: apps/desktop/release/DeepSeek Harness Setup <version>.exe
```

## Packaging notes (why it is the way it is)

- **`asar: false`** — the dsh host resolves its plugin bundles through symlinks +
  `require.resolve` at runtime (`healProfilesModuleFallback`); that resolution cannot
  point into a virtual asar archive, so the app ships as real files.
- **Explicit peer deps** — `dsh-app-boot` / `dsh-web-app` declare several vendor
  packages as `peerDependencies` that pnpm auto-resolves but electron-builder's
  dependency walk misses. `apps/desktop/package.json` therefore lists them (and the rest
  of the runtime closure's peer-only packages) directly under `dependencies`.
- **No native rebuild** — `koffi`, `node-pty`, and `node-addon-require-builtin` are all
  N-API (ABI-stable across Node/Electron), so `npmRebuild` is off and no ABI rebuild is
  needed.
- **`process.argv[1]` shim** — `cordis-plugin-hmr` resolves `process.argv[1]`, which a
  packaged Electron app leaves `undefined`; `src/main.ts` sets it to the app directory
  before booting.
- **`./profile-boot` export** — `@deepseek-ai/dsh` exposes `runProfile` via an
  `exports` entry (`apps/cli/package.json` + `apps/cli/tsdown.config.ts`) so the
  desktop shell can boot the host in process instead of shelling out to the `dsh` bin.
