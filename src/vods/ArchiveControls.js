import { useEffect, useRef, useState } from "react";
import { Box, Button, Collapse, Typography, FormControl, InputLabel, Select, MenuItem, TextField, InputAdornment, Stack, useMediaQuery } from "@mui/material";
import { DatePicker } from "@mui/x-date-pickers/DatePicker";
import { LocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import dayjs from "dayjs";
import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import { START_DATE } from "../config/site";
import "./archive-polish.css";

export default function ArchiveControls(props) {
  const {
    filter,
    changeFilter,
    filters,
    totalVods,
    filterStartDate,
    filterEndDate,
    setFilterStartDate,
    setFilterEndDate,
    handleTitleChange,
    filterTitle,
    handleGameChange,
    filterGame,
    onResetFilters,
  } = props;
  const compact = useMediaQuery("(max-width: 899px)");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const searchInputRef = useRef(null);

  useEffect(() => {
    const focusSearch = (event) => {
      if (event.key?.toLowerCase() !== "k" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.repeat || event.isComposing || event.defaultPrevented) return;
      const editing = (node) => node && (
        /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName || "") || node.isContentEditable ||
        node.closest?.('[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]')
      );
      if (editing(event.target) || editing(document.activeElement)) return;
      const overlayOpen = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"], dialog[open]'))
        .some((node) => node.getClientRects().length > 0 && !node.closest('[aria-hidden="true"]'));
      if (overlayOpen || !searchInputRef.current) return;
      event.preventDefault();
      searchInputRef.current.focus();
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, []);

  const handleFilterChange = (event) => {
    if (event.target.value === "Default") {
      onResetFilters();
      return;
    }
    changeFilter(event);
  };

  const filterSelect = (
    <FormControl size="small" sx={{ minWidth: 130, width: "100%" }}>
      <InputLabel id="filter-select-label">Filter</InputLabel>
      <Select labelId="filter-select-label" label="Filter" value={filter} onChange={handleFilterChange}
        MenuProps={{ slotProps: { paper: { className: "soft-archive-menu" } } }}>
        {filters.map((value) => <MenuItem key={value} value={value} sx={{ minHeight: 44 }}>{value === "Default" ? "All streams" : value}</MenuItem>)}
      </Select>
    </FormControl>
  );

  const datePickerSlots = {
    textField: { size: "small", fullWidth: true },
    mobilePaper: { className: "soft-archive-date-paper", sx: { backgroundColor: (theme) => theme.palette.mode === "dark" ? "#211b20" : "#fff9f1" } },
    desktopPaper: { className: "soft-archive-date-paper" },
  };

  const dateFields = (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
        <DatePicker
          orientation={compact ? "portrait" : undefined}
          minDate={dayjs(START_DATE)} maxDate={dayjs()} label="Start Date" value={filterStartDate}
          onAccept={(newDate) => setFilterStartDate(newDate)} views={["year", "month", "day"]}
          slotProps={datePickerSlots}
        />
        <DatePicker
          orientation={compact ? "portrait" : undefined}
          minDate={dayjs(START_DATE)} maxDate={dayjs()} label="End Date" value={filterEndDate}
          onAccept={(newDate) => setFilterEndDate(newDate)} views={["year", "month", "day"]}
          slotProps={datePickerSlots}
        />
      </Stack>
    </LocalizationProvider>
  );

  const searchField = (
    <TextField
      className="soft-archive-search" inputRef={searchInputRef}
      size="small" fullWidth label="Search titles" type="search" value={["Default", "Title"].includes(filter) ? filterTitle : ""}
      inputProps={{ "aria-keyshortcuts": "Control+k Meta+k" }}
      InputProps={{
        startAdornment: <InputAdornment position="start"><SearchRoundedIcon fontSize="small" /></InputAdornment>,
        endAdornment: !compact && <InputAdornment position="end"><Box component="kbd" className="soft-archive-shortcut" title="Control or Command + K" aria-hidden>Ctrl/⌘ K</Box></InputAdornment>,
      }}
      onChange={(event) => {
        if (filter !== "Title") changeFilter({ target: { value: "Title" } });
        handleTitleChange(event);
      }}
    />
  );

  const activeFilter = filter === "Date"
    ? filterStartDate?.isValid() && filterEndDate?.isValid()
      ? `${filterStartDate.format("MMM D, YYYY")} – ${filterEndDate.format("MMM D, YYYY")}` : "Date range"
    : filter === "Game" && filterGame.trim() ? `Game: ${filterGame}`
      : filter === "Title" && filterTitle.trim() ? `Title: ${filterTitle}` : "";
  const resultSummary = totalVods === null ? "Loading archive…"
    : totalVods === 0 ? "No streams found"
      : `${totalVods.toLocaleString()} stream${totalVods === 1 ? "" : "s"}${activeFilter ? " found" : " in the archive"}`;

  return (
    <Box className="soft-archive-controls">
      <Box className="soft-archive-heading">
        <Box sx={{ minWidth: 0 }}>
          <Typography component="h1" variant="h5" className="soft-section-heading soft-archive-title">
            VOD archive
          </Typography>
          <Typography variant="body2" className="soft-archive-description">
            Find a stream by title, game, or date.
          </Typography>
        </Box>
      </Box>

      <Box className="soft-archive-search-row">
        {searchField}
        {compact ? (
            <Button
              aria-expanded={filtersOpen} aria-controls="soft-archive-filters"
              onClick={() => setFiltersOpen((open) => !open)}
              className="soft-archive-filter-toggle"
              variant={filtersOpen || ["Game", "Date"].includes(filter) ? "contained" : "outlined"}
              startIcon={<TuneRoundedIcon />}
            >Filters</Button>
        ) : filterSelect}
      </Box>
      {compact && <Collapse in={filtersOpen}><Box id="soft-archive-filters" sx={{ pt: 1.5 }}>{filterSelect}</Box></Collapse>}
      {filter === "Date" && <Box className="soft-archive-extra-fields">{dateFields}</Box>}
      {filter === "Game" && <Box className="soft-archive-extra-fields"><TextField size="small" fullWidth label="Search by game" type="search" value={filterGame} onChange={handleGameChange} /></Box>}
      <Box className="soft-archive-results-summary">
        <Typography variant="body2" role="status" aria-live="polite">{resultSummary}</Typography>
        {activeFilter && <Box className="soft-archive-active-filter">
          <Typography variant="body2" noWrap title={activeFilter}>{activeFilter}</Typography>
          <Button onClick={onResetFilters} size="small">Clear filters</Button>
        </Box>}
      </Box>
    </Box>
  );
}
