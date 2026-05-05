import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, Button, CircularProgress, FormControl, FormControlLabel, InputLabel, MenuItem, Select, Stack, Switch, Typography } from "@mui/material";
import { Link as RouterLink } from "react-router-dom";
import SimpleBar from "simplebar-react";
import Footer from "../utils/Footer";
import {
  authenticateAdmin,
  consumePendingAdminPassword,
  clearAdminToken,
  getAdminVods,
  getAdminToken,
  primeAdminWake,
  promptAndLoginAdmin,
  republishVodPart,
  republishVod,
  setVodFlags,
  unpublishVodPart,
  unpublishVod,
  verifyAdminSession,
} from "../api/adminApi";

const SORT_DESC = (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
const INIT_TIMEOUT_MS = 8000;
const withTimeout = async (promise, label) => {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out. Please click Unlock Admin.`));
        }, INIT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const normalizePartNumber = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
};

export default function AdminPage() {
  const [ready, setReady] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [loading, setLoading] = useState(false);
  const [vods, setVods] = useState([]);
  const [selectedVodId, setSelectedVodId] = useState("");
  const [selectedVodPartId, setSelectedVodPartId] = useState("");
  const [noticeEnabled, setNoticeEnabled] = useState(false);
  const [chatReplayAvailable, setChatReplayAvailable] = useState(true);
  const [message, setMessage] = useState({ type: "info", text: "Admin panel is locked." });
  const userUnlockInProgressRef = useRef(false);

  const selectedVod = useMemo(() => {
    if (!selectedVodId) return null;
    return vods.find((vod) => String(vod.id) === String(selectedVodId)) || null;
  }, [selectedVodId, vods]);

  const selectedVodParts = useMemo(() => {
    if (!selectedVod || !Array.isArray(selectedVod.youtube)) return [];
    return selectedVod.youtube
      .filter((entry) => String(entry?.type || "vod") === "vod" && entry?.id)
      .map((entry, index) => ({
        ...entry,
        backendOrder: normalizePartNumber(entry?.adminOrder, index + 1),
        storedPartNumber: normalizePartNumber(entry?.part, index + 1),
        isUnpublished: entry?.unpublished === true,
      }))
      .sort((a, b) => {
        if (a.backendOrder !== b.backendOrder) return a.backendOrder - b.backendOrder;
        return String(a.id).localeCompare(String(b.id));
      })
      .map((entry, index, list) => {
        const publishedPartNumber =
          entry.isUnpublished === true ? null : list.slice(0, index + 1).filter((part) => part.isUnpublished !== true).length;
        return {
          ...entry,
          partNumber: publishedPartNumber,
        };
      });
  }, [selectedVod]);

  const selectedVodPart = useMemo(() => {
    if (!selectedVodPartId) return null;
    return selectedVodParts.find((entry) => String(entry.id) === String(selectedVodPartId)) || null;
  }, [selectedVodPartId, selectedVodParts]);

  const publishedSelectedVodPartCount = useMemo(
    () => selectedVodParts.filter((part) => part.isUnpublished !== true).length,
    [selectedVodParts]
  );

  const syncFlagsFromVod = (vod) => {
    if (!vod) return;
    setNoticeEnabled(Boolean(vod.vodNotice));
    setChatReplayAvailable(vod.chatReplayAvailable !== false);
  };

  const hydrateVods = useCallback(async () => {
    const payload = await getAdminVods();
    const nextVods = Array.isArray(payload?.vods) ? [...payload.vods].sort(SORT_DESC) : [];
    setVods(nextVods);

    const nextSelected = selectedVodId && nextVods.some((vod) => String(vod.id) === String(selectedVodId)) ? selectedVodId : nextVods[0]?.id || "";
    setSelectedVodId(nextSelected);

    const matched = nextVods.find((vod) => String(vod.id) === String(nextSelected)) || null;
    syncFlagsFromVod(matched);
  }, [selectedVodId]);

  useEffect(() => {
    let active = true;
    const init = async () => {
      try {
        const pendingPassword = consumePendingAdminPassword();
        const existingToken = getAdminToken();
        let isAuthorized = false;

        if (pendingPassword) {
          try {
            await withTimeout(authenticateAdmin(pendingPassword), "Admin login");
            isAuthorized = true;
          } catch (error) {
            if (!active || userUnlockInProgressRef.current) return;
            setMessage({ type: "error", text: error.message });
          }
        } else if (existingToken) {
          const valid = await withTimeout(verifyAdminSession(), "Admin session check");
          isAuthorized = valid;
        }

        if (userUnlockInProgressRef.current || !active) return;

        setAuthorized(isAuthorized);
        if (isAuthorized) {
          try {
            await withTimeout(hydrateVods(), "Admin VOD sync");
            if (!active || userUnlockInProgressRef.current) return;
            setMessage({ type: "success", text: "Admin panel unlocked." });
          } catch (error) {
            if (!active || userUnlockInProgressRef.current) return;
            setMessage({ type: "error", text: error.message });
          }
        }
      } catch (error) {
        if (!active || userUnlockInProgressRef.current) return;
        setAuthorized(false);
        setMessage({ type: "error", text: error.message });
      } finally {
        if (!active) return;
        setReady(true);
      }
    };
    init();
    return () => {
      active = false;
    };
  }, [hydrateVods]);

  useEffect(() => {
    syncFlagsFromVod(selectedVod);
  }, [selectedVodId, selectedVod]);

  useEffect(() => {
    if (selectedVodParts.length === 0) {
      setSelectedVodPartId("");
      return;
    }
    const hasCurrent = selectedVodParts.some((entry) => String(entry.id) === String(selectedVodPartId));
    if (!hasCurrent) {
      setSelectedVodPartId(String(selectedVodParts[0].id));
    }
  }, [selectedVodPartId, selectedVodParts]);

  const handleUnlock = useCallback(async () => {
    userUnlockInProgressRef.current = true;
    setLoading(true);
    try {
      const didLogin = await promptAndLoginAdmin();
      if (!didLogin) {
        setMessage({ type: "info", text: "Admin login canceled." });
        return;
      }
      setAuthorized(true);
      await withTimeout(hydrateVods(), "Admin VOD sync");
      setMessage({ type: "success", text: "Admin panel unlocked." });
    } catch (error) {
      setAuthorized(false);
      setMessage({ type: "error", text: error.message });
    } finally {
      userUnlockInProgressRef.current = false;
      setLoading(false);
      setReady(true);
    }
  }, [hydrateVods]);

  const handleLock = () => {
    clearAdminToken();
    setAuthorized(false);
    setMessage({ type: "info", text: "Admin panel locked." });
  };

  const handleRefresh = async () => {
    setLoading(true);
    try {
      await hydrateVods();
      setMessage({ type: "success", text: "VOD data refreshed." });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleSaveFlags = async () => {
    if (!selectedVod) return;

    setLoading(true);
    try {
      await setVodFlags(selectedVod.id, { noticeEnabled, chatReplayAvailable });
      await hydrateVods();
      setMessage({ type: "success", text: `Updated VOD ${selectedVod.id}.` });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleUnpublish = async () => {
    if (!selectedVod) return;

    const accepted = window.confirm(
      `Unpublish VOD ${selectedVod.id} on YouTube and archive?\n\nTwitch VOD will be kept (no delete).`
    );
    if (!accepted) return;

    setLoading(true);
    try {
      const payload = await unpublishVod(selectedVod.id);
      await hydrateVods();
      const youtubeCount = Array.isArray(payload?.result?.youtube) ? payload.result.youtube.length : 0;
      const twitchReason = payload?.result?.twitch?.reason ? ` ${payload.result.twitch.reason}` : "";
      setMessage({
        type: "success",
        text: `Unpublished ${selectedVod.id}. YouTube parts affected: ${youtubeCount}.${twitchReason}`,
      });
    } catch (error) {
      if (error?.code === "TWITCH_AUTH_REQUIRED" && error?.authUrl) {
        try {
          window.open(error.authUrl, "_blank", "noopener,noreferrer");
        } catch {
          // no-op
        }
        const codeHint = error?.userCode ? ` Use code ${error.userCode} if prompted.` : "";
        setMessage({
          type: "warning",
          text: `Twitch authorization is required.${codeHint} If no browser tab opened, open this URL manually: ${error.authUrl}`,
        });
        return;
      }
      setMessage({ type: "error", text: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleUnpublishPart = async () => {
    if (!selectedVod || !selectedVodPart) return;
    if (selectedVodPart.isUnpublished) {
      setMessage({ type: "warning", text: "Selected part is already unpublished. Use Republish Selected Part." });
      return;
    }
    if (publishedSelectedVodPartCount <= 1) {
      setMessage({ type: "warning", text: "This VOD only has one part. You cannot unpublish a single part." });
      return;
    }
    const publishedPartNumber = selectedVodPart.partNumber;
    if (!publishedPartNumber) {
      setMessage({ type: "error", text: "Could not resolve the current published part number." });
      return;
    }

    const accepted = window.confirm(
      `Unpublish VOD ${selectedVod.id} part ${publishedPartNumber} (${selectedVodPart.id}) on YouTube and hide it from the VOD site?\n\nRemaining published parts will be renumbered to stay contiguous.`
    );
    if (!accepted) return;

    setLoading(true);
    try {
      const payload = await unpublishVodPart(selectedVod.id, publishedPartNumber);
      await hydrateVods();
      const remainingCount = Array.isArray(payload?.result?.remainingParts) ? payload.result.remainingParts.length : 0;
      setMessage({
        type: "success",
        text: `Unpublished VOD ${selectedVod.id} part ${publishedPartNumber} on YouTube and VOD site. Remaining published parts: ${remainingCount}.`,
      });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleRepublishPart = async () => {
    if (!selectedVod || !selectedVodPart) return;
    if (!selectedVodPart.isUnpublished) {
      setMessage({ type: "warning", text: "Selected part is already published." });
      return;
    }

    const accepted = window.confirm(
      `Republish VOD ${selectedVod.id} part ${selectedVodPart.id} on YouTube and restore it on the VOD site?`
    );
    if (!accepted) return;

    setLoading(true);
    try {
      const payload = await republishVodPart(selectedVod.id, selectedVodPart.id);
      await hydrateVods();
      const republishedPartNumber = payload?.result?.republishedPart ? ` as part ${payload.result.republishedPart}` : "";
      setMessage({
        type: "success",
        text: `Republished part ${selectedVodPart.id}${republishedPartNumber} on YouTube and VOD site.`,
      });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleRepublish = async () => {
    if (!selectedVod) return;

    const accepted = window.confirm(
      `Republish VOD ${selectedVod.id} on YouTube and make it visible on the archive site?`
    );
    if (!accepted) return;

    setLoading(true);
    try {
      const payload = await republishVod(selectedVod.id);
      await hydrateVods();
      const youtubeResults = Array.isArray(payload?.result?.youtube) ? payload.result.youtube : [];
      const youtubeChanged = youtubeResults.filter((entry) => entry?.changed).length;
      const twitchReason = payload?.result?.twitch?.reason ? ` Twitch: ${payload.result.twitch.reason}` : "";
      const twitchRepublished = payload?.result?.twitch?.republished !== false;
      setMessage({
        type: twitchRepublished ? "success" : "warning",
        text: `Republished ${selectedVod.id}. YouTube parts changed: ${youtubeChanged}/${youtubeResults.length}.${twitchReason}`,
      });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setLoading(false);
    }
  };

  if (!ready) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <SimpleBar style={{ minHeight: 0, height: "100%" }}>
      <Box sx={{ p: 3, maxWidth: "900px", margin: "0 auto" }}>
        <Typography variant="h4" sx={{ mb: 1 }}>
          Admin
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Hidden controls for VOD publish state and manual notice flags. This panel talks to your local admin bridge.
        </Typography>

        <Alert severity={message.type} sx={{ mb: 2 }}>
          {message.text}
        </Alert>

        <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
          {!authorized ? (
            <Button variant="contained" onMouseDown={primeAdminWake} onTouchStart={primeAdminWake} onClick={handleUnlock} disabled={loading}>
              Unlock Admin
            </Button>
          ) : (
            <>
              <Button variant="outlined" onClick={handleRefresh} disabled={loading}>
                Refresh
              </Button>
              <Button component={RouterLink} to="/admin/design" variant="contained" disabled={loading}>
                Design Editor
              </Button>
              <Button variant="outlined" color="warning" onClick={handleLock} disabled={loading}>
                Lock
              </Button>
            </>
          )}
        </Stack>

        {authorized && (
          <Box sx={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 2, p: 2 }}>
            <Typography variant="h6" sx={{ mb: 2 }}>
              VOD Controls
            </Typography>

            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Select VOD
            </Typography>
            <Select
              fullWidth
              value={selectedVodId}
              onChange={(event) => setSelectedVodId(event.target.value)}
              sx={{ mb: 2 }}
            >
              {vods.map((vod) => (
                <MenuItem key={vod.id} value={vod.id}>
                  {`${vod.id} - ${vod.title}${vod.unpublished ? " (unpublished)" : ""}`}
                </MenuItem>
              ))}
            </Select>

            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              YouTube Parts (published + unpublished)
            </Typography>
            <FormControl fullWidth size="small" sx={{ mb: 0.5 }}>
              <InputLabel id="admin-vod-part-label">Part</InputLabel>
              <Select
                labelId="admin-vod-part-label"
                label="Part"
                value={selectedVodPartId}
                onChange={(event) => setSelectedVodPartId(event.target.value)}
                disabled={loading || !selectedVod || selectedVod.unpublished || selectedVodParts.length === 0}
              >
                {selectedVodParts.map((part) => (
                  <MenuItem key={part.id} value={String(part.id)}>
                    {part.isUnpublished
                      ? `Unpublished (backend #${part.backendOrder}, last part ${part.storedPartNumber}) - ${part.id}`
                      : `Part ${part.partNumber} (backend #${part.backendOrder}) - ${part.id}`}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
              {publishedSelectedVodPartCount > 1
                ? "Unpublishing a selected published part hides it on the VOD site and renumbers remaining published parts."
                : "Need at least 2 published parts to unpublish a single part."}
            </Typography>

            <FormControlLabel
              control={<Switch checked={noticeEnabled} onChange={(event) => setNoticeEnabled(event.target.checked)} />}
              label="Show Spotify muted notice on this VOD"
            />
            <FormControlLabel
              control={<Switch checked={chatReplayAvailable} onChange={(event) => setChatReplayAvailable(event.target.checked)} />}
              label="Chat replay available on this VOD"
            />

            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              <Button variant="contained" onClick={handleSaveFlags} disabled={loading || !selectedVod}>
                Save VOD Flags
              </Button>
              <Button
                variant="outlined"
                color="error"
                onClick={handleUnpublishPart}
                disabled={
                  loading ||
                  !selectedVod ||
                  selectedVod.unpublished ||
                  !selectedVodPart ||
                  selectedVodPart.isUnpublished ||
                  publishedSelectedVodPartCount <= 1
                }
              >
                Unpublish Selected Part
              </Button>
              <Button
                variant="outlined"
                color="success"
                onClick={handleRepublishPart}
                disabled={loading || !selectedVod || selectedVod.unpublished || !selectedVodPart || !selectedVodPart.isUnpublished}
              >
                Republish Selected Part
              </Button>
              <Button variant="contained" color="error" onClick={handleUnpublish} disabled={loading || !selectedVod || selectedVod.unpublished}>
                Unpublish (Keep Twitch VOD)
              </Button>
              <Button variant="contained" color="success" onClick={handleRepublish} disabled={loading || !selectedVod || !selectedVod.unpublished}>
                Republish (YouTube + Archive)
              </Button>
            </Stack>
          </Box>
        )}
      </Box>
      <Footer />
    </SimpleBar>
  );
}
