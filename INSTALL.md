# Install Mergen — Choose Your Method

> **Fastest path:** → **[QUICKSTART.md](QUICKSTART.md)** — one command, 2 minutes.

Multiple ways to install Mergen depending on your preferences and environment.

---

## 🚀 Method 1: NPM (Easiest — Recommended)

**Best for:** Quick setup, always latest version

```bash
# One command setup
npx mergen-server@latest setup

# Or install globally
npm install -g mergen-server
mergen-server setup
```

**Time:** ~2 minutes

---

## 🐳 Method 2: Docker (Zero Dependencies)

**Best for:** Containerized environments, consistent deployments

```bash
# Pull and run
docker run -p 3000:3000 mergen/server:latest

# Or with docker-compose
curl -O https://raw.githubusercontent.com/omertt27/Mergen/main/docker-compose.yml
docker-compose up
```

**Time:** ~1 minute

---

## 🍺 Method 3: Homebrew (macOS)

**Best for:** Mac users who prefer native packages

```bash
# Add tap
brew tap omertt27/mergen

# Install
brew install mergen

# Run setup
mergen-server setup
```

**Time:** ~3 minutes

---

## 📦 Method 4: Pre-Built Binary

**Best for:** No Node.js, offline environments

1. **Download for your OS:**
   - [macOS (Apple Silicon)](https://github.com/omertt27/Mergen/releases/latest/download/mergen-macos-arm64)
   - [macOS (Intel)](https://github.com/omertt27/Mergen/releases/latest/download/mergen-macos-x64)
   - [Linux](https://github.com/omertt27/Mergen/releases/latest/download/mergen-linux-x64)
   - [Windows](https://github.com/omertt27/Mergen/releases/latest/download/mergen-windows-x64.exe)

2. **Make executable** (Mac/Linux):
   ```bash
   chmod +x mergen-macos-arm64
   ```

3. **Run setup:**
   ```bash
   ./mergen-macos-arm64 setup
   ```

**Time:** ~2 minutes

---

## 🔧 Method 5: From Source (Developers)

**Best for:** Contributors, local development

```bash
# Clone repository
git clone https://github.com/omertt27/Mergen.git
cd Mergen

# Build server
cd server
npm install
npm run build

# Run setup
node ../scripts/setup.mjs
```

**Time:** ~5 minutes

---

## 🌐 Method 6: One-Line Installer

**Best for:** Quick automated setup

```bash
curl -fsSL https://raw.githubusercontent.com/omertt27/Mergen/main/install.sh | bash
```

**Time:** ~2 minutes


---

## ✅ Verify Installation

After installing via any method:

```bash
# Check version
mergen-server --version

# Run tests
mergen-server test

# Start server
mergen-server start
```

**Expected output:**
```
✓ Server binary exists
✓ Server starts successfully
✓ Health endpoint responds
✓ Event ingestion works
✓ IDE configured correctly

✨ Mergen is ready to use!
```

---

## 🎯 Next Steps

1. **Start the server:**
   ```bash
   mergen-server start
   ```

2. **Open your AI IDE** (Cursor, Claude Code, VS Code with Copilot)

3. **Ask your AI:**
   - "Get recent logs"
   - "Show network activity"
   - "Why did that request fail?"

4. **Visit the web UI** (optional):
   ```
   http://127.0.0.1:3000/setup
   ```

---

## 🆘 Troubleshooting

### "Command not found: mergen-server"

**If using NPM:**
```bash
npx mergen-server@latest setup
```

**If using binary:**
```bash
# Use full path
./mergen-macos-arm64 setup
```

### "Port 3000 already in use"

The server tries ports 3000-3010. If all are taken:
```bash
# Find and kill process
lsof -ti:3000 | xargs kill -9
```

### "Server not responding"

```bash
# Check if running
curl http://127.0.0.1:3000/health

# View logs
mergen-server start
```

### "IDE not showing Mergen tools"

1. **Restart your IDE** after setup
2. **Check configuration:**
   ```bash
   mergen-server test
   ```
3. **Manual config** (if needed):
   - Cursor: `~/.cursor/mcp.json`
   - VS Code: `~/.vscode/mcp.json`
   - Windsurf: `~/.codeium/windsurf/mcp_config.json`

---

## 📊 Comparison

| Method | Time | Dependencies | Updates | Best For |
|--------|------|--------------|---------|----------|
| **NPM** | 2 min | Node.js | Auto | Most users |
| **Docker** | 1 min | Docker | Manual | Containers |
| **Homebrew** | 3 min | None | `brew upgrade` | Mac users |
| **Binary** | 2 min | None | Manual download | No Node.js |
| **Source** | 5 min | Node.js, Git | `git pull` | Developers |

---

## 🔐 Security Note

All installation methods are safe:
- ✅ No data leaves your machine
- ✅ Server runs on localhost only (127.0.0.1)
- ✅ Open source (MIT license)
- ✅ No cloud services, no analytics

---

## 📚 Additional Resources

- **Documentation:** https://github.com/omertt27/Mergen#readme
- **Issues:** https://github.com/omertt27/Mergen/issues
- **Changelog:** https://github.com/omertt27/Mergen/releases
- **Quick Start:** See [README.md](README.md)

---

**Recommended:** Start with **Method 1 (NPM)** for the smoothest experience.
