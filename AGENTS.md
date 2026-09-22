# Repository Instructions

## Yomitan Edit Workflow

- Do not edit built/compiled files under `GSM_Overlay/yomitan/` directly.
- For Yomitan logic changes, edit source files in `C:\Users\Beangate\GSM\yomitan-gsm\ext\` (for example: `ext/js/language/text-scanner.js`).
- After source edits, rebuild and sync the overlay copy by running:
  - `C:\Users\Beangate\GSM\yomitan-gsm\local-build-chrome-overlay.ps1`

## pytest
- Always use .venv for running pytest to ensure dependencies are correctly managed.
- If possible, make tests first, making sure they fail before implementing functionality, and then iterate on your solution until tests pass.
- Increment coverage where possible.

## Ruff
- Always run Ruff after Python changes.
- Use `uv run ruff format GameSentenceMiner tests scripts` from the repo root.

## Localization (i18n)
- All user-facing strings in Electron renderer components must use `t("key")` from `useTranslation()`. Never hardcode English text in JSX.
- Locale files live in `electron-src/renderer/src/i18n/` (`en.json`, `ja.json`, `ukr.json`).
- When adding new UI text, add the key to `en.json` first, then add translations to `ja.json` and `ukr.json`.
- Use `{variable}` interpolation for dynamic values: `t("key", { name: value })`.
- For module-scope constants (outside React components), store i18n key strings in a `labelKey` field or key-map object, then translate at render time with `t(item.labelKey)`.
- See `docs/LOCALIZATION.md` for the full guide, key naming conventions, and code patterns.

## Fork Windows Build / Deployment

- For routine Windows testing of the `kanjieater/GameSentenceMiner` fork, prefer the GitHub Actions build in `.github/workflows/fork_windows_build.yml` instead of reproducing the full Python/Rust/Overlay/Electron packaging toolchain locally.
- The workflow runs automatically for pull requests into `main` and pushes to `main`, and can be triggered manually for any branch.
- It produces one commit-addressed artifact named `gsm-windows-<full commit sha>` containing:
  - the unsigned Windows installer;
  - a zipped `win-unpacked` build;
  - Electron update metadata/blockmap when produced;
  - `build-info.json` with the exact source commit.
- From a Windows checkout, a low-level agent can fetch (and, if needed, trigger) the exact build for a branch with:
  - `pwsh ./tools/deploy-fork-build.ps1 -Ref <branch>`
- To install it:
  - interactive: `pwsh ./tools/deploy-fork-build.ps1 -Ref <branch> -Install`
  - silent NSIS install: `pwsh ./tools/deploy-fork-build.ps1 -Ref <branch> -Install -Silent`
- The deploy helper resolves the requested remote ref to an exact commit, only accepts an artifact for that commit, waits for an in-progress build or triggers `workflow_dispatch` when needed, and verifies `build-info.json` before installation.
- Fork CI artifacts are intentionally unsigned development builds. Do not reuse upstream SignPath/release credentials or publish fork development builds into the upstream release channel.
- If hosted Actions are unavailable (for example, runner quota exhausted), build the same Windows fork artifact locally from a native Windows PowerShell/pwsh session with:
  - `pwsh ./tools/build-fork-windows-local.ps1`
- The local builder intentionally refuses WSL/Linux because GSM packages Windows-native Python, Rust, Electron, and NSIS components. Docker Desktop using the WSL2 backend is still a Linux-container path and is not a substitute for the native Windows build.
- The local builder mirrors the fork workflow, runs the focused provisioning transport test by default, and writes a commit-addressed artifact directory under `dist/local-build-<sha>/` containing the installer, unpacked zip, update metadata when present, and `build-info.json`.

