import React from 'react';
import ReactDOM from 'react-dom/client';

const { useRef, useEffect, useState } = React;

const baseURL = "" // points to whatever is serving this app (eg your -dev.modal.run for modal serve, or .modal.run for modal deploy)

const getBaseURL = () => {
  const envMoshiUrl = import.meta.env.VITE_MOSHI_WS_URL;
  if (envMoshiUrl && envMoshiUrl.trim() !== '') {
    console.log("Using VITE_MOSHI_WS_URL:", envMoshiUrl);
    return envMoshiUrl;
  }

  // Fallback to original logic if environment variable is not set
  console.log("VITE_MOSHI_WS_URL not set, using fallback logic based on current hostname.");
  const currentURL = new URL(window.location.href);
  let hostname = currentURL.hostname;

  if (hostname.includes('-web')) {
    hostname = hostname.replace('-web', '-moshi-web');
  } else {
    // Append '-moshi-web' if '-web' is not present
    hostname = `${hostname}-moshi-web`;
  }

  const wsProtocol = currentURL.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${hostname}/ws`; 
}

const App = () => {
  // Mic Input
  const [recorder, setRecorder] = useState(null); // Opus recorder
  const [amplitude, setAmplitude] = useState(0); // Amplitude, captured from PCM analyzer

  // Audio playback
  const [audioContext] = useState(() => new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 }));
  const sourceNodeRef = useRef(null); // Audio source node
  const scheduledEndTimeRef = useRef(0); // Scheduled end time for audio playback
  const decoderRef = useRef(null); // Decoder for converting opus to PCM

  // WebSocket
  const socketRef = useRef(null); // Ongoing websocket connection
  const reconnectTimerRef = useRef(null); // Timer for reconnection attempts

  // UI State
  const [warmupComplete, setWarmupComplete] = useState(false);
  const [completedSentences, setCompletedSentences] = useState([]);
  const [pendingSentence, setPendingSentence] = useState('');
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [connectionStatusMessage, setConnectionStatusMessage] = useState('');


  // Mic Input: start the Opus recorder
  const startRecording = async () => {
    // prompts user for permission to use microphone
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const recorder = new Recorder({
      encoderPath: "https://cdn.jsdelivr.net/npm/opus-recorder@8.0.5/dist/encoderWorker.min.js",
      streamPages: true,
      encoderApplication: 2049,
      encoderFrameSize: 80, // milliseconds, equal to 1920 samples at 24000 Hz
      encoderSampleRate: 24000,  // 24000 to match model's sample rate
      maxFramesPerPage: 1,
      numberOfChannels: 1,
    });

    recorder.ondataavailable = async (arrayBuffer) => {
      if (socketRef.current) {
        if (socketRef.current.readyState !== WebSocket.OPEN) {
          console.log("Socket not open, dropping audio");
          return;
        }
        await socketRef.current.send(arrayBuffer);
      }
    };

    recorder.start().then(() => {
      console.log("Recording started");
      setRecorder(recorder);
    });

    // create a MediaRecorder object for capturing PCM (calculating amplitude)
    const analyzerContext = new (window.AudioContext || window.webkitAudioContext)();
    const analyzer = analyzerContext.createAnalyser();
    analyzer.fftSize = 256;
    const sourceNode = analyzerContext.createMediaStreamSource(stream);
    sourceNode.connect(analyzer);

    // Use a separate audio processing function instead of MediaRecorder
    const processAudio = () => {
      const dataArray = new Uint8Array(analyzer.frequencyBinCount);
      analyzer.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
      setAmplitude(average);
      requestAnimationFrame(processAudio);
    };
    processAudio();
  };


  // Audio Playback: Prep decoder for converting opus to PCM for audio playback
  useEffect(() => {
    const initializeDecoder = async () => {
      const decoder = new window["ogg-opus-decoder"].OggOpusDecoder();
      await decoder.ready;
      decoderRef.current = decoder;
      console.log("Ogg Opus decoder initialized");
    };
  
    initializeDecoder();
  
    return () => {
      if (decoderRef.current) {
        decoderRef.current.free();
      }
    };
  }, []);

  // Audio Playback: schedule PCM audio chunks for seamless playback
  const scheduleAudioPlayback = (newAudioData) => {
    const sampleRate = audioContext.sampleRate;
    const numberOfChannels = 1;
    const nowTime = audioContext.currentTime;
  
    // Create a new buffer and source node for the incoming audio data
    const newBuffer = audioContext.createBuffer(numberOfChannels, newAudioData.length, sampleRate);
    newBuffer.copyToChannel(newAudioData, 0);
    const sourceNode = audioContext.createBufferSource();
    sourceNode.buffer = newBuffer;
    sourceNode.connect(audioContext.destination);
  
    // Schedule the new audio to play immediately after any currently playing audio
    const startTime = Math.max(scheduledEndTimeRef.current, nowTime);
    sourceNode.start(startTime);
  
    // Update the scheduled end time so we know when to schedule the next piece of audio
    scheduledEndTimeRef.current = startTime + newBuffer.duration;
  
    if (sourceNodeRef.current && sourceNodeRef.current.buffer) {
      const currentEndTime = sourceNodeRef.current.startTime + sourceNodeRef.current.buffer.duration;
      if (currentEndTime <= nowTime) {
        sourceNodeRef.current.disconnect();
      }
    }
    sourceNodeRef.current = sourceNode;
  };


  // WebSocket connection logic
  const connectWebSocket = () => {
    const endpoint = getBaseURL();
    console.log(`Attempting to connect to ${endpoint} (Attempt: ${reconnectAttempts + 1})`);
    setConnectionStatusMessage(`Connecting... (Attempt ${reconnectAttempts + 1})`);

    const socket = new WebSocket(endpoint);

    socket.onopen = () => {
      console.log("WebSocket connection opened");
      socketRef.current = socket;
      setWarmupComplete(true);
      setIsReconnecting(false);
      setReconnectAttempts(0);
      setConnectionStatusMessage("Connected.");
      // Clear message after a few seconds
      setTimeout(() => setConnectionStatusMessage(''), 3000);
      
      // Start recording only if not already started or if it was stopped
      if (!recorder || !recorder.isRecording()) {
        startRecording();
      }
    };

    socket.onmessage = async (event) => {
      // data is a blob, convert to array buffer
      const arrayBuffer = await event.data.arrayBuffer();
      const view = new Uint8Array(arrayBuffer);
      const tag = view[0];
      const payload = arrayBuffer.slice(1);
      if (tag === 1) {
        // audio data
        if (decoderRef.current) {
          const { channelData, samplesDecoded } = await decoderRef.current.decode(new Uint8Array(payload));
          if (samplesDecoded > 0) {
            scheduleAudioPlayback(channelData[0]);
          }
        } else {
          console.warn("Decoder not ready, dropping audio packet.")
        }
      }
      if (tag === 2) {
        // text data
        const decoder = new TextDecoder();
        const text = decoder.decode(payload);

        setPendingSentence(prevPending => {
          const updatedPending = prevPending + text;
          if (updatedPending.endsWith('.') || updatedPending.endsWith('!') || updatedPending.endsWith('?')) {
            setCompletedSentences(prevCompleted => [...prevCompleted, updatedPending]);
            return '';
          }
          return updatedPending;
        });
      }
    };

    socket.onerror = (error) => {
      console.error("WebSocket error:", error);
      // onclose will usually be called automatically after an error
    };

    socket.onclose = () => {
      console.log("WebSocket connection closed");
      socketRef.current = null; // Clear the ref
      setWarmupComplete(false); // No longer ready
      
      if (recorder && recorder.isRecording()) {
        // Consider stopping recorder or handling audio data queueing if desired
        // For now, we just log. If startRecording is called on reconnect, it handles new stream.
        console.log("Recorder was active, will be re-initialized on reconnect if needed.");
      }

      // Don't attempt to reconnect if the component is unmounting (timer cleared)
      // or if a reconnection attempt is already scheduled by another close event
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      
      const currentAttempts = reconnectAttempts; // Capture current attempts for the closure
      const maxAttempts = 10; // Max reconnection attempts

      if (currentAttempts < maxAttempts) {
        setIsReconnecting(true);
        const delay = Math.min(30000, Math.pow(2, currentAttempts) * 1000); // Exponential backoff, max 30s
        setConnectionStatusMessage(`Connection lost. Retrying in ${delay / 1000}s... (Attempt ${currentAttempts + 1})`);
        
        reconnectTimerRef.current = setTimeout(() => {
          setReconnectAttempts(prevAttempts => prevAttempts + 1);
          connectWebSocket();
        }, delay);
      } else {
        setConnectionStatusMessage(`Failed to reconnect after ${maxAttempts} attempts. Please refresh the page.`);
        setIsReconnecting(false);
        console.error(`Failed to reconnect after ${maxAttempts} attempts.`);
      }
    };
    // Assign to ref immediately for cleanup purposes, even before onopen
    socketRef.current = socket; 
  };

  // Effect for initializing and cleaning up WebSocket
  useEffect(() => {
    connectWebSocket(); // Initial connection attempt

    return () => {
      // Cleanup on component unmount
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
      if (recorder) {
        recorder.stop(); // Stop opus recorder
        // If you have a MediaStreamTrack for amplitude, stop that too
      }
    };
  }, []); // Empty dependency array means this runs once on mount and cleans up on unmount

  return (
    <div className="bg-gray-900 text-white min-h-screen flex flex-col items-center justify-center p-4">
      <div className="bg-gray-800 rounded-lg shadow-lg w-full max-w-xl p-6 mb-8">
        <div className="flex">
          <div className="w-5/6 overflow-y-auto max-h-64">
            <TextOutput 
              warmupComplete={warmupComplete} 
              completedSentences={completedSentences} 
              pendingSentence={pendingSentence}
              isReconnecting={isReconnecting}
              connectionStatusMessage={connectionStatusMessage} 
            />
          </div>
          <div className="w-1/6 ml-4 pl-4">
            <AudioControl recorder={recorder} amplitude={amplitude} />
          </div>
        </div>
      </div>
      
      <a
        className="fixed bottom-4 inline-flex items-center justify-center"
        href="https://modal.com"
        target="_blank"
        rel="noopener noreferrer"
      >
        <footer className="flex items-center px-3 py-2 rounded-lg bg-gray-800 shadow-lg hover:bg-gray-700 transition-colors duration-200">
          <span className="text-sm font-medium text-gray-300 mr-2">
            Built with <a 
              className="underline" 
              href="https://github.com/kyutai-labs/moshi" 
              target="_blank" rel="noopener noreferrer">
                Moshi
            </a> and
          </span>
          <img className="w-24" src="/modal-logo.svg" alt="Modal logo" />
        </footer>
      </a>
    </div>
  );
}

const AudioControl = ({ recorder, amplitude }) => {
  const { useState, useEffect } = React; // Added React import for hooks
  const [muted, setMuted] = useState(true);

  const toggleMute = () => {
    if (!recorder) {
      return;
    }
    setMuted(!muted);
    recorder.setRecordingGain(muted ? 1 : 0);
  };

  // unmute automatically once the recorder is ready
  useEffect(() => {
    if (recorder) {
      setMuted(false);
      recorder.setRecordingGain(1);
    }
  },
  [recorder]);

  const amplitudePercent = amplitude / 255;
  const maxAmplitude = 0.3; // for scaling
  const minDiameter = 30; // minimum diameter of the circle in pixels
  const maxDiameter = 200; // increased maximum diameter to ensure overflow
  
  var diameter = minDiameter + (maxDiameter - minDiameter) * (amplitudePercent / maxAmplitude);
  if (muted) {
    diameter = 20;
  }

  return (
    <div className="w-full h-full flex items-center">
      <div className="w-full h-6 rounded-sm relative overflow-hidden">
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className={`rounded-full transition-all duration-100 ease-out hover:cursor-pointer ${muted ? 'bg-gray-200 hover:bg-red-300' : 'bg-red-500 hover:bg-red-300'}`}
            onClick={toggleMute}
            style={{
              width: `${diameter}px`,
              height: `${diameter}px`,
            }}
          ></div>
        </div>
      </div>
    </div>
  );
};

const TextOutput = ({ warmupComplete, completedSentences, pendingSentence, isReconnecting, connectionStatusMessage }) => {
  const { useRef, useEffect } = React; // Added React import for hooks
  const containerRef = useRef(null);
  
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [completedSentences, pendingSentence, connectionStatusMessage]);

  let statusElement = null;
  if (connectionStatusMessage) {
    statusElement = <p className="text-yellow-400 my-2">{connectionStatusMessage}</p>;
  } else if (isReconnecting) { // Default reconnecting message if specific one isn't set
    statusElement = <p className="text-yellow-400 animate-pulse my-2">Attempting to reconnect...</p>;
  } else if (!warmupComplete) {
    statusElement = <p className="text-gray-400 animate-pulse my-2">Warming up model...</p>;
  }

  // Determine if we should show sentences or status messages
  // Show sentences if warmup is complete AND we are not actively showing a connection status message
  // (e.g. "Connected." can briefly show, then sentences appear)
  const showSentences = warmupComplete && !connectionStatusMessage && !isReconnecting;

  // Construct allSentences for display if needed
  const allSentences = [...completedSentences, pendingSentence];
  if (pendingSentence.length === 0 && allSentences.length > 0 && completedSentences.includes(allSentences[allSentences.length-1])) {
     // Avoid duplicating the last completed sentence if pending is empty
     // This logic might need adjustment based on how pendingSentence is cleared
  }


  return (
    <div ref={containerRef} className="flex flex-col-reverse overflow-y-auto max-h-64 pr-2">
      {statusElement}
      {showSentences && allSentences.map((sentence, index) => (
        // Ensure unique keys if sentences can be identical
        <p key={`${sentence}-${index}`} className="text-gray-300 my-2">{sentence}</p>
      )).reverse()}
      {/* If not showing sentences and no specific status, perhaps a placeholder or nothing */}
      {!showSentences && !statusElement && (
        <p className="text-gray-400 my-2">Waiting for connection...</p>
      )}
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
