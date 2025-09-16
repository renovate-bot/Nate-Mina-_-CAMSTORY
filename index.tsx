/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, Type } from '@google/genai';
import { marked } from 'marked';

// --- DOM Elements ---
const videoEl = document.getElementById('webcam') as HTMLVideoElement;
const canvasEl = document.getElementById('canvas') as HTMLCanvasElement;
const labelContainer = document.getElementById('label-container') as HTMLDivElement;
const captureBtn = document.getElementById('capture-btn') as HTMLButtonElement;
const uploadInput = document.getElementById('upload-input') as HTMLInputElement;
const uploadLabel = document.getElementById('upload-label') as HTMLLabelElement;
const storyContainer = document.getElementById('story-container') as HTMLDivElement;
const loader = document.getElementById('loader') as HTMLDivElement;
const voiceSelectionContainer = document.getElementById('voice-selection-container') as HTMLDivElement;
const voiceSelectEl = document.getElementById('voice-select') as HTMLSelectElement;
const speedControl = document.getElementById('speed-control') as HTMLInputElement;

// --- State Management ---
let appState: 'live' | 'processing' | 'result' = 'live';
let audioContext: AudioContext | null = null;

// --- Gemini AI Setup ---
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  storyContainer.innerHTML = 'Error: API_KEY environment variable not set.';
  throw new Error('API_KEY not set');
}
const ai = new GoogleGenAI({ apiKey: API_KEY });

// --- Audio Effects ---

/**
 * Initializes the Web Audio API context on the first user interaction.
 */
function initAudioContext() {
    if (!audioContext) {
        try {
            audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        } catch (e) {
            console.error("Web Audio API is not supported in this browser");
        }
    }
}

/**
 * Plays a synthesized camera shutter sound.
 */
function playShutterSound() {
    if (!audioContext) return;
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    const now = audioContext.currentTime;

    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(1200, now);
    oscillator.frequency.exponentialRampToValueAtTime(800, now + 0.04);

    gainNode.connect(audioContext.destination);
    gainNode.gain.setValueAtTime(0.8, now);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

    oscillator.connect(gainNode);
    oscillator.start(now);
    oscillator.stop(now + 0.05);
}

/**
 * Plays a short "pop" sound for when labels appear.
 */
function playLabelPopSound() {
    if (!audioContext) return;
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    const now = audioContext.currentTime;

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(400, now);
    oscillator.frequency.exponentialRampToValueAtTime(80, now + 0.1);

    gainNode.connect(audioContext.destination);
    gainNode.gain.setValueAtTime(0.5, now);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.1);

    oscillator.connect(gainNode);
    oscillator.start(now);
    oscillator.stop(now + 0.1);
}

/**
 * Plays a gentle chime sound to indicate the story is about to start.
 */
function playStoryStartChime() {
    if (!audioContext) return;
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    const now = audioContext.currentTime;

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(987, now); // B5 note

    gainNode.connect(audioContext.destination);
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(0.4, now + 0.1);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

    oscillator.connect(gainNode);
    oscillator.start(now);
    oscillator.stop(now + 0.5);
}


/**
 * Initializes the webcam stream.
 */
async function initWebcam() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user' },
      audio: false,
    });
    videoEl.srcObject = stream;
    await videoEl.play();
    captureBtn.disabled = false;
  } catch (err) {
    console.error('Error accessing webcam:', err);
    storyContainer.innerHTML = `
      <p><strong>Error:</strong> Could not access webcam.</p>
      <p>Please grant camera permissions and refresh the page.</p>
    `;
    captureBtn.disabled = true;
  }
}

/**
 * Populates the voice selection dropdown with available English voices.
 */
function populateVoiceList() {
    const voices = window.speechSynthesis.getVoices().filter(voice => voice.lang.startsWith('en'));
    if (voices.length === 0 || voiceSelectEl.options.length === voices.length) {
        if (voiceSelectEl.options.length > 0) voiceSelectionContainer.classList.remove('hidden');
        return;
    }
    
    voiceSelectEl.innerHTML = '';
    const savedVoiceName = localStorage.getItem('storyteller-voice');

    voices.forEach(voice => {
        const option = document.createElement('option');
        option.textContent = `${voice.name} (${voice.lang})`;
        option.value = voice.name;
        if (voice.name === savedVoiceName) {
            option.selected = true;
        }
        voiceSelectEl.appendChild(option);
    });

    if (voices.length > 0) {
        voiceSelectionContainer.classList.remove('hidden');
    }
}


