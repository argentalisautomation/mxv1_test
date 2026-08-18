// MXV1 Web Bluetooth Application Controller with Industry-Standard PRN Block-Stream OTA & Settings

const SERVICE_UUID    = "b04d1815-4604-453d-8868-b7ec257c7426";
const CHR_RELAY_STATE = "b04d2a56-4604-453d-8868-b7ec257c7426";
const CHR_RELAY_CMD   = "b04d2a57-4604-453d-8868-b7ec257c7426";
const CHR_POWER       = "b04d2a5b-4604-453d-8868-b7ec257c7426";
const CHR_RADAR       = "b04d2a5a-4604-453d-8868-b7ec257c7426";
const CHR_OTA         = "b04d2a58-4604-453d-8868-b7ec257c7426";
const CHR_FW_VERSION  = "b04d2a5c-4604-453d-8868-b7ec257c7426";
const CHR_BRIGHTNESS  = "b04d2a5d-4604-453d-8868-b7ec257c7426";
const CHR_SENSITIVITY = "b04d2a5e-4604-453d-8868-b7ec257c7426";

let bleDevice = null;
let gattServer = null;
let chrRelayState = null, chrRelayCmd = null, chrPower = null, chrRadar = null, chrOTA = null;
let chrBrightness = null, chrSensitivity = null;
let otaAckResolve = null;

// UI Elements
const btnConnect      = document.getElementById("btnConnect");
const statusText      = document.getElementById("statusText");
const mainsWatts      = document.getElementById("mainsWatts");
const mainsVolts      = document.getElementById("mainsVolts");
const invWatts        = document.getElementById("invWatts");
const invVolts        = document.getElementById("invVolts");
const radarBadge      = document.getElementById("radarBadge");
const radarDist       = document.getElementById("radarDistance");
const relayBtns       = document.querySelectorAll(".relay-btn");

const settingsToggle  = document.getElementById("settingsToggle");
const settingsChevron = document.getElementById("settingsChevron");
const settingsBody    = document.getElementById("settingsBody");
const brightSlider    = document.getElementById("brightSlider");
const brightValBadge  = document.getElementById("brightValBadge");
const sensSlider      = document.getElementById("sensSlider");
const sensValBadge    = document.getElementById("sensValBadge");

const btnSelectFw     = document.getElementById("btnSelectFw");
const otaFileInput    = document.getElementById("otaFileInput");
const progressWrap    = document.getElementById("progressWrap");
const progressBar     = document.getElementById("progressBar");
const otaStatus       = document.getElementById("otaStatus");

// Register Service Worker
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').then(reg => {
        reg.update();
    }).catch(err => console.log('SW registration error:', err));
}

// Collapsible Settings Accordion Toggle
settingsToggle.addEventListener("click", () => {
    const isOpen = settingsBody.classList.toggle("open");
    settingsChevron.classList.toggle("open", isOpen);
});

function formatSensBadge(val) {
    if (val < 16) return `${val} (128x Hover / Proximity)`;
    if (val < 32) return `${val} (64x Thick Glass)`;
    if (val < 48) return `${val} (32x Normal Glass)`;
    if (val < 64) return `${val} (16x Standard Panel)`;
    if (val < 80) return `${val} (8x Light Touch)`;
    if (val < 96) return `${val} (4x Direct Touch)`;
    if (val < 112) return `${val} (2x Firm Press)`;
    return `${val} (1x Heavy Press)`;
}

// Universal Write helper (with response)
async function writeChr(chr, data) {
    if (chr.writeValueWithResponse) {
        return await chr.writeValueWithResponse(data);
    } else {
        return await chr.writeValue(data);
    }
}

