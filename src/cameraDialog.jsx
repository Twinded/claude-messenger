/**
 * Camera capture dialog. Streams getUserMedia({video:true}) into a
 * preview <video>, lets the user freeze a frame onto a hidden <canvas>
 * and returns the captured frame as a base64 PNG data URL the composer
 * can attach as an image content block.
 */

import { useEffect, useRef, useState } from "react";

export function CameraDialog({ onCapture, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [stream, setStream] = useState(null);
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState("");

  useEffect(() => {
    let cancelled = false;
    let activeStream = null;
    async function open() {
      try {
        activeStream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480 },
          audio: false
        });
        if (cancelled) {
          activeStream.getTracks().forEach((track) => track.stop());
          return;
        }
        setStream(activeStream);
        if (videoRef.current) {
          videoRef.current.srcObject = activeStream;
          await videoRef.current.play().catch(() => {});
        }
      } catch (err) {
        setError(err?.message || String(err));
      }
    }
    void open();
    return () => {
      cancelled = true;
      if (activeStream) activeStream.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function snap() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const width = video.videoWidth || 640;
    const height = video.videoHeight || 480;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, width, height);
    setSnapshot(canvas.toDataURL("image/png"));
  }

  function confirm() {
    if (!snapshot) return;
    onCapture?.(snapshot);
    onClose?.();
  }

  function retake() {
    setSnapshot("");
  }

  function handleClose() {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    onClose?.();
  }

  return (
    <div className="settings-dialog-backdrop">
      <div className="settings-dialog camera-dialog">
        <header className="agent-editor-head">
          <h2>Capture caméra</h2>
          <button type="button" onClick={handleClose}>Fermer</button>
        </header>

        {error ? (
          <p className="agent-error">Caméra indisponible : {error}</p>
        ) : null}

        <div className="camera-preview">
          {snapshot ? (
            <img src={snapshot} alt="Capture" />
          ) : (
            <video ref={videoRef} autoPlay muted playsInline />
          )}
          <canvas ref={canvasRef} style={{ display: "none" }} />
        </div>

        <div className="agent-editor-actions">
          {snapshot ? (
            <>
              <button type="button" onClick={confirm} className="msn-signin-button">
                Utiliser cette image
              </button>
              <button type="button" onClick={retake}>Reprendre</button>
            </>
          ) : (
            <button type="button" onClick={snap} className="msn-signin-button" disabled={!stream}>
              📷 Capturer
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default CameraDialog;
