const byId = id => document.getElementById(id);
const fileInput = byId('file');
const playButton = byId('play');
const micButton = byId('mic');
const pauseButton = byId('pause');
const stopButton = byId('stop');
const loop = byId('loop');
const status = byId('status');
const canvas = byId('wave');
const drawing = canvas.getContext('2d');
let context, processor, gain, analyser, source, stream;
let active = false;
let busy = false;

function parameters() {
    return {
        pitch: Number(byId('pitch').value),
        mode: Number(byId('mode').value),
        tier: Number(byId('tier').value),
        formants: byId('formants').checked,
        bypass: byId('bypass').checked,
    };
}

async function ensureAudio() {
    if (context) {
        await context.resume();
        return;
    }
    const audio = new AudioContext();
    try {
        if (!audio.audioWorklet) throw new Error('请通过 HTTPS 或 localhost 打开页面');
        await audio.resume();
        const [response] = await Promise.all([
            fetch('pbshift.wasm'),
            audio.audioWorklet.addModule('pbshift_worklet.js'),
        ]);
        if (!response.ok) throw new Error('WebAssembly 加载失败（HTTP ' + response.status + '）');
        const bytes = await response.arrayBuffer();
        const node = new AudioWorkletNode(audio, 'pbshift-processor', {
            channelCount: 2, channelCountMode: 'explicit', outputChannelCount: [2],
        });
        await new Promise((resolve, reject) => {
            node.onprocessorerror = () => reject(new Error('音频处理器初始化失败'));
            node.port.onmessage = ({ data }) => {
                if (data.type === 'ready') resolve();
                if (data.type === 'drained' && !source && active) {
                    active = false;
                    status.textContent = '文件播放结束';
                    updateControls();
                }
                if (data.type === 'error') {
                    const error = new Error(data.message);
                    reject(error);
                    status.textContent = error.message;
                }
                if (data.type === 'latency') {
                    byId('latency').textContent =
                        '引擎输入延迟 ' + (1000 * data.samples / audio.sampleRate).toFixed(1) + ' ms';
                }
            };
            node.port.postMessage({ type: 'init', bytes, params: parameters() }, [bytes]);
        });
        node.onprocessorerror = () => {
            stopSource();
            status.textContent = '音频处理器出错，请重新打开页面。';
        };
        gain = audio.createGain();
        analyser = audio.createAnalyser();
        analyser.fftSize = 1024;
        node.connect(gain).connect(analyser).connect(audio.destination);
        context = audio;
        processor = node;
        updateParameters();
    } catch (error) {
        await audio.close();
        throw error;
    }
}

function updateControls() {
    fileInput.disabled = busy;
    playButton.disabled = busy || !fileInput.files.length;
    micButton.disabled = busy;
    pauseButton.disabled = busy || !active;
    stopButton.disabled = busy || !active;
    pauseButton.textContent = context?.state === 'suspended' ? '继续' : '暂停';
}

function stopSource() {
    if (source) {
        source.onended = null;
        if (source instanceof AudioBufferSourceNode) source.stop();
        source.disconnect();
        source = null;
    }
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    active = false;
    processor?.port.postMessage({ type: 'reset' });
    updateControls();
}

async function run(action) {
    busy = true;
    updateControls();
    try {
        await action();
    } catch (error) {
        status.textContent = error.message;
    } finally {
        busy = false;
        updateControls();
    }
}

playButton.onclick = () => run(async () => {
    const file = fileInput.files[0];
    await ensureAudio();
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    stopSource();
    const player = context.createBufferSource();
    player.buffer = buffer;
    player.loop = loop.checked;
    player.onended = () => {
        if (source !== player) return;
        player.disconnect();
        source = null;
        status.textContent = '正在播放处理后的尾音';
    };
    player.connect(processor);
    player.start();
    source = player;
    active = true;
    status.textContent = '正在播放 ' + file.name;
});

micButton.onclick = () => run(async () => {
    await ensureAudio();
    const microphone = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    stopSource();
    stream = microphone;
    source = context.createMediaStreamSource(stream);
    source.connect(processor);
    active = true;
    status.textContent = '麦克风监听中';
});

pauseButton.onclick = () => run(async () => {
    if (context.state === 'suspended') await context.resume();
    else await context.suspend();
    status.textContent = context.state === 'suspended' ? '已暂停' : '继续播放';
});

stopButton.onclick = () => {
    stopSource();
    status.textContent = '已停止';
};
fileInput.onchange = updateControls;
loop.onchange = () => {
    if (source instanceof AudioBufferSourceNode) source.loop = loop.checked;
};

function updateParameters() {
    const params = parameters();
    const volume = Number(byId('volume').value);
    byId('pitchValue').value = params.pitch + ' 半音';
    byId('volumeValue').value = volume + '%';
    gain?.gain.setTargetAtTime(volume / 100, context.currentTime, 0.01);
    processor?.port.postMessage({ type: 'params', params });
}

for (const id of ['pitch', 'volume', 'mode', 'tier', 'formants', 'bypass']) {
    byId(id).addEventListener('input', updateParameters);
}

const samples = new Float32Array(1024);
function draw() {
    drawing.clearRect(0, 0, canvas.width, canvas.height);
    if (analyser && active && context.state === 'running') analyser.getFloatTimeDomainData(samples);
    else samples.fill(0);
    drawing.beginPath();
    drawing.strokeStyle = '#4cc997';
    for (let index = 0; index < samples.length; index++) {
        const x = index * canvas.width / (samples.length - 1);
        const y = (1 - samples[index]) * canvas.height / 2;
        if (index === 0) drawing.moveTo(x, y);
        else drawing.lineTo(x, y);
    }
    drawing.stroke();
    requestAnimationFrame(draw);
}
draw();