// ============================================================
// BLE Connection
// ============================================================
btnConnect.addEventListener("click", async () => {
    if (!navigator.bluetooth) {
        alert("Web Bluetooth is not supported on this browser/environment.\n\nPlease open this page in Google Chrome or Microsoft Edge on Android, Windows, or Mac with HTTPS.");
        statusText.textContent = "Web Bluetooth Not Supported";
        return;
    }

    if (bleDevice && bleDevice.gatt.connected) {
        statusText.textContent = "Disconnecting...";
        bleDevice.gatt.disconnect();
        return;
    }

    try {
        statusText.textContent = "Requesting Bluetooth Device...";
        
        try {
            bleDevice = await navigator.bluetooth.requestDevice({
                filters: [{ namePrefix: "MXV1" }],
                optionalServices: [SERVICE_UUID]
            });
        } catch (filterErr) {
            console.log("Filter scan fallback to acceptAllDevices...", filterErr);
            bleDevice = await navigator.bluetooth.requestDevice({
                acceptAllDevices: true,
                optionalServices: [SERVICE_UUID]
            });
        }

        if (!bleDevice) {
            statusText.textContent = "No device selected.";
            return;
        }

        bleDevice.addEventListener("gattserverdisconnected", onDisconnected);
        statusText.textContent = `Connecting to ${bleDevice.name || 'Device'}...`;
        gattServer = await bleDevice.gatt.connect();

        statusText.textContent = "Discovering Services...";
        const service = await gattServer.getPrimaryService(SERVICE_UUID);

        statusText.textContent = "Binding Characteristics...";
        chrRelayState = await service.getCharacteristic(CHR_RELAY_STATE);
        chrRelayCmd   = await service.getCharacteristic(CHR_RELAY_CMD);
        chrPower      = await service.getCharacteristic(CHR_POWER);
        chrRadar      = await service.getCharacteristic(CHR_RADAR);
        chrOTA        = await service.getCharacteristic(CHR_OTA);
        try { chrBrightness = await service.getCharacteristic(CHR_BRIGHTNESS); } catch (_) {}
        try { chrSensitivity = await service.getCharacteristic(CHR_SENSITIVITY); } catch (_) {}

        // Subscribe to Relay State Notifications
        await chrRelayState.startNotifications();
        chrRelayState.addEventListener("characteristicvaluechanged", (e) => {
            const data = new Uint8Array(e.target.value.buffer);
            data.forEach((st, idx) => {
                if (idx < relayBtns.length) {
                    relayBtns[idx].classList.toggle("active", st === 1);
                }
            });
        });

        // Subscribe to Live Power Notifications
        await chrPower.startNotifications();
        chrPower.addEventListener("characteristicvaluechanged", (e) => {
            const view = new DataView(e.target.value.buffer);
            const mV = view.getFloat32(0, true);
            const mW = view.getFloat32(4, true);
            const iV = view.getFloat32(8, true);
            const iW = view.getFloat32(12, true);

            mainsWatts.textContent = `${mW.toFixed(1)} W`;
            mainsVolts.textContent = `${mV.toFixed(1)} V`;
            invWatts.textContent   = `${iW.toFixed(1)} W`;
            invVolts.textContent   = `${iV.toFixed(1)} V`;
        });

        // Subscribe to Radar Presence Notifications
        await chrRadar.startNotifications();
        chrRadar.addEventListener("characteristicvaluechanged", (e) => {
            const view = new DataView(e.target.value.buffer);
            const presence = view.getUint8(0);
            const dist = view.getUint16(2, true);

            radarBadge.textContent = (presence === 1) ? "PRESENT" : "ABSENT";
            radarBadge.className = `badge ${(presence === 1) ? "present" : "absent"}`;
            radarDist.textContent = `Distance: ${dist} cm`;
        });

        // Subscribe to OTA Progress & PRN ACKs
        await chrOTA.startNotifications();
        chrOTA.addEventListener("characteristicvaluechanged", onOtaNotify);

        // Read Initial Relay States
        const initialStates = await chrRelayState.readValue();
        const data = new Uint8Array(initialStates.buffer);
        data.forEach((st, idx) => {
            if (idx < relayBtns.length) relayBtns[idx].classList.toggle("active", st === 1);
        });

        // Read Initial CAP1188 Brightness
        if (chrBrightness) {
            try {
                const bVal = await chrBrightness.readValue();
                const currentBright = bVal.getUint8(0);
                brightSlider.value = currentBright;
                brightValBadge.textContent = `${currentBright}%`;
            } catch (_) {}
        }

        // Read Initial CAP1188 Touch Sensitivity
        if (chrSensitivity) {
            try {
                const sVal = await chrSensitivity.readValue();
                const currentSens = sVal.getUint8(0);
                sensSlider.value = currentSens;
                sensValBadge.textContent = formatSensBadge(currentSens);
            } catch (_) {}
        }

        // Read Firmware Version & Active Boot Slot
        let fwInfo = "v0.01 (legacy)";
        try {
            const chrFw = await service.getCharacteristic(CHR_FW_VERSION);
            const fwVal = await chrFw.readValue();
            const dec = new TextDecoder();
            fwInfo = dec.decode(fwVal);
        } catch (_) {}

        statusText.textContent = `Connected: ${bleDevice.name || 'MXV1'} [${fwInfo}]`;
        btnConnect.textContent = "Disconnect";
        btnConnect.style.background = "#ef4444";
    } catch (err) {
        console.error("BLE Connect Error:", err);
        statusText.textContent = `Error: ${err.message || err}`;
    }
});

