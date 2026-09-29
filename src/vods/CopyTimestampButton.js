import { useState } from "react";
import { Box, Button, DialogActions, DialogContent, DialogTitle, IconButton, Snackbar, TextField, Tooltip } from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import MobileDialog from "./MobileDialog";

export default function CopyTimestampButton({ url, disabled = false }) {
  const [copied, setCopied] = useState(false);
  const [manualUrl, setManualUrl] = useState("");
  const copy = async () => {
    if (!url || disabled) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setManualUrl(url);
    }
  };
  return (
    <>
      <Tooltip title="Copy current timestamp">
        <span style={{ display: "inline-flex" }}>
          <IconButton onClick={copy} disabled={disabled} color="primary" aria-label="Copy current timestamp">
            <ContentCopyIcon />
          </IconButton>
        </span>
      </Tooltip>
      {/* The default SnackbarContent cannot calculate colors from our CSS-variable palette. */}
      <Snackbar open={copied} autoHideDuration={2500} onClose={() => setCopied(false)}>
        <Box role="status" sx={{ px: 2, py: 1.5, borderRadius: 2, color: "var(--soft-text-primary)", background: "var(--soft-surface-strong)", border: "1px solid var(--soft-border)", boxShadow: "0 8px 24px rgba(0,0,0,0.18)", fontSize: 14 }}>
          Timestamp copied
        </Box>
      </Snackbar>
      <MobileDialog open={Boolean(manualUrl)} onClose={() => setManualUrl("")} fullWidth maxWidth="xs" aria-labelledby="copy-timestamp-title"
        PaperProps={{ sx: { m: 2, width: "calc(100% - 32px)", maxHeight: "calc(100dvh - 32px)" } }}>
        <DialogTitle id="copy-timestamp-title">Copy timestamp</DialogTitle>
        <DialogContent>
          <TextField autoFocus fullWidth label="Timestamp link" value={manualUrl} margin="dense"
            onFocus={(event) => event.target.select()} InputProps={{ readOnly: true }} sx={{ "& input": { fontSize: 16 } }}
            helperText="Select and copy this link." />
        </DialogContent>
        <DialogActions><Button onClick={() => setManualUrl("")} sx={{ minHeight: 44 }}>Done</Button></DialogActions>
      </MobileDialog>
    </>
  );
}
