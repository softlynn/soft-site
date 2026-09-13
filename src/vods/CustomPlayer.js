import { useRef, useEffect, useState, useCallback } from "react";
import canAutoPlay from "can-autoplay";
import { Button, Box, Alert, Paper } from "@mui/material";
import VideoJS from "./VideoJS";
import "videojs-hotkeys";
import { toSeconds } from "../utils/helpers";
import { CDN_BASE as CDN_BASE_URL } from "../config/site";

const CDN_BASE = CDN_BASE_URL;

export default function Player(props) {
  const { playerRef, setCurrentTime, setPlaying, type, vod, timestamp, delay, setDelay } = props;
  const timeUpdateRef = useRef(null);
  const timeUpdateCallbackRef = useRef(null);
  const objectUrlRef = useRef(null);
  const lastSavedSecondRef = useRef(-1);
  const [source, setSource] = useState(undefined);
  const [fileError, setFileError] = useState(undefined);
  const videoJsOptions = {
    autoplay: true,
    controls: true,
    responsive: false,
    fluid: false,
    liveui: true,
    poster: vod.thumbnail_url,
  };

  // Save current position to localStorage
  const savePosition = useCallback(
    (player) => {
      if (!player || player.isDisposed()) return;
      const currentTime = player.currentTime();
      try { localStorage.setItem(`video-position-${vod.id}`, currentTime); } catch { /* Storage may be unavailable. */ }
    },
    [vod.id]
  );

  const clearPosition = () => {
    try { localStorage.removeItem(`video-position-${vod.id}`); } catch { /* Storage may be unavailable. */ }
  };

  const onReady = (player) => {
    playerRef.current = player;
    setPlaying({ playing: false, ready: true });

    player.hotkeys({
      alwaysCaptureHotkeys: true,
      volumeStep: 0.1,
      seekStep: 5,
      enableModifiersForNumbers: false,
      enableMute: true,
      enableFullscreen: true,
    });

    canAutoPlay.video().then(({ result }) => {
      if (!result && !player.isDisposed()) player.muted(true);
    });

    // Restore last position after metadata is loaded
    player.on("loadedmetadata", function () {
      // If a timestamp is provided, prefer it, else restore from localStorage
      if (timestamp) {
        player.currentTime(timestamp);
      } else {
        let savedPosition;
        try { savedPosition = localStorage.getItem(`video-position-${vod.id}`); } catch { /* Optional resume position. */ }
        if (savedPosition) {
          const position = parseFloat(savedPosition);
          if (!isNaN(position)) {
            player.currentTime(position);
          }
        }
      }
    });

    // Save position every 5 seconds
    player.on("timeupdate", () => {
      const second = Math.floor(player.currentTime());
      if (second % 5 === 0 && lastSavedSecondRef.current !== second) {
        lastSavedSecondRef.current = second;
        savePosition(player);
      }
    });

    player.on("play", () => {
      timeUpdate();
      loopTimeUpdate();
      setPlaying({ playing: true });
    });

    player.on("pause", () => {
      savePosition(player);
      clearTimeUpdate();
      setPlaying({ playing: false });
    });

    player.on("ended", () => {
      clearPosition();
      clearTimeUpdate();
      setPlaying({ playing: false });
    });

    player.on("error", () => {
      const error = player.error();
      if (error && error.code === 4 && type === "cdn") {
        setSource(`${CDN_BASE}/videos/${vod.id}.mp4`);
      }
    });

    if (type === "cdn") setSource(`${CDN_BASE}/videos/${vod.id}/${vod.id}.m3u8`);
  };

  const timeUpdate = () => {
    if (!playerRef.current || playerRef.current.isDisposed()) return;
    if (playerRef.current.paused()) return;
    let currentTime = 0;
    currentTime += playerRef.current.currentTime();
    currentTime += delay;
    setCurrentTime(currentTime);
  };
  timeUpdateCallbackRef.current = timeUpdate;

  const loopTimeUpdate = () => {
    if (timeUpdateRef.current !== null) clearTimeout(timeUpdateRef.current);
    timeUpdateRef.current = setTimeout(() => {
      timeUpdateCallbackRef.current?.();
      loopTimeUpdate();
    }, 1000);
  };

  const clearTimeUpdate = () => {
    if (timeUpdateRef.current !== null) clearTimeout(timeUpdateRef.current);
  };

  const fileChange = (evt) => {
    setFileError(false);
    const file = evt.target.files[0];
    if (!file) return;
    if (file.type.split("/")[0] !== "video") {
      return setFileError("It has to be a valid video file!");
    }

    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = URL.createObjectURL(file);
    setSource({ src: objectUrlRef.current, type: file.type });
  };

  useEffect(() => {
    if (!source || !playerRef.current) return;
    const player = playerRef.current;
    const updateDuration = () => {
      if (player.isDisposed()) return;
      const playerDuration = player.duration();
      if (!Number.isFinite(playerDuration) || playerDuration <= 0) return;
      const vodDuration = toSeconds(vod.duration);
      const tmpDelay = vodDuration - playerDuration < 0 ? 0 : vodDuration - playerDuration;
      setDelay(tmpDelay);
    };
    player.on("loadedmetadata", updateDuration);
    player.on("durationchange", updateDuration);
    player.src(source);
    return () => {
      if (!player.isDisposed()) {
        player.off("loadedmetadata", updateDuration);
        player.off("durationchange", updateDuration);
      }
    };
  }, [source, playerRef, vod, setDelay]);

  // On unmount, save position
  useEffect(() => {
    return () => {
      clearTimeout(timeUpdateRef.current);
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      if (playerRef.current) {
        savePosition(playerRef.current);
      }
      playerRef.current = null;
    };
  }, [vod.id, playerRef, savePosition]);

  return (
    <Box sx={{ height: "100%", width: "100%" }}>
      {type === "manual" && !source && (
        <Paper sx={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100%", flexDirection: "column" }}>
          {fileError && <Alert severity="error">{fileError}</Alert>}
          <Box sx={{ mt: 1 }}>
            <Button variant="contained" component="label">
              Select Video
              <input type="file" hidden onChange={fileChange} accept="video/*,.mkv" />
            </Button>
          </Box>
        </Paper>
      )}
      <Box style={{ visibility: !source ? "hidden" : "visible", height: "100%", width: "100%", outline: "none" }}>
        <VideoJS options={videoJsOptions} onReady={onReady} />
      </Box>
    </Box>
  );
}