function onDisconnected() {
    statusText.textContent = "Disconnected";
    btnConnect.textContent = "Connect BLE";
    btnConnect.style.background = "#38bdf8";
}

// Relay Toggles
relayBtns.forEach(btn => {
    btn.addEventListener("click", async () => {
        if (!chrRelayCmd) return;
        const relayIdx = parseInt(btn.getAttribute("data-relay"));
        await writeChr(chrRelayCmd, new Uint8Array([relayIdx]));
    });
});

// CAP1188 LED Brightness Slider with Debounce
let brightTimeout = null;
brightSlider.addEventListener("input", (e) => {
    const val = parseInt(e.target.value);
    brightValBadge.textContent = `${val}%`;

    if (brightTimeout) clearTimeout(brightTimeout);
    brightTimeout = setTimeout(async () => {
        if (chrBrightness) {
            try {
                await writeChr(chrBrightness, new Uint8Array([val]));
            } catch (err) {
                console.error("Brightness set error:", err);
            }
        }
    }, 120);
});

// CAP1188 Touch Sensitivity Slider with Debounce
let sensTimeout = null;
sensSlider.addEventListener("input", (e) => {
    const val = parseInt(e.target.value);
    sensValBadge.textContent = formatSensBadge(val);

    if (sensTimeout) clearTimeout(sensTimeout);
    sensTimeout = setTimeout(async () => {
        if (chrSensitivity) {
            try {
                await writeChr(chrSensitivity, new Uint8Array([val]));
            } catch (err) {
                console.error("Sensitivity set error:", err);
            }
        }
    }, 120);
});

// ============================================================
// High-Speed Industry-Standard PRN Block-Stream BLE OTA Engine
// ============================================================
btnSelectFw.addEventListener("click", () => otaFileInput.click());

otaFileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!chrOTA) {
        alert("Please connect to MXV1 via BLE first!");
        return;
    }

    const data = new Uint8Array(await file.arrayBuffer());
    const totalSize = data.length;
    console.log(`Starting OTA transfer for ${file.name} (${totalSize} bytes)...`);

    progressWrap.style.display = "block";
    progressBar.style.width = "0%";
    otaStatus.textContent = `Initializing flash partition (${(totalSize/1024).toFixed(0)} KB)...`;

    try {
        // 1. Send OTA_BEGIN [0x00][size_u32] - Synchronous write confirmation
        const beginPkt = new Uint8Array(5);
        beginPkt[0] = 0x00;
        beginPkt[1] = totalSize & 0xFF;
        beginPkt[2] = (totalSize >> 8) & 0xFF;
        beginPkt[3] = (totalSize >> 16) & 0xFF;
        beginPkt[4] = (totalSize >> 24) & 0xFF;

        await writeChr(chrOTA, beginPkt);
        otaStatus.textContent = "Flash partition ready. Streaming firmware...";

        // 2. Stream Data Packets with PRN Sliding Window
        const CHUNK_SIZE = 490; // Optimized MTU payload
        let offset = 0;
        let seq = 0;
        let packetsSinceAck = 0;
        const startTime = Date.now();

        while (offset < totalSize) {
            const chunkLen = Math.min(CHUNK_SIZE, totalSize - offset);
            const pkt = new Uint8Array(7 + chunkLen);
            
            pkt[0] = 0x01; // OTA_DATA
            pkt[1] = seq & 0xFF;
            pkt[2] = (seq >> 8) & 0xFF;
            pkt[3] = offset & 0xFF;
            pkt[4] = (offset >> 8) & 0xFF;
            pkt[5] = (offset >> 16) & 0xFF;
            pkt[6] = (offset >> 24) & 0xFF;
            pkt.set(data.subarray(offset, offset + chunkLen), 7);

            // Stream chunk without response for maximum throughput
            if (chrOTA.writeValueWithoutResponse) {
                await chrOTA.writeValueWithoutResponse(pkt);
            } else {
                await chrOTA.writeValue(pkt);
            }

            offset += chunkLen;
            seq++;
            packetsSinceAck++;

            const pct = Math.round((offset / totalSize) * 100);
            progressBar.style.width = `${pct}%`;
            const speedKB = ((offset / 1024) / ((Date.now() - startTime) / 1000)).toFixed(1);
            otaStatus.textContent = `Flashing: ${pct}% (${(offset/1024).toFixed(0)}/${(totalSize/1024).toFixed(0)} KB) @ ${speedKB} KB/s`;

            // Await PRN ACK every 15 packets (~7.5KB) or at EOF
            if (packetsSinceAck >= 15 || offset >= totalSize) {
                packetsSinceAck = 0;
                await waitForAck(0x05, 4000);
            }
        }

        // 3. Send OTA_COMMIT [0x03] - Synchronous cryptographic verification & partition swap
        otaStatus.textContent = "Verifying SHA-256 Checksum & Committing...";
        await writeChr(chrOTA, new Uint8Array([0x03]));

        progressBar.style.width = "100%";
        otaStatus.textContent = "✅ Success! Firmware verified. Device is rebooting...";
    } catch (err) {
        console.error("OTA Error:", err);
        if (err.message && err.message.includes("GATT Server is disconnected") && progressBar.style.width === "100%") {
            otaStatus.textContent = "✅ Success! Firmware verified and device rebooted.";
        } else {
            otaStatus.textContent = `OTA Failed: ${err.message || err}`;
        }
        try { await writeChr(chrOTA, new Uint8Array([0xFF])); } catch (_) {}
    }
});

function waitForAck(expectedOpcode, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            otaAckResolve = null;
            reject(new Error(`Timeout waiting for PRN ACK (0x${expectedOpcode.toString(16)})`));
        }, timeoutMs);

        otaAckResolve = (opcode, payload) => {
            if (opcode === expectedOpcode) {
                clearTimeout(timer);
                resolve(payload);
                return true;
            } else if (opcode === 0x0E) { // OTA_ERROR
                clearTimeout(timer);
                reject(new Error("ESP32 reported flash write/verification error"));
                return true;
            }
            return false;
        };
    });
}

function onOtaNotify(e) {
    const data = new Uint8Array(e.target.value.buffer);
    const opcode = data[0];
    const payload = data.subarray(1);
    if (otaAckResolve) {
        const handled = otaAckResolve(opcode, payload);
        if (handled) otaAckResolve = null;
    }
}
