# Contributing to Mergen

Thank you for your interest in contributing to Mergen! We welcome contributions of all kinds.

## 🔁 Community Feedback Loop

Mergen improves fastest when runtime issues, false positives, and detector feedback are shared back with the project.

- **GitHub Discussions** — use for questions, debugging patterns, and early design discussions.
- **GitHub Issues** — use for confirmed bugs and scoped feature requests.
- **VS Code feedback buttons** — when you rate a hypothesis 👍/👎 in the panel, you help calibrate which detectors are trustworthy.

---

## 🚀 Quick Start

1. **Fork the repository**
   ```bash
   # Click "Fork" on GitHub
   ```

2. **Clone your fork**
   ```bash
   git clone https://github.com/YOUR_USERNAME/Mergen.git
   cd Mergen
   ```

3. **Create a branch**
   ```bash
   git checkout -b feature/amazing-feature
   ```

4. **Make your changes**
   ```bash
   # Edit files
   ```

5. **Test your changes**
   ```bash
   cd server
   npm install
   npm run build
   npm test
   ```

6. **Commit your changes**
   ```bash
   git add .
   git commit -m "Add amazing feature"
   ```

7. **Push to your fork**
   ```bash
   git push origin feature/amazing-feature
   ```

8. **Open a Pull Request**
   - Go to your fork on GitHub
   - Click "Pull Request"
   - Fill in description
   - Submit!

---

## 📁 Project Structure

```
Mergen/
├── server/              # Node.js MCP server
│   ├── src/            # TypeScript source
│   ├── dist/           # Compiled JavaScript
│   └── __tests__/      # Test files
│
├── extension/          # Chrome extension
│   ├── src/           # JavaScript source
│   └── manifest.json  # Extension config
│
├── vscode-extension/  # VS Code extension (WIP)
│
├── scripts/           # Utility scripts
│
└── docs/             # Documentation
```

---

## 🧪 Testing

### Run All Tests
```bash
cd server
npm test
```

### Run Specific Tests
```bash
npm test integration.test.ts
npm test mcp-tools.test.ts
npm test -- --grep "should handle errors"
```

### Run Tests with Coverage
```bash
npm run test:coverage
```

### Test Guidelines
- Write tests for new features
- Maintain or improve coverage (>80%)
- Use descriptive test names
- Test edge cases
- Test error handling

---

## 📝 Code Style

### TypeScript (Server)
- Use TypeScript strict mode
- Prefer `const` over `let`
- Use interfaces for public APIs
- Document complex functions
- Keep functions under 50 lines

### JavaScript (Extension)
- Use ES6+ features
- No external dependencies (extension must be self-contained)
- Handle all errors gracefully (never break the host page)

### Formatting
```bash
# Auto-format (if configured)
npm run lint:fix
npm run format
```

### Naming Conventions
- Files: `kebab-case.ts`
- Functions: `camelCase()`
- Classes: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`
- Types/Interfaces: `PascalCase`

---

## 🎯 Contribution Areas

### Good First Issues
Look for issues labeled `good first issue`:
- Documentation improvements
- Test additions
- Bug fixes
- Error message improvements

### High-Value Contributions
- Performance improvements
- New MCP tools
- IDE integrations
- Browser compatibility
- Test coverage

### What We're Looking For
✅ Bug fixes  
✅ Documentation improvements  
✅ Test additions  
✅ Performance optimizations  
✅ IDE integration improvements  
✅ Browser compatibility fixes  

### What to Discuss First
🤔 New features  
🤔 Breaking changes  
🤔 Architecture changes  
🤔 New dependencies  

Open a [discussion](https://github.com/omertt27/Mergen/discussions) for these!

---

## 🐛 Bug Reports

### Before Reporting
1. Search existing issues
2. Try latest version
3. Run `mergen-server test`
4. Check [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

### Issue Template
```markdown
**Describe the bug**
A clear description of what the bug is.

**To Reproduce**
Steps to reproduce:
1. Go to '...'
2. Click on '...'
3. See error

**Expected behavior**
What you expected to happen.

**Actual behavior**
What actually happened.

**Environment:**
- OS: [e.g., macOS 14.0]
- Node.js: [e.g., 20.11.0]
- Mergen version: [e.g., 1.0.0]
- IDE: [e.g., Cursor 0.40.0]
- Browser: [e.g., Chrome 122]

**Additional context**
- Error messages
- Screenshots
- Output of `mergen-server test`
```

---

## 💡 Feature Requests

### Open a Discussion First
For new features, open a [discussion](https://github.com/omertt27/Mergen/discussions) with:
- **Problem:** What problem does this solve?
- **Solution:** How would it work?
- **Alternatives:** What else did you consider?
- **Use case:** When would you use this?

### What Makes a Good Feature Request
- Solves a real problem
- Fits Mergen's scope (local-first, dev observability)
- Doesn't duplicate existing features
- Has clear use cases

---

## 📖 Documentation

### What to Document
- New features
- Configuration options
- MCP tools
- IDE setup steps
- Troubleshooting solutions

### Where to Add Docs
- README.md — High-level overview
- QUICKSTART.md — Getting started
- TROUBLESHOOTING.md — Common issues
- FAQ.md — Questions
- Code comments — Complex logic

### Documentation Style
- Clear and concise
- Show examples
- Include commands
- Test all commands
- Update table of contents

---

## 🔍 Code Review Process

### What We Look For
- ✅ Tests pass
- ✅ Code follows style guide
- ✅ Documentation updated
- ✅ No breaking changes (or discussed)
- ✅ Reasonable scope (focused PR)

### Review Timeline
- Initial response: 1-3 days
- Full review: 3-7 days
- Follow-up: 1-2 days

### Tips for Faster Reviews
- Keep PRs small (<500 lines)
- One feature per PR
- Write clear commit messages
- Respond to feedback promptly
- Rebase on main if needed

---

## 🎨 Commit Message Guidelines

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types
- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation
- `test:` Test additions
- `refactor:` Code refactoring
- `perf:` Performance improvement
- `chore:` Maintenance

### Examples
```bash
feat(mcp): add get_dom_context tool
fix(extension): handle circular references
docs(readme): update installation steps
test(buffer): add edge case for overflow
refactor(ingest): simplify validation logic
perf(buffer): optimize priority eviction
chore(deps): update dependencies
```

---

## 🏗️ Development Setup

### Prerequisites
- Node.js 18.17+
- npm 9+
- Git
- Chrome/Edge browser

### Initial Setup
```bash
# Clone and install
git clone https://github.com/omertt27/Mergen.git
cd Mergen/server
npm install

# Build
npm run build

# Run tests
npm test

# Start server
npm start
```

### Development Workflow
```bash
# Make changes in server/src/

# Watch mode (auto-rebuild)
npm run dev

# Run tests
npm test -- --watch

# Before commit
npm test
npm run lint
```

---

## 🤝 Community Guidelines

- Be respectful and professional
- Help others when you can
- Give constructive feedback
- Assume good intentions
- Keep discussions on-topic

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for details.

---

## 📞 Getting Help

- **Questions:** [GitHub Discussions](https://github.com/omertt27/Mergen/discussions)
- **Bugs:** [GitHub Issues](https://github.com/omertt27/Mergen/issues)
- **Chat:** (If applicable: Discord, Slack, etc.)

---

## 📄 License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

## 🙏 Thank You!

Every contribution makes Mergen better. Whether it's:
- A typo fix
- A bug report
- A feature request
- A full PR

**We appreciate you!** 🎉
