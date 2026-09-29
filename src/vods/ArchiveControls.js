import { useState } from "react";
import { Box, Button, Collapse, Typography, FormControl, InputLabel, Select, MenuItem, TextField, Chip, Stack, useMediaQuery } from "@mui/material";
import { DatePicker } from "@mui/x-date-pickers/DatePicker";
import { LocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import dayjs from "dayjs";
import VideoLibraryRoundedIcon from "@mui/icons-material/VideoLibraryRounded";
import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import { START_DATE } from "../config/site";

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
  } = props;
  const compact = useMediaQuery("(max-width: 899px)");
  const [filtersOpen, setFiltersOpen] = useState(false);

  const handleFilterChange = (event) => {
    if (event.target.value === "Default") {
      handleTitleChange({ target: { value: "" } });
      handleGameChange({ target: { value: "" } });
    }
    changeFilter(event);
  };

  const filterSelect = (
    <FormControl size="small" sx={{ minWidth: 130, width: "100%" }}>
      <InputLabel id="filter-select-label">Filter</InputLabel>
      <Select labelId="filter-select-label" label="Filter" value={filter} onChange={handleFilterChange}>
        {filters.map((value) => <MenuItem key={value} value={value} sx={{ minHeight: 44 }}>{value}</MenuItem>)}
      </Select>
    </FormControl>
  );

  const datePickerSlots = {
    textField: { size: "small", fullWidth: true },
    mobilePaper: { sx: { backgroundColor: (theme) => theme.palette.mode === "dark" ? "#151922" : "#fff9ee" } },
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

  const searchField = filter === "Game" ? (
    <TextField
      key="game" size="small" fullWidth label="Search by Game" type="search" value={filterGame}
      onChange={handleGameChange}
    />
  ) : (
    <TextField
      key="title" size="small" fullWidth label="Search by Title" type="search" value={filterTitle}
      onChange={(event) => {
        if (filter === "Default") changeFilter({ target: { value: "Title" } });
        handleTitleChange(event);
      }}
    />
  );

  return (
    <Box className="soft-archive-controls" sx={{ px: { xs: 0.25, md: 0.5 }, py: { xs: 1.25, md: 1.45 } }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: { xs: "flex-start", md: "center" }, gap: 1.5 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h5" className="soft-section-heading" sx={{ color: "primary.main", pr: 1 }}>
            VOD archive
          </Typography>
          <Typography variant="body2" sx={{ display: { xs: "none", md: "block" }, color: "text.secondary", mt: 0.35, maxWidth: 520, lineHeight: 1.45 }}>
            Search, filter, and jump into any stream with chat replay.
          </Typography>
        </Box>
        {totalVods !== null && (
          <Chip
            icon={<VideoLibraryRoundedIcon sx={{ fontSize: 16 }} />}
            label={`${totalVods} vod${totalVods === 1 ? "" : "s"}`}
            sx={{
              borderRadius: "999px",
              background: "var(--soft-surface)",
              border: "1px solid var(--soft-border)",
              fontWeight: 700,
              flexShrink: 0,
              boxShadow: "inset 0 1px 0 rgba(255,255,255,.14)",
            }}
          />
        )}
      </Box>

      {compact ? (
        <Box sx={{ mt: 2 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            {filter === "Date" ? <Typography sx={{ flex: 1, color: "text.secondary", fontSize: "0.9rem" }}>Filter by date</Typography> : searchField}
            <Button
              aria-expanded={filtersOpen} aria-controls="soft-archive-filters"
              onClick={() => setFiltersOpen((open) => !open)}
              variant={filtersOpen || ["Game", "Date"].includes(filter) ? "contained" : "outlined"}
              startIcon={<TuneRoundedIcon />}
              sx={{ minHeight: 48, flexShrink: 0, px: 1.4, borderRadius: "12px" }}
            >Filters</Button>
          </Box>
          <Collapse in={filtersOpen}>
            <Box id="soft-archive-filters" sx={{ pt: 1.5 }}>{filterSelect}</Box>
          </Collapse>
          {filter === "Date" && <Box sx={{ pt: 1.5 }}>{dateFields}</Box>}
        </Box>
      ) : <Box
        sx={{
          mt: 1.35,
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "160px minmax(220px, 560px)" },
          gap: 1.1,
          alignItems: "center",
        }}
      >
        {filterSelect}
        {filter === "Date" ? dateFields : ["Title", "Game"].includes(filter) ? searchField : <Box />}
      </Box>}
    </Box>
  );
}
