import { useEffect, useState } from "react";
import { Box, DialogContent, DialogTitle, IconButton, TextField, InputAdornment, FormGroup, FormControlLabel, Checkbox } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { DEFAULT_CHAT_DELAY_SECONDS } from "../config/site";
import { getChatDelayBounds } from "./chatDelayPreference";
import MobileDialog from "./MobileDialog";
import "./chat-viewer.css";

const { min: CHAT_DELAY_MIN, max: CHAT_DELAY_MAX } = getChatDelayBounds();

const parseChatDelay = (value) => {
  if (value === "" || value === "-" || value === "+") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(CHAT_DELAY_MIN, Math.min(CHAT_DELAY_MAX, Math.round(parsed)));
};

export default function Settings(props) {
  const { userChatDelay, setUserChatDelay, showModal, setShowModal, showTimestamp, setShowTimestamp } = props;
  const [chatDelayInput, setChatDelayInput] = useState(String(userChatDelay ?? 0));

  useEffect(() => {
    setChatDelayInput(String(userChatDelay ?? 0));
  }, [userChatDelay, showModal]);

  const delayChange = (evt) => {
    const value = evt.target.value;
    setChatDelayInput(value);
    const parsed = parseChatDelay(value);
    if (parsed === null) return;
    setUserChatDelay(parsed);
  };

  const commitDelayInput = () => {
    const parsed = parseChatDelay(chatDelayInput);
    if (parsed === null) {
      setChatDelayInput(String(userChatDelay ?? 0));
      return;
    }
    setChatDelayInput(String(parsed));
    setUserChatDelay(parsed);
  };

  return (
    <MobileDialog open={showModal} onClose={() => setShowModal(false)} fullWidth maxWidth="xs" aria-labelledby="playback-settings-title"
      PaperProps={{ className: "soft-chat-settings-paper", sx: { m: 2, width: "calc(100% - 32px)", maxHeight: "calc(100dvh - 32px)" } }}>
      <DialogTitle className="soft-chat-settings-title" id="playback-settings-title" sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, pl: 2.5, pr: 1, py: 1 }}>
        Playback settings
        <IconButton onClick={() => setShowModal(false)} aria-label="Close playback settings" sx={{ width: 44, height: 44 }}><CloseIcon /></IconButton>
      </DialogTitle>
      <DialogContent sx={{ px: 2.5, pb: 2.5 }}>
        <Box sx={{ display: "flex", flexDirection: "column", width: "100%" }}>
          <Box sx={{ mt: 1 }}>
            <TextField
              sx={{ "& input": { fontVariantNumeric: "tabular-nums", fontSize: 16, minHeight: 44, boxSizing: "border-box" } }}
              InputProps={{
                endAdornment: <InputAdornment position="start">secs</InputAdornment>,
              }}
              fullWidth
              label="Chat Delay"
              size="small"
              type="number"
              onBlur={commitDelayInput}
              onKeyDown={(evt) => {
                if (evt.key === "Enter") {
                  evt.preventDefault();
                  commitDelayInput();
                }
              }}
              onChange={delayChange}
              value={chatDelayInput}
              helperText={`Default is ${DEFAULT_CHAT_DELAY_SECONDS}s. Range ${CHAT_DELAY_MIN} to ${CHAT_DELAY_MAX}.`}
              inputProps={{
                inputMode: "numeric",
                pattern: "-?[0-9]*",
                step: 1,
                min: CHAT_DELAY_MIN,
                max: CHAT_DELAY_MAX,
              }}
              onFocus={(evt) => evt.target.select()}
            />
          </Box>
        </Box>

        <FormGroup className="soft-chat-settings-options" sx={{ mt: 2 }}>
          <FormControlLabel control={<Checkbox checked={showTimestamp} onChange={() => setShowTimestamp(!showTimestamp)} sx={{ width: 44, height: 44 }} />} label="Show timestamps" />
        </FormGroup>
      </DialogContent>
    </MobileDialog>
  );
}
