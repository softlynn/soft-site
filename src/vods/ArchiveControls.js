import { Box, Typography, FormControl, InputLabel, Select, MenuItem, TextField, Chip, Stack } from "@mui/material";
import { DatePicker } from "@mui/x-date-pickers/DatePicker";
import { LocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import dayjs from "dayjs";
import VideoLibraryRoundedIcon from "@mui/icons-material/VideoLibraryRounded";
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

  return (
    <Box sx={{ px: { xs: 0.25, md: 0.5 }, py: { xs: 1.25, md: 1.45 } }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: { xs: "flex-start", md: "center" }, gap: 1.5, flexDirection: { xs: "column", md: "row" } }}>
        <Box>
          <Typography variant="h5" className="soft-section-heading" sx={{ color: "primary.main", pr: 1 }}>
            VOD archive
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.35, maxWidth: 520, lineHeight: 1.45 }}>
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
              boxShadow: "inset 0 1px 0 rgba(255,255,255,.14)",
            }}
          />
        )}
      </Box>

      <Box
        sx={{
          mt: 1.35,
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "160px minmax(220px, 560px)" },
          gap: 1.1,
          alignItems: "center",
        }}
      >
        <FormControl size="small" sx={{ minWidth: 130 }}>
          <InputLabel id="filter-select-label">Filter</InputLabel>
          <Select labelId="filter-select-label" label="Filter" value={filter} onChange={changeFilter}>
            {filters.map((value) => (
              <MenuItem key={value} value={value}>
                {value}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        {filter === "Date" ? (
          <LocalizationProvider dateAdapter={AdapterDayjs}>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
            <DatePicker
              minDate={dayjs(START_DATE)}
              maxDate={dayjs()}
              label="Start Date"
              value={filterStartDate}
              onAccept={(newDate) => setFilterStartDate(newDate)}
              views={["year", "month", "day"]}
              slotProps={{ textField: { size: "small" } }}
            />
            <DatePicker
              minDate={dayjs(START_DATE)}
              maxDate={dayjs()}
              label="End Date"
              value={filterEndDate}
              onAccept={(newDate) => setFilterEndDate(newDate)}
              views={["year", "month", "day"]}
              slotProps={{ textField: { size: "small" } }}
            />
          </Stack>
          </LocalizationProvider>
        ) : filter === "Title" ? (
          <TextField key="title" size="small" fullWidth label="Search by Title" type="search" onChange={handleTitleChange} defaultValue={filterTitle} />
        ) : filter === "Game" ? (
          <TextField key="game" size="small" fullWidth label="Search by Game" type="search" onChange={handleGameChange} defaultValue={filterGame} />
        ) : (
          <Box />
        )}
      </Box>
    </Box>
  );
}
