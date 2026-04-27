/**
 * Tiny wrapper around MediaRecorder + the WebKit SpeechRecognition API.
 *
 * Records microphone audio and, when supported, transcribes the speech
 * locally so the result can be sent to Claude as text. Returning the raw
 * audio blob is also supported for callers that want to attach the
 * recording as a downloadable file.
 *
 * Implementation runs entirely in the renderer; no audio leaves the
 * machine unless the caller explicitly attaches the blob.
 */

export function createVoiceRecorder() {
  let mediaRecorder = null;
  let chunks = [];
  let stream = null;
  let recognition = null;
  let transcript = "";

  async function start({ onTranscript } = {}) {
    if (mediaRecorder && mediaRecorder.state === "recording") return;
    transcript = "";
    chunks = [];

    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    mediaRecorder.start();

    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (SR) {
      try {
        recognition = new SR();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = navigator.language || "fr-FR";
        recognition.onresult = (event) => {
          let final = "";
          let interim = "";
          for (let i = event.resultIndex; i < event.results.length; i += 1) {
            const result = event.results[i];
            if (result.isFinal) final += result[0].transcript;
            else interim += result[0].transcript;
          }
          if (final) transcript += final;
          if (typeof onTranscript === "function") {
            onTranscript({ final: transcript, interim });
          }
        };
        recognition.onerror = () => {};
        recognition.start();
      } catch {
        recognition = null;
      }
    }
  }

  async function stop() {
    if (recognition) {
      try { recognition.stop(); } catch { /* noop */ }
      recognition = null;
    }
    if (!mediaRecorder) return { transcript: "", blob: null, dataUrl: "" };

    return new Promise((resolve) => {
      mediaRecorder.onstop = async () => {
        const mime = mediaRecorder.mimeType || "audio/webm";
        const blob = new Blob(chunks, { type: mime });
        const dataUrl = await new Promise((resolveData) => {
          const reader = new FileReader();
          reader.onloadend = () => resolveData(reader.result || "");
          reader.readAsDataURL(blob);
        });
        chunks = [];
        if (stream) {
          stream.getTracks().forEach((track) => track.stop());
          stream = null;
        }
        const finalTranscript = transcript;
        mediaRecorder = null;
        transcript = "";
        resolve({ transcript: finalTranscript.trim(), blob, dataUrl });
      };
      mediaRecorder.stop();
    });
  }

  function isRecording() {
    return Boolean(mediaRecorder && mediaRecorder.state === "recording");
  }

  return { start, stop, isRecording };
}
