# Mergen Setup Improvements — Implementation Checklist

Track progress on making Mergen easier to install and use.

---

## ✅ Phase 1: Essential (Week 1) — PRIORITY

### 1. NPM Package Publishing
- [ ] Update `package.json` with proper metadata
  - [x] Set `bin` field to `dist/cli.js`
  - [ ] Add keywords: `mcp`, `observability`, `debugging`, `ai`, `cursor`, `claude`
  - [ ] Verify `files` field includes all necessary files
  - [ ] Set proper license (MIT)
  - [ ] Add repository URLs

- [ ] Create npm account / login
  ```bash
  npm login
  ```

- [ ] Test package locally
  ```bash
  cd server
  npm pack
  npm install -g mergen-server-1.0.0.tgz
  mergen-server --help
  ```

- [ ] Publish to npm
  ```bash
  npm publish --access public
  ```

- [ ] Verify installation
  ```bash
  npx mergen-server@latest --version
  ```

**Files:**
- ✅ `server/src/cli.ts` — CLI implementation
- ✅ `server/package.json` — Updated bin field
- ⏳ Test and publish

---

### 2. Chrome Web Store Submission
- [ ] Prepare extension for production
  - [ ] Remove development keys from manifest
  - [ ] Add privacy policy URL
  - [ ] Create store listing screenshots (1280x800)
  - [ ] Write store description (80-132 chars)
  - [ ] Create promotional images

- [ ] Create Chrome Web Store developer account
  - [ ] Pay $5 one-time fee
  - [ ] Complete developer info

- [ ] Package extension
  ```bash
  cd extension
  zip -r ../mergen-extension.zip . -x "*.git*" "node_modules/*"
  ```

- [ ] Submit for review
  - [ ] Upload zip at console.cloud.google.com/apis/credentials
  - [ ] Fill out store listing
  - [ ] Submit for review (7-10 days)

- [ ] Update documentation with store URL
  ```markdown
  Install extension: https://chrome.google.com/webstore/detail/mergen/[ID]
  ```

**Files needed:**
- [ ] `extension/privacy-policy.html`
- [ ] `extension/screenshots/` — Store screenshots
- [ ] `scripts/package-extension.sh` — Automated packaging

---

### 3. Setup Validation Command
- [x] Implement `mergen-server test` command
  - [x] Check server binary exists
  - [x] Check server starts
  - [x] Check health endpoint
  - [x] Check event ingestion
  - [x] Check IDE configuration

- [ ] Add user-friendly error messages
  - [ ] "Server not found" → "Run: mergen-server setup"
  - [ ] "IDE not configured" → Show manual config
  - [ ] "Extension not responding" → Installation guide

- [ ] Test on fresh machines
  - [ ] macOS (M1 & Intel)
  - [ ] Windows 10/11
  - [ ] Ubuntu 22.04

**Status:** ✅ CLI implemented, needs testing

---

### 4. Update README with New Install Flow
- [ ] Add "Quick Install" section at top
  ```markdown
  ## Quick Install (2 minutes)

  ```bash
  # 1. Install server
  npx mergen-server@latest setup

  # 2. Install extension
  https://chrome.google.com/webstore/detail/mergen/xxx

  # 3. Verify
  mergen-server test
  ```

  ✅ Done! Ask your AI: "Get recent logs"
  ```

- [ ] Move manual installation to "Advanced" section
- [ ] Add troubleshooting section
- [ ] Add video tutorial (loom/youtube)

**Files:**
- [ ] `README.md` — Update install instructions
- [ ] `INSTALL.md` — Detailed installation guide
- ✅ `install.sh` — One-command installer

---

## 🔄 Phase 2: Polish (Week 2-3)

### 5. Pre-Built Binaries
- [ ] Set up binary compilation
  - [ ] Install `@vercel/ncc` or `pkg`
  - [ ] Create build script
  - [ ] Test binaries on each platform