/**
 * Speaks the provided text using the selected storyteller voice and speed.
 * @param text The story to speak.
 */
async function speakStory(text: string) {
  window.speechSynthesis.cancel();
  const textToSpeak = text.replace(/\*/g, '');
  const utterance = new SpeechSynthesisUtterance(textToSpeak);

  const selectedVoiceName = voiceSelectEl.value;
  const voices = window.speechSynthesis.getVoices();
  const selectedVoice = voices.find(voice => voice.name === selectedVoiceName);
  
  if (selectedVoice) {
    utterance.voice = selectedVoice;
  } else {
    const fallbackVoice = voices.find(v => v.lang.startsWith('en-US')) || voices.find(v => v.lang.startsWith('en'));
    if (fallbackVoice) {
        utterance.voice = fallbackVoice;
    }
  }

  utterance.pitch = 0.8;
  utterance.rate = parseFloat(speedControl.value);

  window.speechSynthesis.speak(utterance);
}

/**
 * Calls Gemini to identify and locate objects in the image.
 * @param base64Data The base64 encoded image data.
 * @returns A promise that resolves to an array of labeled objects.
 */
async function generateLabels(base64Data: string): Promise<{ name: string; position: { x: number; y: number } }[]> {
  try {
    const imagePart = { inlineData: { mimeType: 'image/jpeg', data: base64Data } };
    const textPart = { text: 'Identify the main objects in this image. For each object, provide its name and a central x,y coordinate (from 0.0 to 1.0).' };

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: { parts: [imagePart, textPart] },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              position: {
                type: Type.OBJECT,
                properties: {
                  x: { type: Type.NUMBER },
                  y: { type: Type.NUMBER }
                }
              }
            }
          }
        }
      }
    });

    const jsonString = response.text.trim();
    return JSON.parse(jsonString);
  } catch (err) {
    console.error("Error generating labels:", err);
    return []; // Return empty array on failure
  }
}

/**
 * Renders the identified object labels onto the label container.
 * @param labels Array of objects with name and position.
 * @param isMirrored Whether the source image was mirrored (like the webcam).
 */
function renderLabels(labels: { name: string; position: { x: number; y: number } }[], isMirrored: boolean) {
  labelContainer.innerHTML = '';
  labels.forEach((label, index) => {
    const labelEl = document.createElement('div');
    labelEl.className = 'label';
    const xPosition = isMirrored ? (1 - label.position.x) : label.position.x;
    labelEl.style.left = `${xPosition * 100}%`;
    labelEl.style.top = `${label.position.y * 100}%`;

    const dotEl = document.createElement('div');
    dotEl.className = 'dot';

    const textEl = document.createElement('span');
    textEl.className = 'text';
    textEl.textContent = label.name;

    labelEl.appendChild(dotEl);
    labelEl.appendChild(textEl);
    labelContainer.appendChild(labelEl);
    
    // Play a staggered sound for each label
    setTimeout(() => {
        playLabelPopSound();
    }, index * 80);
  });
}

/**
 * Generates and streams the story from Gemini, then speaks it.
 * @param base64Data The base64 encoded image data.
 */
async function generateAndSpeakStory(base64Data: string) {
  try {
    const imagePart = { inlineData: { mimeType: 'image/jpeg', data: base64Data } };
    const textPart = { text: 'Look at this image. Write a short, funny, creative story about it for an adult audience. Use Markdown for formatting.' };

    const response = await ai.models.generateContentStream({
      model: 'gemini-2.5-flash',
      contents: { parts: [imagePart, textPart] }
    });

    storyContainer.innerHTML = ''; // Clear previous story
    let fullStoryText = '';
    
    playStoryStartChime();

    for await (const chunk of response) {
      const chunkText = chunk.text;
      fullStoryText += chunkText;
      storyContainer.innerHTML = marked(fullStoryText) as string;
    }

    await speakStory(fullStoryText);
    return fullStoryText;

  } catch (err) {
    console.error("Error generating story:", err);
    storyContainer.innerHTML = 'Sorry, I got a bit of writer\'s block. Please try again!';
    throw err;
  }
}


