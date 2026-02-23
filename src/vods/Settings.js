import { useEffect, useState } from "react";
import { Box, Modal, Typography, TextField, InputAdornment, FormGroup, FormControlLabel, Checkbox } from "@mui/material";

const CHAT_DELAY_MIN = -600;
const CHAT_DELAY_MAX = 600;

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
    <Modal open={showModal} onClose={() => setShowModal(false)}>
      <Box sx={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 350, bgcolor: "background.paper", border: "2px solid #000", boxShadow: 24, p: 4 }}>
        <Box sx={{ mt: 2, display: "flex", flexDirection: "column", width: "100%" }}>
          <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center" }}>
            <Typography variant="h6">Playback Settings</Typography>
          </Box>
          <Box sx={{ mt: 2 }}>
            <TextField
              sx={{ "& input": { fontVariantNumeric: "tabular-nums" } }}
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
              helperText={`Default is 7s. Range ${CHAT_DELAY_MIN} to ${CHAT_DELAY_MAX}.`}
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

        <FormGroup sx={{ mt: 2 }}>
          <FormControlLabel control={<Checkbox checked={showTimestamp} onChange={() => setShowTimestamp(!showTimestamp)} />} label="Show Timestamps" />
        </FormGroup>
      </Box>
    </Modal>
  );
}
