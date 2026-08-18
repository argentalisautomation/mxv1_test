// MXV1 Web Bluetooth Application Controller with PRN Block-Stream OTA

const SERVICE_UUID    = "b04d1815-4604-453d-8868-b7ec257c7426";
const CHR_RELAY_STATE = "b04d2a56-4604-453d-8868-b7ec257c7426";
const CHR_RELAY_CMD   = "b04d2a57-4604-453d-8868-b7ec257c7426";
const CHR_POWER       = "b04d2a5b-4604-453d-8868-b7ec257c7426";
const CHR_RADAR       = "b04d2a5a-4604-453d-8868-b7ec257c7426";
const CHR_OTA         = "b04d2a58-4604-453d-8868-b7ec257c7426";

let bleDevice = null;
let gattServer = null;
let chrRelayState = null, chrRelayCmd = null, chrPower = null, chrRadar = null, chrOTA = null;
let otaAckResolve = null;

// UI Elements
const btnConnect = document.getElementById("btnConnect");
const statusText = document.getElementById("statusText");
const mainsWatts = document.getElementById("mainsWatts");
const mainsVolts = document.getElementById("mainsVolts");
const invWatts   = document.getElementById("invWatts");
const invVolts   = document.getElementById("invVolts");
const radarBadge = document.getElementById("radarBadge");
const radarDist  = document.getElementById("radarDistance");
const relayBtns  = document.querySelectorAll(".relay-btn");

const btnSelectFw   = document.getElementById("btnSelectFw");
const otaFileInput  = document.getElementById("otaFileInput");
const progressWrap  = document.getElementById("progressWrap");
const progressBar   = document.getElementById("progressBar");
const otaStatus     = document.getElementById("otaStatus");

// ============================================================
// BLE Connection
// ============================================================
btnConnect.addEventListener("click", async () => {
    if (bleDevice && bleDevice.gatt.connected) {
        bleDevice.gatt.disconnect();
        return;
    }

    try {
        statusText.textContent = "Scanning for MXV1...";
        bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: "MXV1" }],
            optionalServices: [SERVICE_UUID]
        });

        bleDevice.addEventListener("gattserverdisconnected", onDisconnected);
        statusText.textContent = "Connecting...";
        gattServer = await bleDevice.gatt.connect();

        const service = await gattServer.getPrimaryService(SERVICE_UUID);
        chrRelayState = await service.getCharacteristic(CHR_RELAY_STATE);
        chrRelayCmd   = await service.getCharacteristic(CHR_RELAY_CMD);
        chrPower      = await service.getCharacteristic(CHR_POWER);
        chrRadar      = await service.getCharacteristic(CHR_RADAR);
        chrOTA        = await service.getCharacteristic(CHR_OTA);

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

        // Subscribe to OTA Progress & Flow Control ACKs
        await chrOTA.startNotifications();
        chrOTA.addEventListener("characteristicvaluechanged", onOtaNotify);

        // Read Initial Relay States
        const initialStates = await chrRelayState.readValue();
        const data = new Uint8Array(initialStates.buffer);
        data.forEach((st, idx) => {
            if (idx < relayBtns.length) relayBtns[idx].classList.toggle("active", st === 1);
        });

        statusText.textContent = "Connected (Bluetooth BLE)";
        btnConnect.textContent = "Disconnect";
        btnConnect.style.background = "#ef4444";
    } catch (err) {
        console.error("BLE Connect Error:", err);
        statusText.textContent = `Error: ${err.message}`;
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
        await chrRelayCmd.writeValue(new Uint8Array([relayIdx]));
    });
});

// ============================================================
// High-Speed PRN Block-Stream BLE OTA Engine
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
    otaStatus.textContent = `Starting OTA session (${(totalSize/1024).toFixed(0)} KB)...`;

    try {
        // 1. Send OTA_BEGIN [0x00][size_u32]
        const beginPkt = new Uint8Array(5);
        beginPkt[0] = 0x00;
        beginPkt[1] = totalSize & 0xFF;
        beginPkt[2] = (totalSize >> 8) & 0xFF;
        beginPkt[3] = (totalSize >> 16) & 0xFF;
        beginPkt[4] = (totalSize >> 24) & 0xFF;

        const readyPromise = waitForAck(0x04);
        await chrOTA.writeValue(beginPkt);
        await readyPromise; // Wait for non-blocking flash prep

        // 2. Stream Data Packets with PRN Sliding Window
        const CHUNK_SIZE = 490; // High throughput inside 512 MTU
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

            // Stream chunk without response for maximum speed
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

            // Every 10 packets (~5KB) or at EOF, await PRN ACK from ESP32
            if (packetsSinceAck >= 10 || offset >= totalSize) {
                packetsSinceAck = 0;
                await waitForAck(0x05, 3000);
            }
        }

        // 3. Send OTA_COMMIT [0x03]
        otaStatus.textContent = "Verifying SHA-256 Checksum & Committing...";
        const commitPromise = waitForAck(0x06, 5000);
        await chrOTA.writeValue(new Uint8Array([0x03]));
        await commitPromise;

        progressBar.style.width = "100%";
        otaStatus.textContent = "Success! Firmware updated. Device is rebooting in 1s...";
    } catch (err) {
        console.error("OTA Error:", err);
        otaStatus.textContent = `OTA Failed: ${err.message}`;
        try { await chrOTA.writeValue(new Uint8Array([0xFF])); } catch (_) {}
    }
});

function waitForAck(expectedOpcode, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            otaAckResolve = null;
            reject(new Error(`Timeout waiting for opcode 0x${expectedOpcode.toString(16)}`));
        }, timeoutMs);

        otaAckResolve = (opcode, payload) => {
            if (opcode === expectedOpcode) {
                clearTimeout(timer);
                resolve(payload);
                return true;
            } else if (opcode === 0x0E) { // OTA_ERROR
                clearTimeout(timer);
                reject(new Error("ESP32 reported flash verification error"));
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