- [ ] GitHub Actions workflow
  ```yaml
  name: Build Binaries
  on:
    release:
      types: [published]
  jobs:
    build:
      strategy:
        matrix:
          os: [macos-latest, ubuntu-latest, windows-latest]
  ```

- [ ] Upload to GitHub Releases
  - [ ] `mergen-macos-arm64`
  - [ ] `mergen-macos-x64`
  - [ ] `mergen-linux-x64`
  - [ ] `mergen-windows-x64.exe`

**Files:**
- [ ] `scripts/build-binary.js`
- [ ] `.github/workflows/release.yml`

---

### 6. Web-Based Setup UI
- [ ] Create `/setup` route in server
  - [ ] Step 1: Server status (auto-detected)
  - [ ] Step 2: IDE configuration (interactive)
  - [ ] Step 3: Extension installation (links)
  - [ ] Step 4: Pipeline test (run button)

- [ ] Auto-open on first run
  ```typescript
  if (isFirstRun()) {
    exec('open http://127.0.0.1:3000/setup');
  }
  ```

- [ ] Add screenshots to docs

**Files:**
- [ ] `server/src/routes/setup-ui.ts`
- [ ] `server/public/setup.html`

---

### 7. VS Code Extension
- [ ] Create VS Code extension project
  ```bash
  npm install -g yo generator-code
  yo code
  ```

- [ ] Implement extension
  - [ ] Start/stop server commands
  - [ ] Status bar indicator
  - [ ] Settings (auto-start, port)
  - [ ] Output channel for logs

- [ ] Publish to marketplace
  ```bash
  vsce package
  vsce publish
  ```

**Files:**
- [ ] `vscode-extension/package.json`
- [ ] `vscode-extension/src/extension.ts`

---

### 8. Auto-Update Checker
- [ ] Check GitHub releases on startup
  ```typescript
  async function checkForUpdates() {
    const res = await fetch('https://api.github.com/repos/omertt27/Mergen/releases/latest');
    const latest = await res.json();
    if (latest.tag_name > currentVersion) {
      console.log(`Update available: ${latest.tag_name}`);
    }
  }
  ```

- [ ] Add `--no-update-check` flag
- [ ] Respect `NO_UPDATE_NOTIFIER` env var

**Files:**
- [ ] `server/src/update-checker.ts`

---

## 🌟 Phase 3: Ecosystem (Week 4+)

### 9. Docker Image
- [x] Create Dockerfile
- [ ] Test multi-arch build
  ```bash
  docker buildx build --platform linux/amd/64,linux/arm64 -t mergen/server:latest .
  ```

- [ ] Push to Docker Hub
  ```bash
  docker push mergen/server:latest
  ```

- [ ] Update docs
  ```bash
  docker run -p 3000:3000 mergen/server:latest
  ```

**Files:**
- [ ] `Dockerfile`
- [ ] `docker-compose.yml`
- [ ] `.dockerignore`

---

### 10. Homebrew Formula
- [ ] Create tap repository
  ```bash
  gh repo create homebrew-mergen --public
  ```

- [ ] Write formula
  ```ruby
  class Mergen < Formula
    desc "Local-first browser observability for AI"
    homepage "https://github.com/omertt27/Mergen"
    url "https://github.com/omertt27/Mergen/archive/v1.0.0.tar.gz"
    sha256 "..."
    
    depends_on "node@20"
    
    def install
      cd "server" do
        system "npm", "install"
        system "npm", "run", "build"
      end
      bin.install "server/dist/cli.js" => "mergen-server"
    end
  end
  ```

- [ ] Test formula
  ```bash
  brew install --build-from-source ./mergen.rb
  mergen-server --version
  ```

- [ ] Submit to homebrew-core (optional)

**Files:**
- [ ] `homebrew-mergen/Formula/mergen.rb`

---

