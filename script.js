// The ID of the camera app will be read from the input field

let peer = null;
let mediaConnection = null;
let dataConnection = null; // For sending commands like switch camera
let remoteStreamObj = null;

let mediaRecorder;
let recordedChunks = [];
let isRecording = false;
let isAudioMuted = false;

const statusText = document.getElementById('statusText');
const remoteVideo = document.getElementById('remoteVideo');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const deviceIdInput = document.getElementById('deviceIdInput');

// New Buttons
const switchCamBtn = document.getElementById('switchCamBtn');
const snapshotBtn = document.getElementById('snapshotBtn');
const recordBtn = document.getElementById('recordBtn');
const muteAudioBtn = document.getElementById('muteAudioBtn');
const switchViewBtn = document.getElementById('switchViewBtn');

let currentMode = "CAMERA"; // "CAMERA" or "SCREEN"

function updateStatus(message, color = "#FFA500") {
    statusText.textContent = message;
    statusText.style.color = color;
}

function initializePeer() {
    const viewerId = "viewer_" + Math.random().toString(36).substr(2, 9);
    peer = new Peer(viewerId, { debug: 2 });

    peer.on('open', (id) => {
        updateStatus("Ready to connect to camera.");
        connectBtn.disabled = false;
    });

    peer.on('error', (err) => {
        console.error("PeerJS error:", err);
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
        remoteStreamObj = remoteStream;
        remoteVideo.srcObject = remoteStream;
        remoteVideo.play().catch(e => console.warn("Auto-play prevented:", e));
        
        connectBtn.disabled = true;
        disconnectBtn.disabled = false;
        enableExtraControls();
    });

    call.on('close', () => {
        updateStatus("Camera disconnected.", "#f44336");
        remoteVideo.srcObject = null;
        remoteStreamObj = null;
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        disableExtraControls();
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

function connectToCamera(targetId) {
    updateStatus("Calling camera (" + targetId + ")...", "#FFA500");
    connectBtn.disabled = true;
    
    // Save to dropdown history
    saveDeviceId(targetId);
    
    dataConnection = peer.connect(targetId);
    
    dataConnection.on('open', () => {
        updateStatus("Requesting stream from camera...", "#FFA500");
        dataConnection.send({ command: "START_STREAM" });
    });
    
    dataConnection.on('error', (err) => {
        // Only show error if we were trying to connect to a camera (screen might just not be running)
        if(currentMode === "CAMERA") {
            updateStatus("Camera not reachable. Make sure the app is running.", "#f44336");
            connectBtn.disabled = false;
        }
    });
}

disconnectBtn.addEventListener('click', () => {
    if (dataConnection) {
        dataConnection.send({ command: "STOP_STREAM" });
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
    if (dataConnection && dataConnection.open) {
        dataConnection.send({ command: "SWITCH_CAMERA" });
        updateStatus("Switching camera...", "#2196F3");
    } else {
        alert("Control connection not active.");
    }
});

// Switch View (Camera <-> Screen)
switchViewBtn.addEventListener('click', () => {
    if (!dataConnection || !dataConnection.open) {
        alert("Control connection not active.");
        return;
    }
    
    if (currentMode === "CAMERA") {
        currentMode = "SCREEN";
        switchViewBtn.textContent = "Switch to Camera";
        switchViewBtn.style.backgroundColor = "#9C27B0";
        updateStatus("Switching to Screen View...", "#9C27B0");
        
        dataConnection.send({ command: "SWITCH_TO_SCREEN" });
        if (mediaConnection) mediaConnection.close();
        setTimeout(() => {
            if (dataConnection.open) dataConnection.send({ command: "START_STREAM" });
        }, 800);
    } else {
        currentMode = "CAMERA";
        switchViewBtn.textContent = "Switch to Screen";
        switchViewBtn.style.backgroundColor = "#2196F3";
        updateStatus("Switching to Camera View...", "#2196F3");
        
        dataConnection.send({ command: "SWITCH_TO_CAMERA" });
        if (mediaConnection) mediaConnection.close();
        setTimeout(() => {
            if (dataConnection.open) dataConnection.send({ command: "START_STREAM" });
        }, 800);
    }
});

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
    let saved = JSON.parse(localStorage.getItem('savedDevices') || '[]');
    if (!saved.includes(id)) {
        saved.push(id);
        localStorage.setItem('savedDevices', JSON.stringify(saved));
        updateDeviceDropdown();
    }
}

function updateDeviceDropdown() {
    deviceIdInput.innerHTML = '';
    
    // Add default option
    const defOpt = document.createElement('option');
    defOpt.value = "";
    defOpt.text = "-- Select Phone --";
    deviceIdInput.appendChild(defOpt);
    
    let saved = JSON.parse(localStorage.getItem('savedDevices') || '[]');
    saved.forEach(id => {
        // Hide _screen endpoints from the main dropdown to keep it clean
        if (id.endsWith("_screen")) return;
        
        const option = document.createElement('option');
        option.value = id;
        option.text = id;
        deviceIdInput.appendChild(option);
    });
}

// Call it on load
updateDeviceDropdown();

// --- Auto-Discovery using Public MQTT ---
const DISCOVERY_BASE_TOPIC = "ar115_hidden_cam_discovery_99182/devices/";
const mqttClient = mqtt.connect('wss://broker.hivemq.com:8884/mqtt');

let onlineDevices = new Set();

mqttClient.on('connect', () => {
    console.log("Connected to Discovery Server");
    mqttClient.subscribe(DISCOVERY_BASE_TOPIC + "+");
});

mqttClient.on('message', (topic, message) => {
    if (topic.startsWith(DISCOVERY_BASE_TOPIC)) {
        const payload = message.toString();
        const deviceId = topic.split('/').pop();
        
        if (payload === "") {
            // Device went offline (Last Will and Testament)
            console.log("Phone disconnected:", deviceId);
            onlineDevices.delete(deviceId);
        } else {
            // Device is online
            console.log("Discovered new phone:", deviceId);
            onlineDevices.add(deviceId);
            saveDeviceId(deviceId); // Keep history
            
            // Auto-fill input if it's currently empty
            if (deviceIdInput.value.trim() === "") {
                deviceIdInput.value = deviceId;
                updateStatus("Auto-detected new phone! Ready to connect.", "#4CAF50");
            }
        }
        updateLiveDeviceDropdown();
    }
});

function updateLiveDeviceDropdown() {
    // Save current selection to restore it
    const currentVal = deviceIdInput.value;
    
    deviceIdInput.innerHTML = '';
    const defOpt = document.createElement('option');
    defOpt.value = "";
    defOpt.text = "-- Select Phone --";
    deviceIdInput.appendChild(defOpt);
    
    let addedBaseIds = new Set();
    
    // Add online devices first
    onlineDevices.forEach(id => {
        // Extract base ID
        let baseId = id;
        if (id.endsWith("_screen")) baseId = id.replace("_screen", "");
        
        if (!addedBaseIds.has(baseId)) {
            const option = document.createElement('option');
            option.value = baseId;
            option.text = "🟢 " + baseId + " (Online)";
            deviceIdInput.appendChild(option);
            addedBaseIds.add(baseId);
        }
    });
    
    // Add offline history devices
    let saved = JSON.parse(localStorage.getItem('savedDevices') || '[]');
    saved.forEach(id => {
        let baseId = id;
        if (id.endsWith("_screen")) baseId = id.replace("_screen", "");
        
        if (!addedBaseIds.has(baseId)) {
            const option = document.createElement('option');
            option.value = baseId;
            option.text = "⚪ " + baseId + " (Offline)";
            deviceIdInput.appendChild(option);
            addedBaseIds.add(baseId);
        }
    });
    
    if (addedBaseIds.has(currentVal)) {
        deviceIdInput.value = currentVal;
    }
}

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

// Initialize peer when page loads
initializePeer();