/**
 * Updates the UI based on the current application state.
 * @param newState The new state: 'live', 'processing', or 'result'.
 */
function updateUI(newState: 'live' | 'processing' | 'result') {
  appState = newState;
  switch (newState) {
    case 'live':
      videoEl.style.display = 'block';
      canvasEl.style.display = 'none';
      labelContainer.innerHTML = '';
      storyContainer.innerHTML = '';
      loader.classList.add('hidden');
      captureBtn.disabled = false;
      captureBtn.textContent = 'Capture Scene & Tell Story';
      uploadLabel.classList.remove('hidden');
      break;
    case 'processing':
      videoEl.style.display = 'none';
      canvasEl.style.display = 'block';
      loader.classList.remove('hidden');
      captureBtn.disabled = true;
      captureBtn.textContent = 'Working...';
      uploadLabel.classList.add('hidden');
      break;
    case 'result':
      loader.classList.add('hidden');
      captureBtn.disabled = false;
      captureBtn.textContent = 'Start Over';
      uploadLabel.classList.add('hidden');
      break;
  }
}


/**
 * Main processing function for an image.
 * @param imageData The image data source (HTMLVideoElement or HTMLImageElement).
 * @param isMirrored True if the image source is mirrored (like the webcam).
 */
async function processImage(imageData: HTMLVideoElement | HTMLImageElement, isMirrored: boolean) {
    initAudioContext();
    playShutterSound();

    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;

    // FIX: Use type-safe access to element dimensions and use intrinsic size for images.
    canvasEl.width = imageData instanceof HTMLVideoElement ? imageData.videoWidth : imageData.naturalWidth;
    canvasEl.height = imageData instanceof HTMLVideoElement ? imageData.videoHeight : imageData.naturalHeight;

    if (isMirrored) {
        ctx.save();
        ctx.scale(-1, 1);
        ctx.drawImage(imageData, -canvasEl.width, 0, canvasEl.width, canvasEl.height);
        ctx.restore();
    } else {
        ctx.drawImage(imageData, 0, 0, canvasEl.width, canvasEl.height);
    }

    updateUI('processing');
    const base64Data = canvasEl.toDataURL('image/jpeg').split(',')[1];

    try {
        const labelsPromise = generateLabels(base64Data);
        const storyPromise = generateAndSpeakStory(base64Data);

        const labels = await labelsPromise;
        renderLabels(labels, isMirrored);

        await storyPromise;

        updateUI('result');
    } catch (error) {
        console.error("Processing failed:", error);
        storyContainer.innerHTML = '<p>Oops! Something went wrong while creating your story. Please try again.</p>';
        updateUI('live');
    }
}


// --- Event Listeners and Initialization ---
function init() {
    initWebcam();
    populateVoiceList();
    if (speechSynthesis.onvoiceschanged !== undefined) {
        speechSynthesis.onvoiceschanged = populateVoiceList;
    }

    const savedVoice = localStorage.getItem('storyteller-voice');
    if (savedVoice) voiceSelectEl.value = savedVoice;

    const savedSpeed = localStorage.getItem('storyteller-speed');
    if (savedSpeed) speedControl.value = savedSpeed;


    captureBtn.addEventListener('click', () => {
        if (appState === 'result') {
            updateUI('live');
        } else if (appState === 'live') {
            processImage(videoEl, true);
        }
    });

    uploadInput.addEventListener('change', (event) => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (file && appState === 'live') {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => processImage(img, false);
                img.src = e.target?.result as string;
            };
            reader.readAsDataURL(file);
        }
    });

    voiceSelectEl.addEventListener('change', () => {
        localStorage.setItem('storyteller-voice', voiceSelectEl.value);
    });

    speedControl.addEventListener('input', () => {
        localStorage.setItem('storyteller-speed', speedControl.value);
    });
}

init();
