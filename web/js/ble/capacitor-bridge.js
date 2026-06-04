// Web Bluetooth → Capacitor BLE bridge (no-bundler version).
//
// When the dashboard is loaded inside a Capacitor native app (iOS / Android),
// `navigator.bluetooth` does not exist — those platforms' WKWebView/WebView
// deliberately exclude the Web Bluetooth API. Instead, native BLE is exposed
// via the @capacitor-community/bluetooth-le plugin, which Capacitor exposes
// on the global as `window.Capacitor.Plugins.BluetoothLe`.
//
// Rather than rewrite every caller, this module synthesises a
// Web-Bluetooth-compatible `navigator.bluetooth` object on top of that
// plugin, so the existing BLE client code (`ble/client.js`,
// `health/scale.js`) keeps working unchanged in the native shell.
//
// In a regular browser (Chrome, Edge, Arc) this module is a no-op — the
// real `navigator.bluetooth` is used.

const isCapacitor = !!(typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.());

function int16ToDataView(b) { return new DataView(new Uint8Array(b).buffer); }

/**
 * Install the bridge if and only if we're inside Capacitor.
 * Idempotent — safe to call multiple times.
 */
export async function installCapacitorBleBridge() {
  if (!isCapacitor) return false;
  if (navigator.bluetooth?._isCapacitorBridge) return true; // already installed

  const Ble = window.Capacitor?.Plugins?.BluetoothLe;
  if (!Ble) {
    console.warn('[ble-bridge] BluetoothLe plugin not registered on window.Capacitor.Plugins');
    return false;
  }

  await Ble.initialize({ androidNeverForLocation: true }).catch((err) => {
    console.warn('[ble-bridge] init failed', err);
  });

  // Cache of device wrappers so the same deviceId returns the same instance.
  const deviceById = new Map();

  // Android allows only ONE outstanding GATT operation per connection at a
  // time; a second write while one is in flight fails with status 201
  // (ERROR_GATT_WRITE_REQUEST_BUSY). Web Bluetooth auto-queues these, so the
  // BLE client code assumes it can fire operations freely — we replicate that
  // by serialising every read/write/notify per device through a promise chain.
  const gattQueue = new Map(); // deviceId -> tail promise
  function enqueueGatt(deviceId, op) {
    const prev = gattQueue.get(deviceId) || Promise.resolve();
    const run = prev.then(() => op(), () => op()); // run regardless of prior outcome
    gattQueue.set(deviceId, run.then(() => {}, () => {}));
    return run;
  }

  // deviceId -> Map("service|char" -> { write, writeNoResp }) from discovery,
  // so writeValue() can pick write-with- vs without-response like the web does.
  const charPropsByDevice = new Map();

  // @capacitor-community/bluetooth-le marshals characteristic values over the
  // JS↔native bridge as HEX STRINGS — `write` expects e.g. "aa 01 0c …" and
  // notifications/reads arrive the same way (see the plugin's
  // dataViewToHexString / hexStringToDataView). We bypass the plugin's JS
  // wrapper and call the raw plugin, so the bridge MUST do the same hex
  // marshaling. (Sending base64 here made the native side parse base64 as hex
  // and crash the whole app with "Invalid Hexadecimal Character".)

  // hex string (any of "aa010c", "aa 01 0c", "AA:01") → DataView. Non-hex chars
  // are ignored, mirroring the plugin's hexStringToDataView.
  function toDataView(v) {
    if (v instanceof DataView) return v;
    if (v instanceof ArrayBuffer) return new DataView(v);
    if (ArrayBuffer.isView(v)) return new DataView(v.buffer, v.byteOffset, v.byteLength);
    const hex = typeof v === 'string' ? v : (v && typeof v.value === 'string' ? v.value : null);
    if (hex == null) {
      if (Array.isArray(v)) return new DataView(new Uint8Array(v).buffer);
      return new DataView(new ArrayBuffer(0));
    }
    const bytes = [];
    let hi = -1;
    for (let i = 0; i < hex.length; i++) {
      const c = hex.charCodeAt(i);
      let nib;
      if (c >= 48 && c <= 57) nib = c - 48;        // 0-9
      else if (c >= 65 && c <= 70) nib = c - 55;   // A-F
      else if (c >= 97 && c <= 102) nib = c - 87;  // a-f
      else continue;                               // skip separators
      if (hi < 0) hi = nib; else { bytes.push((hi << 4) | nib); hi = -1; }
    }
    return new DataView(Uint8Array.from(bytes).buffer);
  }

  // bytes → space-separated lowercase hex, matching the plugin's
  // dataViewToHexString (the format its native `write` parses).
  function dataToHex(data) {
    let bytes;
    if (data instanceof DataView) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else bytes = new Uint8Array(data);
    const parts = new Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      const s = bytes[i].toString(16);
      parts[i] = s.length === 1 ? '0' + s : s;
    }
    return parts.join(' ');
  }

  function makeCharacteristic(deviceId, serviceUuid, charUuid) {
    const listeners = new Set();
    let notifying = false;
    let notifyHandle = null;
    const props = charPropsByDevice.get(deviceId)?.get(`${serviceUuid}|${charUuid}`);
    const ch = {
      uuid: charUuid,
      service: { uuid: serviceUuid },
      properties: {
        notify: true, read: true,
        write: props ? props.write : true,
        writeWithoutResponse: props ? props.writeNoResp : true,
      },
      value: null,

      async readValue() {
        const res = await enqueueGatt(deviceId, () =>
          Ble.read({ deviceId, service: serviceUuid, characteristic: charUuid }));
        ch.value = toDataView(res);
        return ch.value;
      },

      async writeValue(data) {
        const value = dataToHex(data);
        // Mirror Web Bluetooth writeValue(): use write-WITH-response when the
        // characteristic supports it, otherwise write-without-response. Picking
        // the wrong type makes the strap never ACK → "Write timeout."
        if (props && !props.write && props.writeNoResp) {
          await enqueueGatt(deviceId, () =>
            Ble.writeWithoutResponse({ deviceId, service: serviceUuid, characteristic: charUuid, value }));
        } else {
          await enqueueGatt(deviceId, () =>
            Ble.write({ deviceId, service: serviceUuid, characteristic: charUuid, value }));
        }
      },

      async writeValueWithoutResponse(data) {
        const value = dataToHex(data);
        await enqueueGatt(deviceId, () =>
          Ble.writeWithoutResponse({ deviceId, service: serviceUuid, characteristic: charUuid, value }));
      },

      async startNotifications() {
        if (notifying) return ch;
        // The low-level plugin delivers notifications as an EVENT named
        // `notification|<deviceId>|<service>|<characteristic>` — it does NOT
        // honour a callback argument (that's only the JS wrapper). Register the
        // listener explicitly, or notifications fire with "no listeners" and no
        // data ever reaches the client.
        notifyHandle = await Ble.addListener(
          `notification|${deviceId}|${serviceUuid}|${charUuid}`,
          (event) => fire(event),
        );
        await enqueueGatt(deviceId, () =>
          Ble.startNotifications({ deviceId, service: serviceUuid, characteristic: charUuid }));
        notifying = true;
        return ch;

        function fire(data) {
          // event payload is { value: "<hex>" }
          ch.value = toDataView(data);
          const ev = new Event('characteristicvaluechanged');
          Object.defineProperty(ev, 'target', { value: ch, enumerable: true });
          for (const fn of listeners) {
            try { fn(ev); } catch (e) { console.error('[ble-bridge] listener', e); }
          }
        }
      },

      async stopNotifications() {
        if (!notifying) return ch;
        try { await notifyHandle?.remove?.(); } catch { /* ignore */ }
        notifyHandle = null;
        await enqueueGatt(deviceId, () =>
          Ble.stopNotifications({ deviceId, service: serviceUuid, characteristic: charUuid })).catch(() => {});
        notifying = false;
        return ch;
      },

      addEventListener(event, fn) {
        if (event === 'characteristicvaluechanged') listeners.add(fn);
      },
      removeEventListener(event, fn) {
        if (event === 'characteristicvaluechanged') listeners.delete(fn);
      },
    };
    return ch;
  }

  function makeService(deviceId, serviceUuid) {
    return {
      uuid: serviceUuid,
      device: deviceById.get(deviceId),
      async getCharacteristic(uuid) {
        return makeCharacteristic(deviceId, serviceUuid, String(uuid).toLowerCase());
      },
      async getCharacteristics() { return []; },
    };
  }

  function makeServer(deviceId, device) {
    // Set of service UUIDs actually present on the strap, discovered after
    // connect. Stays null if discovery fails (then we behave permissively).
    let discovered = null;
    const server = {
      connected: false,
      device,
      async connect() {
        const onDisconnected = () => {
          server.connected = false;
          device.dispatchEvent(new Event('gattserverdisconnected'));
        };
        // @capacitor-community/bluetooth-le v3 reads the disconnect callback
        // from the `onDisconnected` option; v2 took it as the 2nd positional
        // arg. Pass both so a drop always propagates and reconnect/backoff
        // fires — under v3 the old 2-arg form was silently ignored, freezing
        // the app on BLE loss.
        //
        // The plugin connects with autoConnect=true (patched — see Device.kt),
        // which reliably handles the WHOOP's random address but can take longer
        // to establish, so give it a generous 45s. A single attempt: with
        // autoConnect we must NOT disconnect mid-flight (that cancels the
        // pending acceptlist connection), so no retry here.
        const opts = { deviceId, timeout: 45000, onDisconnected };
        await Ble.connect(opts, onDisconnected);
        server.connected = true;

        // Discover the strap's real services so getPrimaryService() can honour
        // Web Bluetooth's NotFoundError contract. WITHOUT this the bridge
        // pretends EVERY requested service exists, so WhoopClient's "try the
        // 5.0 service, fall back to 4.0" probe always resolves as 5.0 — and a
        // 4.0 strap then hangs forever subscribing to 5.0 characteristics that
        // aren't there (the "stuck on Connecting…" bug). Best-effort: if
        // discovery fails we leave `discovered` null and stay permissive.
        try {
          const res = await Ble.getServices({ deviceId });
          const list = Array.isArray(res) ? res : (res?.services ?? []);
          // Only enforce when we actually got a service list; an empty result
          // (discovery not settled / unsupported) stays permissive.
          discovered = list.length ? new Set(list.map((s) => String(s.uuid).toLowerCase())) : null;
          // Capture per-characteristic write properties so writeValue() can pick
          // write-with- vs without-response correctly.
          const props = new Map();
          for (const s of list) {
            const su = String(s.uuid).toLowerCase();
            for (const c of (s.characteristics ?? [])) {
              const p = c.properties ?? {};
              props.set(`${su}|${String(c.uuid).toLowerCase()}`, {
                write: !!p.write, writeNoResp: !!p.writeWithoutResponse,
              });
            }
          }
          charPropsByDevice.set(deviceId, props);
        } catch (e) {
          console.warn('[ble-bridge] getServices failed; service detection disabled', e);
          discovered = null;
        }
        return server;
      },
      disconnect() {
        Ble.disconnect({ deviceId }).catch(() => {});
        server.connected = false;
      },
      async getPrimaryService(uuid) {
        const u = String(uuid).toLowerCase();
        if (discovered && !discovered.has(u)) {
          const err = new Error(`Service ${u} not found on device`);
          err.name = 'NotFoundError';   // matches the Web Bluetooth contract
          throw err;
        }
        return makeService(deviceId, u);
      },
    };
    return server;
  }

  function makeDevice(rawDevice) {
    const id = rawDevice.deviceId;
    const cached = deviceById.get(id);
    if (cached) return cached;

    const listeners = new Map();
    const device = {
      id,
      name: rawDevice.name ?? rawDevice.localName ?? 'Whoop',
      _isCapacitorBridgeDevice: true,
      gatt: null,
      addEventListener(event, fn) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(fn);
      },
      removeEventListener(event, fn) {
        listeners.get(event)?.delete(fn);
      },
      dispatchEvent(ev) {
        const set = listeners.get(ev.type);
        if (set) for (const fn of set) { try { fn(ev); } catch (e) { console.error(e); } }
        return true;
      },
    };
    device.gatt = makeServer(id, device);
    deviceById.set(id, device);
    return device;
  }

  // Remember devices the user has picked so getDevices() can return them after
  // an app restart — this is what enables silent auto-reconnect (the plugin
  // can't enumerate previously-granted devices on its own). Persisted in
  // localStorage so it survives the WebView process being killed.
  const REMEMBER_KEY = 'whoof.ble.devices';
  function rememberDevice(id, name) {
    if (!id) return;
    try {
      const list = JSON.parse(localStorage.getItem(REMEMBER_KEY) || '[]');
      const next = [{ deviceId: id, name: name || 'Whoop' }, ...list.filter((d) => d.deviceId !== id)].slice(0, 5);
      localStorage.setItem(REMEMBER_KEY, JSON.stringify(next));
    } catch { /* localStorage may be unavailable */ }
  }

  const bridge = {
    _isCapacitorBridge: true,
    async getAvailability() { return true; },

    async requestDevice({ filters = [], optionalServices = [] } = {}) {
      const services = [];
      let namePrefix;
      for (const f of filters) {
        if (Array.isArray(f.services)) services.push(...f.services.map((u) => String(u).toLowerCase()));
        if (f.namePrefix && !namePrefix) namePrefix = f.namePrefix;
      }
      for (const s of optionalServices) services.push(String(s).toLowerCase());
      const raw = await Ble.requestDevice({
        services: services.length ? services : undefined,
        namePrefix,
        optionalServices: optionalServices.map((u) => String(u).toLowerCase()),
      });
      rememberDevice(raw.deviceId, raw.name ?? raw.localName);
      return makeDevice(raw);
    },

    async getDevices() {
      // Return the devices the user has previously paired with (from
      // localStorage), so auto-reconnect on launch can find the strap by id.
      try {
        const list = JSON.parse(localStorage.getItem(REMEMBER_KEY) || '[]');
        return list.map((d) => makeDevice({ deviceId: d.deviceId, name: d.name }));
      } catch {
        return [];
      }
    },
  };

  try {
    Object.defineProperty(navigator, 'bluetooth', { value: bridge, configurable: true });
  } catch {
    navigator.bluetooth = bridge;
  }
  console.info('[ble-bridge] navigator.bluetooth installed (Capacitor → BLE plugin)');
  return true;
}

// Auto-install on module load when in Capacitor.
if (isCapacitor) {
  installCapacitorBleBridge().catch((err) => {
    console.warn('[ble-bridge] install failed', err);
  });
}