### 11. Linux Packages
- [ ] Create Snap package
  ```yaml
  name: mergen
  version: '1.0.0'
  summary: Browser observability for AI
  base: core22
  ```

- [ ] Create .deb package (Debian/Ubuntu)
- [ ] Create .rpm package (Fedora/RHEL)
- [ ] Publish to Snap Store

**Files:**
- [ ] `snap/snapcraft.yaml`
- [ ] `debian/control`

---

### 12. Windows Installer
- [ ] Create MSI installer (WiX Toolset)
- [ ] Or Chocolatey package
  ```powershell
  choco install mergen
  ```

- [ ] Test on Windows 10/11

**Files:**
- [ ] `windows/mergen.wxs`
- [ ] Or `chocolatey/mergen.nuspec`

---

## 📊 Progress Tracking

| Phase | Task | Status | Priority | ETA |
|-------|------|--------|----------|-----|
| **Phase 1** | NPM Package | ⏳ In Progress | P0 | Week 1 |
| **Phase 1** | Chrome Store | 🔲 Not Started | P0 | Week 1 |
| **Phase 1** | Validation | ✅ Done | P0 | ✓ |
| **Phase 1** | README Update | 🔲 Not Started | P0 | Week 1 |
| **Phase 2** | Binaries | 🔲 Not Started | P1 | Week 2 |
| **Phase 2** | Web UI | 🔲 Not Started | P1 | Week 2 |
| **Phase 2** | VS Code Ext | 🔲 Not Started | P1 | Week 3 |
| **Phase 2** | Auto-Update | 🔲 Not Started | P1 | Week 3 |
| **Phase 3** | Docker | 🔲 Not Started | P2 | Week 4 |
| **Phase 3** | Homebrew | 🔲 Not Started | P2 | Week 4 |
| **Phase 3** | Linux Pkgs | 🔲 Not Started | P3 | Week 5+ |
| **Phase 3** | Windows Inst | 🔲 Not Started | P3 | Week 5+ |

---

## 🎯 Success Metrics

### Before Improvements
- ⏱️ Setup time: ~10 minutes
- ❌ Failure rate: ~30%
- 🤔 Support tickets: ~5/week
- 📝 Steps required: 5+ manual steps

### After Phase 1
- ⏱️ Setup time: ~2 minutes
- ✅ Failure rate: <10%
- 💬 Support tickets: ~2/week
- 📝 Steps required: 2 commands

### After Phase 3
- ⏱️ Setup time: ~1 minute
- ✅ Failure rate: <5%
- 💬 Support tickets: ~1/week
- 📝 Steps required: 1 command

---

## 📝 Testing Checklist

Before marking items complete, test on:

- [ ] macOS Monterey+ (M1)
- [ ] macOS (Intel)
- [ ] Windows 10
- [ ] Windows 11
- [ ] Ubuntu 22.04
- [ ] Ubuntu 20.04
- [ ] Chrome browser
- [ ] Edge browser (Chromium)
- [ ] Brave browser

---

## 🚀 Quick Start (Current)

**After Phase 1 completion:**

```bash
# One command install
curl -fsSL https://raw.githubusercontent.com/omertt27/Mergen/main/install.sh | bash

# Or via NPM
npx mergen-server@latest setup

# Verify
mergen-server test
```

**Install takes 2 minutes, not 10.**

---

## 📞 Next Actions (This Week)

1. **Today:**
   - [x] Finish CLI implementation
   - [ ] Test CLI on macOS
   - [ ] Create npm account

2. **Tomorrow:**
   - [ ] Publish to npm
   - [ ] Test `npx mergen-server`
   - [ ] Update README

3. **This Week:**
   - [ ] Prepare Chrome Web Store submission
   - [ ] Create store listing assets
   - [ ] Submit extension for review

---

**Priority:** Focus on Phase 1 — it delivers 80% of the value with 20% of the effort.

**Status:** ✅ CLI ready, ⏳ awaiting npm publish
