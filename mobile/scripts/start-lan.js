#!/usr/bin/env node
/**
 * Starts Expo in LAN mode with a dev-server host the phone can actually reach.
 *
 * Why this exists:
 * Expo CLI derives the QR/exp:// URL from `getIpAddress()` (utils/ip.js), which
 * delegates to `lan-network`. On this machine that returns the loopback
 * interface (127.0.0.1), so `expo start --lan` advertises exp://127.0.0.1:8081
 * and any phone scanning it fails with "Failed to connect to /127.0.0.1:8081".
 *
 * `UrlCreator.getDefaultHostname()` checks REACT_NATIVE_PACKAGER_HOSTNAME before
 * falling back to that broken lookup, so we detect the real LAN IPv4 ourselves
 * and set it. Detection runs on every start, so a new DHCP lease is picked up
 * automatically -- no hand-editing of IPs.
 */

const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Adapters that exist on the host but are not the real LAN path to a phone.
const VIRTUAL_ADAPTER = /vmware|virtualbox|vbox|hyper-?v|vethernet|wsl|docker|loopback|bluetooth|tailscale|zerotier|tap|tun/i;
const WIFI_ADAPTER = /wi-?fi|wlan|wireless/i;
const WIRED_ADAPTER = /ethernet|^eth|^en\d/i;

function detectLanHost() {
  const candidates = [];

  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (VIRTUAL_ADAPTER.test(name)) continue;
      candidates.push({ name, address: addr.address });
    }
  }

  if (candidates.length === 0) return null;

  // A phone on the same Wi-Fi reaches the Wi-Fi adapter first; prefer it.
  const wifi = candidates.find((c) => WIFI_ADAPTER.test(c.name));
  if (wifi) return wifi;

  const wired = candidates.find((c) => WIRED_ADAPTER.test(c.name));
  if (wired) return wired;

  return candidates[0];
}

// An explicit override always wins, so this stays debuggable.
const override = process.env.REACT_NATIVE_PACKAGER_HOSTNAME;
const detected = override ? { name: 'env override', address: override } : detectLanHost();

if (!detected) {
  console.error(
    '\n[start-lan] Could not find a non-virtual LAN IPv4 address.\n' +
      '            Connect this machine to Wi-Fi/Ethernet, or set\n' +
      '            REACT_NATIVE_PACKAGER_HOSTNAME=<your-ip> manually.\n'
  );
  process.exit(1);
}

const host = detected.address;

console.log(`\n[start-lan] Dev server host: ${host}  (via ${detected.name})`);
console.log(`[start-lan] Expo Go URL     : exp://${host}:8081`);
console.log(`[start-lan] Backend expected: http://${host}:5000\n`);

// The host is NOT written back to .env on purpose.
//
// Expo's env loader (@expo/env, SDK 54+) refuses to read machine-specific
// variables such as REACT_NATIVE_PACKAGER_HOSTNAME from a shared .env and
// aborts the whole `expo start` with:
//
//   Error: Refused to load personal environment variables from a
//          non-.local env file. Move them to a .local env file.
//
// Writing it here used to make every single `npm start` fail. The value is
// already handed to the child process via `env` below, which is all Expo
// needs, so persisting it bought nothing. If you want a hand-set override,
// put it in .env.local (git-ignored) or export it in your shell.

// Resolve the CLI entry directly instead of shelling out to npx, so this works
// the same on Windows (no .cmd/shell quoting) as on macOS/Linux.
const cli = require.resolve('expo/bin/cli', { paths: [path.resolve(__dirname, '..')] });
const passthrough = process.argv.slice(2);

const child = spawn(process.execPath, [cli, 'start', '--lan', ...passthrough], {
  cwd: path.resolve(__dirname, '..'),
  // 'inherit' keeps the TTY attached, which is what makes Expo print the QR
  // code (startAsync only renders it when isInteractive() is true).
  stdio: 'inherit',
  env: { ...process.env, REACT_NATIVE_PACKAGER_HOSTNAME: host },
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
