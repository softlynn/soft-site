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

      const player = (playerRef.current = videojs(videoRef.current, options, () => {
        onReady && onReady(player);
      }));
    }
  }, [options, videoRef, onReady]);

  return (
    <div data-vjs-player style={{ width: "100%", height: "100%", lineHeight: 0, background: "transparent" }}>
      <video ref={videoRef} autoPlay playsInline className="video-js" style={{ height: "100%", width: "100%" }} />
    </div>
  );
};

export default VideoJS;
