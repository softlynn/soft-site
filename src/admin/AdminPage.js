import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Box, Button, CircularProgress, FormControlLabel, MenuItem, Select, Stack, Switch, Typography } from "@mui/material";
import SimpleBar from "simplebar-react";
import Footer from "../utils/Footer";
import {
  clearAdminToken,
  getAdminVods,
  promptAndLoginAdmin,
  setVodChatReplay,
  setVodNotice,
  unpublishVod,
  verifyAdminSession,
} from "../api/adminApi";

const SORT_DESC = (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();

export default function AdminPage() {
  const [ready, setReady] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [loading, setLoading] = useState(false);
  const [vods, setVods] = useState([]);
  const [selectedVodId, setSelectedVodId] = useState("");
  const [noticeEnabled, setNoticeEnabled] = useState(false);
  const [chatReplayAvailable, setChatReplayAvailable] = useState(true);
  const [message, setMessage] = useState({ type: "info", text: "Admin panel is locked." });

  const selectedVod = useMemo(() => {
    if (!selectedVodId) return null;
    return vods.find((vod) => String(vod.id) === String(selectedVodId)) || null;
  }, [selectedVodId, vods]);

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
    const init = async () => {
      const valid = await verifyAdminSession();
      setAuthorized(valid);
      if (valid) {
        try {
          await hydrateVods();
          setMessage({ type: "success", text: "Admin panel unlocked." });
        } catch (error) {
          setMessage({ type: "error", text: error.message });
        }
      }
      setReady(true);
    };
    init();
  }, [hydrateVods]);

  useEffect(() => {
    syncFlagsFromVod(selectedVod);
  }, [selectedVodId, selectedVod]);

  const handleUnlock = async () => {
    setLoading(true);
    try {
      const didLogin = await promptAndLoginAdmin();
      if (!didLogin) {
        setMessage({ type: "info", text: "Admin login canceled." });
        return;
      }
      setAuthorized(true);
      await hydrateVods();
      setMessage({ type: "success", text: "Admin panel unlocked." });
    } catch (error) {
      setAuthorized(false);
      setMessage({ type: "error", text: error.message });
    } finally {
      setLoading(false);
    }
  };

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
      await setVodNotice(selectedVod.id, noticeEnabled);
      await setVodChatReplay(selectedVod.id, chatReplayAvailable);
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
      `Unpublish VOD ${selectedVod.id} on YouTube and Twitch?\n\nThis also hides it on the archive site.`
    );
    if (!accepted) return;

    setLoading(true);
    try {
      const payload = await unpublishVod(selectedVod.id);
      await hydrateVods();
      const youtubeCount = Array.isArray(payload?.result?.youtube) ? payload.result.youtube.length : 0;
      setMessage({
        type: "success",
        text: `Unpublished ${selectedVod.id}. YouTube parts affected: ${youtubeCount}.`,
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
          Hidden controls for VOD unpublish and manual notice flags. This panel talks to your local admin bridge.
        </Typography>

        <Alert severity={message.type} sx={{ mb: 2 }}>
          {message.text}
        </Alert>

        <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
          {!authorized ? (
            <Button variant="contained" onClick={handleUnlock} disabled={loading}>
              Unlock Admin
            </Button>
          ) : (
            <>
              <Button variant="outlined" onClick={handleRefresh} disabled={loading}>
                Refresh
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
              <Button variant="contained" color="error" onClick={handleUnpublish} disabled={loading || !selectedVod || selectedVod.unpublished}>
                Unpublish on Twitch + YouTube
              </Button>
            </Stack>
          </Box>
        )}
      </Box>
      <Footer />
    </SimpleBar>
  );
}
