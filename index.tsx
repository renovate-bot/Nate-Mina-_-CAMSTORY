/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from '@google/genai';
import { marked } from 'marked';

// --- DOM Elements ---
const videoEl = document.getElementById('webcam') as HTMLVideoElement;
const canvasEl = document.getElementById('canvas') as HTMLCanvasElement;
const captureBtn = document.getElementById('capture-btn') as HTMLButtonElement;
const storyContainer = document.getElementById('story-container') as HTMLDivElement;
const loader = document.getElementById('loader') as HTMLDivElement;

// --- Gemini AI Setup ---
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  storyContainer.innerHTML = 'Error: API_KEY environment variable not set.';
  throw new Error('API_KEY not set');
}
const ai = new GoogleGenAI({ apiKey: API_KEY });

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
 * Speaks the provided text using a male storyteller voice.
 * @param text The story to speak.
 */
async function speakStory(text: string) {
  // Ensure any ongoing speech is stopped before starting a new one.
  window.speechSynthesis.cancel();

  // Create a promise to handle the asynchronous loading of voices.
  const getVoices = (): Promise<SpeechSynthesisVoice[]> => {
    return new Promise(resolve => {
      let voices = window.speechSynthesis.getVoices();
      if (voices.length) {
        resolve(voices);
        return;
      }
      window.speechSynthesis.onvoiceschanged = () => {
        voices = window.speechSynthesis.getVoices();
        resolve(voices);
      };
    });
  };

  const voices = await getVoices();
  const utterance = new SpeechSynthesisUtterance(text);

  // Find a suitable "serious yet funny" male voice.
  // We'll look for an English male voice, prioritizing non-Google voices
  // which are often higher quality system voices.
  const maleVoice =
    voices.find(
      voice =>
        voice.lang.startsWith('en') && voice.name.includes('Male') && !voice.name.includes('Google')
    ) ||
    voices.find(
      voice => voice.lang.startsWith('en') && voice.name.includes('Male')
    ) ||
    voices.find(voice => voice.lang.startsWith('en-US')); // Fallback

  if (maleVoice) {
    utterance.voice = maleVoice;
  }

  // Adjust pitch and rate for a "storyteller" effect.
  utterance.pitch = 0.8; // Deeper voice.
  utterance.rate = 0.9; // Slightly slower, more deliberate pace.

  window.speechSynthesis.speak(utterance);
}


/**
 * Captures a frame from the webcam, sends it to Gemini, and streams the story.
 */
async function generateStory() {
  // 1. Set loading state and stop any currently playing story
  captureBtn.disabled = true;
  loader.classList.remove('hidden');
  storyContainer.innerHTML = '';
  window.speechSynthesis.cancel();

  try {
    // 2. Capture frame from video
    const context = canvasEl.getContext('2d');
    if (!context) throw new Error('Could not get canvas context');
    canvasEl.width = videoEl.videoWidth;
    canvasEl.height = videoEl.videoHeight;
    context.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);

    // 3. Convert frame to base64
    const dataUrl = canvasEl.toDataURL('image/jpeg');
    const base64Data = dataUrl.split(',')[1];

    // 4. Prepare request for Gemini
    const imagePart = {
      inlineData: {
        mimeType: 'image/jpeg',
        data: base64Data,
      },
    };

    const textPart = {
      text: "Look at this image and tell me a story about it. What's the secret story behind this scene?",
    };

    // 5. Call the Gemini API and stream the response
    const response = await ai.models.generateContentStream({
      model: 'gemini-2.5-flash',
      contents: { parts: [imagePart, textPart] },
      config: {
        systemInstruction: `You are a master storyteller for adults. Your stories are hilarious, lewd, witty, and often absurd. 
        You find the hidden, naughty humor in any situation. Do not be shy, but keep it clever. 
        Analyze the provided image and create a short, funny story inspired by what you see.`,
      },
    });

    let fullResponse = '';
    for await (const chunk of response) {
      const text = chunk.text;
      if (text) {
        fullResponse += text;
        storyContainer.innerHTML = await marked.parse(fullResponse);
      }
    }
    
    // Speak the story once it is complete
    if (fullResponse.trim()) {
      await speakStory(fullResponse);
    }
    
  } catch (err) {
    console.error('Error generating story:', err);
    storyContainer.innerHTML = `
      <p><strong>Oops!</strong> Something went wrong while generating the story.</p>
      <p>Please try again. Error: ${err instanceof Error ? err.message : String(err)}</p>
    `;
  } finally {
    // 6. Reset UI
    captureBtn.disabled = false;
    loader.classList.add('hidden');
  }
}

/**
 * Main function to initialize the app.
 */
async function main() {
  captureBtn.disabled = true;
  await initWebcam();
  captureBtn.addEventListener('click', generateStory);
}

main();