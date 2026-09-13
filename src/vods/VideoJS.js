import React, { useEffect } from "react";
import videojs from "video.js";
import "video.js/dist/video-js.css";

export const VideoJS = (props) => {
  const videoRef = React.useRef(null);
  const playerRef = React.useRef(null);
  const { options, onReady } = props;

  useEffect(() => {
    if (!playerRef.current) {
      if (!videoRef.current) return;

      const videoElement = document.createElement("video-js");
      videoElement.setAttribute("playsinline", "");
      videoElement.style.width = "100%";
      videoElement.style.height = "100%";
      videoRef.current.appendChild(videoElement);
      const player = (playerRef.current = videojs(videoElement, options, () => {
        onReady && onReady(player);
      }));
    }
  }, [options, videoRef, onReady]);

  useEffect(() => () => {
    if (playerRef.current && !playerRef.current.isDisposed()) playerRef.current.dispose();
    playerRef.current = null;
  }, []);

  return (
    <div data-vjs-player style={{ width: "100%", height: "100%", lineHeight: 0, background: "transparent" }}>
      <div ref={videoRef} style={{ height: "100%", width: "100%" }} />
    </div>
  );
};

export default VideoJS;
