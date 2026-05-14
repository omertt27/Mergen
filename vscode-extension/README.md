# Mergen VS Code Extension

Start/stop Mergen server from VS Code.

## Installation

1. Build the server:
   ```bash
   cd ../server && npm install && npm run build
   ```

2. Install extension:
   ```bash
   code --install-extension mergen-1.0.0.vsix
   ```

## Usage

- `Mergen: Start Server` - Start the Mergen server
- `Mergen: Stop Server` - Stop the server
- `Mergen: Show Status` - Check server status

## Development

```bash
npm install
npm run compile
```

Press F5 in VS Code to debug.
